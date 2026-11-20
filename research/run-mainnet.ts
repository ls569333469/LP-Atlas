import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import { collectPositionFeeGrowth, type GrowthPlan } from "./collect-mainnet-growth.ts";
import type { Dataset, Features, LifecyclePolicy, Signal, Trial } from "./engine.ts";
import { netPnl, ResearchEngine } from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "outputs/signal-research/v2026-11-13-mainnet");
const H = 3600;
const LOCAL_START = Date.parse("2026-11-09T14:00:00.000Z") / 1000;
const DISCOVERY_END = Date.parse("2026-11-11T04:00:00.000Z") / 1000;
const OUTFLOW_START = Date.parse("2026-11-11T05:00:00.000Z") / 1000;
const shanghai = (unix: number): string =>
	new Date((unix + 8 * H) * 1000).toISOString().replace("T", " ").slice(0, 16);
const absAtMost = (x: number | null | undefined, n: number) => x != null && Math.abs(x) <= n;
const atLeast = (x: number | null | undefined, n: number) => x != null && x >= n;

type Segment = "discovery" | "boundary" | "outflow" | "outside";
const segmentOf = (start: number): Segment => {
	if (start >= LOCAL_START && start < DISCOVERY_END) return "discovery";
	if (start === DISCOVERY_END) return "boundary";
	if (start >= OUTFLOW_START) return "outflow";
	if (start < LOCAL_START) return "discovery"; // backfilled mainnet-day hours belong to discovery
	return "outside";
};

type EntryRule = {
	id: string;
	name: string;
	rule: string;
	test: (f: Features, width: number) => boolean;
};
const entries: EntryRule[] = [
	{ id: "baseline", name: "名单基线（见池就做）", rule: "仅统一 1H 三门槛", test: () => true },
	{
		id: "flat-aligned",
		name: "收费横盘（宽度对齐）",
		rule: "费用/TVL≥0.1%，连续2H，|1H涨跌|≤该策略总宽的一半",
		test: (f, w) => atLeast(f.feeRate, 0.001) && f.consecutive >= 2 && absAtMost(f.price1, w / 2),
	},
	{
		id: "multi-flat",
		name: "多窗横盘（宽度对齐）",
		rule: "|1H|≤总宽/2，|6H|≤总宽，|24H|≤2×总宽；缺窗不通过",
		test: (f, w) =>
			atLeast(f.feeRate, 0.001) &&
			absAtMost(f.price1, w / 2) &&
			absAtMost(f.price6 ?? f.price4, w) &&
			absAtMost(f.price24, 2 * w),
	},
	{
		id: "defensive",
		name: "防撤池",
		rule: "TVL保留≥90%，池龄≥24H，连续2H，|1H|≤3%（另需入场前TVL≥25000，在trial中执行）",
		test: (f) =>
			atLeast(f.tvlRatio, 0.9) &&
			atLeast(f.ageHours, 24) &&
			f.consecutive >= 2 &&
			absAtMost(f.price1, 0.03),
	},
	{
		id: "fee-stress",
		name: "费用覆盖波动（前两轮公式）",
		rule: "1H费用/TVL≥0.1%且≥全范围50/50 IL基准的2倍，连续2H",
		test: (f) =>
			f.price1 != null &&
			atLeast(f.feeRate, 0.001) &&
			f.consecutive >= 2 &&
			atLeast(f.feeRate, 2 * (1 - (2 * Math.sqrt(Math.max(0, 1 + f.price1))) / (2 + f.price1))),
	},
	{
		id: "vol-1.5",
		name: "量能起量 1.5 倍",
		rule: "当前1H成交/前2H小时均值≥1.5，分母为0不通过",
		test: (f) => atLeast(f.volumeAcceleration, 1.5),
	},
	{
		id: "vol-2",
		name: "量能起量 2 倍",
		rule: "成交加速≥2",
		test: (f) => atLeast(f.volumeAcceleration, 2),
	},
	{
		id: "vol-3",
		name: "量能起量 3 倍",
		rule: "成交加速≥3",
		test: (f) => atLeast(f.volumeAcceleration, 3),
	},
	{
		id: "vol-2-confirm",
		name: "量能起量 2 倍且再确认",
		rule: "成交加速≥2，且连续2H合格",
		test: (f) => atLeast(f.volumeAcceleration, 2) && f.consecutive >= 2,
	},
	{
		id: "fee-cover-width",
		name: "费用覆盖该宽度走到边上的库存亏损",
		rule: "费用/TVL≥0.1%，连续2H；入场前1H区间费用须盖住下边界库存损失+往返成本，否则跳过",
		test: (f) => atLeast(f.feeRate, 0.001) && f.consecutive >= 2,
	},
	{
		id: "cj-3000",
		name: "CJ 年化纪律（研究配置）",
		rule: "实际归普通LP手续费年化≥3000%才打；低于1000%不打。不是产品默认值",
		test: (f) => atLeast(f.apr, 30),
	},
];

