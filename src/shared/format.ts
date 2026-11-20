import { protocolById } from "./catalog.ts";
import { V4_DYNAMIC_FEE_FLAG } from "./constants.ts";
import type { ProtocolId } from "./types.ts";

export function isDynamicFeeTier(feePips: number): boolean {
	return (feePips & V4_DYNAMIC_FEE_FLAG) !== 0;
}

export function staticFeePips(feePips: number): number {
	return feePips & ~V4_DYNAMIC_FEE_FLAG;
}

/** Formats a Uniswap fee in pips (hundredths of a bip) as a percentage label. */
export function formatFeeTierLabel(
	feePips: number,
	options?: { dynamic?: boolean; currentLpFeePips?: number },
): string {
	const dynamic = options?.dynamic ?? isDynamicFeeTier(feePips);
	const current = options?.currentLpFeePips;
	if (dynamic) {
		if (current !== undefined) {
			return `动态（当前 ${formatPipsAsPercent(current)}）`;
		}
		return "动态";
	}
	return formatPipsAsPercent(staticFeePips(feePips));
}

export function formatPipsAsPercent(feePips: number): string {
	const percent = feePips / 10_000;
	if (Number.isInteger(percent)) {
		return `${percent}%`;
	}
	const text = percent.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
	return `${text}%`;
}

export function protocolLabel(protocol: ProtocolId): string {
	return protocolById(protocol)?.label ?? protocol;
}

export function formatPairLabel(symbol0: string, symbol1: string): string {
	return `${symbol0}/${symbol1}`;
}
