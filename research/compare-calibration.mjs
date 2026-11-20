import assert from "node:assert/strict";
import fs from "node:fs";
import Decimal from "decimal.js";
import { EFFICIENCY_BOOKS, efficiencySignals } from "./efficiency.ts";
import { inventory, ResearchEngine } from "./engine.ts";

const root = "outputs/signal-research",
	dir = `${root}/wallet-calibration`;
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const baseline = load(`${dir}/integration-baseline.json`);
const original = load(`${root}/dataset.json`),
	revised = load(`${root}/dataset-growth.json`);
const event = load(`${dir}/event-growth-dataset.json`),
	audit = load(`${dir}/usd-audit.json`).hours;
const wallet = load(`${dir}/wallet-audit.json`),
	boundaries = load(`${dir}/wallet-boundaries.json`).snapshots;
const comparisons = {};
const key = (r) =>
	JSON.stringify([r.book, r.scenario.capital, r.scenario.delay, r.poolId, r.signalTime]);
for (const profile of ["lifecycle", "efficiency"]) {
	const old = baseline[profile],
		current = load(`${root}/${profile}/results.json`);
	const extended = load(`${dir}/event-${profile}/results.json`);
	assert.deepEqual(current.books, extended.books, "Same strategy definitions across periods");
	assert.equal(current.data.start, old.data.start);
	assert.equal(current.data.end, old.data.end);
	assert.equal(current.calibration.personalPnl, null);
	const comparableOld = old.pairs.filter((r) => r.scenario.capture === 0.5);
	const oldRows = new Map(comparableOld.map((r) => [key(r), r]));
	let changed = 0,
		added = 0;
	for (const p of current.pairs) {
		const n = p.dynamic,
			o = oldRows.get(key({ ...p, poolId: n.poolId, signalTime: n.signalTime }));
		if (!o) {
			added++;
			continue;
		}
		if (
			[
				"entryTime",
				"exitTime",
				"lower",
				"upper",
				"status",
				"reason",
				"inventoryPnl",
				"feeProxy",
			].some((k) => o[k] !== n[k])
		)
			changed++;
	}
	const summaries = current.summaries.map((n) => {
		const o = old.summaries.find(
			(s) =>
				s.book === n.book &&
				s.capital === n.capital &&
				s.delay === n.delay &&
				s.capture === 0.5 &&
				s.half === n.half,
		);
		return {
			book: n.book,
			capital: n.capital,
			delay: n.delay,
			capture: n.capture,
			half: n.half,
			oldMean: o?.mean ?? null,
			newMean: n.mean,
			oldAttempts: o?.attempts ?? null,
			newAttempts: n.attempts,
		};
	});
	for (const p of extended.pairs) {
		assert(p.dynamic.signalTime <= p.dynamic.entryTime);
		if (p.dynamic.exitTime) assert(p.dynamic.exitTime <= event.end);
		assert(p.dynamic.entryTime >= event.start);
	}
	const defaultCapital = profile === "efficiency" ? "200" : "1000";
	const selected = extended.accounts.filter(
		(a) =>
			a.scenario.capital === defaultCapital &&
			a.scenario.delay === 0 &&
			a.scenario.capture === 1 &&
			a.mode === "withdraw",
	);
	comparisons[profile] = {
		oldPairs: comparableOld.length,
		newPairs: current.pairs.length,
		changed,
		added,
		removed: comparableOld.length - (current.pairs.length - added),
		summaries,
		event: {
			observations: extended.data.observations,
			pairs: extended.pairs.length,
			positiveDefaultAccounts: selected.filter(
				(a) => a.finalEquity !== null && Number(a.finalEquity) > Number(a.scenario.capital),
			).length,
			bestDefault: selected
				.filter((a) => a.finalEquity !== null)
				.sort((a, b) => Number(b.finalEquity) - Number(a.finalEquity))[0],
		},
	};
}
// The same inventory function used by both runners must reproduce actual on-chain principal.
const pool1 = event.pools.find((p) => p.feePips === 10000).poolId;
const pool2 = event.pools.find((p) => p.feePips === 8000).poolId;
const actual = wallet.snapshots.map((s) => ({ ...s, poolId: pool1, h: s.lpH, k: s.lpK }));
for (const s of boundaries) {
	const h = audit.find((h) => h.windowStart + 3600 === s.signalBoundary);
	assert.equal(h.atBlock, s.blockNumber, "Wallet and price state must be the same block");
	const poolId = s.fee === 10000 ? pool1 : pool2;
	actual.push({ ...s.position, poolId, block: s.blockNumber, sqrt: h.states[poolId].sqrtPriceX96 });
}
const principalChecks = actual.map((s) => {
	const price = new Decimal(2).pow(192).div(new Decimal(s.sqrt).pow(2));
	const lower = new Decimal(1).div(new Decimal("1.0001").pow(s.upper));
	const upper = new Decimal(1).div(new Decimal("1.0001").pow(s.lower));
	const amounts = inventory(price, lower, upper, new Decimal(s.liquidity).div("1e18"));
	const hypeError = amounts.quote.minus(new Decimal(s.h).div("1e18")).abs();
	const kntqError = amounts.base.minus(new Decimal(s.k).div("1e18")).abs();
	assert(
		hypeError.lt("1e-12") && kntqError.lt("1e-10"),
		"Inventory formula must match actual NFT principal",
	);
	return {
		block: s.block,
		nft: s.nft ?? s.id,
		poolId: s.poolId,
		hypeError: hypeError.toString(),
		kntqError: kntqError.toString(),
	};
});
const engine = new ResearchEngine(event),
	signals = engine.signals();