type Shape = LifecyclePolicy["range"];
type ExitId = "out" | "out-1pct" | "heat" | "hold-only" | "stops-2pct" | "rebalance";
type Play = {
	id: string;
	name: string;
	width: number;
	shape: Shape;
	exit: ExitId;
	holdHours: number;
	preflight: boolean;
	precision: "precise" | "degraded";
	precisionNote: string;
};

const widths = [0.01, 0.02, 0.04, 0.08, 0.1, 0.2];
const plays: Play[] = [];
const add = (p: Omit<Play, "id" | "name"> & { name?: string }) => {
	const degraded = p.precision === "degraded" || p.width <= 0.01;
	const play: Play = {
		...p,
		precision: degraded ? "degraded" : p.precision,
		id: `${Math.round(p.width * 100)}w-${p.shape}-${p.exit}-${p.holdHours}h${p.preflight ? "-pre" : ""}`,
		name:
			p.name ??
			`总宽${Math.round(p.width * 100)}% ${shapeName(p.shape)} ${exitName(p.exit)} 上限${p.holdHours}H`,
	};
	plays.push(play);
};
function shapeName(s: Shape): string {
	return { symmetric: "对称", up: "上偏80", down: "下偏80", buy: "单边接货", sell: "单边兑现" }[s];
}
function exitName(e: ExitId): string {
	return {
		out: "出区即撤",
		"out-1pct": "出区后再偏约1%",
		heat: "热度衰减50%",
		"hold-only": "仅限时离场",
		"stops-2pct": "旧±2%止盈止损对照",
		rebalance: "出区自动再平衡对照",
	}[e];
}

for (const width of widths) {
	for (const hold of [2, 4, 6, 12]) {
		for (const exit of ["out", "out-1pct", "heat"] as ExitId[]) {
			add({
				width,
				shape: "symmetric",
				exit,
				holdHours: hold,
				preflight: false,
				precision: width <= 0.01 ? "degraded" : "precise",
				precisionNote:
					width <= 0.01
						? "1% 窄区间用小时线判断触边，精度低于更宽区间，不进入精确总榜"
						: "单区间对称铺法，小时末触边",
			});
		}
	}
	add({
		width,
		shape: "symmetric",
		exit: "hold-only",
		holdHours: 6,
		preflight: false,
		precision: width <= 0.01 ? "degraded" : "precise",
		precisionNote: "只比较限时离场，不出区以外的提前规则",
	});
}
for (const shape of ["up", "down", "buy", "sell"] as Shape[]) {
	for (const exit of ["out", "heat"] as ExitId[]) {
		add({
			width: 0.1,
			shape,
			exit,
			holdHours: 6,
			preflight: false,
			precision: "precise",
			precisionNote: "单区间不对称或单边，可精确用同一套库存与feeGrowth公式",
		});
	}
}
add({
	width: 0.02,
	shape: "symmetric",
	exit: "stops-2pct",
	holdHours: 6,
	preflight: false,
	precision: "precise",
	precisionNote: "旧±2%止盈止损只作对照，不套到全部新策略",
});
add({
	width: 0.08,
	shape: "symmetric",
	exit: "stops-2pct",
	holdHours: 6,
	preflight: false,
	precision: "precise",
	precisionNote: "旧±2%止盈止损只作对照",
});
add({
	width: 0.02,
	shape: "symmetric",
	exit: "rebalance",
	holdHours: 6,
	preflight: false,
	precision: "degraded",
	precisionNote: "自动再平衡按出区后重新开同等宽度新仓近似，小时路径较粗，降级报告",
});
add({
	width: 0.08,
	shape: "symmetric",
	exit: "rebalance",
	holdHours: 6,
	preflight: false,
	precision: "degraded",
	precisionNote: "自动再平衡对照，降级报告",
});

