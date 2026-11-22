import Decimal from "decimal.js";
import { composeFromHours } from "../metrics/compose-windows.ts";
import {
	rowPassesFilters,
	rowPassesMetricConditions,
	sortBoardRows,
} from "../metrics/filter-sort.ts";
import { currentAndPreviousWindows } from "../metrics/windows.ts";
import { BOARD_WINDOWS } from "../shared/constants.ts";
import type {
	BoardFilters,
	BoardRow,
	BoardSort,
	BoardWindowMeta,
	BoardWindowMetrics,
	MetricValue,
	WindowId,
} from "../shared/types.ts";
import type { AppDatabase } from "../store/db.ts";
import { listMeteoraMetadata, listWindowsInRange } from "../store/repositories.ts";

/** Official rows share the normal query/pagination path; only source-specific normalization differs. */
export async function readMeteoraBoardRows(input: {
	db: Pick<AppDatabase, "execute">;
	asOf: string;
	filters: BoardFilters;
	sort: BoardSort;
	allWindows: boolean;
}) {
	const asOfUnix = Math.floor(Date.parse(input.asOf) / 1000);
	const ranges = new Map(
		BOARD_WINDOWS.map((w) => [w.id, currentAndPreviousWindows(asOfUnix, w.id)]),
	);
	const windowsMeta = Object.fromEntries(
		[...ranges].map(([id, range]) => [
			id,
			{
				windowStart: new Date(range.current.startUnix * 1000).toISOString(),
				windowEnd: new Date(range.current.endUnix * 1000).toISOString(),
				currentHourComplete: false,
			},
		]),
	) as Record<WindowId, BoardWindowMeta>;
	const publication = (
		await input.db.execute(
			"SELECT official_discovery_as_of FROM chain_publications WHERE chain='solana'",
		)
	).rows[0];
	const metadata = await listMeteoraMetadata(input.db);
	const history = await listWindowsInRange(
		input.db,
		asOfUnix - 96 * 3600 - 3600,
		asOfUnix + 3600,
		"solana",
	);
	const byPool = new Map<string, typeof history>();
	for (const w of history) {
		const rows = byPool.get(w.poolId) ?? [];
		rows.push(w);
		byPool.set(w.poolId, rows);
	}
	const rows: BoardRow[] = [];
	let rowCountBeforeFilter = 0;
	for (const [key, details] of metadata) {
		if (details.asOf !== publication?.official_discovery_as_of) continue;
		const pool = details.metadata;
		const hours = byPool.get(key) ?? [];
		const reported = new Set(
			hours
				.filter((w) => w.sourceObservation?.coverage === "reported_hour")
				.map((w) => w.windowStart),
		);
		const metric = (value: string | null, asOf = details.asOf, reason?: string): MetricValue => ({
			value,
			source: "official_index",
			asOf,
			complete: false,
			...(reason ? { reason } : {}),
		});
		const empty = metric(null);
		const feesUnknown = metric(null, details.asOf, "ordinary_lp_unverified");
		const metrics = {} as Record<WindowId, BoardWindowMetrics>;
		for (const [id, range] of ranges) {
			const window = composeFromHours(hours, range.current, reported);
			const volume = window?.volumeUsd ?? null;
			metrics[id] = {
				volumeUsd: metric(volume, window?.asOf ?? details.asOf),
				feesUsd: feesUnknown,
				feesApr: feesUnknown,
				changeVsPrevWindow: feesUnknown,
				priceChange: empty,
				capitalEfficiency: metric(
					volume !== null && new Decimal(pool.currentTvlUsd).gt(0)
						? new Decimal(volume).div(pool.currentTvlUsd).toString()
						: null,
					window?.asOf ?? details.asOf,
				),
			};
		}
		const row: BoardRow = {
			poolId: pool.address,
			chainId: null,
			chain: "solana",
			protocol: "meteora_dlmm",
			pairLabel: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
			token0: {
				address: pool.tokenX.address,
				symbol: pool.tokenX.symbol,
				decimals: pool.tokenX.decimals,
				name: pool.tokenX.name,
				chainId: null,
			},
			token1: {
				address: pool.tokenY.address,
				symbol: pool.tokenY.symbol,
				decimals: pool.tokenY.decimals,
				name: pool.tokenY.name,
				chainId: null,
			},
			feeTierPips: null,
			feeTierLabel: "动态费率",
			hookType: "DLMM",
			tvlUsd: metric(pool.currentTvlUsd),
			poolAgeSeconds: metric(
				pool.createdAtUnix === null ? null : String(Math.max(0, asOfUnix - pool.createdAtUnix)),
			),
			...metrics["1h"],
			officialPool: details,
		};
		rowCountBeforeFilter++;
		if (!rowPassesFilters(row, input.filters, false)) continue;
		const selected = { ...row, ...metrics[input.sort.window], windows: metrics };
		if (!rowPassesMetricConditions(selected, input.filters.metricConditions ?? [])) continue;
		rows.push(input.allWindows ? selected : { ...row, ...metrics[input.sort.window] });
	}
	return { rows: sortBoardRows(rows, input.sort), rowCountBeforeFilter, windowsMeta };
}
