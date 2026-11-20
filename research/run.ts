import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import Decimal from "decimal.js";
import { isHypeLike, isOfficialUsdStable } from "../src/normalize/prices.ts";
import { HOUR_SECONDS as H } from "../src/shared/constants.ts";
import {
	latestSuccessfulRefresh,
	listPoolsByIds,
	listScannedHours,
	listTokensForPools,
	listWindowsInRange,
} from "../src/store/repositories.ts";
import {
	type Dataset,
	netPnl,
	normalizeHour,
	qualifies,
	ResearchEngine,
	STRATEGIES,
	type Trial,
} from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string): string | undefined => {
	const i = args.indexOf(key);
	return i < 0 ? undefined : args[i + 1];
};
const capital = arg("--capital") ?? "1000";
if (!new Decimal(capital).isFinite() || new Decimal(capital).lte(0))
	throw new Error("本金必须为正数");
const output = path.resolve(arg("--out") ?? path.join(root, "outputs/signal-research"));
const input = arg("--input");
await fs.mkdir(output, { recursive: true });
let dataset: Dataset;
if (input) {
	dataset = JSON.parse(await fs.readFile(path.resolve(input), "utf8")) as Dataset;
	if (dataset.schema !== 1) throw new Error("不支持的数据格式");
} else {
	const db = createClient({
		url: `file:${path.resolve(arg("--db") ?? path.join(root, "data/lp-atlas.db"))}`,
	});
	await db.execute("PRAGMA query_only=ON");
	const tx = await db.transaction("read");
	try {
		const last = await latestSuccessfulRefresh(tx);
		if (!last?.blockTime) throw new Error("没有可发布数据");
		const end = Math.floor(Date.parse(last.blockTime) / 1000 / H) * H,
			start = end - 48 * H;
		const earliest = await tx.execute(
			"SELECT MIN(window_start) AS earliest FROM window_aggregates",
		);
		const all = await listWindowsInRange(tx, Number(earliest.rows[0]?.earliest ?? start), end + H);
		const candidateIds = [
			...new Set(all.filter((h) => h.windowStart >= start && qualifies(h)).map((h) => h.poolId)),
		];
		const pools = await listPoolsByIds(tx, candidateIds);
		dataset = {
			schema: 1,
			exportedAt: new Date().toISOString(),
			revision: last.id,
			asOf: last.blockTime,
			start,
			end,
			pools,
			tokens: [],
			hours: [],
			coverage: [],
			bridges: { pools: [], hours: [] },
		};
		// Bridge selection comes from this same transaction, including retired bridge pools.
		const allIds = [...new Set(all.map((h) => h.poolId))];
		const catalog = await listPoolsByIds(tx, allIds);
		const bridgePools = catalog.filter(
			(p) =>
				(isHypeLike(p.token0) && isOfficialUsdStable(p.token1)) ||
				(isHypeLike(p.token1) && isOfficialUsdStable(p.token0)),
		);
		const poolMap = new Map(pools.map((p) => [p.poolId, p])),
			bridgeSet = new Set(bridgePools.map((p) => p.poolId));
		dataset.tokens = await listTokensForPools(tx, [...new Set([...candidateIds, ...bridgeSet])]);
		dataset.hours = all.flatMap((h) => {
			const pool = poolMap.get(h.poolId);
			return pool ? [normalizeHour(h, pool)] : [];
		});
		dataset.coverage = await listScannedHours(tx, {
			startUnix: Number(earliest.rows[0]?.earliest ?? start),
			endUnixExclusive: end + H,
		});
		dataset.bridges = { pools: bridgePools, hours: all.filter((h) => bridgeSet.has(h.poolId)) };
	} finally {
		tx.close();
		db.close();
	}
	await fs.writeFile(path.join(output, "dataset.json"), JSON.stringify(dataset));
}
const engine = new ResearchEngine(dataset);
const signals = engine.signals();
const forward = signals.flatMap((s) => [1, 2, 4].map((n) => engine.forward(s, n)));
console.log(
	`导出 ${dataset.pools.length} 池、${dataset.hours.length} 条小时档；${signals.length} 个完整小时准入观察`,
);
const trials: Trial[] = [];
const capitals = [...new Set([capital, "100"])];
for (const amount of capitals)
	for (const width of [0.02, 0.1, 0.2])
		for (const holdHours of [1, 2, 4]) {
			const batch = engine.run(signals, { width, holdHours, delayHours: 1, capital: amount });
			trials.push(...batch);
			console.log(
				`本金 $${amount}，区间总宽 ${width * 100}%、${holdHours}H：${batch.length} 条策略试验`,
			);
		}