function policyOf(play: Play): LifecyclePolicy {
	return {
		range: play.shape,
		dynamic: play.exit !== "hold-only",
		capture: 1,
		costBps: 50,
		fixedCost: "1",
		stop: 0.02,
		take: 0.02,
		trail: 0.01,
		coverageExit: false,
		preflight: play.preflight,
		efficiencyDecay: play.exit === "heat" ? 0.5 : undefined,
		edgeBuffer: play.exit === "out-1pct" || play.exit === "rebalance" ? 0.01 : undefined,
		autoRebalance: play.exit === "rebalance",
		useStops: play.exit === "stops-2pct",
	};
}

function csvEscape(value: unknown): string {
	const text = value == null ? "" : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function writeCsv(file: string, headers: string[], rows: Array<Array<unknown>>) {
	await fs.writeFile(
		file,
		[headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n") + "\n",
		"utf8",
	);
}

const args = process.argv.slice(2);
const collect = !args.includes("--no-collect");
const COLLECT_BUDGET_MS = 75 * 60 * 1000;
const capital = "200";

const frozenPath = path.join(outDir, "dataset.json");
const gapPath = path.join(outDir, "dataset-with-gap.json");
const computablePath = path.join(outDir, "dataset-computable.json");
const preferred = args.includes("--local-only")
	? frozenPath
	: (await fileExists(computablePath))
		? computablePath
		: (await fileExists(gapPath))
			? gapPath
			: frozenPath;
const dataset = JSON.parse(await fs.readFile(preferred, "utf8")) as Dataset;
if (dataset.schema !== 1) throw new Error("不支持的数据格式");
console.log(
	JSON.stringify({
		dataset: preferred,
		start: shanghai(dataset.start),
		end: shanghai(dataset.end),
		pools: dataset.pools.length,
		hours: dataset.hours.length,
	}),
);

const engine0 = new ResearchEngine(dataset);
const signals = engine0.signals();
const bySeg = {
	discovery: signals.filter((s) => segmentOf(s.start) === "discovery"),
	outflow: signals.filter((s) => segmentOf(s.start) === "outflow"),
	boundary: signals.filter((s) => segmentOf(s.start) === "boundary"),
};
console.log(
	JSON.stringify({
		phase: "signals",
		discovery: bySeg.discovery.length,
		outflow: bySeg.outflow.length,
		boundary: bySeg.boundary.length,
		total: signals.length,
	}),
);

type Row = Trial & {
	entryId: string;
	playId: string;
	segment: Segment;
	delay: number;
	precision: Play["precision"];
	capitalPnl: string | null;
	hodlNet: string | null;
};
const coverageBlocks = new Map<number, string>();
for (const h of dataset.coverage) {
	if (h.complete && h.toBlock) coverageBlocks.set(h.windowEnd, h.toBlock);
}

function runSet(
	engine: ResearchEngine,
	list: Signal[],
	segment: Segment,
	delay: number,
	withFees: boolean,
): Row[] {
	const rows: Row[] = [];
	const started = Date.now();
	for (const play of plays) {
		for (const entry of entries) {
			const preflight = entry.id === "fee-cover-width";
			const cfg = {
				width: play.width,
				holdHours: play.holdHours,
				delayHours: delay,
				capital,
				lifecycle: { ...policyOf({ ...play, preflight }), preflight },
			};
			const busy = new Map<string, number>();
			for (const signal of list) {
				if (!entry.test(signal.features, play.width)) continue;
				if (signal.start + H < (busy.get(signal.poolId) ?? 0)) continue;
				const trial = engine.trial(signal, `${entry.id}::${play.id}`, cfg);
				const capPnl = trial.status === "modeled" ? netPnl(trial, capital, 1, 50, "1") : null;
				const rel =
					trial.status === "modeled" &&
					trial.inventoryPnl != null &&
					trial.hodlPnl != null &&
					trial.feeProxy != null
						? new Decimal(trial.inventoryPnl)
								.minus(trial.hodlPnl)
								.plus(trial.feeProxy)
								.minus(new Decimal(capital).mul(50).div(10000))
								.minus(1)
						: null;
				const { checkpoints: _checkpoints, ...rest } = trial;
				void _checkpoints;
				rows.push({
					...rest,
					entryId: entry.id,
					playId: play.id,
					segment,
					delay,
					precision: play.precision,
					capitalPnl: capPnl?.toString() ?? null,
					hodlNet: rel?.toString() ?? null,
				});
				busy.set(
					signal.poolId,
					trial.status === "modeled" && trial.exitTime
						? trial.exitTime
						: trial.entryTime + play.holdHours * H,
				);
			}
		}
	}
	void withFees;
	console.log(
		JSON.stringify({
			phase: "run-set-done",
			segment,
			delay,
			withFees,
			rows: rows.length,
			ms: Date.now() - started,
		}),
	);
	return rows;
}

// Planning pass without feeGrowth: unique width/shape at max hold, both delays, no retained trials.
const planEngine = new ResearchEngine({ ...dataset, positionFeeGrowth: undefined });
const uniqueShapes = [...new Map(plays.map((p) => [`${p.width}:${p.shape}`, p])).values()];
type Planned = GrowthPlan & { width: number };
const needed: Planned[] = [];
const planStarted = Date.now();
for (const delay of [0, 1]) {
	for (const list of [bySeg.discovery, bySeg.outflow]) {
		for (const signal of list) {
			for (const play of uniqueShapes) {
				const trial = planEngine.trial(signal, "plan", {
					width: play.width,
					holdHours: 12,
					delayHours: delay,
					capital,
					lifecycle: {
						...policyOf({ ...play, holdHours: 12, exit: "hold-only", preflight: false }),
						preflight: false,
						useStops: false,
					},
				});
				if (
					trial.tickLower == null ||
					trial.tickUpper == null ||
					trial.tickLower >= trial.tickUpper
				)
					continue;
				if (!trial.entered && trial.lower == null) continue;
				const start = trial.entryTime - H;
				const end = Math.min(trial.entryTime + 12 * H + H, dataset.end);
				for (let time = start; time <= end; time += H) {
					const block = coverageBlocks.get(time);
					if (block)
						needed.push({
							poolId: trial.poolId,
							lower: trial.tickLower,
							upper: trial.tickUpper,
							time,
							block,
							width: play.width,
						});
				}
			}
		}
	}
}
console.log(
	JSON.stringify({
		phase: "plan-done",
		rawPlans: needed.length,
		shapes: uniqueShapes.length,
		ms: Date.now() - planStarted,
	}),
);

const growthDir = path.join(outDir, "fee-growth");
let growth = dataset.positionFeeGrowth;
if (collect) {
	const uniqueNeeded = [
		...new Map(needed.map((p) => [`${p.poolId}:${p.lower}:${p.upper}:${p.time}`, p])).values(),
	];
	const priorityWidth = (w: number) => {
		if (w === 0.02 || w === 0.04 || w === 0.08) return 0;
		if (w === 0.1 || w === 0.2) return 1;
		return 2;
	};
	uniqueNeeded.sort((a, b) => priorityWidth(a.width) - priorityWidth(b.width) || a.time - b.time);
	const collectDeadline = Date.now() + COLLECT_BUDGET_MS;
	console.log(
		JSON.stringify({
			phase: "collect-growth",
			uniquePlans: uniqueNeeded.length,
			budgetMs: COLLECT_BUDGET_MS,
		}),
	);
	const evidence = await collectPositionFeeGrowth({
		plans: uniqueNeeded,
		pools: dataset.pools,
		cacheDir: growthDir,
		deadlineAtMs: collectDeadline,
		label: "v2026-11-13-mainnet",
	});
	growth = { basis: evidence.basis, hours: evidence.hours };
	await fs.writeFile(
		path.join(outDir, "fee-growth-coverage.json"),
		JSON.stringify(evidence, null, 2),
	);
	console.log(JSON.stringify({ phase: "growth-done", ...evidence }));
}

const feeEngine = new ResearchEngine(growth ? { ...dataset, positionFeeGrowth: growth } : dataset);
const discoveryRows = runSet(feeEngine, bySeg.discovery, "discovery", 1, true);
const outflowRows = runSet(feeEngine, bySeg.outflow, "outflow", 1, true);
const delay0Discovery = runSet(feeEngine, bySeg.discovery, "discovery", 0, true);
const allRows = [
	...discoveryRows,
	...outflowRows,
	...delay0Discovery.map((r) => ({ ...r, delay: 0 })),
];

type Summary = {
	entryId: string;
	playId: string;
	segment: string;
	delay: number;
	precision: string;
	capital: string;
	tried: number;
	modeled: number;
	unknown: number;
	censored: number;
	skipped: number;
	fees: number;
	inventory: number;
	cost: number;
	net: number;
	relHodl: number;
	finalAssets: number;
	pools: number;
};
function summarize(rows: Row[], key: (r: Row) => string): Map<string, Summary> {
	const map = new Map<string, Summary>();
	for (const r of rows) {
		const k = key(r);
		let s = map.get(k);
		if (!s) {
			s = {
				entryId: r.entryId,
				playId: r.playId,
				segment: r.segment,
				delay: r.delay,
				precision: r.precision,
				capital,
				tried: 0,
				modeled: 0,
				unknown: 0,
				censored: 0,
				skipped: 0,
				fees: 0,
				inventory: 0,
				cost: 0,
				net: 0,
				relHodl: 0,
				finalAssets: 0,
				pools: 0,
			};
			map.set(k, s);
		}
		s.tried++;
		if (r.status === "modeled") {
			s.modeled++;
			s.fees += Number(r.feeProxy ?? 0);
			s.inventory += Number(r.inventoryPnl ?? 0);
			s.cost += Number(capital) * 0.005 + 1;
			s.net += Number(r.capitalPnl ?? 0);
			s.relHodl += Number(r.hodlNet ?? 0);
			s.finalAssets += Number(capital) + Number(r.capitalPnl ?? 0);
			const boxed = s as Summary & { poolSet?: Set<string> };
			if (!boxed.poolSet) boxed.poolSet = new Set();
			boxed.poolSet.add(r.poolId);
		} else if (r.status === "censored") s.censored++;
		else if (!r.entered) s.skipped++;
		else s.unknown++;
	}
	for (const s of map.values()) {
		s.pools = (s as Summary & { poolSet?: Set<string> }).poolSet?.size ?? 0;
		delete (s as Summary & { poolSet?: Set<string> }).poolSet;
	}
	return map;
}

const summaries = summarize(allRows, (r) => `${r.entryId}::${r.playId}::${r.segment}::${r.delay}`);
await fs.mkdir(outDir, { recursive: true });
await writeCsv(
	path.join(outDir, "strategy-summary.csv"),
	[
		"entry",
		"play",
		"segment",
		"delay",
		"precision",
		"capital",
		"tried",
		"modeled",
		"unknown",
		"censored",
		"skipped",
		"fees",
		"inventory",
		"cost",
		"net_capital",
		"net_vs_hodl",
		"final_assets_if_independent",
		"modeled_pools",
	],
	[...summaries.values()].map((s) => [
		s.entryId,
		s.playId,
		s.segment,
		s.delay,
		s.precision,
		s.capital,
		s.tried,
		s.modeled,
		s.unknown,
		s.censored,
		s.skipped,
		s.fees.toFixed(4),
		s.inventory.toFixed(4),
		s.cost.toFixed(4),
		s.net.toFixed(4),
		s.relHodl.toFixed(4),
		s.finalAssets.toFixed(4),
		s.pools,
	]),
);
await writeCsv(
	path.join(outDir, "trades.csv"),
	[
		"entry",
		"play",
		"segment",
		"delay",
		"precision",
		"pool",
		"pair",
		"signal",
		"entry",
		"exit",
		"status",
		"reason",
		"width",
		"lower",
		"upper",
		"inventory",
		"fees",
		"capital_pnl",
		"rel_hodl",
	],
	allRows.map((r) => [
		r.entryId,
		r.playId,
		r.segment,
		r.delay,
		r.precision,
		r.poolId,
		r.pair,
		shanghai(r.signalTime),
		shanghai(r.entryTime),
		r.exitTime ? shanghai(r.exitTime) : "",
		r.status,
		r.reason,
		r.width,
		r.lower,
		r.upper,
		r.inventoryPnl,
		r.feeProxy,
		r.capitalPnl,
		r.hodlNet,
	]),
);
const compact = allRows.map(({ checkpoints, features, ...rest }) => ({
	...rest,
	efficiency: features.efficiency,
	feeRate: features.feeRate,
	apr: features.apr,
	price1: features.price1,
}));
await fs.writeFile(path.join(outDir, "trades.json"), JSON.stringify(compact));

// Account paths: only precise 2%/4%/8% symmetric, out or heat, delay 1, on discovery, then outflow separately.
type Account = {
	id: string;
	status: string;
	start: number;
	end: number | null;
	cash: string;
	trades: number;
	unknownStop: boolean;
	equity: string;
};
function rollSingle(rows: Row[], reinvest: boolean): Account {
	const ordered = rows
		.filter((r) => r.segment === "discovery" && r.delay === 1 && r.precision === "precise")
		.sort((a, b) => a.entryTime - b.entryTime || a.poolId.localeCompare(b.poolId));
	let cash = new Decimal(capital);
	let ready = 0;
	let trades = 0;
	let unknownStop = false;
	let end: number | null = null;
	for (const r of ordered) {
		if (unknownStop) break;
		if (r.entryTime < ready) continue;
		if (r.status === "unknown" && r.entered) {
			unknownStop = true;
			end = r.entryTime;
			break;
		}
		if (r.status !== "modeled" || r.capitalPnl == null) continue;
		const amount = reinvest ? cash : new Decimal(capital);
		if (amount.lte(0)) break;
		const scale = amount.div(capital);
		const pnl = new Decimal(r.capitalPnl).mul(scale);
		cash = reinvest ? amount.plus(pnl) : cash.plus(pnl);
		trades++;
		ready = (r.exitTime ?? r.entryTime) + H;
		end = r.exitTime ?? r.entryTime;
	}
	return {
		id: `${rows[0]?.entryId ?? ""}::${rows[0]?.playId ?? ""}::fixed-or-reinvest`,
		status: unknownStop ? "unknown_stop" : "complete",
		start: Number(capital),
		end,
		cash: cash.toString(),
		trades,
		unknownStop,
		equity: cash.toString(),
	};
}

const accountRows: Array<Array<unknown>> = [];
const accountFocus = discoveryRows.filter(
	(r) =>
		r.precision === "precise" &&
		(r.playId.includes("2w-symmetric-out-6h") ||
			r.playId.includes("2w-symmetric-heat-6h") ||
			r.playId.includes("4w-symmetric-out-6h") ||
			r.playId.includes("8w-symmetric-out-6h") ||
			r.playId.includes("2w-symmetric-out-1pct-6h")) &&
		[
			"baseline",
			"flat-aligned",
			"multi-flat",
			"defensive",
			"fee-stress",
			"vol-2",
			"fee-cover-width",
			"cj-3000",
		].includes(r.entryId),
);
const grouped = new Map<string, Row[]>();
for (const r of accountFocus) {
	const k = `${r.entryId}::${r.playId}`;
	const list = grouped.get(k) ?? [];
	list.push(r);
	grouped.set(k, list);
}

function rollWallet(
	rows: Row[],
	wallet: Decimal,
	slot: Decimal,
	maxPos: number,
	reinvest: boolean,
): Account {
	const ordered = [...rows].sort(
		(a, b) => a.entryTime - b.entryTime || a.poolId.localeCompare(b.poolId),
	);
	let cash = wallet;
	const open: Array<{ exit: number; amount: Decimal; pnl: Decimal | null; row: Row }> = [];
	let trades = 0;
	let unknownStop = false;
	let end: number | null = null;
	for (const r of ordered) {
		if (unknownStop) break;
		open.splice(
			0,
			open.length,
			...open.filter((o) => {
				if ((o.row.exitTime ?? o.exit) <= r.entryTime) {
					if (o.row.status === "modeled" && o.row.capitalPnl != null) {
						const pnl = new Decimal(o.row.capitalPnl).mul(o.amount.div(capital));
						cash = cash.plus(o.amount).plus(pnl);
						trades++;
					}
					return false;
				}
				return true;
			}),
		);
		if (r.status === "unknown" && r.entered) {
			unknownStop = true;
			end = r.entryTime;
			break;
		}
		if (r.status !== "modeled") continue;
		if (open.length >= maxPos) continue;
		const amount = Decimal.min(slot, cash);
		if (amount.lt(slot)) continue;
		cash = cash.minus(amount);
		open.push({ exit: r.exitTime ?? r.entryTime + r.holdHours * H, amount, pnl: null, row: r });
		end = r.exitTime ?? r.entryTime;
		void reinvest;
	}
	for (const o of open) {
		if (o.row.status === "modeled" && o.row.capitalPnl != null) {
			const pnl = new Decimal(o.row.capitalPnl).mul(o.amount.div(capital));
			cash = cash.plus(o.amount).plus(pnl);
			trades++;
			end = o.row.exitTime ?? end;
		} else if (o.row.entered) {
			unknownStop = true;
		}
	}
	return {
		id: "wallet",
		status: unknownStop ? "unknown_stop" : "complete",
		start: wallet.toNumber(),
		end,
		cash: cash.toString(),
		trades,
		unknownStop,
		equity: cash.toString(),
	};
}

for (const [k, list] of grouped) {
	const fixed = rollSingle(list, false);
	const reinvest = rollSingle(list, true);
	const ten = rollWallet(list, new Decimal(2000), new Decimal(200), 10, true);
	accountRows.push([
		k,
		"single-fixed-200",
		fixed.status,
		fixed.trades,
		fixed.cash,
		fixed.unknownStop,
	]);
	accountRows.push([
		k,
		"single-reinvest-200",
		reinvest.status,
		reinvest.trades,
		reinvest.cash,
		reinvest.unknownStop,
	]);
	accountRows.push([k, "wallet-10x200", ten.status, ten.trades, ten.cash, ten.unknownStop]);
}
await writeCsv(
	path.join(outDir, "accounts.csv"),
	["config", "account", "status", "trades", "equity", "unknown_stop"],
	accountRows,
);

// Event check: reuse planned entries on the 11-10 window around 08:34 if the pool is in the dataset.
const eventStart = Date.parse("2026-11-10T00:34:54.000Z") / 1000; // 08:34:54 Asia/Shanghai
const eventPools = new Set([
	"0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac",
	"0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472",
]);
const eventHourStarts = [eventStart - (eventStart % H) - H, eventStart - (eventStart % H)];
const eventSignals = signals.filter(
	(s) =>
		eventPools.has(s.poolId) &&
		s.start >= eventHourStarts[0]! - 2 * H &&
		s.start <= eventHourStarts[1]! + 2 * H,
);
const eventRows = allRows.filter(
	(r) => eventPools.has(r.poolId) && Math.abs(r.entryTime - (eventHourStarts[1]! + H)) <= 4 * H,
);
await fs.writeFile(
	path.join(outDir, "event-0834.json"),
	JSON.stringify({
		eventTime: shanghai(eventStart),
		note: "独立事件校验：对照 11 月 10 日 08:34 前后已触发的研究入场，不得为了捕捉它而改门槛。",
		nearbySignals: eventSignals.map((s) => ({
			poolId: s.poolId,
			pair: s.pair,
			hour: shanghai(s.start),
			entries: entries.filter((e) => e.test(s.features, 0.02)).map((e) => e.id),
			apr: s.features.apr,
			feeRate: s.features.feeRate,
			volumeAcceleration: s.features.volumeAcceleration,
			price1: s.features.price1,
		})),
		nearbyTrades: eventRows.slice(0, 400),
	}),
);

const growthCov = growth
	? {
			hours: growth.hours.length,
			usable: growth.hours.filter((h) => h.status === "usable").length,
			unknown: growth.hours.filter((h) => h.status !== "usable").length,
		}
	: { hours: 0, usable: 0, unknown: 0 };

const preciseDisc = [...summaries.values()].filter(
	(s) => s.segment === "discovery" && s.delay === 1 && s.precision === "precise" && s.modeled > 0,
);
const interesting = preciseDisc.sort((a, b) => b.net - a.net).slice(0, 12);
const noGain = [...summaries.values()].filter(
	(s) =>
		s.segment === "discovery" &&
		s.delay === 1 &&
		s.precision === "precise" &&
		s.modeled >= 5 &&
		s.net <= 0,
);
const report = `# 入场信号与 LP 策略对照（主网研究）

生成时间：${new Date().toISOString()}。时区标签为 Asia/Shanghai。样本来自 \`${path.basename(preferred)}\`，起点 ${shanghai(dataset.start)}，终点（不含当前未完成小时）${shanghai(dataset.end)}。费用公式：已实盘核对的 feeGrowthInside（liquidity × ΔfeeGrowthInside / Q128）。未使用 50% 代理、本金/TVL 分摊或标称费率×成交量作为净利润。公共 RPC 标 public_temporary。未修改生产采集、默认过滤、定时扫描、看板 API、钱包或开仓，未覆盖旧 48 小时包，未把任何规则写入生产信号。未宣布已验证盈利。

## 覆盖

- 信号观察：发现集 ${bySeg.discovery.length}，外流集 ${bySeg.outflow.length}，边界小时 ${bySeg.boundary.length}。
- 入场规则 ${entries.length} 条，铺法/退出组合 ${plays.length} 条。主比较使用延迟 1 小时入场（信号在该小时结束后才可用）；延迟 0 为理想边界入场对照。
- feeGrowth 证据：计划/可用/未知见 fee-growth-coverage.json。当前小时证据 ${growthCov.hours}，可用 ${growthCov.usable}，未知 ${growthCov.unknown}。缺证据的仓位记 unknown，不伪造完成，不计入亏损。
- 1% 窄区间、自动再平衡按精度不足降级，不进入下面的精确对照叙述。密铺网格与双层挂单本轮未做精确回测（小时线看不住格与格之间的来回），只在文末标明无法判断。

## 发现集（延迟 1 小时，精确单区间）主表摘要

金额是同一配置下各笔可算交易的加总，**不是**一份资金的滚动收益。滚动账户见 accounts.csv。

| 入场 | 玩法 | 尝试 | 可算 | 未知 | 未到期 | 未入场 | 手续费 | 库存损益 | 成本 | 本金净利润 | 相对持币净额 | 可算池数 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${interesting
	.map(
		(s) =>
			`| ${s.entryId} | ${s.playId} | ${s.tried} | ${s.modeled} | ${s.unknown} | ${s.censored} | ${s.skipped} | ${s.fees.toFixed(2)} | ${s.inventory.toFixed(2)} | ${s.cost.toFixed(2)} | ${s.net.toFixed(2)} | ${s.relHodl.toFixed(2)} | ${s.pools} |`,
	)
	.join("\n")}

完整主表：strategy-summary.csv。可算很少时不在本文推荐“最佳策略”。

## 外流压力对照

外流集（11-11 13:00 起）同样写入 strategy-summary.csv 的 segment=outflow。不在外流段上调整门槛。

## 值得继续验证 / 没有增益 / 还无法判断

- 发现集精确组里，本金净额合计为正且可算至少 5 笔的配置（仍只是独立加总，不是一份资金）：${
	preciseDisc
		.filter((s) => s.modeled >= 5 && s.net > 0)
		.map((s) => `${s.entryId}/${s.playId} (n=${s.modeled}, net=${s.net.toFixed(2)})`)
		.join("；") || "无。可算样本不足或尚未出现稳定正净额。"
}
- 可算至少 5 笔但合计净额不为正：${
	noGain
		.slice(0, 8)
		.map((s) => `${s.entryId}/${s.playId}`)
		.join("；") || "无或样本不足。"
}
- 因覆盖或粒度不足还无法判断：1% 小时触边、密铺网格、双层近似、自动再平衡的精确优劣；半小时剥头皮与盘中插针；feeGrowth 未知或 tick 未初始化的池；11 月 9 日 00:00–21:00 若未完成回补的缺档。
- 账户路径（固定出利 / 复投 / 最多 10 个池同一钱包）只对焦点配置尝试，缺费用或退出证据时停止后续模拟，见 accounts.csv。

## 11 月 10 日 08:34 事件校验（独立）

见 event-0834.json。只展示当时前后研究规则会不会发出信号、以及邻近可算交易，不把单笔盈亏当成全市场结论，也没有为了捕捉该笔而改门槛。

## 本轮明确不测

资金费、期现、杠杆循环、Pendle、预测市场、跨所搬砖、MEV/防夹，以及公开主网上线前（10-19 至 11-08）小时档。

复现：\`npx pnpm@10.34.6 exec tsx research/run-mainnet.ts\`
`;
await fs.writeFile(path.join(outDir, "main-report.md"), report, "utf8");
console.log(
	JSON.stringify(
		{
			signals: { discovery: bySeg.discovery.length, outflow: bySeg.outflow.length },
			plays: plays.length,
			entries: entries.length,
			rows: allRows.length,
			summaries: summaries.size,
			growth: growthCov,
			report: path.join(outDir, "main-report.md"),
		},
		null,
		2,
	),
);

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
