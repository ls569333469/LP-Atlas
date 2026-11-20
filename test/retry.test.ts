import { describe, expect, it } from "vitest";
import { classifyRpcError, errorText, RpcFailureError } from "../src/adapters/errors.ts";
import { isRetryableRpcError, retryDelayMs, withRetry } from "../src/adapters/retry.ts";

it("redacts credential URLs inside RPC failure messages", () => {
	expect(errorText(new Error("URL: https://example.com/v2/test-secret\nDetails: failed"))).toBe(
		"URL: https://example.com/v2/***\nDetails: failed",
	);
	expect(errorText("https://example.com/?api_key=test-secret&network=4663")).not.toContain(
		"test-secret",
	);
});

describe("withRetry", () => {
	it("classifies oversized HTTP bodies as range failures rather than connection failures", () => {
		const error = new Error(
			"HTTP response body exceeded the size limit.\nMax: 10485760 bytes\nReceived: 10493240 bytes",
		);
		expect(classifyRpcError(error).code).toBe("rpc_range_limited");
		expect(isRetryableRpcError(error)).toBe(false);
		expect(classifyRpcError(new Error("connection timed out")).code).toBe("rpc_down");
	});
	it("retries retryable failures with exponential backoff and then succeeds", async () => {
		const delays: number[] = [];
		let calls = 0;
		const result = await withRetry(
			async () => {
				calls += 1;
				if (calls < 3) {
					throw new RpcFailureError("rpc_rate_limited", "节点限流：too many requests");
				}
				return "ok";
			},
			{
				attempts: 3,
				baseDelayMs: 100,
				sleep: async (ms) => {
					delays.push(ms);
				},
			},
		);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
		expect(delays).toEqual([100, 200]);
		expect(retryDelayMs(2, 100)).toBe(400);
	});

	it("does not retry misconfiguration or range-limit errors", async () => {
		let calls = 0;
		await expect(
			withRetry(
				async () => {
					calls += 1;
					throw new RpcFailureError("rpc_misconfigured", "未配置主节点");
				},
				{ attempts: 3, sleep: async () => undefined },
			),
		).rejects.toMatchObject({ code: "rpc_misconfigured" });
		expect(calls).toBe(1);
		expect(isRetryableRpcError(new RpcFailureError("rpc_range_limited", "范围过大"))).toBe(false);
		expect(isRetryableRpcError(new RpcFailureError("rpc_down", "连接失败"))).toBe(true);
	});

	it("throws the last classified error after the limited attempts", async () => {
		let calls = 0;
		await expect(
			withRetry(
				async () => {
					calls += 1;
					throw new Error("429 too many requests");
				},
				{ attempts: 3, baseDelayMs: 1, sleep: async () => undefined },
			),
		).rejects.toMatchObject({ code: "rpc_rate_limited" });
		expect(calls).toBe(3);
	});
});
