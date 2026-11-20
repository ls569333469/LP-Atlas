import Decimal from "decimal.js";
import {
	type Features,
	type LifecyclePolicy,
	netPnl,
	type ResearchEngine,
	type Signal,
	type Trial,
} from "./engine.ts";

const H = 3600;
export type Playbook = {
	id: string;
	name: string;
	entry: string;
	rangeText: string;
	exit: string;
	source: string;
	range: LifecyclePolicy["range"];
	width: (f: Features) => number;
	test: (s: Signal) => boolean;
	coverageExit: boolean;
	preflight?: boolean;
	holdHours?: number;
	efficiencyDecay?: number;
	volatilityExpansion?: number;
};
const calm = (f: Features) => f.price1 !== null && Math.abs(f.price1) <= 0.02 && f.consecutive >= 2;
const charged = (f: Features) => f.feeRate !== null && f.feeRate >= 0.001;
const adaptive = (f: Features) =>
	Math.min(0.2, Math.max(0.04, 4 * Math.max(Math.abs(f.price1 ?? 0), Math.abs(f.price4 ?? 0) / 2)));
const exits =
	"每小时观察：出区间；净亏≥2%或净赚≥2%；盈利达1%后回吐≥1%；TVL降20%；成交或费用强度降50%；最长4H。费用覆盖型额外检验下一小时费用压力。退出冷却1H，不自动重挂。";
const definitions: Omit<Playbook, "exit">[] = [
	{
		id: "flat-tight",
		name: "01 横盘窄区间",
		entry: "连续2H合格、1H涨跌≤±2%、费用/TVL≥0.1%",
		rangeText: "现价±1%，tick外扩",
		range: "symmetric",
		width: () => 0.02,
		test: (s) => calm(s.features) && charged(s.features),
		coverageExit: false,
		source: "Meteora Spot-Concentrated思路；V3单区间近似",
	},
	{
		id: "flat-medium",
		name: "02 横盘中区间",
		entry: "同01，单独比较区间宽度",
		rangeText: "现价±5%",
		range: "symmetric",
		width: () => 0.1,
		test: (s) => calm(s.features) && charged(s.features),
		coverageExit: false,
		source: "Spot与CJ横盘收费",
	},
	{
		id: "flat-adaptive",
		name: "03 波动自适应",
		entry: "连续2H合格、费用/TVL≥0.1%，有1H及4H涨跌",
		rangeText: "总宽=4×max(|1H涨跌|,|4H涨跌|/2)，限制4%–20%；非真实波动率",
		range: "symmetric",
		width: adaptive,
		test: (s) =>
			charged(s.features) &&
			s.features.consecutive >= 2 &&
			s.features.price1 !== null &&
			s.features.price4 !== null,
		coverageExit: true,
		source: "Meteora按波动选择范围；阈值为本实验",
	},
	{
		id: "rabbit",
		name: "04 起量快进快出",
		entry: "费用/TVL≥0.1%、成交/前2H均值≥1.5、1H涨跌≤±10%",
		rangeText: "现价±5%",
		range: "symmetric",
		width: () => 0.1,
		test: (s) =>
			charged(s.features) &&
			(s.features.volumeAcceleration ?? 0) >= 1.5 &&
			s.features.price1 !== null &&
			Math.abs(s.features.price1) <= 0.1,
		coverageExit: true,
		source: "LP Army CryptoWhiskers Rabbit公开摘要；非复刻分钟参数",
	},
	{
		id: "up-skew",
		name: "05 上涨偏置收费",
		entry: "1H上涨1%–5%、4H涨幅>0、费用环比≥0、费用/TVL≥0.1%",
		rangeText: "现价下2%、上8%",
		range: "up",
		width: () => 0.1,
		test: (s) =>
			charged(s.features) &&
			(s.features.price1 ?? 0) >= 0.01 &&
			(s.features.price1 ?? 1) <= 0.05 &&
			(s.features.price4 ?? 0) > 0 &&
			(s.features.growth ?? -1) >= 0,
		coverageExit: true,
		source: "CJ方向判断；非合约做多",
	},
	{
		id: "sell-range",
		name: "06 上涨单边兑现",
		entry: "同05；入场持代币，向上分批卖出",
		rangeText: "现价上方0%–10%，内侧tick向上对齐，未触及不收费用",
		range: "sell",
		width: () => 0.1,
		test: (s) =>
			charged(s.features) &&
			(s.features.price1 ?? 0) >= 0.01 &&
			(s.features.price1 ?? 1) <= 0.05 &&
			(s.features.price4 ?? 0) > 0 &&
			(s.features.growth ?? -1) >= 0,
		coverageExit: false,
		source: "Uniswap Range Orders；Meteora DCA out",
	},
	{
		id: "down-skew",
		name: "07 回撤偏置收费",
		entry: "1H下跌1%–5%、连续2H合格、费用/TVL≥0.1%",
		rangeText: "现价下8%、上2%",
		range: "down",
		width: () => 0.1,
		test: (s) =>
			charged(s.features) &&
			s.features.consecutive >= 2 &&
			(s.features.price1 ?? 0) <= -0.01 &&
			(s.features.price1 ?? -1) >= -0.05,
		coverageExit: true,
		source: "CJ回撤方向实验；不声称探明支撑",
	},
	{
		id: "buy-range",
		name: "08 下方单边接货",
		entry: "同07；入场持报价币，不默认长期扛币",
		rangeText: "现价下方10%–0%，内侧tick向下对齐，未触及不收费用",
		range: "buy",
		width: () => 0.1,
		test: (s) =>
			charged(s.features) &&
			s.features.consecutive >= 2 &&
			(s.features.price1 ?? 0) <= -0.01 &&
			(s.features.price1 ?? -1) >= -0.05,
		coverageExit: false,
		source: "Uniswap buy range；Meteora DCA in",
	},
	{
		id: "fee-cover",
		name: "09 费用支撑退出",
		entry: "费用/TVL≥0.1%、连续2H合格",
		rangeText: "现价±5%",
		range: "symmetric",
		width: () => 0.1,
		test: (s) => charged(s.features) && s.features.consecutive >= 2,
		coverageExit: true,
		source: "CJ Fee覆盖；下一小时库存下行情景退出",
	},
	{
		id: "defensive",
		name: "10 深度与稳定收费",
		entry: "TVL≥$25,000、保留≥90%、池龄≥24H、连续2H、1H涨跌≤±3%",
		rangeText: "现价±5%",
		range: "symmetric",
		width: () => 0.1,
		test: (s) => s.strategies.includes("defensive"),
		coverageExit: true,
		source: "LP Army风控摘要与既有防撤池对照",
	},
];
definitions.push({
	rangeText: "现价±1%，tick外扩",
	range: "symmetric",
	width: () => 0.02,
	test: (s) => calm(s.features) && charged(s.features),
	id: "fee-budget",
	name: "11 入场前费用预算",
	entry: "同01；另要求预估1H个人费用代理>跌至下边界的库存损失+完整往返成本，否则不入场",
	preflight: true,
	coverageExit: true,
	source: "CJ入场前费用覆盖；本实验数学预算对照，非社区固定阈值",
});
export const PLAYBOOKS: Playbook[] = definitions.map((p) => ({ ...p, exit: exits }));

