import { describe, expect, it } from "vitest";
import { rowPassesMetricConditions } from "../src/metrics/filter-sort.ts";
import { parseBoardMetricFilters } from "../src/server/board-query.ts";
import {
	conditionToDisplay,
	conditionToValue,
	feePercentToPips,
	feePipsToInput,
} from "../src/shared/query-controls.ts";
import type { BoardMetricCondition, BoardRow, MetricValue } from "../src/shared/types.ts";

const condition: BoardMetricCondition = {
	field: "feesApr",
	window: "1h",
	operator: ">",
	value: "30",
};
describe("query unit contracts", () => {
	it("converts percentages exactly without rounding extra precision or dynamic flags", () => {
		expect(feePercentToPips("1")).toBe("10000");
		expect(feePercentToPips("0.3")).toBe("3000");
		expect(feePercentToPips("0")).toBe("0");
		expect(feePercentToPips("")).toBe("");
		expect(feePipsToInput("3000")).toBe("0.3");
		expect(feePipsToInput("8388608")).toBe("");
		for (const invalid of ["0.00001", "101", "-1", "Infinity", "1e3"])
			expect(() => feePercentToPips(invalid)).toThrow();
	});
	it("converts APR 3000 percent, fee growth 30 percent and age hours to stored units", () => {
		expect(conditionToValue("feesApr", "3000")).toBe("30");
		expect(conditionToValue("changeVsPrevWindow", "30")).toBe("0.3");
		expect(conditionToValue("poolAge", "1.5")).toBe("5400");
		expect(
			conditionToDisplay({ ...condition, field: "poolAge", window: null, value: "5400" }),
		).toBe("1.5");
		expect(conditionToDisplay(condition)).toBe("3000");
		const tiny = conditionToValue("feesApr", "0.000001");
		expect(tiny).toBe("0.00000001");
		expect(
			parseBoardMetricFilters({ metricConditions: JSON.stringify([{ ...condition, value: tiny }]) })
				.metricConditions?.[0]?.value,
		).toBe(tiny);
		expect(() => conditionToValue("feesApr", "Infinity")).toThrow();
	});
});
describe("v2 filter boundary and AND conditions", () => {
	it("keeps zero and canonicalizes conditions while rejecting malformed or duplicate inputs", () => {
		const raw = {
			minLpFees1hUsd: "0",
			metricConditions: JSON.stringify([
				{ field: "priceChange", window: "2h", operator: "<", value: "0" },
				condition,
			]),
		};
		const parsed = parseBoardMetricFilters(raw);
		expect(parsed.minLpFees1hUsd).toBe("0");
		expect(parsed.metricConditions).toHaveLength(2);
		for (const query of [
			{ metricConditions: "{}" },
			{ minLpFees1hUsd: "-1" },
			{ minLpFees1hUsd: ["10", "20"] },
			{ metricConditions: JSON.stringify([condition, condition]) },
			{ metricConditions: JSON.stringify([{ ...condition, window: "7d" }]) },
			{ metricConditions: JSON.stringify([{ ...condition, field: "poolAge" }]) },
		])
			expect(() => parseBoardMetricFilters(query)).toThrow();
	});
	it("does not use a neighboring window and fails missing values, including comparisons with zero", () => {
		const m = (value: string | null): MetricValue => ({
			value,
			source: "self_built",
			asOf: "2026-11-17T00:00:00Z",
			complete: true,
		});
		const row = {
			tvlUsd: m("1000"),
			windows: {
				"1h": { feesApr: m("31"), priceChange: m("0") },
				"2h": { feesApr: m(null), priceChange: m("-0.1") },
			},
		} as unknown as BoardRow;
		expect(
			rowPassesMetricConditions(row, [
				condition,
				{ field: "priceChange", window: "2h", operator: "<", value: "0" },
			]),
		).toBe(true);
		expect(rowPassesMetricConditions(row, [{ ...condition, window: "2h" }])).toBe(false);
		expect(
			rowPassesMetricConditions(row, [
				{ field: "priceChange", window: "1h", operator: "<", value: "0" },
			]),
		).toBe(false);
		expect(
			rowPassesMetricConditions(row, [
				{ field: "tvl", window: null, operator: ">=", value: "1000" },
			]),
		).toBe(true);
	});
});

it("validates optional confirmed LP restriction filtering", () => {
	expect(parseBoardMetricFilters({}).hideLpRestrictions).toBeUndefined();
	expect(parseBoardMetricFilters({ hideLpRestrictions: "true" }).hideLpRestrictions).toBe(true);
	expect(parseBoardMetricFilters({ hideLpRestrictions: "false" }).hideLpRestrictions).toBe(false);
	expect(() => parseBoardMetricFilters({ hideLpRestrictions: "yes" })).toThrow();
});
