import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { evaluatePoolRisks, type RiskPool } from "../src/normalize/pool-risks.ts";
import type { BoardRow } from "../src/shared/types.ts";

const pool: RiskPool = {
	chainId: 4663,
	protocol: "uniswap_v4",
	poolId: "0xa8f330994e5832b499e1c82921846f423a20ba7601fe9b42340715d2f81c8bd0",
	hooks: "0xbeF9c77eC3c1A0D92c4CB6264F8923B37a63EAE0",
};
const flags = (bits: number[]) =>
	`0x${bits
		.reduce((n, b) => n | (1 << b), 0)
		.toString(16)
		.padStart(40, "0")}`;
it("distinguishes before/after gates from pure settlement and swap callbacks", () => {
	for (const bit of [11, 10])
		expect(
			evaluatePoolRisks({ ...pool, hooks: flags([bit]) }).riskNotices.map((n) => n.kind),
		).toEqual(["entry"]);
	for (const bit of [9, 8])
		expect(
			evaluatePoolRisks({ ...pool, hooks: flags([bit]) }).riskNotices.map((n) => n.kind),
		).toEqual(["exit"]);
	for (const [bit, kind] of [
		[1, "add_settlement"],
		[0, "remove_settlement"],
		[3, "swap_settlement"],
		[2, "swap_settlement"],
	] as const)
		expect(
			evaluatePoolRisks({ ...pool, hooks: flags([bit]) }).riskNotices.map((n) => n.kind),
		).toEqual([kind]);
	expect(evaluatePoolRisks({ ...pool, hooks: flags([13, 7, 5, 4]) }).riskNotices).toEqual([]);
	expect(evaluatePoolRisks({ ...pool, hooks: flags([]) }).riskNotices).toEqual([]);
	expect(evaluatePoolRisks({ ...pool, protocol: "uniswap_v3" }).riskNotices).toEqual([]);
});
it("marks only reviewed pool/version as confirmed, preserving unknown permissions", () => {
	const result = evaluatePoolRisks(pool);
	expect(result.riskNotices.map((n) => [n.kind, n.label, n.level])).toEqual([
		["entry", "已确认无法添加", "verified"],
		["exit", "已确认无法撤出", "verified"],
	]);
	expect(result.feeEntitlementNotice).toContain("非外部 LP");
	for (const changed of [{ chainId: 99901 }, { poolId: "other" }, { hooks: flags([11, 9]) }])
		expect(
			evaluatePoolRisks({ ...pool, ...changed }).riskNotices.every(
				(n) => n.level === "permission_only",
			),
		).toBe(true);
	expect(
		evaluatePoolRisks(pool, {
			...pool,
			hook: String(pool.hooks).toLowerCase(),
			codeVersion: "outdated",
			source: "source",
			checkedAt: "date",
		}).riskNotices.every((n) => n.level === "permission_only"),
	).toBe(true);
});
it("renders static confirmed and possible labels without explanation popovers", async () => {
	const modulePath = "../src/web/src/PoolRiskNotices.tsx";
	const { PoolRiskNotices } = await import(modulePath);
	const html = renderToStaticMarkup(
		createElement(PoolRiskNotices, { row: { ...evaluatePoolRisks(pool) } as BoardRow }),
	);
	expect(html).toContain("LP参与限制");
	expect((html.match(/<span /g) ?? []).length).toBe(1);
	expect(html).not.toContain("<details");
	expect(html).not.toContain("pool-risk-explanation");

	expect(html).not.toContain("已验证源码");
	const unverified = renderToStaticMarkup(
		createElement(PoolRiskNotices, {
			row: { ...evaluatePoolRisks({ ...pool, chainId: 99901 }) } as BoardRow,
		}),
	);
	expect(unverified).toContain("LP参与限制");
	expect(unverified).not.toContain("已确认无法");
});
it("converts each complete batch of 200 admitted pools within 10ms over 20 batches", () => {
	const inputs = Array.from({ length: 200 }, (_, i) => ({
		...pool,
		...(i % 3 === 0 ? {} : { chainId: 99901, hooks: flags([11, 10, 9, 8, 1, 0, 3, 2]) }),
	}));
	for (let i = 0; i < 5; i++) inputs.map((p) => evaluatePoolRisks(p));
	const times = [];
	for (let i = 0; i < 20; i++) {
		const start = performance.now();
		const result = inputs.map((p) => evaluatePoolRisks(p));
		times.push(performance.now() - start);
		expect(result).toHaveLength(200);
	}
	console.log("200-pool risk conversion ms", JSON.stringify(times));
	expect(Math.max(...times)).toBeLessThanOrEqual(10);
});
