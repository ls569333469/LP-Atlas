import { absBigInt, splitV4SwapFee, unpackV4ProtocolFee } from "../adapters/fees.ts";
import type { DecodedSwap, SwapWindowAcc } from "../adapters/types.ts";
import type { HourWindow } from "../metrics/windows.ts";

export type BlockBoundedWindow = HourWindow & {
	fromBlock: bigint;
	toBlock: bigint;
};

export function assignSwapWindow(
	blockNumber: bigint,
	windows: readonly BlockBoundedWindow[],
): BlockBoundedWindow | undefined {
	return windows.find((window) => blockNumber >= window.fromBlock && blockNumber <= window.toBlock);
}

export function accumulateSwapWindows(
	swaps: readonly DecodedSwap[],
	windows: readonly BlockBoundedWindow[],
): Map<string, SwapWindowAcc> {
	const acc = new Map<string, SwapWindowAcc>();
	for (const swap of swaps) {
		const window = assignSwapWindow(swap.blockNumber, windows);
		if (!window) {
			continue;
		}
		const key = `${swap.poolId}:${window.startUnix}`;
		const current = acc.get(key) ?? {
			poolId: swap.poolId,
			protocol: swap.protocol,
			windowStart: window.startUnix,
			volume0: 0n,
			volume1: 0n,
			lpFees0: 0n,
			lpFees1: 0n,
			swapCount: 0,
			sqrtPriceStart: null,
			sqrtPriceEnd: null,
			firstBlock: null,
			lastBlock: null,
		};
		current.volume0 += absBigInt(swap.amount0);
		current.volume1 += absBigInt(swap.amount1);
		if (swap.inputIsToken0) {
			current.lpFees0 += swap.lpFee;
		} else {
			current.lpFees1 += swap.lpFee;
		}
		current.swapCount += 1;
		if (current.sqrtPriceStart === null) {
			current.sqrtPriceStart = swap.sqrtPriceX96;
			current.firstBlock = swap.blockNumber;
		}
		current.sqrtPriceEnd = swap.sqrtPriceX96;
		current.lastBlock = swap.blockNumber;
		acc.set(key, current);
	}
	return acc;
}

export function applyV4ProtocolFees(
	swaps: DecodedSwap[],
	protocolFeeByPool: Map<string, number>,
): void {
	for (const swap of swaps) {
		if (swap.protocol !== "uniswap_v4") {
			continue;
		}
		const packed = protocolFeeByPool.get(swap.poolId) ?? 0;
		const split = splitV4SwapFee({
			amount0: swap.amount0,
			amount1: swap.amount1,
			swapFeePips: swap.feePips,
			protocolFeePips: unpackV4ProtocolFee(packed, swap.amount0 < 0n),
		});
		if (!split) continue;
		swap.inputIsToken0 = split.inputIsToken0;
		swap.protocolFee = split.protocolFee;
		swap.lpFee = split.lpFee;
	}
}
