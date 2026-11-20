import { describe, expect, it } from "vitest";
import {
	defaultBoardFilters,
	filterBoardRows,
	parseBoardFilters,
	sortBoardRows,
} from "../src/metrics/filter-sort.ts";
import {
	BOARD_COLUMNS,
	DEFAULT_BOARD_FILTERS,
	DEFAULT_BOARD_SORT,
	METRIC_SOURCE_SELF_BUILT,
} from "../src/shared/constants.ts";
import type { BoardRow, MetricValue } from "../src/shared/types.ts";

const asOf = "2026-11-12T00:00:00.000Z";

function metric(value: string | null, complete = true): MetricValue {
	return { value, source: METRIC_SOURCE_SELF_BUILT, asOf, complete };
}

function row(partial: Partial<BoardRow> & Pick<BoardRow, "poolId">): BoardRow {
	const token = { address: "0x0", symbol: "X", decimals: 18 };
	return {
		chainId: 99901,
		chain: "elysium",
		protocol: "uniswap_v3",
		pairLabel: "A/B",
		token0: { ...token, chainId: 99901 },
		token1: { ...token, chainId: 99901 },
		feeTierPips: 3000,
		feeTierLabel: "0.3%",
		hookType: null,
		tvlUsd: metric("1000"),
		volumeUsd: metric("100"),
		feesUsd: metric("10"),
		feesApr: metric("0.1"),
		changeVsPrevWindow: metric(null),
		priceChange: metric(null),
		capitalEfficiency: metric("0.1"),
		poolAgeSeconds: metric("3600"),
		...partial,
	};
}

describe("filterBoardRows", () => {
	it("admits the exact unrounded 1H LP fee boundary and rejects unknown fees", () => {
		const rows = [
			row({ poolId: "below", feesUsd: metric("9.99999") }),
			row({ poolId: "exact", feesUsd: metric("10") }),
			row({ poolId: "unknown", feesUsd: metric(null) }),
			row({ poolId: "zero", feesUsd: metric("0") }),
		];
		expect(filterBoardRows(rows, defaultBoardFilters()).map((item) => item.poolId)).toEqual([
			"exact",
		]);
	});
	it("uses the shared default thresholds, not a looser hardcoded cut", () => {
		const filters = parseBoardFilters({});
		expect(filters).toEqual(defaultBoardFilters());
		expect(filters.minTvlUsd).toBe(DEFAULT_BOARD_FILTERS.minTvlUsd);
		expect(filters.minWindowVolumeUsd).toBe(DEFAULT_BOARD_FILTERS.minWindowVolumeUsd);
		const rows = [
			row({ poolId: "pass", tvlUsd: metric("1000"), volumeUsd: metric("100") }),
			row({ poolId: "low-tvl", tvlUsd: metric("999.99"), volumeUsd: metric("500") }),
			row({ poolId: "low-vol", tvlUsd: metric("5000"), volumeUsd: metric("99.99") }),
		];
		expect(filterBoardRows(rows, filters).map((item) => item.poolId)).toEqual(["pass"]);
	});

	it("leaves a missing window empty and does not pass the filter from a neighbor", () => {
		const filters = parseBoardFilters({});
		const missingVolume = row({
			poolId: "gap",
			tvlUsd: metric("5000"),
			volumeUsd: metric(null),
			feesApr: metric("9"),
		});
		expect(filterBoardRows([missingVolume], filters)).toEqual([]);
	});

	it("does not apply an APR threshold by default", () => {
		const filters = parseBoardFilters({});
		const lowApr = row({ poolId: "low-apr", feesApr: metric("0") });
		expect(filterBoardRows([lowApr], filters).map((item) => item.poolId)).toEqual(["low-apr"]);
	});
});

describe("sortBoardRows", () => {
	it("defaults to 1h fees APR descending and keeps null APR last", () => {
		expect(DEFAULT_BOARD_SORT).toEqual({ field: "feesApr", window: "1h", direction: "desc" });
		const rows = [
			row({ poolId: "b", feesApr: metric("0.2") }),
			row({ poolId: "gap", feesApr: metric(null) }),
			row({ poolId: "a", feesApr: metric("0.5") }),
			row({ poolId: "c", feesApr: metric("0.2") }),
		];
		expect(sortBoardRows(rows, DEFAULT_BOARD_SORT).map((item) => item.poolId)).toEqual([
			"a",
			"b",
			"c",
			"gap",
		]);
	});

	it("can sort by TVL and pool age", () => {
		const rows = [
			row({ poolId: "older", tvlUsd: metric("2000"), poolAgeSeconds: metric("7200") }),
			row({ poolId: "newer", tvlUsd: metric("8000"), poolAgeSeconds: metric("60") }),
		];
		expect(
			sortBoardRows(rows, { field: "tvl", window: "1h", direction: "desc" }).map(
				(item) => item.poolId,
			),
		).toEqual(["newer", "older"]);
		expect(
			sortBoardRows(rows, { field: "poolAge", window: "1h", direction: "asc" }).map(
				(item) => item.poolId,
			),
		).toEqual(["newer", "older"]);
	});
});

describe("board column definitions", () => {
	it("keeps the first-phase columns in shared constants", () => {
		expect(BOARD_COLUMNS.map((column) => column.label)).toEqual([
			"交易对",
			"费率档",
			"协议",
			"TVL",
			"成交量",
			"手续费",
			"fees APR",
			"相对上一窗口变化",
			"涨跌",
			"资金效率",
			"池龄",
		]);
	});
});

describe("reserved board filters", () => {
	it("filters by chain, protocol, fee tier, and pair search", () => {
		const rows = [
			row({ poolId: "v3", protocol: "uniswap_v3", feeTierPips: 3000, pairLabel: "HYPE/USDC" }),
			row({
				poolId: "v4",
				protocol: "uniswap_v4",
				feeTierPips: 500,
				pairLabel: "WETH/USDC",
				token0: { chainId: 99901, address: "0x0", symbol: "WETH", decimals: 18 },
			}),
		];
		const byProtocol = parseBoardFilters({ protocol: "uniswap_v3" });
		expect(filterBoardRows(rows, byProtocol).map((item) => item.poolId)).toEqual(["v3"]);
		const byFee = parseBoardFilters({ feeTierPips: "500" });
		expect(filterBoardRows(rows, byFee).map((item) => item.poolId)).toEqual(["v4"]);
		const bySearch = parseBoardFilters({ search: "weth" });
		expect(filterBoardRows(rows, bySearch).map((item) => item.poolId)).toEqual(["v4"]);
		const byChain = parseBoardFilters({ chain: "99901" });
		expect(byChain.chain).toBe("elysium");
		expect(filterBoardRows(rows, byChain).map((item) => item.poolId)).toEqual(["v3", "v4"]);
	});
});
