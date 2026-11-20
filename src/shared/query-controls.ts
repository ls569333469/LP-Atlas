import Decimal from "decimal.js";
import type { BoardMetricCondition, SortField } from "./types.ts";

export const QUERY_METRICS: ReadonlyArray<{
	field: SortField;
	label: string;
	unit: string;
	scale: number;
	windowed: boolean;
}> = [
	{ field: "feesApr", label: "fees APR", unit: "%", scale: 100, windowed: true },
	{ field: "volume", label: "成交量", unit: "美元", scale: 1, windowed: true },
	{ field: "fees", label: "LP 手续费", unit: "美元", scale: 1, windowed: true },
	{ field: "changeVsPrevWindow", label: "手续费环比", unit: "%", scale: 100, windowed: true },
	{ field: "priceChange", label: "价格涨跌", unit: "%", scale: 100, windowed: true },
	{ field: "capitalEfficiency", label: "资金效率", unit: "倍", scale: 1, windowed: true },
	{ field: "tvl", label: "TVL", unit: "美元", scale: 1, windowed: false },
	{ field: "poolAge", label: "池龄", unit: "小时", scale: 1 / 3600, windowed: false },
];

export function feePercentToPips(input: string): string {
	const raw = input.trim();
	if (!raw) return "";
	if (!/^(?:\d+(?:\.\d{0,4})?|\.\d{1,4})$/.test(raw))
		throw new Error("费率请输入最多4位小数的百分数");
	const value = new Decimal(raw).mul(10000);
	if (value.lt(0) || value.gt(1000000)) throw new Error("池子费率须在0%至100%之间");
	return value.toFixed(0);
}

export function feePipsToInput(input: string): string {
	return /^\d+$/.test(input) && Number(input) <= 1000000
		? new Decimal(input).div(10000).toString()
		: "";
}

export function conditionToDisplay(condition: BoardMetricCondition): string {
	const metric = QUERY_METRICS.find((m) => m.field === condition.field)!;
	return condition.field === "poolAge"
		? new Decimal(condition.value).div(3600).toString()
		: new Decimal(condition.value).mul(metric.scale).toString();
}

export function conditionToValue(field: SortField, value: string): string {
	const metric = QUERY_METRICS.find((m) => m.field === field)!;
	const numeric = new Decimal(value);
	if (!numeric.isFinite()) throw new Error("请输入有效数值");
	const result = (field === "poolAge" ? numeric.mul(3600) : numeric.div(metric.scale)).toFixed();
	if (result.length > 80) throw new Error("筛选数值过长");
	return result;
}
