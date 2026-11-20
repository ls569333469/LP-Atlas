import Decimal from "decimal.js";
import { findChain, findProtocol } from "../shared/catalog.ts";
import { BOARD_SORT_FIELDS, BOARD_WINDOWS } from "../shared/constants.ts";
import type { BoardMetricCondition } from "../shared/types.ts";
import { BoardPageError } from "./board-pages.ts";

type Query = Record<string, string | string[] | undefined>;

/** Validate external multi-select syntax once, then pass canonical sets internally. */
export function parseBoardSelection(query: Query): {
	chains?: string[];
	protocols?: string[];
	includeWindows?: "all";
} {
	const result: { chains?: string[]; protocols?: string[]; includeWindows?: "all" } = {};
	for (const [plural, singular, find] of [
		["chains", "chain", findChain],
		["protocols", "protocol", findProtocol],
	] as const) {
		const raw = query[plural];
		if (raw !== undefined && query[singular] !== undefined)
			throw new BoardPageError(400, `${plural} 与 ${singular} 不能同时提供`);
		if (raw !== undefined) {
			const values = Array.isArray(raw) ? raw : [raw];
			const ids = values.map((value) => {
				const item = find(value);
				if (!item) throw new BoardPageError(400, `未知 ${singular}：${value}`);
				return item.id;
			});
			result[plural] = [...new Set(ids)].sort();
		} else if (query[singular] !== undefined) {
			const value = query[singular];
			if (Array.isArray(value) || !find(value))
				throw new BoardPageError(400, `未知或重复的 ${singular}`);
		}
	}
	if (query.includeWindows !== undefined) {
		if (query.includeWindows !== "all") throw new BoardPageError(400, "includeWindows 只能为 all");
		result.includeWindows = "all";
	}
	return result;
}

/** Validate the additional v2 filters at the HTTP boundary. Values use stored metric units. */
export function parseBoardMetricFilters(query: Query): {
	hideLpRestrictions?: boolean;
	minLpFees1hUsd?: string;
	metricConditions?: BoardMetricCondition[];
} {
	const result: {
		hideLpRestrictions?: boolean;
		minLpFees1hUsd?: string;
		metricConditions?: BoardMetricCondition[];
	} = {};
	if (query.hideLpRestrictions !== undefined) {
		if (query.hideLpRestrictions !== "true" && query.hideLpRestrictions !== "false")
			throw new BoardPageError(400, "参与限制筛选必须为 true 或 false");
		result.hideLpRestrictions = query.hideLpRestrictions === "true";
	}
	const decimal = (raw: unknown): string => {
		if (
			typeof raw !== "string" ||
			raw.length > 80 ||
			!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ||
			!new Decimal(raw).isFinite()
		)
			throw new BoardPageError(400, "筛选数值格式无效");
		return new Decimal(raw).toFixed();
	};
	for (const field of ["minTvlUsd", "minWindowVolumeUsd", "minLpFees1hUsd"] as const) {
		if (query[field] !== undefined) {
			const value = decimal(query[field]);
			if (new Decimal(value).lt(0)) throw new BoardPageError(400, "准入门槛不能小于0");
			if (field === "minLpFees1hUsd") result.minLpFees1hUsd = value;
		}
	}
	if (
		query.feeTierPips !== undefined &&
		(typeof query.feeTierPips !== "string" ||
			!/^\d+$/.test(query.feeTierPips) ||
			!Number.isSafeInteger(Number(query.feeTierPips)) ||
			(Number(query.feeTierPips) > 1000000 && Number(query.feeTierPips) !== 8388608))
	)
		throw new BoardPageError(400, "池子费率格式无效");
	if (query.metricConditions !== undefined) {
		let raw: unknown;
		try {
			if (typeof query.metricConditions !== "string" || query.metricConditions.length > 4000)
				throw new Error();
			raw = JSON.parse(query.metricConditions);
		} catch {
			throw new BoardPageError(400, "组合条件格式无效");
		}
		if (!Array.isArray(raw) || raw.length > 8) throw new BoardPageError(400, "最多8项指标条件");
		const fields = new Set<string>();
		result.metricConditions = raw
			.map((item) => {
				if (
					!item ||
					typeof item !== "object" ||
					!BOARD_SORT_FIELDS.includes(item.field) ||
					fields.has(item.field) ||
					![">", ">=", "<", "<=", "="].includes(item.operator)
				)
					throw new BoardPageError(400, "指标或比较方式无效，同指标仅支持一项条件");
				fields.add(item.field);
				const noWindow = item.field === "tvl" || item.field === "poolAge";
				if (noWindow ? item.window !== null : !BOARD_WINDOWS.some((w) => w.id === item.window))
					throw new BoardPageError(400, "指标窗口无效");
				return {
					field: item.field,
					window: item.window,
					operator: item.operator,
					value: decimal(item.value),
				};
			})
			.sort((a, b) => BOARD_SORT_FIELDS.indexOf(a.field) - BOARD_SORT_FIELDS.indexOf(b.field));
	}
	return result;
}
