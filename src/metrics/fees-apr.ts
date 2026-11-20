import type Decimal from "decimal.js";
import { SECONDS_PER_YEAR } from "../shared/constants.ts";

/**
 * fees APR is the annualized actual LP fees in this window only.
 * Never fee-tier × volume. Protocol and hook fees must already be excluded
 * from `lpFeesUsd` by the caller.
 */
export function annualizeFeesApr(input: {
	lpFeesUsd: Decimal;
	tvlUsd: Decimal;
	windowDurationSeconds: number;
}): Decimal | null {
	if (!input.lpFeesUsd.isFinite() || !input.tvlUsd.isFinite()) {
		return null;
	}
	if (input.tvlUsd.lte(0) || input.windowDurationSeconds <= 0) {
		return null;
	}
	return input.lpFeesUsd.div(input.tvlUsd).mul(SECONDS_PER_YEAR).div(input.windowDurationSeconds);
}

export function windowDurationSeconds(input: {
	windowStartUnix: number;
	windowEndUnix: number;
	asOfUnix: number;
	complete: boolean;
}): number {
	if (input.complete) {
		return Math.max(0, input.windowEndUnix - input.windowStartUnix);
	}
	return Math.max(0, Math.min(input.asOfUnix, input.windowEndUnix) - input.windowStartUnix);
}

export function capitalEfficiency(volumeUsd: Decimal, tvlUsd: Decimal): Decimal | null {
	if (!volumeUsd.isFinite() || !tvlUsd.isFinite() || tvlUsd.lte(0)) {
		return null;
	}
	return volumeUsd.div(tvlUsd);
}

export function relativeChange(current: Decimal, previous: Decimal): Decimal | null {
	if (!current.isFinite() || !previous.isFinite() || previous.eq(0)) {
		return null;
	}
	return current.minus(previous).div(previous);
}

export function priceChangeRatio(startPrice: Decimal, endPrice: Decimal): Decimal | null {
	if (!startPrice.isFinite() || !endPrice.isFinite() || startPrice.lte(0)) {
		return null;
	}
	return endPrice.minus(startPrice).div(startPrice);
}
