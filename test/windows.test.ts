import { describe, expect, it } from "vitest";
import {
	currentAndPreviousHourWindows,
	currentAndPreviousWindows,
	findWindow,
	hourStartsInWindow,
} from "../src/metrics/windows.ts";
import { HOUR_SECONDS } from "../src/shared/constants.ts";

describe("currentAndPreviousHourWindows", () => {
	it("marks the current hour incomplete before it ends", () => {
		const asOf = 1_700_000_100;
		const expectedStart = Math.floor(asOf / HOUR_SECONDS) * HOUR_SECONDS;
		const { current, previous } = currentAndPreviousHourWindows(asOf);
		expect(current.complete).toBe(false);
		expect(current.startUnix).toBe(expectedStart);
		expect(current.endUnix).toBe(expectedStart + HOUR_SECONDS);
		expect(previous.complete).toBe(true);
		expect(previous.startUnix).toBe(expectedStart - HOUR_SECONDS);
		expect(previous.endUnix).toBe(expectedStart);
	});

	it("does not invent a missing neighbor window", () => {
		const windows = [{ startUnix: 1_700_000_000, feesUsd: "10" }];
		expect(findWindow(windows, 1_700_000_000)?.feesUsd).toBe("10");
		expect(findWindow(windows, 1_699_996_400)).toBeUndefined();
	});
});

describe("currentAndPreviousWindows", () => {
	it("builds equal-length current and previous windows for 2h, 6h, 24h, and 3d", () => {
		const asOf = 1_700_000_100;
		const two = currentAndPreviousWindows(asOf, "2h");
		expect(two.current.endUnix - two.current.startUnix).toBe(7200);
		expect(two.previous.endUnix - two.previous.startUnix).toBe(7200);
		expect(two.previous.endUnix).toBe(two.current.startUnix);
		expect(two.current.complete).toBe(false);

		const day = currentAndPreviousWindows(asOf, "24h");
		expect(day.current.endUnix - day.current.startUnix).toBe(86_400);
		expect(day.previous.startUnix).toBe(day.current.startUnix - 86_400);

		const week = currentAndPreviousWindows(asOf, "3d");
		expect(week.current.endUnix - week.current.startUnix).toBe(3 * 86_400);
	});

	it("lists hour starts without inventing a neighbor hour", () => {
		expect(hourStartsInWindow(100, 7300)).toEqual([100, 3700]);
		expect(findWindow([{ startUnix: 100 }], 3700)).toBeUndefined();
	});
});
