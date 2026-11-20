import type { AbiEvent, Address, Log, PublicClient } from "viem";
import { assertWithinDeadline, classifyRpcError, errorText, RpcFailureError } from "./errors.ts";
import { withRetry } from "./retry.ts";

const DEFAULT_CHUNK = 150_000n;
const MIN_CHUNK = 1n;

function minBigInt(left: bigint, right: bigint): bigint {
	return left < right ? left : right;
}

function isRangeLimit(error: unknown): boolean {
	if (error instanceof RpcFailureError) {
		return error.code === "rpc_range_limited";
	}
	return classifyRpcError(error).code === "rpc_range_limited";
}

export async function getLogsPaginated(input: {
	client: PublicClient;
	address?: Address | Address[];
	event: AbiEvent;
	fromBlock: bigint;
	toBlock: bigint;
	chunkSize?: bigint;
	concurrency?: number;
	deadlineAtMs?: number;
}): Promise<Log[]> {
	if ((input.concurrency ?? 1) > 1) return getLogsParallel(input);
	const logs: Log[] = [];
	let cursor = input.fromBlock;
	let chunk = input.chunkSize ?? DEFAULT_CHUNK;
	while (cursor <= input.toBlock) {
		assertWithinDeadline(input.deadlineAtMs);
		const end = minBigInt(cursor + chunk - 1n, input.toBlock);
		try {
			const page = await withRetry(() =>
				input.client.getLogs({
					address: input.address,
					event: input.event,
					fromBlock: cursor,
					toBlock: end,
					strict: true,
				}),
			);
			logs.push(...page);
			cursor = end + 1n;
			if (page.length < 1000 && chunk < (input.chunkSize ?? DEFAULT_CHUNK)) {
				chunk *= 2n;
			}
		} catch (error) {
			if (isRangeLimit(error) && end > cursor) {
				chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
				continue;
			}
			throw classifyRpcError(error);
		}
	}
	return logs;
}

// V3 and V4 share one endpoint budget, even when their hourly reads overlap.
const logBudgets = new WeakMap<
	PublicClient,
	{ active: number; limit: number; waiters: Array<() => void> }
>();

async function getLogsParallel(input: Parameters<typeof getLogsPaginated>[0]): Promise<Log[]> {
	const concurrency = input.concurrency ?? 8;
	const started = Date.now();
	let requests = 0;
	let splits = 0;
	let requestMs = 0;
	let budget = logBudgets.get(input.client);
	if (!budget) {
		budget = { active: 0, limit: concurrency, waiters: [] };
		logBudgets.set(input.client, budget);
	}
	const shared = budget;
	async function readRange(fromBlock: bigint, toBlock: bigint, failures = 0): Promise<Log[]> {
		assertWithinDeadline(input.deadlineAtMs);
		while (shared.active >= shared.limit) {
			await new Promise<void>((resolve) => shared.waiters.push(resolve));
		}
		shared.active += 1;
		const requestStarted = Date.now();
		let failure: RpcFailureError | undefined;
		try {
			return await withRetry(
				async () => {
					requests += 1;
					const attemptStarted = Date.now();
					try {
						return await input.client.getLogs({
							address: input.address,
							event: input.event,
							fromBlock,
							toBlock,
							strict: true,
						});
					} catch (error) {
						const classified = classifyRpcError(error);
						const message = errorText(classified);
						console.info(
							JSON.stringify({
								event: "rpc_log_page_failure",
								logEvent: input.event.name,
								address: input.address ?? null,
								fromBlock: fromBlock.toString(),
								toBlock: toBlock.toString(),
								durationMs: Date.now() - attemptStarted,
								code: classified.code,
								error:
									message.length > 800
										? `${message.slice(0, 200)} … ${message.slice(-600)}`
										: message,
							}),
						);
						if (classified.code === "rpc_rate_limited")
							shared.limit = Math.max(1, Math.floor(shared.limit / 2));
						throw classified;
					}
				},
				{ shouldRetry: (error) => classifyRpcError(error).code === "rpc_rate_limited" },
			);
		} catch (error) {
			failure = classifyRpcError(error);
		} finally {
			requestMs += Date.now() - requestStarted;
			shared.active -= 1;
			for (const wake of shared.waiters.splice(0)) wake();
		}
		if (
			toBlock > fromBlock &&
			(failure.code === "rpc_range_limited" || (failure.code === "rpc_down" && failures < 4))
		) {
			splits += 1;
			const middle = (fromBlock + toBlock) / 2n;
			const halves = await Promise.allSettled([
				readRange(fromBlock, middle, failures + 1),
				readRange(middle + 1n, toBlock, failures + 1),
			]);
			const logs: Log[] = [];
			for (const half of halves) {
				if (half.status === "rejected") throw half.reason;
				logs.push(...half.value);
			}
			return logs;
		}
		throw failure;
	}
	const chunk = input.chunkSize ?? DEFAULT_CHUNK;
	let cursor = input.fromBlock;
	const pages: Log[][] = [];
	let nextPage = 0;
	let failure: unknown;
	async function worker(): Promise<void> {
		while (cursor <= input.toBlock && failure === undefined) {
			const from = cursor;
			const end = minBigInt(from + chunk - 1n, input.toBlock);
			cursor = end + 1n;
			const index = nextPage++;
			try {
				pages[index] = await readRange(from, end);
			} catch (error) {
				failure ??= error;
			}
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	console.info(
		JSON.stringify({
			event: "rpc_log_pages",
			logEvent: input.event.name,
			fromBlock: input.fromBlock.toString(),
			toBlock: input.toBlock.toString(),
			durationMs: Date.now() - started,
			requests,
			splits,
			requestMs,
			concurrency: shared.limit,
			pages: pages.filter(Boolean).length,
			logs: pages.reduce((sum, page) => sum + page.length, 0),
			status: failure === undefined ? "ok" : "error",
		}),
	);
	if (failure !== undefined) throw failure;
	return pages.flat();
}

export async function getLogsInAddressBatches(input: {
	client: PublicClient;
	addresses: Address[];
	event: AbiEvent;
	fromBlock: bigint;
	toBlock: bigint;
	batchSize?: number;
	chunkSize?: bigint;
	deadlineAtMs?: number;
}): Promise<Log[]> {
	const batchSize = input.batchSize ?? 80;
	const logs: Log[] = [];
	for (let i = 0; i < input.addresses.length; i += batchSize) {
		assertWithinDeadline(input.deadlineAtMs);
		const batch = input.addresses.slice(i, i + batchSize);
		if (batch.length === 0) {
			continue;
		}
		const page = await getLogsPaginated({
			client: input.client,
			address: batch,
			event: input.event,
			fromBlock: input.fromBlock,
			toBlock: input.toBlock,
			chunkSize: input.chunkSize,
			deadlineAtMs: input.deadlineAtMs,
		});
		logs.push(...page);
	}
	return logs;
}