const iso = (t: number): string => new Date(t * 1000).toISOString();
const csv = (rows: Record<string, unknown>[], fields?: string[]): string => {
	const columns = fields ?? Object.keys(rows[0] ?? {});
	const cell = (v: unknown): string =>
		`"${String(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
	return `\ufeff${columns.map(cell).join(",")}\r\n${rows.map((r) => columns.map((k) => cell(r[k])).join(",")).join("\r\n")}`;
};
const summarize = (rows: Trial[], capture: number, costBps: number, fixedCost: string) => {
	const modeled = rows.filter((t) => t.status === "modeled");
	const pnl = modeled.map((t) => {
		const value = netPnl(t, t.capital, capture, costBps, fixedCost);
		if (value === null) throw new Error("Modeled trial has missing money fields");
		return value;
	});
	const total = pnl.reduce((s, p) => s.plus(p), new Decimal(0));
	const unknown = rows.filter((t) => t.status === "unknown").length,
		censored = rows.filter((t) => t.status === "censored").length;
	const included = rows.length - censored;
	const principal = rows[0]?.capital ?? capital;
	return {
		attempts: rows.length,
		modeled: modeled.length,
		unknown,
		censored,
		wins: pnl.filter((p) => p.gt(0)).length,
		winRate: modeled.length ? pnl.filter((p) => p.gt(0)).length / modeled.length : null,
		total: total.toString(),
		mean: modeled.length ? total.div(modeled.length).toString() : null,
		stressTotal: total.minus(new Decimal(principal).mul(unknown)).toString(),
		stressWinRate: included ? pnl.filter((p) => p.gt(0)).length / included : null,
	};
};
const summary: Array<
	{ capital: string; strategy: string; width: number; hold: number; half: string } & ReturnType<
		typeof summarize
	>
> = [];
for (const amount of capitals)
	for (const s of STRATEGIES)
		for (const width of [0.02, 0.1, 0.2])
			for (const hold of [1, 2, 4])
				for (const half of ["all", "first", "second"]) {
					const rows = trials.filter(
						(t) =>
							t.capital === amount &&
							t.strategy === s.id &&
							t.width === width &&
							t.holdHours === hold &&
							(half === "all" || t.half === half),
					);
					summary.push({
						capital: amount,
						strategy: s.id,
						width,
						hold,
						half,
						...summarize(rows, 0.5, 50, "1"),
					});
				}
const hourly = dataset.hours
	.filter((h) => h.windowStart >= dataset.start)
	.map((h) => ({
		...h,
		utcStart: iso(h.windowStart),
		qualified: qualifies(h),
		partial: !h.complete,
	}));
const pools = dataset.pools.map((p) => {
	const rows = hourly.filter((h) => h.poolId === p.poolId);
	return {
		...p,
		pair: engine.pair(p),
		qualifiedCompleteHours: rows.filter((h) => h.qualified && h.complete).length,
		qualifiedPartialHours: rows.filter((h) => h.qualified && !h.complete).length,
		firstQualified:
			rows.filter((h) => h.qualified).sort((a, b) => a.windowStart - b.windowStart)[0]?.utcStart ??
			null,
	};
});
const results = {
	schema: 1,
	capital,
	capitals,
	forward,
	delayHours: 1,
	dataHash: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
	data: {
		start: dataset.start,
		end: dataset.end,
		asOf: dataset.asOf,
		exportedAt: dataset.exportedAt,
		revision: dataset.revision,
		pools: dataset.pools.length,
		tokens: dataset.tokens.length,
		hours: dataset.hours.length,
		observations: signals.length,
	},
	strategies: STRATEGIES.map(({ test: _, ...s }) => s),
	signals,
	trials,
	summary,
};
await Promise.all([
	fs.writeFile(path.join(output, "results.json"), JSON.stringify(results)),
	fs.writeFile(path.join(output, "pools.csv"), csv(pools)),
	fs.writeFile(path.join(output, "tokens.csv"), csv(dataset.tokens)),
	fs.writeFile(path.join(output, "hours.csv"), csv(hourly)),
	fs.writeFile(path.join(output, "coverage.csv"), csv(dataset.coverage)),
	fs.writeFile(
		path.join(output, "signals.csv"),
		csv(signals.map((s) => ({ ...s, utcSignal: iso(s.start + H), ...s.features }))),
	),
	fs.writeFile(
		path.join(output, "trials.csv"),
		csv(
			trials.map((t) => ({
				...t,
				utcEntry: iso(t.entryTime),
				net0: netPnl(t, t.capital, 0, 50, "1")?.toString() ?? null,
				net25: netPnl(t, t.capital, 0.25, 50, "1")?.toString() ?? null,
				net50: netPnl(t, t.capital, 0.5, 50, "1")?.toString() ?? null,
				net100: netPnl(t, t.capital, 1, 50, "1")?.toString() ?? null,
			})),
		),
	),
	fs.writeFile(path.join(output, "summary.csv"), csv(summary)),
	fs.writeFile(path.join(output, "forward.csv"), csv(forward)),
	fs.writeFile(path.join(output, "pricing.csv"), csv([...engine.pricing.values()])),
]);
const htmlTemplate = await fs.readFile(path.join(root, "research/workbench.html"), "utf8");
// One outcome is reused by several signal rules; do not embed repeated money fields per strategy.
const uniqueOutcomes: Array<Omit<Trial, "strategy" | "features">> = [];
const outcomeIds = new Map<string, number>();
const assignments = trials.map((trial) => {
	const key = JSON.stringify([
		trial.capital,
		trial.poolId,
		trial.signalTime,
		trial.width,
		trial.holdHours,
	]);
	let id = outcomeIds.get(key);
	if (id === undefined) {
		id = uniqueOutcomes.length;
		outcomeIds.set(key, id);
		const { strategy: _strategy, features: _features, ...outcome } = trial;
		uniqueOutcomes.push(outcome);
	}
	return [STRATEGIES.findIndex((s) => s.id === trial.strategy), id];
});
const { trials: _trials, summary: _summary, signals: _signals, ...htmlBase } = results;
const htmlData = {
	...htmlBase,
	features: Object.fromEntries(signals.map((s) => [`${s.poolId}:${s.start + H}`, s.features])),
	outcomes: uniqueOutcomes,
	assignments,
};
await fs.writeFile(
	path.join(output, "index.html"),
	htmlTemplate.replace("/*__RESULTS__*/null", JSON.stringify(htmlData).replaceAll("<", "\\u003c")),
);
const reasons = Object.entries(
	trials.reduce<Record<string, number>>((m, t) => {
		if (t.status !== "modeled") m[t.reason] = (m[t.reason] ?? 0) + 1;
		return m;
	}, {}),
).sort((a, b) => b[1] - a[1]);
const best = summary
	.filter((r) => r.capital === capital && r.half === "second" && r.modeled >= 10)
	.sort((a, b) => new Decimal(b.mean ?? 0).cmp(a.mean ?? 0))
	.slice(0, 10);
const strategyById = new Map(STRATEGIES.map((s) => [s.id, s]));
const stablePositive = summary
	.filter((s) => s.half === "first" && s.modeled >= 10 && new Decimal(s.mean ?? 0).gt(0))
	.filter((a) =>
		summary.some(
			(b) =>
				b.capital === a.capital &&
				b.strategy === a.strategy &&
				b.width === a.width &&
				b.hold === a.hold &&
				b.half === "second" &&
				b.modeled >= 10 &&
				new Decimal(b.mean ?? 0).gt(0),
		),
	);
const signalReview = [
	"baseline",
	"apr-3000",
	"turnover",
	"flat-4h",
	"stable-income",
	"defensive",
	"fee-vs-stress",
]
	.map((id) => {
		const rows = forward.filter((f) => f.horizon === 2 && f.strategies.includes(id));
		const priced = rows.filter((f) => f.priceStress !== null),
			liquid = rows.filter((f) => f.liquidityStress !== null);
		const fees = rows
			.flatMap((f) => (f.futureFeeRate === null ? [] : [new Decimal(f.futureFeeRate)]))
			.sort((a, b) => a.cmp(b));
		const middle = Math.floor(fees.length / 2);
		const median = fees.length
			? fees.length % 2
				? fees[middle]
				: fees[middle - 1]?.plus(fees[middle] ?? 0).div(2)
			: undefined;
		return `|${strategyById.get(id)?.name}|${rows.length}|${priced.filter((f) => f.priceStress).length}/${priced.length}|${liquid.filter((f) => f.liquidityStress).length}/${liquid.length}|${median?.mul(100).toFixed(4) ?? "—"}%|`;
	})
	.join("\n");
const evidence = trials.filter(
	(t) =>
		t.strategy === "baseline" &&
		t.capital === capital &&
		t.width === 0.2 &&
		t.holdHours === 2 &&
		t.status === "modeled",
);
const examplePositive = evidence.find((t) => netPnl(t, t.capital, 0.5, 50, "1")?.gt(0));
const exampleNegative = evidence.find((t) => netPnl(t, t.capital, 0.5, 50, "1")?.lt(-50));
const exampleText = [examplePositive, exampleNegative]
	.flatMap((t) => {
		if (!t) return [];
		const pool = dataset.pools.find((p) => p.poolId === t.poolId);
		return [
			`### ${t.pair} · ${netPnl(t, t.capital, 0.5, 50, "1")?.gt(0) ? "盈利情景样本" : "亏损情景样本"}\n\n- 池：${t.poolId}；链 ${pool?.chainId} / ${pool?.protocol}；代币 ${pool?.token0} / ${pool?.token1}。\n- 信号截止 ${iso(t.signalTime)}，入场 ${iso(t.entryTime)}，退出 ${t.exitTime ? iso(t.exitTime) : "—"}（UTC）。\n- 入场前1H费用/TVL ${(Number(t.features.feeRate ?? 0) * 100).toFixed(4)}%，效率 ${t.features.efficiency?.toFixed(4)}，连续合格 ${t.features.consecutive}H；价格区间 ${t.lower} 至 ${t.upper}（报价资产/非报价资产，已对齐tick）。\n- 库存损益 $${new Decimal(t.inventoryPnl ?? 0).toFixed(2)}，HODL损益 $${new Decimal(t.hodlPnl ?? 0).toFixed(2)}，个人费用代理 $${new Decimal(t.feeProxy ?? 0).toFixed(2)}（仅计50%），研究成本 $${new Decimal(t.capital).mul(0.005).plus(1).toFixed(2)}，净损益 $${netPnl(t, t.capital, 0.5, 50, "1")?.toFixed(2)}。\n- 利润来源解释：${new Decimal(t.feeProxy ?? 0).isZero() ? "该例没有计入手续费，收益/亏损来自库存价格变化，不能当作收费信号有效的证据。" : "费用和库存变化分别列出，不能只把手续费加总当作净利润。"}\n- 退出原因：${t.reason}。可盈利的情景条件是：实际可得费用 > 交易成本 − 库存损益；不是达到入场信号就必赚。\n`,
		];
	})
	.join("\n");
