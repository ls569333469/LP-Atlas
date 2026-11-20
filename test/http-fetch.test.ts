import { createServer, type RequestListener } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { getHttpRpcClient } from "viem/utils";
import { afterEach, expect, it } from "vitest";
import { createRpcFetch } from "../src/adapters/http-fetch.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(handler: RequestListener) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test listener");
	const pool = createRpcFetch();
	cleanups.push(async () => {
		pool.close();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	return { pool, url: `http://127.0.0.1:${address.port}` };
}

it("sends JSON-RPC and reuses connections across compressed responses", async () => {
	const ports = new Set<number | undefined>();
	const bodies: string[] = [];
	const { pool, url } = await serve(async (req, res) => {
		ports.add(req.socket.remotePort);
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		bodies.push(body);
		const encoding = bodies.length === 1 ? "gzip" : "br";
		const json = Buffer.from(
			JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: "0x2a" }),
		);
		const compressed = encoding === "gzip" ? gzipSync(json) : brotliCompressSync(json);
		res.writeHead(200, {
			"content-type": "application/json",
			"content-encoding": encoding,
			"content-length": compressed.length,
		});
		res.end(compressed);
	});
	const client = getHttpRpcClient(url, { fetchFn: pool.fetch });
	for (let i = 0; i < 3; i++) {
		const reply = await client.request({ body: { method: "eth_blockNumber" } });
		expect(reply.result).toBe("0x2a");
	}
	expect(ports.size).toBe(1);
	expect(bodies.map((body) => JSON.parse(body).method)).toEqual(Array(3).fill("eth_blockNumber"));
});

it("preserves HTTP status and retry headers for the existing retry layer", async () => {
	const { pool, url } = await serve((_req, res) => {
		res.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
		res.end(JSON.stringify({ error: { code: -32005, message: "limited" } }));
	});
	const client = getHttpRpcClient(url, { fetchFn: pool.fetch });
	try {
		await client.request({ body: { method: "eth_blockNumber" } });
		throw new Error("Expected failure");
	} catch (error) {
		expect(error).toMatchObject({ status: 429 });
		expect((error as { headers: Headers }).headers.get("retry-after")).toBe("2");
	}
});

it.each(["headers", "body"])(
	"aborts stalled %s and recovers on the next request",
	async (phase) => {
		let calls = 0;
		let disconnected: Promise<void> | undefined;
		const { pool, url } = await serve((_req, res) => {
			if (++calls === 1) {
				disconnected = new Promise<void>((resolve) => res.once("close", resolve));
				if (phase === "body") {
					res.writeHead(200, { "content-type": "application/json" });
					res.write('{"result":');
				}
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end('{"result":"0x2a"}');
		});
		const client = getHttpRpcClient(url, { fetchFn: pool.fetch });
		await expect(
			client.request({ body: { method: "eth_blockNumber" }, timeout: 100 }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		await disconnected;
		expect(
			(await client.request({ body: { method: "eth_blockNumber" }, timeout: 1000 })).result,
		).toBe("0x2a");
	},
);

it("enforces viem's limit after decompression and recovers after cancellation", async () => {
	let calls = 0;
	const { pool, url } = await serve((_req, res) => {
		const json = JSON.stringify({ result: ++calls === 1 ? "x".repeat(100_000) : "0x2a" });
		res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
		res.end(gzipSync(json));
	});
	const client = getHttpRpcClient(url, { fetchFn: pool.fetch, maxResponseBodySize: 1024 });
	await expect(client.request({ body: { method: "eth_blockNumber" } })).rejects.toMatchObject({
		name: "ResponseBodyTooLargeError",
	});
	expect((await client.request({ body: { method: "eth_blockNumber" } })).result).toBe("0x2a");
});

it("propagates a broken compressed response and can retry on a fresh connection", async () => {
	let calls = 0;
	const { pool, url } = await serve((_req, res) => {
		if (++calls === 1) {
			res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
			res.end(Buffer.from("not gzip"));
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end('{"result":"0x2a"}');
	});
	const client = getHttpRpcClient(url, { fetchFn: pool.fetch, timeout: 1000 });
	await expect(client.request({ body: { method: "eth_blockNumber" } })).rejects.toMatchObject({
		name: "HttpRequestError",
	});
	expect((await client.request({ body: { method: "eth_blockNumber" } })).result).toBe("0x2a");
});

it("preserves explicit cancellation during a compressed response and closes the connection", async () => {
	let received!: () => void;
	const started = new Promise<void>((resolve) => {
		received = resolve;
	});
	let closed!: () => void;
	const disconnected = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const { pool, url } = await serve((_req, res) => {
		res.once("close", closed);
		res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
		res.write(gzipSync('{"result":'));
		received();
	});
	const controller = new AbortController();
	const client = getHttpRpcClient(url, { fetchFn: pool.fetch, timeout: 1000 });
	const result = client.request({
		body: { method: "eth_blockNumber" },
		fetchOptions: { signal: controller.signal },
	});
	const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
	await disconnected;
});
