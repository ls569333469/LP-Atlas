export class RpcFailureError extends Error {
	readonly code: "rpc_down" | "rpc_rate_limited" | "rpc_range_limited" | "rpc_misconfigured";

	constructor(code: RpcFailureError["code"], message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RpcFailureError";
		this.code = code;
	}
}

export function classifyRpcError(error: unknown): RpcFailureError {
	if (error instanceof RpcFailureError) {
		return error;
	}
	const text = errorText(error).toLowerCase();
	if (
		text.includes("429") ||
		text.includes("rate limit") ||
		text.includes("too many requests") ||
		text.includes("over rate")
	) {
		return new RpcFailureError("rpc_rate_limited", `节点限流：${errorText(error)}`, {
			cause: error,
		});
	}
	if (
		text.includes("logs count limit") ||
		text.includes("query exceeds") ||
		text.includes("block range") ||
		text.includes("response size") ||
		text.includes("response body exceeded the size limit") ||
		text.includes("range is too large")
	) {
		return new RpcFailureError("rpc_range_limited", `查询范围受限：${errorText(error)}`, {
			cause: error,
		});
	}
	return new RpcFailureError("rpc_down", `节点不可用或请求失败：${errorText(error)}`, {
		cause: error,
	});
}

export function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/https?:\/\/[^\s"<>]+/gi, redactRpcUrl);
}

export function redactRpcUrl(url: string): string {
	return url
		.replace(/\/v2\/[^/\s"<>?]+/gi, "/v2/***")
		.replace(/[?&](api[_-]?key|apikey|key)=([^&]+)/gi, "$1=***");
}

export function assertWithinDeadline(
	deadlineAtMs: number | undefined,
	message = "已达到本轮刷新时限，停止继续拉数。",
): void {
	if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
		throw new RpcFailureError("rpc_down", message);
	}
}
