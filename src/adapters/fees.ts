import { FEE_PIPS_DENOMINATOR } from "../shared/constants.ts";

export type SplitSwapFee = {
	amountIn: bigint;
	inputIsToken0: boolean;
	totalFee: bigint;
	protocolFee: bigint;
	lpFee: bigint;
};

const ZERO = 0n;

export function absBigInt(value: bigint): bigint {
	return value < 0n ? -value : value;
}

export function swapInput(
	amount0: bigint,
	amount1: bigint,
): { amountIn: bigint; inputIsToken0: boolean } | null {
	if (amount0 === ZERO && amount1 === ZERO) {
		return null;
	}
	if (amount0 > 0n) {
		return { amountIn: amount0, inputIsToken0: true };
	}
	if (amount1 > 0n) {
		return { amountIn: amount1, inputIsToken0: false };
	}
	return null;
}

/** V3: protocol takes 1 / feeProtocol of the swap fee when feeProtocol is non-zero. */
export function splitV3SwapFee(input: {
	amount0: bigint;
	amount1: bigint;
	feePips: number;
	feeProtocol0: number;
	feeProtocol1: number;
}): SplitSwapFee | null {
	const side = swapInput(input.amount0, input.amount1);
	if (!side) {
		return null;
	}
	const totalFee = (side.amountIn * BigInt(input.feePips)) / BigInt(FEE_PIPS_DENOMINATOR);
	const protocolDenominator = side.inputIsToken0 ? input.feeProtocol0 : input.feeProtocol1;
	const protocolFee = protocolDenominator > 0 ? totalFee / BigInt(protocolDenominator) : ZERO;
	return {
		...side,
		totalFee,
		protocolFee,
		lpFee: totalFee - protocolFee,
	};
}

export function unpackV3FeeProtocol(feeProtocol: number): {
	feeProtocol0: number;
	feeProtocol1: number;
} {
	return {
		feeProtocol0: feeProtocol % 16,
		feeProtocol1: feeProtocol >> 4,
	};
}

/**
 * V4: the Swap event `fee` is the combined swap fee (protocol taken from input first,
 * then LP fee from the remainder). Protocol pips come from StateView slot0.
 */
export function splitV4SwapFee(input: {
	amount0: bigint;
	amount1: bigint;
	swapFeePips: number;
	protocolFeePips: number;
}): SplitSwapFee | null {
	// V4 emits the caller's BalanceDelta: input is negative, opposite to V3.
	const side = swapInput(-input.amount0, -input.amount1);
	if (!side) {
		return null;
	}
	const denom = BigInt(FEE_PIPS_DENOMINATOR);
	const totalFee = (side.amountIn * BigInt(input.swapFeePips)) / denom;
	const protocolFee = (side.amountIn * BigInt(input.protocolFeePips)) / denom;
	const lpFee = totalFee > protocolFee ? totalFee - protocolFee : ZERO;
	return {
		...side,
		totalFee,
		protocolFee,
		lpFee,
	};
}

export function unpackV4ProtocolFee(protocolFee: number, zeroForOne: boolean): number {
	return zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
}
