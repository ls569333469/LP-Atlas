import type { PublicClient } from "viem";
import { assertWithinDeadline, classifyRpcError } from "./errors.ts";
import { withRetry } from "./retry.ts";

export type ChainHead = {
	blockNumber: bigint;
	timestamp: number;
};

export async function readChainHead(client: PublicClient): Promise<ChainHead> {
	try {
		const block = await withRetry(() => client.getBlock({ blockTag: "latest" }));
		return { blockNumber: block.number, timestamp: Number(block.timestamp) };
	} catch (error) {
		throw classifyRpcError(error);
	}
}

export function narrowBlockRangeByTime(input: {
	low: bigint;
	high: bigint;
	targetUnix: number;
	latest: ChainHead;
}): { low: bigint; high: bigint; guess: bigint } {
	let low = input.low;
	let high = input.high;
	const elapsed = input.latest.timestamp - input.targetUnix;
	if (elapsed <= 0 || input.latest.blockNumber <= 0n) {
		return { low, high, guess: high };
	}
	const far = input.latest.blockNumber - BigInt(Math.ceil(elapsed * 10));
	const near = input.latest.blockNumber - BigInt(Math.floor(elapsed * 0.2));
	if (far > low) {
		low = far;
	}
	if (near < high && near > 0n) {
		high = near;
	}
	if (low > high) {
		low = input.low;
		high = input.high;
	}
	let guess = input.latest.blockNumber - BigInt(elapsed);
	if (guess < low) {
		guess = low;
	}
	if (guess > high) {
		guess = high;
	}
	return { low, high, guess };
}

export async function findBlockAtOrAfter(
	client: PublicClient,
	targetUnix: number,
	latest: ChainHead,
	fromBlock = 1n,
	deadlineAtMs?: number,
): Promise<bigint> {
	try {
		assertWithinDeadline(deadlineAtMs);
		if (targetUnix <= 0) {
			return fromBlock < 1n ? 1n : fromBlock;
		}
		if (targetUnix > latest.timestamp) {
			return latest.blockNumber;
		}
		let low = fromBlock < 1n ? 1n : fromBlock;
		let high = latest.blockNumber;
		if (low > high) {
			low = 1n;
		}
		const narrowed = narrowBlockRangeByTime({ low, high, targetUnix, latest });
		low = narrowed.low;
		high = narrowed.high;
		if (low < high) {
			assertWithinDeadline(deadlineAtMs);
			const block = await withRetry(() => client.getBlock({ blockNumber: narrowed.guess }), {
				attempts: 2,
			});
			const timestamp = Number(block.timestamp);
			let usedRefined = false;
			if (
				narrowed.guess !== latest.blockNumber &&
				latest.blockNumber > narrowed.guess &&
				latest.timestamp !== timestamp
			) {
				const secondsPerBlock =
					(latest.timestamp - timestamp) / Number(latest.blockNumber - narrowed.guess);
				if (Number.isFinite(secondsPerBlock) && secondsPerBlock > 0) {
					const estimated =
						latest.blockNumber -
						BigInt(Math.round((latest.timestamp - targetUnix) / secondsPerBlock));
					if (estimated > low && estimated < high && estimated !== narrowed.guess) {
						assertWithinDeadline(deadlineAtMs);
						const refined = await withRetry(() => client.getBlock({ blockNumber: estimated }), {
							attempts: 2,
						});
						usedRefined = true;
						if (Number(refined.timestamp) < targetUnix) {
							low = estimated + 1n;
						} else {
							high = estimated;
						}
					}
				}
			}
			if (!usedRefined) {
				if (timestamp < targetUnix) {
					if (narrowed.guess + 1n > low) {
						low = narrowed.guess + 1n;
					}
				} else if (narrowed.guess < high) {
					high = narrowed.guess;
				}
			}
		}
		while (low < high) {
			assertWithinDeadline(deadlineAtMs);
			const mid = (low + high) / 2n;
			const block = await withRetry(() => client.getBlock({ blockNumber: mid }), { attempts: 2 });
			const timestamp = Number(block.timestamp);
			if (timestamp < targetUnix) {
				low = mid + 1n;
			} else {
				high = mid;
			}
		}
		return low;
	} catch (error) {
		throw classifyRpcError(error);
	}
}

export async function readBlockTimestamp(
	client: PublicClient,
	blockNumber: bigint,
	deadlineAtMs?: number,
): Promise<number> {
	try {
		assertWithinDeadline(deadlineAtMs);
		const block = await withRetry(() => client.getBlock({ blockNumber }));
		return Number(block.timestamp);
	} catch (error) {
		throw classifyRpcError(error);
	}
}
