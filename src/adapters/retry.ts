import { classifyRpcError, RpcFailureError } from "./errors.ts";

export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 400;

export type RetryOptions = {
	attempts?: number;
	baseDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: (ms: number) => Promise<void>;
};

export function isRetryableRpcError(error: unknown): boolean {
	const classified = error instanceof RpcFailureError ? error : classifyRpcError(error);
	return classified.code === "rpc_down" || classified.code === "rpc_rate_limited";
}

export function retryDelayMs(
	attemptIndexFromZero: number,
	baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
): number {
	return baseDelayMs * 2 ** attemptIndexFromZero;
}

async function defaultSleep(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Limited retries with exponential backoff for transient ingest failures.
 * Does not retry misconfiguration or range-limit errors (those need a different response).
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
	const shouldRetry = options.shouldRetry ?? isRetryableRpcError;
	const sleep = options.sleep ?? defaultSleep;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error instanceof RpcFailureError ? error : classifyRpcError(error);
			if (attempt >= attempts || !shouldRetry(lastError)) {
				throw lastError;
			}
			await sleep(retryDelayMs(attempt - 1, baseDelayMs));
		}
	}
	throw lastError instanceof Error ? lastError : new RpcFailureError("rpc_down", "重试后仍然失败");
}
