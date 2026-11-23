import Decimal from "decimal.js";
import type { BoardValuationFilters } from "./types.ts";

export const VALUATION_FILTER_KEYS = [
	"minFdvUsd", "maxFdvUsd", "fdvSide", "minTickSpacing", "maxTickSpacing", "minSpacingBps", "maxSpacingBps",
] as const;

export function parseValuationFilters(
	query: Partial<Record<(typeof VALUATION_FILTER_KEYS)[number], string | string[]>>,
): BoardValuationFilters {
	const result: BoardValuationFilters = {};
	for (const field of ["minFdvUsd", "maxFdvUsd"] as const) {
		const raw = query[field];
		if (raw === undefined || raw === "") continue;
		if (typeof raw !== "string" || raw.length > 80 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))
			throw new Error("FDV 必须是非负美元金额");
		result[field] = new Decimal(raw).toFixed();
	}
	if (
		result.minFdvUsd !== undefined && result.maxFdvUsd !== undefined &&
		new Decimal(result.minFdvUsd).gt(result.maxFdvUsd)
	) throw new Error("FDV 最低值不能高于最高值");
	const side = query.fdvSide;
	if (side !== undefined) {
		if (side !== "either" && side !== "token0" && side !== "token1" && side !== "both")
			throw new Error("FDV 代币匹配方式无效");
		if (side !== "either" && (result.minFdvUsd !== undefined || result.maxFdvUsd !== undefined))
			result.fdvSide = side;
	}
	for (const field of ["minTickSpacing", "maxTickSpacing"] as const) {
		const raw = query[field];
		if (raw === undefined || raw === "") continue;
		if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw) || Number(raw) < 1 || Number(raw) > 8388607)
			throw new Error("Uniswap 刻度间距必须是 int24 范围内的正整数");
		result[field] = Number(raw);
	}
	if (
		result.minTickSpacing !== undefined && result.maxTickSpacing !== undefined &&
		result.minTickSpacing > result.maxTickSpacing
	) throw new Error("刻度间距最低值不能高于最高值");
	for (const field of ["minSpacingBps", "maxSpacingBps"] as const) {
		const raw = query[field];
		if (raw === undefined || raw === "") continue;
		if (typeof raw !== "string" || !/^\d{1,12}(?:\.\d{1,4})?$/.test(raw))
			throw new Error("价格档位间距须为非负基点数，最多四位小数");
		result[field] = Number(raw);
	}
	if ((result.minSpacingBps ?? 0) > (result.maxSpacingBps ?? Infinity))
		throw new Error("价格档位间距最低值不能高于最高值");
	return result;
}

export function writeValuationFilters(params: URLSearchParams, filters: BoardValuationFilters): void {
	for (const key of VALUATION_FILTER_KEYS) {
		if (filters[key] !== undefined) params.set(key, String(filters[key]));
	}
}
