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
	matchesBoardVenue,
	rowPassesFilters,
	rowPassesMetricConditions,
	rowPassesValuationFilters,
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
	TokenFdv,
	WindowId,
} from "../shared/types.ts";
import type { AppDatabase } from "../store/db.ts";
import {
	meteoraPriceAt,
	readMeteoraPriceObservations,
} from "../store/meteora-price-observations.ts";
import { listMeteoraMetadata, listPoolWindowsInRange } from "../store/repositories.ts";
import type { StoredWindow } from "../store/types.ts";

function reportedFees(window: StoredWindow | null): Decimal | null {
	if (window?.representation !== "official_usd" || window.reportedFeesUsd == null) return null;
	return new Decimal(window.reportedFeesUsd);
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

function meteoraFdvByMint(metadata: Awaited<ReturnType<typeof listMeteoraMetadata>>) {
	const byMint = new Map<string, { value: TokenFdv; pool: string }>();
	for (const { metadata: pool, asOf } of metadata.values()) {
		for (const token of [pool.tokenX, pool.tokenY]) {
			if (token.address === WRAPPED_SOL_MINT || token.priceUsd === null || token.totalSupply === null)
				continue;
			const price = new Decimal(token.priceUsd);
			const supply = new Decimal(token.totalSupply);
			if (price.lte(0) || supply.lte(0)) continue;
			const existing = byMint.get(token.address);
			if (existing && (asOf < existing.value.priceObservedAt ||
				(asOf === existing.value.priceObservedAt && pool.address >= existing.pool))) continue;
			byMint.set(token.address, {
				pool: pool.address,
				value: {
					fdvUsd: price.times(supply).toFixed(),
					priceObservedAt: asOf,
					supplyObservedAt: asOf,
					source: "meteora",
				},
			});
		}
	}
	return byMint;
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
	const discoveryAsOf = publication?.official_discovery_as_of;
	if (typeof discoveryAsOf !== "string") return { rows: [], rowCountBeforeFilter: 0, windowsMeta };
	const metadata = await listMeteoraMetadata(input.db, discoveryAsOf);
	const rowCountBeforeFilter = metadata.size;
	if (
		!matchesBoardVenue("solana", "meteora_dlmm", input.filters) ||
		input.filters.feeTierPips !== null
	) {
		return { rows: [], rowCountBeforeFilter, windowsMeta };
	}
	const candidates = [...metadata].filter(
		([, { metadata: pool }]) =>
			!input.filters.dlmmFilters || matchesDlmmFilters(pool, input.filters.dlmmFilters),
	);
	const valuations = meteoraFdvByMint(metadata);
	const oneHour = currentAndPreviousWindows(asOfUnix, "1h").current;
	const hourEndMs = oneHour.endUnix * 1000;
	const current = await listPoolWindowsInRange(
		input.db,
		candidates.map(([key]) => key),
		oneHour.startUnix,
		oneHour.endUnix,
	);
	const currentByPool = new Map(current.map((hour) => [hour.poolId, hour]));
	// A single covered hour composes to its own reported volume. Nulls cannot pass admission.
	const admitted = candidates.filter(([key, { metadata: pool }]) => {
		const hour = currentByPool.get(key);
		return (
			hour?.representation === "official_usd" &&
			hour.sourceObservation?.coverage === "reported_hour" &&
			hour.volumeUsd !== null &&
			new Decimal(hour.volumeUsd).gte(input.filters.minWindowVolumeUsd) &&
			new Decimal(pool.currentTvlUsd).gte(input.filters.minTvlUsd)
		);
	});
	const priceTargets = new Set<number>();
	for (const [, { metadata: pool }] of candidates) {
		if (pool.priceObservedAt === undefined) continue;
		priceTargets.add(pool.priceObservedAt);
		priceTargets.add(Math.min(pool.priceObservedAt, hourEndMs));
	}
	if (priceTargets.size) {
		for (const { current } of ranges.values()) priceTargets.add(current.startUnix * 1000);
	}
	const prices = await readMeteoraPriceObservations(input.db, [...priceTargets]).catch(() => null);
	// The 3-day window has no previous-period comparison.
	const start = Math.min(
		...[...ranges].map(([id, range]) =>
			id === "3d" ? range.current.startUnix : range.previous.startUnix,
		),
	);
	const history = await listPoolWindowsInRange(
		input.db,
		admitted.map(([key]) => key),
		start,
		oneHour.startUnix,
	);
	const byPool = new Map<string, typeof history>();
	for (const w of history) {
		const rows = byPool.get(w.poolId) ?? [];
		rows.push(w);
		byPool.set(w.poolId, rows);
	}
	const rows: BoardRow[] = [];
	for (const [key, details] of admitted) {
		const pool = details.metadata;
		const hours = byPool.get(key) ?? [];
		const currentHour = currentByPool.get(key);
		if (currentHour) hours.push(currentHour);
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
			token0Fdv: valuations.get(pool.tokenX.address)?.value ?? null,
			token1Fdv: valuations.get(pool.tokenY.address)?.value ?? null,
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
		if (!rowPassesValuationFilters(row, input.filters)) continue;
		const selected = { ...row, ...metrics[input.sort.window], windows: metrics };
		if (!rowPassesMetricConditions(selected, input.filters.metricConditions ?? [])) continue;
		rows.push(input.allWindows ? selected : { ...row, ...metrics[input.sort.window] });
	}
	return { rows: sortBoardRows(rows, input.sort), rowCountBeforeFilter, windowsMeta };
}
