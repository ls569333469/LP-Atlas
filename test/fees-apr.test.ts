import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
	annualizeFeesApr,
	capitalEfficiency,
	relativeChange,
	windowDurationSeconds,
} from "../src/metrics/fees-apr.ts";
import { SECONDS_PER_YEAR } from "../src/shared/constants.ts";

describe("annualizeFeesApr", () => {
	it("annualizes actual LP fees over a complete 1h window", () => {
		const apr = annualizeFeesApr({
			lpFeesUsd: new Decimal("1"),
			tvlUsd: new Decimal("1000"),
			windowDurationSeconds: 3600,
		});
		expect(apr?.toString()).toBe(
			new Decimal("1").div(1000).mul(SECONDS_PER_YEAR).div(3600).toString(),
		);
		expect(apr?.toNumber()).toBe(8.76);
	});

	it("never treats fee-tier times volume as fees", () => {
		const volumeUsd = new Decimal("10_000");
		const feeTier = new Decimal("0.003");
		const fake = volumeUsd.mul(feeTier);
		const actualLpFees = new Decimal("12");
		const apr = annualizeFeesApr({
			lpFeesUsd: actualLpFees,
			tvlUsd: new Decimal("1000"),
			windowDurationSeconds: 3600,
		});
		const fakeApr = annualizeFeesApr({
			lpFeesUsd: fake,
			tvlUsd: new Decimal("1000"),
			windowDurationSeconds: 3600,
		});
		expect(apr?.toString()).not.toBe(fakeApr?.toString());
		expect(apr?.toNumber()).toBe(105.12);
	});

	it("annualizes an incomplete hour by elapsed time and not a full hour", () => {
		const fees = new Decimal("1");
		const tvl = new Decimal("1000");
		const incomplete = annualizeFeesApr({
			lpFeesUsd: fees,
			tvlUsd: tvl,
			windowDurationSeconds: 1800,
		});
		const asFullHour = annualizeFeesApr({
			lpFeesUsd: fees,
			tvlUsd: tvl,
			windowDurationSeconds: 3600,
		});
		expect(incomplete?.toNumber()).toBe(17.52);
		expect(asFullHour?.toNumber()).toBe(8.76);
	});

	it("returns null when TVL or duration is missing or zero", () => {
		expect(
			annualizeFeesApr({
				lpFeesUsd: new Decimal("1"),
				tvlUsd: new Decimal("0"),
				windowDurationSeconds: 3600,
			}),
		).toBeNull();
		expect(
			annualizeFeesApr({
				lpFeesUsd: new Decimal("1"),
				tvlUsd: new Decimal("1000"),
				windowDurationSeconds: 0,
			}),
		).toBeNull();
	});
});

describe("windowDurationSeconds", () => {
	it("uses the full hour when the window is complete", () => {
		expect(
			windowDurationSeconds({
				windowStartUnix: 1_000_000,
				windowEndUnix: 1_003_600,
				asOfUnix: 1_002_000,
				complete: true,
			}),
		).toBe(3600);
	});

	it("uses elapsed time for an incomplete hour", () => {
		expect(
			windowDurationSeconds({
				windowStartUnix: 1_000_000,
				windowEndUnix: 1_003_600,
				asOfUnix: 1_001_800,
				complete: false,
			}),
		).toBe(1800);
	});
});

describe("capitalEfficiency and relativeChange", () => {
	it("computes volume / TVL", () => {
		expect(capitalEfficiency(new Decimal("250"), new Decimal("1000"))?.toString()).toBe("0.25");
	});

	it("returns null when the previous window is zero or missing", () => {
		expect(relativeChange(new Decimal("10"), new Decimal("0"))).toBeNull();
	});
});
