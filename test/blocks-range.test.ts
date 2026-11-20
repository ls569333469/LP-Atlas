import { describe, expect, it } from "vitest";
import { narrowBlockRangeByTime } from "../src/adapters/blocks.ts";

describe("narrowBlockRangeByTime", () => {
	it("seeds a 1-second guess and keeps the range around the target time", () => {
		const latest = { blockNumber: 5_000_000n, timestamp: 1_800_000_000 };
		const targetUnix = 1_800_000_000 - 7200;
		const range = narrowBlockRangeByTime({
			low: 1n,
			high: latest.blockNumber,
			targetUnix,
			latest,
		});
		expect(range.guess).toBe(5_000_000n - 7200n);
		expect(range.low).toBeGreaterThan(1n);
		expect(range.high).toBeLessThan(latest.blockNumber);
		expect(range.low).toBeLessThanOrEqual(range.guess);
		expect(range.guess).toBeLessThanOrEqual(range.high);
	});
});
