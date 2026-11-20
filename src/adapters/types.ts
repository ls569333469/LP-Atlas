import type { Address } from "viem";
import type { ProtocolId } from "../shared/types.ts";

export type DiscoveredPool = {
	poolId: string;
	protocol: ProtocolId;
	token0: Address;
	token1: Address;
	feePips: number;
	tickSpacing: number;
	hooks: Address | null;
	poolAddress: Address | null;
	createdBlock: bigint;
};

export type DecodedSwap = {
	poolId: string;
	protocol: ProtocolId;
	blockNumber: bigint;
	logIndex: number;
	timestamp: number | null;
	amount0: bigint;
	amount1: bigint;
	sqrtPriceX96: bigint;
	feePips: number;
	lpFee: bigint;
	protocolFee: bigint;
	inputIsToken0: boolean;
};

export type V3PoolState = {
	poolId: string;
	sqrtPriceX96: bigint;
	tick: number;
	liquidity: bigint;
	feeProtocol0: number;
	feeProtocol1: number;
	amount0: bigint;
	amount1: bigint;
};

export type V4PoolState = {
	poolId: string;
	sqrtPriceX96: bigint;
	tick: number;
	liquidity: bigint;
	protocolFee: number;
	lpFee: number;
	amount0: bigint | null;
	amount1: bigint | null;
	tvlGap: string | null;
	hasCustomAccounting: boolean;
};

export type TokenMetadata = {
	address: Address | typeof import("../shared/constants.ts").ZERO_ADDRESS;
	symbol: string;
	decimals: number;
	name: string | null;
};

export type SwapWindowKey = {
	poolId: string;
	windowStart: number;
};

export type SwapWindowAcc = {
	poolId: string;
	protocol: ProtocolId;
	windowStart: number;
	volume0: bigint;
	volume1: bigint;
	lpFees0: bigint;
	lpFees1: bigint;
	swapCount: number;
	sqrtPriceStart: bigint | null;
	sqrtPriceEnd: bigint | null;
	firstBlock: bigint | null;
	lastBlock: bigint | null;
};
