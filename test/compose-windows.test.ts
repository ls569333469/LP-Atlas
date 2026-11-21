import { createPublicClient, custom } from "viem";
import { describe, expect, it } from "vitest";
import {
	composeFromHours,
	hoursToFetch,
	missingHourCount,
} from "../src/metrics/compose-windows.ts";
import { currentAndPreviousWindows, hourStartsInWindow } from "../src/metrics/windows.ts";
import {
	lookbackHourStarts,
	resolveOneHour,
	selectRefreshHours,
} from "../src/normalize/refresh-hours.ts";
import { METRIC_SOURCE_SELF_BUILT } from "../src/shared/constants.ts";
import type { StoredNativeWindow as StoredWindow } from "../src/store/types.ts";

function hour(
	partial: Partial<StoredWindow> & Pick<StoredWindow, "windowStart" | "windowEnd">,
): StoredWindow {
	return {
		poolId: "pool-a",
		complete: true,
		volume0: "0",
		volume1: "0",
		lpFees0: "0",
		lpFees1: "0",
		swapCount: 0,
		volumeUsd: "0",
		lpFeesUsd: "0",
		feeStatus: "estimated",
		tvlUsd: "1000",
		sqrtPriceStart: null,
		sqrtPriceEnd: null,
		source: METRIC_SOURCE_SELF_BUILT,
		asOf: "2026-11-12T01:00:00.000Z",
		gapReason: null,
		...partial,
	};
}

describe("composeFromHours", () => {
	it("does not publish known hours as total fees when one hour has unresolved fees", () => {
		const rows = [
			hour({ windowStart: 0, windowEnd: 3600, lpFeesUsd: "5" }),
			hour({ windowStart: 3600, windowEnd: 7200, lpFeesUsd: "0", feeStatus: "hook_unresolved" }),
		];
		const result = composeFromHours(
			rows,
			{ startUnix: 0, endUnix: 7200, complete: true },
			new Set([0, 3600]),
		);
		expect(result?.feeStatus).toBe("hook_unresolved");
		expect(result?.lpFeesUsd).toBeNull();
		expect(result?.volumeUsd).toBe("0");
	});
	it("sums two adjacent hours for a 2h window and compares with the previous equal window", () => {
		const asOf = 1_700_003_600;
		const { current, previous } = currentAndPreviousWindows(asOf, "2h");
		expect(current.endUnix - current.startUnix).toBe(7200);
		const scanned = new Set(hourStartsInWindow(previous.startUnix, current.endUnix));
		const rows = hourStartsInWindow(previous.startUnix, current.endUnix).map((start, index) =>
			hour({
				windowStart: start,
				windowEnd: start + 3600,
				volumeUsd: String(10 * (index + 1)),
				lpFeesUsd: String(index + 1),
				swapCount: index + 1,
			}),
		);
		const currentWindow = composeFromHours(rows, current, scanned);
		const previousWindow = composeFromHours(rows, previous, scanned);
		expect(currentWindow?.volumeUsd).toBe("70");
		expect(previousWindow?.volumeUsd).toBe("30");
		expect(currentWindow?.lpFeesUsd).toBe("7");
	});

	it("composes 3d from 72 hours and keeps a missing previous period separate", () => {
		const { current, previous } = currentAndPreviousWindows(1_700_003_600, "3d");
		const starts = hourStartsInWindow(current.startUnix, current.endUnix);
		expect(starts).toHaveLength(72);
		const rows = starts.map((start) =>
			hour({
				windowStart: start,
				windowEnd: start + 3600,
				volumeUsd: "100",
				lpFeesUsd: "10",
			}),
		);
		const scanned = new Set(starts);
		expect(composeFromHours(rows, current, scanned)).toMatchObject({
			volumeUsd: "7200",
			lpFeesUsd: "720",
		});
		expect(composeFromHours(rows, previous, scanned, { allowEmpty: true })).toBeNull();
		scanned.delete(starts[10] as number);
		expect(composeFromHours(rows, current, scanned)).toBeNull();
	});

	it("returns a zero previous window when hours were scanned but the pool had no trades", () => {
		const asOf = 1_700_003_600;
		const { current, previous } = currentAndPreviousWindows(asOf, "1h");
		const scanned = new Set(hourStartsInWindow(previous.startUnix, current.endUnix));
		const onlyCurrent = hour({
			windowStart: current.startUnix,
			windowEnd: current.endUnix,
			volumeUsd: "100",
			lpFeesUsd: "2",
			swapCount: 3,
		});
		expect(composeFromHours([onlyCurrent], previous, scanned)).toBeNull();
		const emptyPrevious = composeFromHours([onlyCurrent], previous, scanned, { allowEmpty: true });
		expect(emptyPrevious?.lpFeesUsd).toBe("0");
		expect(emptyPrevious?.volumeUsd).toBe("0");
		expect(emptyPrevious?.complete).toBe(true);
		expect(
			composeFromHours([onlyCurrent], previous, new Set([current.startUnix]), { allowEmpty: true }),
		).toBeNull();
	});

	it("leaves a 24h window empty when any constituent hour is missing, and does not use the 1h value", () => {
		const asOf = 1_700_003_600;
		const { current } = currentAndPreviousWindows(asOf, "24h");
		const onlyLatest = hour({
			windowStart: current.endUnix - 3600,
			windowEnd: current.endUnix,
			volumeUsd: "999",
			lpFeesUsd: "9",
		});
		const scanned = new Set([onlyLatest.windowStart]);
		expect(composeFromHours([onlyLatest], current, scanned)).toBeNull();
		expect(missingHourCount(hourStartsInWindow(current.startUnix, current.endUnix), scanned)).toBe(
			23,
		);
	});
});

