import Decimal from "decimal.js";

export const DLMM_FILTERS = {
	baseFee: [
		"基础交易费率",
		"池设置的基础交易收费比例，0.25 表示 0.25%。费用年化使用窗口费用和 TVL。",
		"%",
	],
	binStep: ["分箱步长", "相邻价格分箱的间距，10 bps 等于 0.10%。", "bps"],
	mode: ["费用收取模式", "随输入币按每笔交易的输入币收费；仅 Y 币在两个方向都收池里的 Y 币。"],
	farm: ["农场激励", "Meteora 是否标记有额外的农场奖励。"],
	side: ["筛选范围", "任一侧要求同一代币通过全部代币条件；两侧模式要求两个代币各自通过。"],
	marketCap: ["市值", "所选代币的官方美元市值。", "美元"],
	holders: ["持有人数", "所选代币的官方持有人数。", "人"],
	tokenPrice: ["代币美元价", "所选代币的当前美元价格。", "美元"],
	supply: ["总供应量", "所选代币的总供应量。", "枚"],
	decimals: ["小数位", "代币最小记账单位的小数位数。", "位"],
	verified: ["官方验证", "Meteora 上报的代币验证状态。"],
	freezeDisabled: ["冻结权限已撤销", "按官方记录判断代币冻结权限是否已撤销。"],
	launchpad: ["发射平台", "Meteora 在池资料中返回的发射平台。"],
	blacklisted: ["官方黑名单", "Meteora 在池资料中返回的黑名单状态。"],
	pairType: ["池类型代码", "按 Meteora 返回的整数池类型代码筛选。"],
	protocolFee: ["协议费分成比例", "协议在交易费中的分成比例。", "%"],
	poolPrice: ["当前池价", "每 1 单位 X 币对应的 Y 币数量。", "Y/X"],
	amountX: ["X 币储备数量", "池储备中的 X 币数量。", "枚"],
	amountY: ["Y 币储备数量", "池储备中的 Y 币数量。", "枚"],
	reserveX: ["X 储备账户地址", "X 币储备的 Solana 账户地址，区分大小写。"],
	reserveY: ["Y 储备账户地址", "Y 币储备的 Solana 账户地址，区分大小写。"],
	rewardMint: ["奖励代币 Mint 地址", "匹配任一已配置奖励 Mint，跳过占位地址。"],
	officialWindow: ["官方统计窗口", "用于协议费金额和费用/TVL，默认 1 小时。"],
	protocolFees: ["协议费金额", "所选官方窗口的报告协议费。", "美元"],
	feeTvlRatio: ["费用 / TVL", "所选官方窗口的费用占 TVL 的百分比。", "%"],
	lifetimeVolume: ["累计成交额", "Meteora 返回的累计成交额。", "美元"],
	lifetimeFees: ["累计费用", "Meteora 返回的累计费用。", "美元"],
} as const;

type Key = keyof typeof DLMM_FILTERS;
export type DlmmRangeKey = {
	[K in Key]: (typeof DLMM_FILTERS)[K] extends readonly [string, string, string] ? K : never;
}[Key];
export type DlmmFilters = Partial<
	Record<Exclude<Key, DlmmRangeKey> | `${DlmmRangeKey}Min` | `${DlmmRangeKey}Max`, string>
>;
export const DLMM_OFFICIAL_WINDOWS = ["30m", "1h", "2h", "4h", "12h", "24h"] as const;
export const DLMM_INTEGER_RANGES = ["binStep", "holders", "decimals"];

const choices: Partial<Record<Key, readonly string[]>> = {
	mode: ["0", "1"],
	farm: ["true", "false"],
	verified: ["true", "false"],
	freezeDisabled: ["true", "false"],
	blacklisted: ["true", "false"],
	side: ["x", "y", "either", "both"],
	officialWindow: DLMM_OFFICIAL_WINDOWS,
};

export function parseDlmmFilters(input: string): DlmmFilters {
	if (input.length > 4096) throw new Error("DLMM 筛选条件过长");
	const raw: unknown = JSON.parse(input);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DLMM 筛选条件无效");
	const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
	const result: DlmmFilters = {};
	for (const [key, inputValue] of entries) {
		const field = key.replace(/(?:Min|Max)$/, "") as Key;
		if (!Object.hasOwn(DLMM_FILTERS, field) || typeof inputValue !== "string")
			throw new Error("DLMM 筛选字段无效");
		const range = DLMM_FILTERS[field].length === 3;
		if (range === (field === key)) throw new Error("DLMM 筛选字段无效");
		const value = inputValue.trim();
		if (!value) continue;
		if (value.length > 80) throw new Error("DLMM 筛选数值过长");
		if (range) {
			const integer = DLMM_INTEGER_RANGES.includes(field);
			if (
				!(integer ? /^\d+$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/).test(value) ||
				(field === "binStep" && Number(value) < 1)
			)
				throw new Error(`${DLMM_FILTERS[field][0]}数值无效`);
		} else if (
			(choices[field] && !choices[field]?.includes(value)) ||
			(field === "pairType" && !/^\d+$/.test(value)) ||
			(["reserveX", "reserveY", "rewardMint"].includes(field) &&
				!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
		) {
			throw new Error(`${DLMM_FILTERS[field][0]}条件无效`);
		}
		result[key as keyof DlmmFilters] = value;
	}
	for (const [key, value] of Object.entries(result)) {
		if (!key.endsWith("Min")) continue;
		const max = result[`${key.slice(0, -3)}Max` as keyof DlmmFilters];
		if (value && max && new Decimal(value).gt(max))
			throw new Error("DLMM 筛选的最高值须大于或等于最低值");
	}
	return result;
}

export function countDlmmFilters(filters: DlmmFilters): number {
	return new Set(
		Object.entries(filters)
			.filter(([key, value]) => value && key !== "side" && key !== "officialWindow")
			.map(([key]) => key.replace(/(?:Min|Max)$/, "")),
	).size;
}