const conclusion = `## 当前结论与信号优先级\n\n在本次固定成本（50bps+$1）、50%费用代理情景中，前后24H各至少10次可计算样本且两段均值为正的配置为 **${stablePositive.length} 组**。这不是证明所有LP策略亏损，而是本数据与本模型尚未筛出经两段验证的盈利规则。某个配置单段微利但未知很多，不足以成为入场建议。\n\n优先继续观察19号收费横盘、12号多窗横盘、21号防撤池，以及23号费用覆盖波动的组合；它们是在减少危险信号方面提供对照，不是本轮验证的盈利策略。APR与费用/TVL在固定1H内只是同一指标的年化换算，不能当成两个独立确认。\n\n以下为信号后延迟1H入场、再观察2H的独立信号结果，不受本金/区间假设影响。缺失和未到期仍留在信号总数中，各风险分母仅为该项可知样本；同池多小时相关，不是独立交易人数。\n\n|信号|总观察|价格跌≥10%/价格可知|TVL缩水≥70%/TVL可知|后续每小时费用/入场TVL中位数|\n|---|---:|---:|---:|---:|\n${signalReview}\n\n价格风险、收费强度和美元净利润是三件事，不能互相代替。后续应优先保存每次原始信号快照、分钟或逐笔价格、tick流动性与仓位份额，再验证这些候选组合；本次不改生产采集范围。\n\n## 同一基准下的逐池情景示例\n\n${exampleText}\n`;
const report = `> 本文件为原24组入场信号对照。完整退出与滚动研究请看 [新版报告](lifecycle/report.md)。\n\n# 两日信号实验结果\n\n导出版本 ${dataset.revision}，冻结截止 ${dataset.asOf}。完整测试区间 ${iso(dataset.start)} 至 ${iso(dataset.end)}（UTC）；共 ${dataset.pools.length} 池、${dataset.tokens.length} 个代币资料、${signals.length} 个合格完整小时观察。小时档 ${dataset.hours.length} 条（含预热和当前小时）。\n\n## 使用\n\n打开 index.html 筛选信号、区间宽度、持时、前后半段、费用分摊和成本；点击汇总行查看逐笔结果。CSV 与 dataset.json 为独立导出；金额字符串保留精度。trials 里重复出现的不同策略不是独立本金组合，汇总总额也不是一份账户收益。\n\n## 研究条件\n\n本金 $${capitals.join(" / $")}/笔分别对照（本报告榜单为 $${capital}），信号使用已结束小时，延迟一小时入场，逐池不重叠。总宽 2%/10%/20%，上限 1/2/4H，按 tick spacing 向外对齐；HYPE 等报价资产转成同小时美元价格。默认往返成本 50bps+$1，费用按全池资金占比的50%情景，不是实测。缺档、撤池或冲击过大记未知，数据末尾记未到期。所有费用来源仍为 estimated，未补做跨 tick 精确取整。\n\n未来持有期缺档不能按零收益或成功退出处理。研究的未知全损压力情景并非实际损失推断，超出本金占比或缺少定价路径的未入场样本也在其中，所以它是完整不可计算集的极端假设，不能当预期损失，只用于避免仅展示可计算样本造成幸存偏差。无法由48小时识别稳定盈利；回填历史不是可实时部署证据。\n\n## 后24H探索榜（仅可计算>=10次，默认情景，未按未知压力筛选）\n\n|信号|总宽|持有上限|可算|未知|未到期|均值USD|模型胜率|未知全损压力总额|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${best.map((r) => `|${strategyById.get(r.strategy)?.name}|${r.width * 100}%|${r.hold}H|${r.modeled}|${r.unknown}|${r.censored}|${new Decimal(r.mean ?? 0).toFixed(2)}|${((r.winRate ?? 0) * 100).toFixed(1)}%|${new Decimal(r.stressTotal).toFixed(2)}|`).join("\n")}\n\n## 不可计算与未到期原因（跨策略/区间重复计数）\n\n${reasons.map(([k, v]) => `- ${k}：${v}`).join("\n")}\n\n## 策略与进出规则\n\n${STRATEGIES.map((s) => `### ${s.name}\n\n入场信号：${s.rule}。依据：${s.rationale}\n\n在信号小时结束后延迟1H，使用入场小时开始边界价格。三个总宽与三个持时均分别测试。小时末发现出区间退出，否则达到持时退出；本实验不能保证盘中出区间实时退出。\n`).join("\n")}\n## 数据与方法边界\n\n- 选池包含两日曾合格的池，保留其后不合格小时。当前未完成小时的观察池也导出，但不加入正式信号。已经被4天清理删除的历史无法恢复。\n- 信号价格动量对有官方稳定币/HYPE报价的交易对统一为非报价资产价格；原始六窗输出保留 token1/token0 方向，不与生产字段混淆。\n- 无历史发布快照、逐笔成交价格路径、tick流动性分布、个人手续费份额、历史gas/税费与可成交报价。故这是条件筛选和集中库存模型，不是精确LP收益回测。\n- 价格主要取精确下一小时起始边界，缺此边界时用当小时最后成交价；后者可能陈旧，且小时内往返越界不可见。区间外小时费用保守不分配，区间内也不能证明全小时在区间。0/25/50/100%费用只是情景，不是真实上下界。\n- poolId + chainId + protocol + 代币地址一起保留，不按同名币合并；当前钱包/开仓及扫描完全未修改。\n- 参考 CJ、Uniswap、Revert、Barker、LP Agent 的方法，链接与适用范围见 docs/03-data/06-signal-research.md；实验阈值由本工具制定，不冒充网站参数。\n\n复现：\n\n\`node --import tsx research/run.ts --input outputs/signal-research/dataset.json --out outputs/signal-research --capital ${capital}\`\n\n报价来源详见 pricing.csv：按前一小时已知TVL排序、至少$1,000；本次独立桥接报价不改生产代码。
\n数据 SHA256：${results.dataHash}\n`;
await fs.writeFile(
	path.join(output, "report.md"),
	report.replace("## 使用", `${conclusion}\n## 使用`),
);
console.log(
	JSON.stringify(
		{
			output,
			signals: signals.length,
			trials: trials.length,
			status: trials.reduce<Record<string, number>>((m, t) => {
				m[t.status] = (m[t.status] ?? 0) + 1;
				return m;
			}, {}),
			top: best.slice(0, 3),
		},
		null,
		2,
	),
);
