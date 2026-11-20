export const FEE_DATA_STATUSES = [
	"verified_zero",
	"estimated",
	"hook_unresolved",
	"legacy_unverified",
	"protocol_state_missing",
] as const;

export type FeeDataStatus = (typeof FEE_DATA_STATUSES)[number];

export const FEE_DATA_REASONS: Record<FeeDataStatus, string> = {
	verified_zero: "无 Hook、固定 LP 费率为 0；核心交易 LP 手续费为 0，不含外部奖励或主动捐赠。",
	estimated: "按逐笔事件重建的估算值；历史协议费参数及跨 tick 逐步取整尚未精确重放对账。",
	hook_unresolved:
		"Hook 独立收费及最终 LP 分配尚未核验；核心 Swap 费用不能代表完整 LP 收益，未知不按 0 处理。",
	legacy_unverified: "旧 V4 输入币方向解析有误，该小时档尚未重算；手续费与 APR 暂不可用。",
	protocol_state_missing: "协议费状态读取缺失，无法确定归 LP 的金额，未默认协议费为 0。",
};

export function feeDataUsable(status: FeeDataStatus): boolean {
	return status === "verified_zero" || status === "estimated";
}

/** Any unresolved constituent prevents publishing a partial sum as total LP fees. */
export function combineFeeStatuses(statuses: readonly FeeDataStatus[]): FeeDataStatus {
	for (const status of [
		"hook_unresolved",
		"legacy_unverified",
		"protocol_state_missing",
	] as const) {
		if (statuses.includes(status)) return status;
	}
	return statuses.includes("estimated") ? "estimated" : "verified_zero";
}
