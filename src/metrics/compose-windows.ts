import Decimal from "decimal.js";
import { combineFeeStatuses, feeDataUsable } from "../shared/fee-quality.ts";
import { isNativeWindow, type StoredNativeWindow, type StoredWindow } from "../store/types.ts";
import { hourStartsInWindow } from "./windows.ts";

export type ComposeRange = {
	startUnix: number;
	endUnix: number;
	complete: boolean;
};

/**
 * Compose a longer determined window from self-built hourly aggregates.
 * If any constituent hour was not scanned, the composed window is missing
 * and must stay empty — never fill from a neighbor or a shorter window.
 */
export function composeFromHours(
	hours: readonly StoredNativeWindow[],
	range: ComposeRange,
	scannedStarts: ReadonlySet<number>,
	options?: { allowEmpty?: boolean },
): StoredNativeWindow | null;
export function composeFromHours(
	hours: readonly StoredWindow[],
	range: ComposeRange,
	scannedStarts: ReadonlySet<number>,
	options?: { allowEmpty?: boolean },
): StoredWindow | null;

export function composeFromHours(
	hours: readonly StoredWindow[],
	range: ComposeRange,
	scannedStarts: ReadonlySet<number>,
	options?: { allowEmpty?: boolean },
): StoredWindow | null {
	const needed = hourStartsInWindow(range.startUnix, range.endUnix);
	if (needed.length === 0) {
		return null;
	}
	for (const start of needed) {
		if (!scannedStarts.has(start)) {
			return null;
		}
	}
	const byStart = new Map(hours.map((hour) => [hour.windowStart, hour]));
	const parts = needed.map((start) => byStart.get(start) ?? null);
	const present = parts.filter((part): part is StoredWindow => part !== null);
	if (present.length === 0) {
		if (!options?.allowEmpty) {
			return null;
		}
		return {
			poolId: hours[0]?.poolId ?? "",
			windowStart: range.startUnix,
			windowEnd: range.endUnix,
			complete: range.complete,
			volume0: "0",
			volume1: "0",
			lpFees0: "0",
			lpFees1: "0",
			swapCount: 0,
			volumeUsd: "0",
			lpFeesUsd: "0",
			feeStatus: "verified_zero",
			tvlUsd: null,
			sqrtPriceStart: null,
			sqrtPriceEnd: null,
			source: "self_built",
			asOf: "",
			gapReason: null,
		};
	}

	if (present.some((hour) => !isNativeWindow(hour))) {
		// Official pool cumulative samples do not imply a venue's missing pools/hours are zero.
		if (present.some(isNativeWindow) || parts.some((part) => part === null)) return null;
		const observation = present[0]?.sourceObservation;
		if (
			!observation ||
			present.some(
				(hour) =>
					!hour.sourceObservation ||
					hour.sourceObservation.source !== observation.source ||
					hour.sourceObservation.schemaVersion !== observation.schemaVersion,
			)
		)
			return null;
		const sumKnown = (field: "volumeUsd" | "lpFeesUsd") =>
			present.some((hour) => hour[field] === null)
				? null
				: present.reduce((sum, hour) => sum.plus(hour[field] as string), new Decimal(0)).toString();
		const feeStatus = combineFeeStatuses(
			present.map((hour) => hour.feeStatus ?? "legacy_unverified"),
		);
		return {
			poolId: present[0]?.poolId ?? "",
			representation: "official_usd",
			sourceObservation: {
				...observation,
				observedAt:
					present
						.map((hour) => hour.sourceObservation?.observedAt ?? "")
						.sort((a, b) => Date.parse(a) - Date.parse(b))
						.at(-1) ?? observation.observedAt,
				dataCutoff: present.some((hour) => !hour.sourceObservation?.dataCutoff)
					? null
					: (present
							.map((hour) => hour.sourceObservation?.dataCutoff ?? "")
							.sort((a, b) => Date.parse(a) - Date.parse(b))
							.at(-1) ?? null),
				finality: present.every((hour) => hour.sourceObservation?.finality === "finalized")
					? "finalized"
					: "unverified",
				feeAttribution: present.every(
					(hour) => hour.sourceObservation?.feeAttribution === "ordinary_lp_verified",
				)
					? "ordinary_lp_verified"
					: "unverified",
			},
			windowStart: range.startUnix,
			windowEnd: range.endUnix,
			complete: range.complete && present.every((hour) => hour.complete),
			volume0: null,
			volume1: null,
			lpFees0: null,
			lpFees1: null,
			swapCount: null,
			volumeUsd: sumKnown("volumeUsd"),
			lpFeesUsd: feeDataUsable(feeStatus) ? sumKnown("lpFeesUsd") : null,
			tvlUsd: present.at(-1)?.tvlUsd ?? null,
			sqrtPriceStart: null,
			sqrtPriceEnd: null,
			feeStatus,
			source: present[0]?.source ?? "official_index",
			asOf:
				present
					.map((hour) => hour.asOf)
					.sort((a, b) => Date.parse(a) - Date.parse(b))
					.at(-1) ?? "",
			gapReason:
				present
					.map((hour) => hour.gapReason)
					.filter(Boolean)
					.join("；") || null,
		};
	}
	const native = present.filter(isNativeWindow);

	const sumBig = (field: "volume0" | "volume1" | "lpFees0" | "lpFees1"): string =>
		native.reduce((acc, hour) => acc + BigInt(hour[field]), 0n).toString();
	const sumUsd = (field: "volumeUsd" | "lpFeesUsd"): string | null => {
		if (
			native.some(
				(hour) => hour[field] === null && BigInt(hour.volume0) + BigInt(hour.volume1) > 0n,
			)
		) {
			return null;
		}
		let total = new Decimal(0);
		for (const hour of native) {
			if (hour[field] !== null) {
				total = total.plus(hour[field] as string);
			}
		}
		return total.toString();
	};

	const firstWithStart = native[0];
	const lastWithEnd =
		[...native].reverse().find((hour) => hour.sqrtPriceEnd !== null) ?? native.at(-1);
	const tvlUsd = [...native].reverse().find((hour) => hour.tvlUsd !== null)?.tvlUsd ?? null;
	const asOf =
		[...native]
			.map((hour) => hour.asOf)
			.sort()
			.at(-1) ?? "";
	const feeStatus = combineFeeStatuses(native.map((hour) => hour.feeStatus ?? "legacy_unverified"));

	return {
		poolId: native[0]?.poolId ?? "",
		windowStart: range.startUnix,
		windowEnd: range.endUnix,
		complete: range.complete && native.every((hour) => hour.complete),
		volume0: sumBig("volume0"),
		volume1: sumBig("volume1"),
		lpFees0: sumBig("lpFees0"),
		lpFees1: sumBig("lpFees1"),
		swapCount: native.reduce((sum, hour) => sum + hour.swapCount, 0),
		volumeUsd: sumUsd("volumeUsd"),
		lpFeesUsd: feeDataUsable(feeStatus) ? sumUsd("lpFeesUsd") : null,
		feeStatus,
		tvlUsd,
		sqrtPriceStart: firstWithStart?.sqrtPriceStart ?? null,
		sqrtPriceEnd: lastWithEnd?.sqrtPriceEnd ?? null,
		source: native[0]?.source ?? "self_built",
		asOf,
		gapReason:
			[...new Set(native.flatMap((hour) => (hour.gapReason ? [hour.gapReason] : [])))].join("；") ||
			null,
	};
}

export function hoursToFetch(input: {
	neededStarts: readonly number[];
	scannedStarts: ReadonlySet<number>;
	rescanStart?: number;
	maxHours: number;
}): number[] {
	const needed = [...new Set(input.neededStarts)];
	const missing = needed
		.filter((start) => start !== input.rescanStart && !input.scannedStarts.has(start))
		.sort((left, right) => right - left);
	const rescan = input.rescanStart;
	const shouldRescan = rescan !== undefined && needed.includes(rescan);
	const currentAlreadyScanned = shouldRescan && input.scannedStarts.has(rescan);
	const ordered: number[] = [];
	if (shouldRescan && !currentAlreadyScanned) {
		ordered.push(rescan);
	}
	ordered.push(...missing);
	if (shouldRescan && currentAlreadyScanned) {
		ordered.push(rescan);
	}
	return ordered.slice(0, Math.max(0, input.maxHours));
}

export function missingHourCount(
	neededStarts: readonly number[],
	scannedStarts: ReadonlySet<number>,
): number {
	return neededStarts.filter((start) => !scannedStarts.has(start)).length;
}
