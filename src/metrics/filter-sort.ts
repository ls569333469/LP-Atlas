import Decimal from "decimal.js";
import { findChain, findProtocol } from "../shared/catalog.ts";
import {
	BOARD_SORT_FIELDS,
	BOARD_WINDOWS,
	DEFAULT_BOARD_FILTERS,
	DEFAULT_BOARD_SORT,
} from "../shared/constants.ts";
import { poolIdentity } from "../shared/pool-identity.ts";
import { priceSpacingBps } from "../shared/format.ts";
import type {
	BoardFilters,
	BoardMetricCondition,
	BoardRow,
	BoardSort,
	SortDirection,
	SortField,
	WindowId,
} from "../shared/types.ts";

function metricDecimal(value: string | null): Decimal | null {
	if (value === null) {
		return null;
	}
	const parsed = new Decimal(value);
	return parsed.isFinite() ? parsed : null;
}

function matchesSearch(row: BoardRow, search: string): boolean {
	const needle = search.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	const haystacks = [
		row.pairLabel,
		row.token0.symbol,
		row.token1.symbol,
		row.token0.name ?? "",
		row.token1.name ?? "",
		row.token0.address,
		row.token1.address,
		row.poolId,
	];
	return haystacks.some((value) => value.toLowerCase().includes(needle));
}

export function matchesBoardVenue(
	chain: string,
	protocol: string,
	filters: Pick<BoardFilters, "chain" | "chains" | "protocol" | "protocols">,
): boolean {
	return (
		(!filters.chains?.length || filters.chains.includes(chain)) &&
		(!filters.protocols?.length || filters.protocols.includes(protocol)) &&
		(!filters.chain || chain === filters.chain) &&
		(!filters.protocol || protocol === filters.protocol)
	);
}

/**
 * Rows with missing TVL or window volume cannot be shown as having passed the
 * default thresholds. They are excluded, not filled from a neighbor window.
 */
export function rowPassesFilters(
	row: BoardRow,
	filters: BoardFilters,
	requireLpFees = true,
): boolean {
	if (!matchesBoardVenue(row.chain, row.protocol, filters)) return false;
	if (filters.feeTierPips !== null && row.feeTierPips !== filters.feeTierPips) {
		return false;
	}
	if (filters.search && !matchesSearch(row, filters.search)) {
		return false;
	}
	const tvl = metricDecimal(row.tvlUsd.value);
	const volume = metricDecimal(row.volumeUsd.value);
	const fees = metricDecimal(row.feesUsd.value);
	if (tvl === null || volume === null || (requireLpFees && fees === null)) {
		return false;
	}
	return (
		tvl.gte(filters.minTvlUsd) &&
		volume.gte(filters.minWindowVolumeUsd) &&
		(!requireLpFees ||
			fees?.gte(filters.minLpFees1hUsd ?? DEFAULT_BOARD_FILTERS.minLpFees1hUsd) === true)
	);
}

export function rowPassesValuationFilters(row: BoardRow, filters: BoardFilters): boolean {
	if (filters.minSpacingBps !== undefined || filters.maxSpacingBps !== undefined) {
		const spacing = priceSpacingBps(row);
		if (spacing === null || spacing < (filters.minSpacingBps ?? 0) ||
			spacing > (filters.maxSpacingBps ?? Infinity)) return false;
	}
	if (
		(row.protocol === "uniswap_v3" || row.protocol === "uniswap_v4") &&
		(filters.minTickSpacing !== undefined || filters.maxTickSpacing !== undefined)
	) {
		if (
			row.tickSpacing == null ||
			row.tickSpacing < (filters.minTickSpacing ?? 0) ||
			row.tickSpacing > (filters.maxTickSpacing ?? Number.POSITIVE_INFINITY)
		) return false;
	}
	if (filters.minFdvUsd === undefined && filters.maxFdvUsd === undefined) return true;
	const matches = (value: string | undefined) => {
		const amount = metricDecimal(value ?? null);
		return amount !== null &&
			(filters.minFdvUsd === undefined || amount.gte(filters.minFdvUsd)) &&
			(filters.maxFdvUsd === undefined || amount.lte(filters.maxFdvUsd));
	};
	const first = matches(row.token0Fdv?.fdvUsd);
	const second = matches(row.token1Fdv?.fdvUsd);
	switch (filters.fdvSide) {
		case "token0": return first;
		case "token1": return second;
		case "both": return first && second;
		default: return first || second;
	}
}

export function filterBoardRows(rows: readonly BoardRow[], filters: BoardFilters): BoardRow[] {
	return rows.filter((row) => rowPassesFilters(row, filters) && rowPassesValuationFilters(row, filters));
}

