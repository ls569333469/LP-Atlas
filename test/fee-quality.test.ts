import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeV4SwapLog } from "../src/adapters/venues/elysium/uniswap-v4.ts";
import { poolFeeStatus } from "../src/normalize/fee-quality.ts";
import { accumulateSwapWindows, applyV4ProtocolFees } from "../src/normalize/windows-from-swaps.ts";
import { ZERO_ADDRESS } from "../src/shared/constants.ts";
import { combineFeeStatuses, feeDataUsable } from "../src/shared/fee-quality.ts";

describe("LP fee quality", () => {
	it("distinguishes zero core fees without a hook from unverified hook income", () => {
		const window = { feeStatus: "legacy_unverified" as const, lpFees0: "0", lpFees1: "0" };
		const pool = { protocol: "uniswap_v4", feePips: 0, hooks: ZERO_ADDRESS };
		expect(poolFeeStatus(pool, window)).toBe("verified_zero");
		expect(
			poolFeeStatus(
				{ ...pool, hooks: "0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC" },
				{ ...window, feeStatus: "estimated" },
			),
		).toBe("estimated");
		expect(poolFeeStatus({ ...pool, feePips: 3000 }, window)).toBe("legacy_unverified");
		expect(feeDataUsable("hook_unresolved")).toBe(false);
		expect(feeDataUsable("protocol_state_missing")).toBe(false);
		expect(combineFeeStatuses(["estimated", "legacy_unverified"])).toBe("legacy_unverified");
	});

	it("publishes reconstructed core LP fees for hook pools without reviving unverified history", () => {
		const pool = {
			protocol: "uniswap_v4",
			feePips: 100,
			hooks: "0xb1F013e3DF51B1f6e9e3Cb6277387C713ab34144",
		};
		const window = { lpFees0: "4176191570947131413671", lpFees1: "961038" };
		expect(poolFeeStatus(pool, { ...window, feeStatus: "estimated" })).toBe("estimated");
		for (const feeStatus of [
			"legacy_unverified",
			"protocol_state_missing",
			"hook_unresolved",
		] as const) {
			expect(poolFeeStatus(pool, { ...window, feeStatus })).toBe(feeStatus);
		}
	});

	it("keeps the real V4 fee in the input token through protocol deduction and aggregation", () => {
		const log = JSON.parse(readFileSync(new URL("fixtures/v4-swap.json", import.meta.url), "utf8"));
		const swap = decodeV4SwapLog(log, () => 0);
		// The two directions intentionally differ: oneForZero uses the upper 12 bits.
		applyV4ProtocolFees([swap], new Map([[swap.poolId, (20 << 12) | 10]]));
		expect(swap.protocolFee).toBe(196_600_000_000_000n);
		expect(swap.lpFee).toBe(786_400_000_000_000n);
		const result = accumulateSwapWindows(
			[swap],
			[
				{
					startUnix: 0,
					endUnix: 3600,
					complete: true,
					fromBlock: swap.blockNumber,
					toBlock: swap.blockNumber,
				},
			],
		);
		const acc = [...result.values()][0];
		expect(acc?.lpFees0).toBe(0n);
		expect(acc?.lpFees1).toBe(786_400_000_000_000n);
	});
});
