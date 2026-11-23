import Decimal from "decimal.js";
import { composeFromHours } from "../metrics/compose-windows.ts";
import { matchesDlmmFilters } from "../metrics/dlmm-filters.ts";
import {
	annualizeFeesApr,
	capitalEfficiency,
	priceChangeRatio,
	relativeChange,
	windowDurationSeconds,
} from "../metrics/fees-apr.ts";
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
import {
	meteoraPriceAt,
	readMeteoraPriceObservations,
} from "../store/meteora-price-observations.ts";
import { listMeteoraMetadata, listWindowsInRange } from "../store/repositories.ts";
import type { StoredWindow } from "../store/types.ts";

function reportedFees(window: StoredWindow | null): Decimal | null {
	if (window?.representation !== "official_usd" || window.reportedFeesUsd == null) return null;
	return new Decimal(window.reportedFeesUsd);
}

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
	const hourEndMs = currentAndPreviousWindows(asOfUnix, "1h").current.endUnix * 1000;
	const priceTargets = new Set<number>();
	for (const { metadata: pool, asOf } of metadata.values()) {
		if (asOf !== publication?.official_discovery_as_of || pool.priceObservedAt === undefined)
			continue;
		priceTargets.add(pool.priceObservedAt);
		priceTargets.add(Math.min(pool.priceObservedAt, hourEndMs));
	}
	if (priceTargets.size) {
		for (const { current } of ranges.values()) priceTargets.add(current.startUnix * 1000);
	}
	const prices = await readMeteoraPriceObservations(input.db, [...priceTargets]).catch(() => null);
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
		rowCountBeforeFilter++;
		if (input.filters.dlmmFilters && !matchesDlmmFilters(pool, input.filters.dlmmFilters)) continue;
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
		const poolPrices = prices?.get(key) ?? [];
		const priceEnd =
			pool.priceObservedAt !== undefined &&
			poolPrices.some((sample) => sample.observedAt === pool.priceObservedAt)
				? meteoraPriceAt(poolPrices, Math.min(pool.priceObservedAt, hourEndMs), pool)
				: undefined;
		const feeMetric = (value: Decimal | null, asOf: string, reason?: string): MetricValue => ({
			...metric(value?.toString() ?? null, asOf, reason),
			feeBasis: "reported_fees",
		});
		const tvl = new Decimal(pool.currentTvlUsd);
		const metrics = {} as Record<WindowId, BoardWindowMetrics>;
		for (const [id, range] of ranges) {
			const window = composeFromHours(hours, range.current, reported);
			const volume = window?.volumeUsd ?? null;
			const asOf = window?.asOf ?? details.asOf;
			const total = reportedFees(window);
			const previous = id === "3d" ? null : composeFromHours(hours, range.previous, reported);
			const previousTotal = reportedFees(previous);
			const apr =
				total === null
					? null
					: annualizeFeesApr({
							lpFeesUsd: total,
							tvlUsd: tvl,
							windowDurationSeconds: windowDurationSeconds({
								windowStartUnix: range.current.startUnix,
								windowEndUnix: range.current.endUnix,
								asOfUnix,
								complete: false,
							}),
						});
			const priceStart =
				priceEnd && meteoraPriceAt(poolPrices, range.current.startUnix * 1000, pool);
			const priceChange =
				priceStart && priceEnd && priceEnd.observedAt > priceStart.observedAt
					? priceChangeRatio(new Decimal(priceStart.price), new Decimal(priceEnd.price))
					: null;
			metrics[id] = {
				volumeUsd: metric(volume, window?.asOf ?? details.asOf),
				feesUsd: feeMetric(total, asOf),
				feesApr: feeMetric(apr, asOf),
				changeVsPrevWindow: feeMetric(
					total !== null && previousTotal !== null ? relativeChange(total, previousTotal) : null,
					asOf,
					previousTotal?.isZero() ? "previous_zero" : undefined,
				),
				priceChange:
					priceChange && priceEnd
						? metric(
								priceChange.toString(),
								new Date(priceEnd.observedAt).toISOString(),
								"meteora_sampled_pool_price",
							)
						: empty,
				capitalEfficiency: metric(
					volume !== null
						? (capitalEfficiency(new Decimal(volume), tvl)?.toString() ?? null)
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
		if (!rowPassesFilters(row, input.filters, false)) continue;
		const selected = { ...row, ...metrics[input.sort.window], windows: metrics };
		if (!rowPassesMetricConditions(selected, input.filters.metricConditions ?? [])) continue;
		rows.push(input.allWindows ? selected : { ...row, ...metrics[input.sort.window] });
	}
	return { rows: sortBoardRows(rows, input.sort), rowCountBeforeFilter, windowsMeta };
}
