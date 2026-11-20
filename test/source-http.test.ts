import { expect, it } from "vitest";
import { readSourceUrl } from "../src/adapters/source-http.ts";

it("honors Retry-After and stops instead of shortening a long cooldown", async () => {
	let calls = 0;
	const delays: number[] = [];
	const request: typeof fetch = async () => {
		calls++;
		return calls === 1
			? new Response("limited", { status: 429, headers: { "Retry-After": "2" } })
			: new Response("source");
	};
	expect(
		(
			await readSourceUrl("https://example.com", {
				fetch: request,
				sleep: async (ms) => {
					delays.push(ms);
				},
			})
		).status,
	).toBe("ok");
	expect(delays).toEqual([2000]);
	expect(calls).toBe(2);
	const result = await readSourceUrl("https://example.com", {
		fetch: async () => new Response("limited", { status: 429, headers: { "Retry-After": "120" } }),
	});
	expect(result).toMatchObject({ status: "rate_limited", attempts: 1, retryAfterMs: 120000 });
});

it("does not retry security challenges or missing source", async () => {
	for (const [body, code, status] of [
		["Vercel Security Checkpoint", 429, "access_blocked"],
		["missing", 404, "not_found"],
	] as const) {
		const result = await readSourceUrl("https://example.com", {
			fetch: async () => new Response(body, { status: code }),
		});
		expect(result).toMatchObject({ status, attempts: 1 });
	}
});

it("supports HTTP dates and bounds failed network attempts", async () => {
	const now = Date.parse("2026-11-12T00:00:00Z");
	const delays: number[] = [];
	let calls = 0;
	await readSourceUrl("https://example.com", {
		now: () => now,
		sleep: async (ms) => {
			delays.push(ms);
		},
		fetch: async () =>
			++calls === 1
				? new Response("busy", {
						status: 429,
						headers: { "Retry-After": "Thu, 12 Nov 2026 00:00:03 GMT" },
					})
				: new Response("ok"),
	});
	expect(delays).toEqual([3000]);
	const result = await readSourceUrl("https://example.com", {
		fetch: async () => {
			throw new Error("connect timeout");
		},
		sleep: async () => undefined,
	});
	expect(result).toMatchObject({ status: "network_error", attempts: 3, httpStatus: null });
});
