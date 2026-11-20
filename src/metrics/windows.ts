import { BOARD_WINDOWS, HOUR_SECONDS } from "../shared/constants.ts";
import type { WindowId } from "../shared/types.ts";

export type HourWindow = {
	startUnix: number;
	endUnix: number;
	complete: boolean;
};

export function alignHourStart(unixSeconds: number): number {
	return Math.floor(unixSeconds / HOUR_SECONDS) * HOUR_SECONDS;
}

export function windowLengthSeconds(windowId: WindowId): number {
	const found = BOARD_WINDOWS.find((window) => window.id === windowId);
	return found?.seconds ?? HOUR_SECONDS;
}

/**
 * Trailing window ending at the current clock-hour end, and the immediately
 * previous equal-length window. Missing constituents must stay empty; callers
 * must not substitute a neighbor window.
 */
export function currentAndPreviousWindows(
	asOfUnix: number,
	windowId: WindowId,
): {
	current: HourWindow;
	previous: HourWindow;
} {
	const length = windowLengthSeconds(windowId);
	const currentHourStart = alignHourStart(asOfUnix);
	const currentEnd = currentHourStart + HOUR_SECONDS;
	const currentStart = currentEnd - length;
	const current: HourWindow = {
		startUnix: currentStart,
		endUnix: currentEnd,
		complete: asOfUnix >= currentEnd,
	};
	const previous: HourWindow = {
		startUnix: currentStart - length,
		endUnix: currentStart,
		complete: true,
	};
	return { current, previous };
}

/**
 * Current (possibly incomplete) hour and the immediately previous complete hour.
 * Missing windows must stay empty; callers must not substitute a neighbor.
 */
export function currentAndPreviousHourWindows(asOfUnix: number): {
	current: HourWindow;
	previous: HourWindow;
} {
	return currentAndPreviousWindows(asOfUnix, "1h");
}

export function findWindow<T extends { startUnix: number }>(
	windows: readonly T[],
	startUnix: number,
): T | undefined {
	return windows.find((window) => window.startUnix === startUnix);
}

export function hourStartsInWindow(startUnix: number, endUnix: number): number[] {
	const starts: number[] = [];
	for (let cursor = startUnix; cursor < endUnix; cursor += HOUR_SECONDS) {
		starts.push(cursor);
	}
	return starts;
}
