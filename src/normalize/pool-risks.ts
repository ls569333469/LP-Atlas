import type { PoolRiskNotice } from "../shared/types.ts";

export type RiskPool = { chainId: number; protocol: string; poolId: string; hooks: string | null };
export type ReviewedPoolEvidence = {
	chainId: number;
	protocol: string;
	poolId: string;
	hook: string;
	codeVersion: string;
	source: string;
	checkedAt: string;
};
const hook = "0xbef9c77ec3c1a0d92c4cb6264f8923b37a63eae0";
const poolId = "0xa8f330994e5832b499e1c82921846f423a20ba7601fe9b42340715d2f81c8bd0";
const reviewedVersion = "0x905ade489eea8d32391a80a1adbd1577020c3dde60c328e93ba0887af4d3eb53";
// Deployment-reviewed binding, not a live upgrade detector. No RPC in board reads.
const deployedVersions: ReadonlyMap<string, string> = new Map([
	[`4663:uniswap_v4:${poolId}:${hook}`, reviewedVersion],
]);
const reviewed: ReviewedPoolEvidence = {
	chainId: 4663,
	protocol: "uniswap_v4",
	poolId,
	hook,
	codeVersion: reviewedVersion,
	source: `https://sourcify.dev/server/v2/contract/4663/${hook}?fields=sources,abi`,
	checkedAt: "2026-11-16T14:11:28.154Z",
};

export function evaluatePoolRisks(
	pool: RiskPool,
	evidence: ReviewedPoolEvidence = reviewed,
): {
	riskNotices: PoolRiskNotice[];
	feeEntitlementNotice?: string;
} {
	if (pool.protocol !== "uniswap_v4" || !pool.hooks || BigInt(pool.hooks) === 0n)
		return { riskNotices: [] };
	const flags = Number(BigInt(pool.hooks) & 0x3fffn);
	const notices: PoolRiskNotice[] = [];
	const rules = [
		[
			"entry",
			(1 << 11) | (1 << 10),
			"可能有入场限制",
			"Hook 可在添加前后拒绝操作；未验证实际添加通道。",
		],
		[
			"exit",
			(1 << 9) | (1 << 8),
			"可能有撤池风险",
			"Hook 可在撤出前后拒绝操作；未验证实际退出通道。",
		],
		["add_settlement", 1 << 1, "添加结算可能调整", "Hook 可调整添加结算，不代表已确认禁止添加。"],
		[
			"remove_settlement",
			1,
			"撤出结算可能调整",
			"Hook 可调整撤出结算，不代表已确认撤出收费或禁止撤出。",
		],
		["swap_settlement", 12, "交易结算可能调整", "Hook 可调整交易结算，未核实是否实际额外扣费。"],
	] as const;
	for (const [kind, mask, label, description] of rules) {
		if (flags & mask) notices.push({ kind, level: "permission_only", label, description });
	}
	const id = pool.poolId.slice(pool.poolId.lastIndexOf(":") + 1).toLowerCase();
	const key = `${pool.chainId}:${pool.protocol}:${id}:${pool.hooks.toLowerCase()}`;
	const matches =
		evidence.chainId === pool.chainId &&
		evidence.protocol === pool.protocol &&
		evidence.poolId === id &&
		evidence.hook === pool.hooks.toLowerCase() &&
		deployedVersions.get(key) === evidence.codeVersion;
	if (!matches) return { riskNotices: notices };
	for (const notice of notices) {
		if (notice.kind !== "entry" && notice.kind !== "exit") continue;
		notice.level = "verified";
		notice.label = notice.kind === "entry" ? "已确认无法添加" : "已确认无法撤出";
		notice.description =
			notice.kind === "entry"
				? "已核源码：外部添加流动性回调无条件拒绝。"
				: "已核源码：外部撤出流动性回调无条件拒绝。";
		notice.evidence = {
			source: evidence.source,
			checkedAt: evidence.checkedAt,
			codeVersion: evidence.codeVersion,
			scope: "人工核对的池/Hook代码版本；未验证实际操作，不自动追踪升级或动态门控。",
		};
	}
	return { riskNotices: notices, feeEntitlementNotice: "池级费用年化，非外部 LP 可得收益" };
}