function sortMetric(row: BoardRow, field: SortField): Decimal | null {
	switch (field) {
		case "feesApr":
			return metricDecimal(row.feesApr.value);
		case "tvl":
			return metricDecimal(row.tvlUsd.value);
		case "volume":
			return metricDecimal(row.volumeUsd.value);
		case "fees":
			return metricDecimal(row.feesUsd.value);
		case "changeVsPrevWindow":
			return metricDecimal(row.changeVsPrevWindow.value);
		case "priceChange":
			return metricDecimal(row.priceChange.value);
		case "capitalEfficiency":
			return metricDecimal(row.capitalEfficiency.value);
		case "poolAge":
			return metricDecimal(row.poolAgeSeconds.value);
		default: {
			const _exhaustive: never = field;
			return _exhaustive;
		}
	}
}

export function sortBoardRows(
	rows: readonly BoardRow[],
	sort: BoardSort = DEFAULT_BOARD_SORT,
): BoardRow[] {
	const direction = sort.direction === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = sortMetric(a, sort.field);
		const right = sortMetric(b, sort.field);
		if (left === null && right === null) {
			return poolIdentity(a).localeCompare(poolIdentity(b));
		}
		if (left === null) {
			return 1;
		}
		if (right === null) {
			return -1;
		}
		const compared = left.cmp(right);
		if (compared !== 0) {
			return compared * direction;
		}
		return poolIdentity(a).localeCompare(poolIdentity(b));
	});
}

const EMPTY_FILTERS: Pick<BoardFilters, "chain" | "protocol" | "feeTierPips" | "search"> = {
	chain: null,
	protocol: null,
	feeTierPips: null,
	search: null,
};

export function defaultBoardFilters(): BoardFilters {
	return {
		minTvlUsd: DEFAULT_BOARD_FILTERS.minTvlUsd,
		minWindowVolumeUsd: DEFAULT_BOARD_FILTERS.minWindowVolumeUsd,
		...EMPTY_FILTERS,
	};
}

export function parseBoardFilters(input: {
	hideLpRestrictions?: boolean;
	minLpFees1hUsd?: string;
	metricConditions?: BoardMetricCondition[];
	minTvlUsd?: string;
	minWindowVolumeUsd?: string;
	chain?: string;
	protocol?: string;
	feeTierPips?: string;
	search?: string;
}): BoardFilters {
	const chain = findChain(input.chain);
	const protocol = findProtocol(input.protocol);
	const feeRaw = input.feeTierPips?.trim();
	const feeTierPips =
		feeRaw && /^\d+$/.test(feeRaw) ? Number(feeRaw) : input.feeTierPips ? Number.NaN : null;
	return {
		...(input.minLpFees1hUsd !== undefined ? { minLpFees1hUsd: input.minLpFees1hUsd } : {}),
		...(input.metricConditions ? { metricConditions: input.metricConditions } : {}),
		...(input.hideLpRestrictions ? { hideLpRestrictions: true } : {}),
		minTvlUsd: input.minTvlUsd ?? DEFAULT_BOARD_FILTERS.minTvlUsd,
		minWindowVolumeUsd: input.minWindowVolumeUsd ?? DEFAULT_BOARD_FILTERS.minWindowVolumeUsd,
		chain: input.chain?.trim() ? (chain?.id ?? input.chain.trim().toLowerCase()) : null,
		protocol: input.protocol?.trim() ? (protocol?.id ?? input.protocol.trim()) : null,
		feeTierPips: feeTierPips !== null && Number.isInteger(feeTierPips) ? feeTierPips : null,
		search: input.search?.trim() ? input.search.trim() : null,
	};
}

export function parseWindowId(input: string | undefined): WindowId {
	const match = BOARD_WINDOWS.find((window) => window.id === input);
	return match?.id ?? DEFAULT_BOARD_SORT.window;
}

export function parseBoardSort(input: {
	field?: string;
	direction?: string;
	window?: string;
}): BoardSort {
	const field = BOARD_SORT_FIELDS.includes(input.field as SortField)
		? (input.field as SortField)
		: DEFAULT_BOARD_SORT.field;
	const direction: SortDirection = input.direction === "asc" ? "asc" : DEFAULT_BOARD_SORT.direction;
	return { field, window: parseWindowId(input.window), direction };
}

export function rowPassesMetricConditions(
	row: BoardRow,
	conditions: readonly BoardMetricCondition[],
): boolean {
	return conditions.every((condition) => {
		const source = condition.window ? row.windows?.[condition.window] : row;
		if (!source) return false;
		const key = {
			feesApr: "feesApr",
			volume: "volumeUsd",
			fees: "feesUsd",
			changeVsPrevWindow: "changeVsPrevWindow",
			priceChange: "priceChange",
			capitalEfficiency: "capitalEfficiency",
			tvl: "tvlUsd",
			poolAge: "poolAgeSeconds",
		}[condition.field];
		const value = metricDecimal(
			(source as unknown as Record<string, { value: string | null }>)[key]?.value ?? null,
		);
		if (value === null) return false;
		const compared = value.cmp(condition.value);
		return condition.operator === ">"
			? compared > 0
			: condition.operator === ">="
				? compared >= 0
				: condition.operator === "<"
					? compared < 0
					: condition.operator === "<="
						? compared <= 0
						: compared === 0;
	});
}
