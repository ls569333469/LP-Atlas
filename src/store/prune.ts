import { alignHourStart } from "../metrics/windows.ts";
import { HOURLY_RETENTION_SECONDS } from "../shared/constants.ts";
import type { AppDatabase } from "./db.ts";
import { deleteExpiredHourlyRows, latestSuccessfulRefresh } from "./repositories.ts";

export type PruneExpiredHourlyResult = {
	cutoff: number;
	windowsDeleted: number;
	scannedHoursDeleted: number;
	refreshRunsDeleted: number;
	skipped?: boolean;
};

/** Inclusive start of the retained hourly window: floorToHour(asOf) - 4 days. */
export function hourlyRetentionCutoff(asOfUnix: number): number {
	return alignHourStart(asOfUnix) - HOURLY_RETENTION_SECONDS;
}

function isoToUnix(iso: string): number | null {
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Board "now" follows lastSuccess / refresh block_time when available.
 * Prefer that clock so prune cannot delete the retained lookback
 * just because wall time or a failed run's head is later.
 */
export async function resolveRetentionAsOfUnix(
	db: AppDatabase,
	explicit: number | null,
): Promise<number | null> {
	const lastSuccess = await latestSuccessfulRefresh(db);
	const fromSuccess = lastSuccess?.blockTime
		? isoToUnix(lastSuccess.blockTime)
		: lastSuccess?.finishedAt
			? isoToUnix(lastSuccess.finishedAt)
			: null;
	if (fromSuccess != null) {
		return fromSuccess;
	}
	if (explicit != null && Number.isFinite(explicit)) {
		return explicit;
	}
	return null;
}

export async function pruneExpiredHourlyData(
	db: AppDatabase,
	asOfUnix: number,
): Promise<PruneExpiredHourlyResult> {
	const cutoff = hourlyRetentionCutoff(asOfUnix);
	const latestSuccess = await latestSuccessfulRefresh(db);
	const deleted = await deleteExpiredHourlyRows(db, {
		cutoff,
		keepRefreshRunId: latestSuccess?.id ?? null,
	});
	return { cutoff, ...deleted };
}

let pruneInFlight = false;

/** Best-effort hook for the refresh pipeline. Never throws. Skips if re-entrant. */
export async function pruneHourlyCache(
	db: AppDatabase,
	asOfUnix: number | null,
): Promise<PruneExpiredHourlyResult | null> {
	if (pruneInFlight) {
		return {
			cutoff: 0,
			windowsDeleted: 0,
			scannedHoursDeleted: 0,
			refreshRunsDeleted: 0,
			skipped: true,
		};
	}
	pruneInFlight = true;
	try {
		const asOf = await resolveRetentionAsOfUnix(db, asOfUnix);
		if (asOf == null) {
			return null;
		}
		return await pruneExpiredHourlyData(db, asOf);
	} catch {
		return null;
	} finally {
		pruneInFlight = false;
	}
}
