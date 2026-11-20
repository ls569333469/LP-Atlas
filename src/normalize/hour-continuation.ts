import type { SwapWindowAcc } from "../adapters/types.ts";
import type { StoredScannedHour, StoredWindow } from "../store/types.ts";
import type { BlockBoundedWindow } from "./windows-from-swaps.ts";

export function hourContinuation(
	window: BlockBoundedWindow,
	hour: StoredScannedHour | undefined,
	rows: StoredWindow[],
) {
	const resume =
		hour &&
		!hour.complete &&
		hour.stateBlockNumber === hour.toBlock &&
		hour.fromBlock === window.fromBlock.toString() &&
		BigInt(hour.toBlock) <= window.toBlock &&
		rows.every((row) => !row.complete && Date.parse(row.asOf) <= Date.parse(hour.asOf));
	return {
		fromBlock: resume ? BigInt(hour.toBlock) + 1n : window.fromBlock,
		base: resume ? rows : [],
	};
}

export function mergeHourContinuation(
	aggregated: Map<string, SwapWindowAcc>,
	rows: readonly StoredWindow[],
	protocol: SwapWindowAcc["protocol"],
): void {
	for (const row of rows) {
		const key = `${row.poolId}:${row.windowStart}`;
		const current = aggregated.get(key);
		aggregated.set(key, {
			poolId: row.poolId,
			protocol,
			windowStart: row.windowStart,
			volume0: BigInt(row.volume0) + (current?.volume0 ?? 0n),
			volume1: BigInt(row.volume1) + (current?.volume1 ?? 0n),
			lpFees0: BigInt(row.lpFees0) + (current?.lpFees0 ?? 0n),
			lpFees1: BigInt(row.lpFees1) + (current?.lpFees1 ?? 0n),
			swapCount: row.swapCount + (current?.swapCount ?? 0),
			sqrtPriceStart: row.sqrtPriceStart === null ? null : BigInt(row.sqrtPriceStart),
			sqrtPriceEnd:
				current?.sqrtPriceEnd ?? (row.sqrtPriceEnd === null ? null : BigInt(row.sqrtPriceEnd)),
			firstBlock: current?.firstBlock ?? null,
			lastBlock: current?.lastBlock ?? null,
		});
	}
}
