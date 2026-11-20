import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { pipeline, Readable } from "node:stream";
import { TLSSocket } from "node:tls";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import type { HttpTransportConfig } from "viem";

export function createRpcFetch() {
	const options = { keepAlive: true, maxSockets: 64, maxFreeSockets: 64 };
	const httpAgent = new HttpAgent(options);
	const httpsAgent = new HttpsAgent(options);
	const fetch: NonNullable<HttpTransportConfig["fetchFn"]> = async (input, init) => {
		const request = new Request(input, init);
		const body = Buffer.from(await request.arrayBuffer());
		const headers = new Headers(request.headers);
		if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
		const secure = new URL(request.url).protocol === "https:";
		return new Promise<Response>((resolve, reject) => {
			let connectionTimer: ReturnType<typeof setTimeout> | undefined;
			const clearConnectionTimer = () => clearTimeout(connectionTimer);
			const outgoing = (secure ? httpsRequest : httpRequest)(
				request.url,
				{
					agent: secure ? httpsAgent : httpAgent,
					method: request.method,
					headers: Object.fromEntries(headers),
					signal: request.signal,
				},
				(incoming) => {
					clearConnectionTimer();
					const responseHeaders = new Headers();
					for (let i = 0; i < incoming.rawHeaders.length; i += 2)
						responseHeaders.append(
							incoming.rawHeaders[i] as string,
							incoming.rawHeaders[i + 1] as string,
						);
					const encoding = incoming.headers["content-encoding"];
					const decoder =
						encoding === "br"
							? createBrotliDecompress()
							: encoding === "gzip" || encoding === "deflate"
								? createUnzip()
								: undefined;
					if (decoder) {
						pipeline(incoming, decoder, () => {});
						responseHeaders.delete("content-encoding");
						responseHeaders.delete("content-length");
					}
					// Keep a stream so viem can enforce its decompressed body limit and cancel reads.
					const reader = (
						Readable.toWeb(decoder ?? incoming) as ReadableStream<Uint8Array>
					).getReader();
					const stream = new ReadableStream<Uint8Array>({
						async pull(controller) {
							try {
								const { done, value } = await reader.read();
								if (done) controller.close();
								else controller.enqueue(value);
							} catch (error) {
								// Node's response emits ECONNRESET on abort; preserve fetch's abort reason.
								controller.error(request.signal.aborted ? request.signal.reason : error);
							}
						},
						cancel: (reason) => reader.cancel(reason),
					});
					resolve(
						new Response(stream, {
							status: incoming.statusCode,
							headers: responseHeaders,
						}),
					);
				},
			);
			outgoing.once("socket", (socket) => {
				if (outgoing.reusedSocket) return;
				// Match the existing fetch transport's connection deadline, not the RPC response timeout.
				connectionTimer = setTimeout(
					() =>
						outgoing.destroy(
							Object.assign(new Error("RPC connection timed out"), { code: "ETIMEDOUT" }),
						),
					10_000,
				);
				socket.once(
					socket instanceof TLSSocket ? "secureConnect" : "connect",
					clearConnectionTimer,
				);
			});
			outgoing.once("error", reject);
			outgoing.once("error", clearConnectionTimer);
			outgoing.once("close", clearConnectionTimer);
			outgoing.end(body);
		});
	};
	return {
		fetch,
		close: () => {
			httpAgent.destroy();
			httpsAgent.destroy();
		},
	};
}
