import { hasHook } from "../adapters/hooks.ts";
import type { FeeDataStatus } from "../shared/fee-quality.ts";
import type { StoredPool, StoredWindow } from "../store/types.ts";

export function poolFeeStatus(
	pool: Pick<StoredPool, "protocol" | "hooks" | "feePips">,
	window: Pick<StoredWindow, "feeStatus" | "lpFees0" | "lpFees1">,
): FeeDataStatus {
	if (pool.protocol === "uniswap_v4") {
		if (hasHook(pool.hooks)) {
			// Core Swap fees accrue to LPs even when a hook charges separately.
			// Old unresolved rows must be rescanned: their protocol state was not retained.
			if (window.feeStatus !== "estimated") return window.feeStatus ?? "legacy_unverified";
			return "estimated";
		}
		if (pool.feePips === 0 && window.lpFees0 === "0" && window.lpFees1 === "0") {
			return "verified_zero";
		}
	}
	return window.feeStatus ?? "legacy_unverified";
}