export type Scenario = { capital: string; delay: number; capture: number };
export function policy(book: Playbook, scene: Scenario, dynamic = true): LifecyclePolicy {
	return {
		range: book.range,
		dynamic,
		capture: scene.capture,
		costBps: 50,
		fixedCost: "1",
		stop: 0.02,
		take: 0.02,
		trail: 0.01,
		coverageExit: book.coverageExit,
		preflight: book.preflight,
		efficiencyDecay: book.efficiencyDecay,
		volatilityExpansion: book.volatilityExpansion,
	};
}
export function simulate(
	engine: ResearchEngine,
	signal: Signal,
	book: Playbook,
	scene: Scenario,
	dynamic = true,
): Trial {
	return engine.trial(signal, book.id, {
		width: book.width(signal.features),
		holdHours: book.holdHours ?? 4,
		delayHours: scene.delay,
		capital: scene.capital,
		lifecycle: policy(book, scene, dynamic),
	});
}
export type Paired = { scenario: Scenario; book: string; dynamic: Trial; control: Trial };
export function runPaired(
	engine: ResearchEngine,
	signals: Signal[],
	book: Playbook,
	scene: Scenario,
): Paired[] {
	const busy = new Map<string, number>(),
		rows: Paired[] = [];
	for (const s of signals) {
		const entry = s.start + (1 + scene.delay) * H;
		if (!book.test(s) || entry < (busy.get(s.poolId) ?? 0)) continue;
		const dynamic = simulate(engine, s, book, scene);
		rows.push({
			scenario: scene,
			book: book.id,
			dynamic,
			control: simulate(engine, s, book, scene, false),
		});
		// Unknown/censored paths cannot be assumed to have exited; block this pool thereafter.
		busy.set(
			s.poolId,
			dynamic.status === "modeled" && dynamic.exitTime
				? dynamic.exitTime + H
				: dynamic.entered
					? Infinity
					: entry + H,
		);
	}
	return rows;
}
export function describe(rows: Trial[], capture: number) {
	const good = rows.filter((t) => t.status === "modeled");
	const pnl = good.map((t) => Number(netPnl(t, t.capital, capture, 50, "1")));
	return {
		attempts: rows.length,
		modeled: good.length,
		unknown: rows.filter((t) => t.status === "unknown" && t.entered).length,
		skipped: rows.filter((t) => t.status === "unknown" && !t.entered).length,
		censored: rows.filter((t) => t.status === "censored").length,
		wins: pnl.filter((x) => x > 0).length,
		mean: pnl.length ? pnl.reduce((a, b) => a + b, 0) / pnl.length : null,
		total: pnl.reduce((a, b) => a + b, 0),
		meanHours: good.length
			? good.reduce((a, t) => a + ((t.exitTime ?? t.entryTime) - t.entryTime) / H, 0) / good.length
			: null,
	};
}
export type Account = {
	book: string;
	scenario: Scenario;
	mode: "withdraw" | "compound" | "recover";
	status: string;
	cash: string;
	withdrawn: string;
	atRisk: string;
	finalEquity: string | null;
	realizedPnl: string;
	closedDrawdown: string;
	trades: Trial[];
	ignored: number;
};
export function rollAccount(
	engine: ResearchEngine,
	signals: Signal[],
	book: Playbook,
	scene: Scenario,
	mode: Account["mode"],
): Account {
	const initial = new Decimal(scene.capital);
	let cash = initial,
		withdrawn = new Decimal(0),
		realized = new Decimal(0),
		peak = initial,
		drawdown = new Decimal(0),
		ready = engine.data.start;
	const out: Account = {
		book: book.id,
		scenario: scene,
		mode,
		status: "finished",
		cash: "",
		withdrawn: "0",
		atRisk: "0",
		finalEquity: null,
		realizedPnl: "0",
		closedDrawdown: "0",
		trades: [],
		ignored: 0,
	};
	const byTime = new Map<number, Signal[]>();
	for (const s of signals)
		if (book.test(s)) {
			const group = byTime.get(s.start) ?? [];
			group.push(s);
			byTime.set(s.start, group);
		}
	for (const [t, candidates] of byTime) {
		const entry = t + (1 + scene.delay) * H;
		if (entry >= engine.data.end) break;
		if (entry < ready) continue;
		if (cash.lt(10)) {
			out.status = "cash_exhausted";
			break;
		}
		const budget = mode === "withdraw" ? Decimal.min(initial, cash) : cash;
		const amount = budget.minus(1).div(1.005);
		const entryCost = amount.mul(0.005).plus(1).div(2);
		candidates.sort(
			(a, b) =>
				(b.features.feeRate ?? 0) - (a.features.feeRate ?? 0) || a.poolId.localeCompare(b.poolId),
		);
		for (const s of candidates) {
			const trial = simulate(engine, s, book, { ...scene, capital: amount.toString() });
			// Pre-entry rejection is observable at entry; do not select using future outcome.
			if (trial.status === "unknown" && !trial.entered) {
				out.ignored++;
				continue;
			}
			out.trades.push(trial);
			if (trial.status !== "modeled") {
				out.status = trial.status;
				out.atRisk = amount.toString();
				cash = cash.minus(amount).minus(entryCost);
				realized = realized.minus(entryCost);
				ready = Infinity;
				break;
			}
			const pnl = netPnl(trial, amount.toString(), scene.capture, 50, "1");
			if (pnl === null) throw new Error("Closed account trade has no PnL");
			realized = realized.plus(pnl);
			cash = cash.plus(pnl);
			if (mode === "withdraw" && cash.gt(initial)) {
				withdrawn = withdrawn.plus(cash.minus(initial));
				cash = initial;
			}
			if (mode === "recover" && withdrawn.isZero() && cash.gte(initial.mul(2))) {
				cash = cash.minus(initial);
				withdrawn = initial;
			}
			const equity = cash.plus(withdrawn);
			peak = Decimal.max(peak, equity);
			drawdown = Decimal.max(drawdown, peak.minus(equity).div(peak));
			ready = (trial.exitTime ?? entry) + H;
			break;
		}
		if (!Number.isFinite(ready)) break;
	}
	out.cash = cash.toString();
	out.withdrawn = withdrawn.toString();
	out.realizedPnl = realized.toString();
	out.closedDrawdown = drawdown.toString();
	out.finalEquity =
		out.status === "unknown" || out.status === "censored" ? null : cash.plus(withdrawn).toString();
	return out;
}