const efficient = efficiencySignals(engine).filter((s) => EFFICIENCY_BOOKS.some((b) => b.test(s)));
const date = (t) =>
	new Date(t * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const beforeExplosion = signals.filter((s) => s.start + 3600 <= 1794270894);
const nearEvent = signals.filter(
	(s) => s.start + 3600 >= 1794268800 && s.start + 3600 <= 1794283200,
);
const sameEngine = new ResearchEngine(revised),
	oldEngine = new ResearchEngine(original);
const signalKey = (s) => `${s.poolId}:${s.start}:${s.strategies.join(",")}`;
const oldSignalKeys = oldEngine.signals().map(signalKey),
	newSignalKeys = sameEngine.signals().map(signalKey);
const replacements = load(`${dir}/input-replacements.json`);
const result = {
	comparisons,
	principalChecks,
	personalFeesCalibrated: false,
	actualFeeFormulaVerified: true,
	feeReplay: load(`${dir}/position-fee-replay.json`),
	personalPnl: null,
	signalSetsUnchanged: JSON.stringify(oldSignalKeys) === JSON.stringify(newSignalKeys),
	replacedTotal: replacements.length,
	replacedWithinTest: replacements.filter((r) => r.hour >= original.start && r.hour < original.end)
		.length,
	event: {
		start: event.start,
		end: event.end,
		hoursPerPool: (event.end - event.start) / 3600,
		signals: signals.length,
		efficiencySignals: efficient.length,
		beforeUserEntry: beforeExplosion.length,
		nearEvent: nearEvent.map((s) => ({
			poolId: s.poolId,
			time: s.start + 3600,
			features: s.features,
			strategies: s.strategies,
		})),
	},
};
fs.writeFileSync(`${dir}/integration-results.json`, JSON.stringify(result, null, 2));
const evidence = load(`${dir}/position-fee-hours.json`);
result.coverage = {
	total: evidence.hours.length,
	usable: evidence.hours.filter((h) => h.status === "usable").length,
	reasons: Object.fromEntries(
		[...new Set(evidence.hours.map((h) => h.reason).filter(Boolean))].map((reason) => [
			reason,
			evidence.hours.filter((h) => h.reason === reason).length,
		]),
	),
};
const accountStats = (rows) => ({
	total: rows.length,
	noTrade: rows.filter((a) => a.trades.length === 0).length,
	settled: rows.filter((a) => a.finalEquity !== null).length,
	positive: rows.filter(
		(a) => a.finalEquity !== null && Number(a.finalEquity) > Number(a.scenario.capital),
	).length,
	best:
		rows
			.filter((a) => a.finalEquity !== null)
			.sort(
				(a, b) =>
					Number(b.finalEquity) -
					Number(b.scenario.capital) -
					(Number(a.finalEquity) - Number(a.scenario.capital)),
			)[0] ?? null,
});
let report = `# 两日历史信号与 LP 策略实验：手续费算法修正版

实盘记录用于校验实验算法。真实70笔交易、11次流动性修改的手续费按共享feeGrowth公式重放一致；不把个人钱包收益直接套给其他池或策略。

原48H：${date(original.start)}—${date(original.end)}。双池事件期：${date(event.start)}—${date(event.end)}，与原测试分开。

旧默认模型为本金/TVL×全池费用×50%；新模型为区间feeGrowth增量×假设仓位流动性/Q128，按token取整，无固定折扣。出区间前产生的费用保留。新旧改变的是费用来源，不能把差额归因于策略变好。

本金公式${principalChecks.length}个真实NFT检查点吻合。历史区间证据${result.coverage.usable}/${result.coverage.total}条可用，其他原因见JSON。新资金不改变历史市场路径是模型假设；成本仍为往返50bps+$1，不是实测。

|研究与范围|默认本金|入场尝试|可计算|未知|跳过|未到期|出利账户可结算/总数|其中正模型净额|空仓账户|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
`;
result.runs = {};
for (const profile of ["lifecycle", "efficiency"]) {
	for (const [period, path] of [
		["原48H", `${root}/${profile}/results.json`],
		["事件期", `${dir}/event-${profile}/results.json`],
	]) {
		const r = load(path),
			capital = profile === "efficiency" ? "200" : "1000";
		assert.equal(r.calibration.actualFeeFormulaVerified, true);
		const sums = r.summaries.filter(
			(s) => s.capital === capital && s.delay === 0 && s.capture === 1 && s.half === "all",
		);
		const accounts = r.accounts.filter(
			(a) =>
				a.scenario.capital === capital &&
				a.scenario.delay === 0 &&
				a.scenario.capture === 1 &&
				a.mode === "withdraw",
		);
		const stats = accountStats(accounts);
		const total = (k) => sums.reduce((n, s) => n + (s[k] ?? 0), 0);
		result.runs[`${profile}-${period}`] = { summaries: sums, accounts: stats };
		report += `|${profile} ${period}|$${capital}|${total("attempts")}|${total("modeled")}|${total("unknown")}|${total("skipped")}|${total("censored")}|${stats.settled}/${stats.total}|${stats.positive}|${stats.noTrade}|\n`;
	}
}
report +=
	"\n## 原48H默认出利的正模型净额配置\n\n|研究|策略|本金|完整交易数|模型净额|\n|---|---|---:|---:|---:|\n";
for (const profile of ["lifecycle", "efficiency"]) {
	const r = load(`${root}/${profile}/results.json`),
		capital = profile === "efficiency" ? "200" : "1000";
	for (const a of r.accounts.filter(
		(a) =>
			a.scenario.capital === capital &&
			a.scenario.delay === 0 &&
			a.mode === "withdraw" &&
			a.finalEquity !== null &&
			Number(a.finalEquity) > Number(capital),
	))
		report += `|${profile}|${r.books.find((b) => b.id === a.book).name}|$${capital}|${a.trades.length}|+$${(Number(a.finalEquity) - Number(capital)).toFixed(2)}|\n`;
}
report += "\n4H/6H/12H横盘配置实际退出路径相同，不能算三份独立证据。空仓账户不代表策略交易通过。\n";
report += `
未知不能按亏损算；可算交易也不能代替未结算完整账户。配置共用样本，不是独立交易。原规则仍可能漏报：10日08点1%池效率约0.38低于1，09点涨幅约13.41%超过原涨幅上限。本轮不为追求盈利倒调入场、区间或退出阈值。

区间未初始化、小时内清零或缺读取证据时不能精确沿用历史feeGrowth，保留未知。完整个人钱包净利润的资金流与执行成本仍未核实，不妨碍实盘费用公式的独立校验。其他池美元输入仅沿用原冻结值，未声称全部已重估。

入口：[原48H完整策略](../lifecycle/) · [原48H效率波动](../efficiency/) · [事件期完整策略](event-lifecycle/) · [事件期效率波动](event-efficiency/)。逐策略和逐笔结果在各页，切换本金/延迟时分别查看。

复跑：run-lifecycle.ts使用dataset-growth.json；效率轮增加--profile efficiency。事件期使用event-growth-dataset.json和对应--out。compare-calibration.mjs汇总。生产未修改。
`;
fs.writeFileSync(`${dir}/integration-results.json`, JSON.stringify(result, null, 2));
fs.writeFileSync(`${dir}/integration-results.md`, "\uFEFF" + report, "utf8");
const escapeHtml = (text) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const inline = (text) =>
	escapeHtml(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
let html = "",
	inTable = false;
for (const line of report.split("\n")) {
	if (line.startsWith("|")) {
		if (/^\|[-:| ]+\|$/.test(line)) continue;
		const header = !inTable;
		if (header) {
			html += '<div class="table"><table>';
			inTable = true;
		}
		const tag = header ? "th" : "td";
		html +=
			"<tr>" +
			line
				.slice(1, -1)
				.split("|")
				.map((c) => `<${tag}>${inline(c.trim())}</${tag}>`)
				.join("") +
			"</tr>";
	} else {
		if (inTable) {
			html += "</table></div>";
			inTable = false;
		}
		const heading = line.match(/^(#{1,3}) (.*)$/);
		if (heading) html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
		else if (line.trim()) html += `<p>${inline(line)}</p>`;
	}
}
if (inTable) html += "</table></div>";
fs.writeFileSync(
	`${dir}/integration-results.html`,
	`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LP Atlas · 策略实验结论</title><style>body{margin:32px auto;padding:0 24px;max-width:1250px;background:#0b1412;color:#e0eae3;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}h1{font-size:26px}h2{font-size:21px;margin-top:32px}a{color:#c6ff6e}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:10px;text-align:left;border:1px solid #3b5746}th{background:#1e3025}p{overflow-wrap:anywhere}</style>${html}</html>`,
	"utf8",
);

console.log(
	JSON.stringify({
		coverage: result.coverage,
		runs: Object.fromEntries(Object.entries(result.runs).map(([k, v]) => [k, v.accounts])),
	}),
);