describe("hoursToFetch and selectRefreshHours", () => {
	it("fills uncovered hours before repairing covered history while keeping hour closeout and current first", () => {
		const current = 1_800_000_000;
		const covered = new Set(Array.from({ length: 50 }, (_, i) => current - i * 3600));
		const repaired = new Set(Array.from({ length: 22 }, (_, i) => current - i * 3600));
		expect(
			selectRefreshHours({
				asOfUnix: current + 600,
				scannedStarts: repaired,
				coveredStarts: covered,
				maxHours: 8,
			}),
		).toEqual([current, ...Array.from({ length: 7 }, (_, i) => current - (50 + i) * 3600)]);
		repaired.delete(current - 3600);
		expect(
			selectRefreshHours({
				asOfUnix: current + 600,
				scannedStarts: repaired,
				coveredStarts: covered,
				maxHours: 3,
				unfinishedStarts: new Set([current - 3600]),
			}),
		).toEqual([current - 3600, current, current - 50 * 3600]);
	});

	it("fetches only required 72 hourly archives while retention stays independent", () => {
		const current = 1_800_000_000;
		const range = lookbackHourStarts(current + 600);
		expect(range.starts).toHaveLength(72);
		expect(range.starts[0]).toBe(current - 71 * 3600);
		expect(range.starts.at(-1)).toBe(current);
		const done = new Set(range.starts);
		expect(
			selectRefreshHours({
				asOfUnix: current + 600,
				scannedStarts: done,
				coveredStarts: done,
				maxHours: 8,
			}),
		).toEqual([current]);
	});

	it("repairs the visible 3d before filling older retained hours", () => {
		const current = 1_800_000_000;
		const covered = new Set(Array.from({ length: 72 }, (_, i) => current - i * 3600));
		const repaired = new Set(covered);
		repaired.delete(current - 30 * 3600);
		expect(
			selectRefreshHours({
				asOfUnix: current + 600,
				scannedStarts: repaired,
				coveredStarts: covered,
				maxHours: 3,
			}),
		).toEqual([current, current - 30 * 3600]);
		covered.delete(current - 71 * 3600);
		repaired.delete(current - 71 * 3600);
		expect(
			selectRefreshHours({
				asOfUnix: current + 600,
				scannedStarts: repaired,
				coveredStarts: covered,
				maxHours: 3,
			}),
		).toEqual([current, current - 71 * 3600, current - 30 * 3600]);
	});

	it("reuses adjacent completed-hour boundaries and never freezes the current hour", async () => {
		const client = createPublicClient({
			transport: custom({
				request: async () => {
					throw new Error("unexpected RPC");
				},
			}),
		});
		expect(
			await resolveOneHour({
				client,
				head: { blockNumber: 500n, timestamp: 7300 },
				startUnix: 3600,
				previousBounds: { toBlock: "99", complete: true },
				nextBounds: { fromBlock: "200" },
			}),
		).toEqual({ startUnix: 3600, endUnix: 7200, complete: true, fromBlock: 100n, toBlock: 199n });
		expect(
			await resolveOneHour({
				client,
				head: { blockNumber: 500n, timestamp: 7300 },
				startUnix: 7200,
				previousBounds: { toBlock: "199", complete: true },
				nextBounds: { fromBlock: "999" },
			}),
		).toMatchObject({ fromBlock: 200n, toBlock: 500n, complete: false });
	});
	it("reuses persisted hour boundaries without repeating historical block searches", async () => {
		const client = createPublicClient({
			transport: custom({
				request: async () => {
					throw new Error("unexpected RPC");
				},
			}),
		});
		expect(
			await resolveOneHour({
				client,
				head: { blockNumber: 500n, timestamp: 7300 },
				startUnix: 0,
				knownBounds: { fromBlock: "10", toBlock: "99", complete: true },
			}),
		).toEqual({ startUnix: 0, endUnix: 3600, complete: true, fromBlock: 10n, toBlock: 99n });
		expect(
			await resolveOneHour({
				client,
				head: { blockNumber: 500n, timestamp: 7300 },
				startUnix: 7200,
				knownBounds: { fromBlock: "490", toBlock: "495", complete: false },
			}),
		).toMatchObject({ fromBlock: 490n, toBlock: 500n, complete: false });
	});
	it("rescans the current hour and prefers recent missing hours, staying within the cap", () => {
		const asOf = 1_700_003_100;
		const currentStart = Math.floor(asOf / 3600) * 3600;
		const scanned = new Set([currentStart - 3600, currentStart - 7200]);
		const selected = hoursToFetch({
			neededStarts: [currentStart - 7200, currentStart - 3600, currentStart],
			scannedStarts: scanned,
			rescanStart: currentStart,
			maxHours: 2,
		});
		expect(selected).toEqual([currentStart]);
		const more = selectRefreshHours({ asOfUnix: asOf, scannedStarts: new Set(), maxHours: 3 });
		expect(more).toHaveLength(3);
		expect(more[0]).toBe(currentStart);
		expect(more[1]).toBe(currentStart - 3600);
		expect(
			selectRefreshHours({ asOfUnix: asOf, scannedStarts: new Set([currentStart]), maxHours: 2 }),
		).toEqual([currentStart, currentStart - 3600]);

		const backfill = hoursToFetch({
			neededStarts: [currentStart - 10_800, currentStart - 7200, currentStart - 3600, currentStart],
			scannedStarts: new Set([currentStart]),
			rescanStart: currentStart,
			maxHours: 2,
		});
		expect(backfill).toEqual([currentStart - 3600, currentStart - 7200]);
	});
});
