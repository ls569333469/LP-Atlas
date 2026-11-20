const Q128 = 1n << 128n;
const U256 = 1n << 256n;

/** Growth is an unsigned wrapping counter; liquidity changes settle the old amount first. */
export function positionFeeDelta(liquidity: bigint, previous: bigint, current: bigint): bigint {
	return (liquidity * ((current - previous + U256) % U256)) / Q128;
}

export type PositionFeeHour = {
	poolId: string;
	lower: number;
	upper: number;
	start: number;
	growth0Start: string;
	growth1Start: string;
	growth0End: string;
	growth1End: string;
	status: "usable" | "unknown";
	reason: string | null;
};
