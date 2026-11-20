import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EFFICIENCY_BOOKS, efficiencySignals } from "./efficiency.ts";
import { type Dataset, netPnl, ResearchEngine } from "./engine.ts";
import {
	type Account,
	describe,
	type Paired,
	PLAYBOOKS,
	rollAccount,
	runPaired,
} from "./lifecycle.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const efficiencyProfile = arg("--profile") === "efficiency";
const books = efficiencyProfile ? EFFICIENCY_BOOKS : PLAYBOOKS;
const input = path.resolve(
	arg("--input") ?? path.join(root, "outputs/signal-research/dataset.json"),
);
const output = path.resolve(
	arg("--out") ??
		path.join(
			root,
			efficiencyProfile
				? "outputs/signal-research/efficiency"
				: "outputs/signal-research/lifecycle",
		),
);
const text = await fs.readFile(input, "utf8"),
	data = JSON.parse(text) as Dataset;
if (data.schema !== 1) throw new Error("Unsupported frozen data schema");
const defaultCapture = data.positionFeeGrowth ? 1 : 0.5;
const engine = new ResearchEngine(data),
	signals = efficiencyProfile ? efficiencySignals(engine) : engine.signals();
const pairs: Paired[] = [],
	accounts: Account[] = [];
const summaries: Array<
	{
		book: string;
		capital: string;
		delay: number;
		capture: number;
		half: string;
		matched: number;
		pairedDelta: number | null;
		control: ReturnType<typeof describe>;
	} & ReturnType<typeof describe>
> = [];
for (const capital of efficiencyProfile ? ["100", "200", "1000"] : ["100", "1000"])
	for (const delay of [0, 1])
		for (const capture of data.positionFeeGrowth ? [1] : [0, 0.5, 1]) {
			const scene = { capital, delay, capture };
			for (const b of books) {
				const rows = runPaired(engine, signals, b, scene);
				pairs.push(...rows);
				for (const half of ["all", "first", "second"]) {
					const subset = rows.filter((r) => half === "all" || r.dynamic.half === half);
					const matched = subset.filter(
						(r) => r.dynamic.status === "modeled" && r.control.status === "modeled",
					);
					const delta = matched.map(
						(r) =>
							Number(netPnl(r.dynamic, capital, capture, 50, "1")) -
							Number(netPnl(r.control, capital, capture, 50, "1")),
					);
					summaries.push({
						book: b.id,
						...scene,
						half,
						...describe(
							subset.map((r) => r.dynamic),
							capture,
						),
						matched: matched.length,
						pairedDelta: delta.length ? delta.reduce((a, v) => a + v, 0) / delta.length : null,
						control: describe(
							subset.map((r) => r.control),
							capture,
						),
					});
				}
				for (const mode of ["withdraw", "compound", "recover"] as const)
					accounts.push(rollAccount(engine, signals, b, scene, mode));
			}
			console.log(
				`完成 $${capital} delay=${delay}H capture=${capture}: ${books.length}套策略及滚动账户`,
			);
		}
const serialBooks = books.map(({ test: _, width: __, ...b }) => b);
const reasons: Record<string, number> = {};
for (const r of pairs) reasons[r.dynamic.reason] = (reasons[r.dynamic.reason] ?? 0) + 1;
const result = {
	schema: 2,
	calibration: data.calibration
		? {
				...data.calibration,
				personalFeesCalibrated: false,
				actualFeeFormulaVerified: Boolean(data.positionFeeGrowth),
				feeMethod: data.positionFeeGrowth ? "position_growth" : "legacy_proxy",
				actualFeeReplay: data.positionFeeGrowth
					? JSON.parse(
							await fs.readFile(
								path.join(
									root,
									"outputs/signal-research/wallet-calibration/position-fee-replay.json",
								),
								"utf8",
							),
						)
					: null,
				personalPnl: null,
				baseline: JSON.parse(
					await fs.readFile(
						path.join(root, "outputs/signal-research/wallet-calibration/integration-baseline.json"),
						"utf8",
					),
				)[efficiencyProfile ? "efficiency" : "lifecycle"].summaries,
				wallet: JSON.parse(
					await fs.readFile(
						path.join(root, "outputs/signal-research/wallet-calibration/wallet-boundaries.json"),
						"utf8",
					),
				).snapshots,
				feeCheck: JSON.parse(
					await fs.readFile(
						path.join(root, "outputs/signal-research/wallet-calibration/wallet-audit.json"),
						"utf8",
					),
				).summary,
				activeShares: JSON.parse(
					await fs.readFile(
						path.join(root, "outputs/signal-research/wallet-calibration/active-shares.json"),
						"utf8",
					),
				),
				eventHref:
					path
						.relative(
							output,
							path.join(
								root,
								"outputs/signal-research/wallet-calibration",
								efficiencyProfile ? "event-efficiency" : "event-lifecycle",
							),
						)
						.replaceAll("\\", "/") + "/",
				comparisonHref: path
					.relative(
						output,
						path.join(root, "outputs/signal-research/wallet-calibration/integration-results.html"),
					)
					.replaceAll("\\", "/"),
			}
		: null,
	data: {
		revision: data.revision,
		start: data.start,
		end: data.end,
		asOf: data.asOf,
		pools: data.pools.length,
		observations: signals.length,
		hash: createHash("sha256").update(text).digest("hex"),
	},
	books: serialBooks,
	summaries,
	pairs,
	accounts,
	reasons,
};
const csv = (rows: Record<string, unknown>[]) => {
	const keys = Object.keys(rows[0] ?? {});
	const cell = (v: unknown) =>
		`"${String(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
	return (
		"\ufeff" +
		[keys.map(cell).join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join(
			"\r\n",
		)
	);
};
const checks = pairs.flatMap((r) =>
	(r.dynamic.checkpoints ?? []).map((c) => ({
		book: r.book,
		...r.scenario,
		poolId: r.dynamic.poolId,
		signalTime: r.dynamic.signalTime,
		...c,
	})),
);
const trades = pairs.flatMap((r) =>
	[true, false].map((dynamic) => {
		const t = dynamic ? r.dynamic : r.control;
		return {
			...r.scenario,
			book: r.book,
			mode: dynamic ? "dynamic" : "control",
			...t,
			net: netPnl(t, t.capital, r.scenario.capture, 50, "1")?.toString() ?? null,
			breakEvenTotalCost:
				t.status === "modeled"
					? Number(t.inventoryPnl) + Number(t.feeProxy) * r.scenario.capture
					: null,
		};
	}),
);
const good = summaries.filter(
	(r) =>
		r.half === "first" &&
		r.modeled >= 10 &&
		(r.mean ?? -Infinity) > 0 &&
		summaries.some(
			(s) =>
				s.book === r.book &&
				s.capital === r.capital &&
				s.delay === r.delay &&
				s.capture === r.capture &&
				s.half === "second" &&
				s.modeled >= 10 &&
				(s.mean ?? -Infinity) > 0,
		),
);
const defaultRows = summaries.filter(
	(s) => s.capital === "1000" && s.delay === 0 && s.capture === defaultCapture && s.half === "all",
);
const rowText = defaultRows
	.map(
		(s) =>
			`|${serialBooks.find((b) => b.id === s.book)?.name}|${s.attempts}/${s.modeled}|${s.unknown}/${s.skipped}/${s.censored}|${s.mean?.toFixed(2) ?? "—"}|${s.meanHours?.toFixed(2) ?? "—"}|${s.matched}|${s.pairedDelta?.toFixed(2) ?? "—"}|`,
	)
	.join("\n");
const accountText = accounts
	.filter(
		(a) =>
			a.scenario.capital === "1000" &&
			a.scenario.delay === 0 &&
			a.scenario.capture === defaultCapture,
	)
	.map(
		(a) =>
			`|${a.book}|${a.mode}|${a.status}|${a.trades.length}|${Number(a.realizedPnl).toFixed(2)}|${Number(a.withdrawn).toFixed(2)}|${Number(a.cash).toFixed(2)}|${Number(a.atRisk).toFixed(2)}|${a.finalEquity === null ? "未知" : Number(a.finalEquity).toFixed(2)}|`,
	)
	.join("\n");
const examples = pairs.filter(
	(r) =>
		r.scenario.capital === "1000" &&
		r.scenario.delay === 0 &&
		r.scenario.capture === defaultCapture &&
		r.dynamic.status === "modeled",
);
const selectedExamples = [
	examples.find((r) => r.dynamic.reason.includes("费用不足")),
	examples.find((r) => r.dynamic.reason.includes("不足入场")),
	examples.find((r) => r.dynamic.reason.includes("止盈")),
	examples.find((r) => r.dynamic.reason.includes("止损")),
].filter((r): r is Paired => !!r);
const exampleText = selectedExamples
	.map(
		(r) =>
			`### ${r.book} · ${r.dynamic.pair}\n\n池 ${r.dynamic.poolId}；信号 ${new Date(r.dynamic.signalTime * 1000).toISOString()}；入场 ${new Date(r.dynamic.entryTime * 1000).toISOString()}；范围 ${r.dynamic.lower}–${r.dynamic.upper}；退出 ${r.dynamic.exitTime ? new Date(r.dynamic.exitTime * 1000).toISOString() : "未知"}。\n\n${(r.dynamic.checkpoints ?? []).map((c) => `- ${new Date(c.time * 1000).toISOString()}：库存损益 $${Number(c.inventoryPnl).toFixed(2)}，累计费用代理 $${(Number(c.feeProxy) * r.scenario.capture).toFixed(2)}，扣成本净额 $${Number(c.net).toFixed(2)}；预估下小时费用 $${Number(c.expectedFee).toFixed(2)}，库存下行压力 $${Number(c.nextLossStress).toFixed(2)}；${c.action}。`).join("\n")}\n`,
	)
	.join("\n");
let report = `# 完整LP策略：进场、区间、退出与滚动研究\n\n冻结发布版${data.revision}，北京时间 ${new Date(data.start * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 至 ${new Date(data.end * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。全部结果是Elysium V3/V4小时情景，不是Meteora实盘收益。\n\n## 结论怎么读\n\n本轮有明确入场与逐小时退出，不再只等待固定持有上限。全参数中前后24H各至少10笔可算且均值为正的配置 ${good.length} 个，其中默认50%费用情景 ${good.filter((s) => s.capture === defaultCapture).length} 个；这只是探索筛选，不能称作稳定盈利验证。小时数据仍不能证明分钟级剥头皮。未知和未到期不计成功轮换。\n\n## 默认结果\n\n每笔$1000，完整小时结束边界入场（delay=0理想执行），费用代理50%，往返成本50bps+$1。两天所有可算样本汇总，不是账户收益；跳过表示入场条件不适用，不能按亏损算。\n\n|策略|尝试/可算|未知/跳过/未到期|每笔净额均值$|平均持有H|双方可算配对|动态减控制均值$|\n|---|---:|---:|---:|---:|---:|---:|\n${rowText}\n\n控制组使用同一入场、相同范围，只因出区间或4H到期退出。动态按自身退出时点加1H冷却再找同池信号；配对控制交易可能重叠，仅作退出规则诊断。\n\n## 十一套完整规则\n\n${serialBooks.map((b) => `### ${b.name}\n\n- 入场：原三个准入门槛，加${b.entry}。\n- 范围：${b.rangeText}。报价为报价资产/目标代币，HYPE报价非美元。\n- 退出：${b.exit}${b.coverageExit ? "同时：预估下一小时费用≤库存下行压力+半程退出成本即退出。" : ""}\n- 来源：${b.source}。\n`).join("\n")}\n\n## 费用支撑怎么判断\n\n只用当前及此前完整小时：下一小时费用代理沿用刚结束小时的全池费用×本金/max(入场前TVL,当前TVL,本金)×情景分摊；库存压力用当前价格再下跌max(刚结束小时涨跌绝对值,0.5%)计算集中库存额外损失，报价美元价保持当前值。加半程成本后比较。这是预留退出成本的保守门槛；退出成本并非全部由继续持有新增，不能当作最优停止公式。这是情景规则，不是预测，也不把过去已发生亏损当作继续持有的必要成本。1H净涨跌不是小时高低点/真实波动率。\n\n## 滚动账户\n\n每套策略独立一份$1000，单仓轮换；按当时费用/TVL排序，不按未来利润选池。出利模式提取超出初始本金的现金、亏损不补资；账户本金先预留完整往返成本，不透支支付手续费；复投使用当时剩余现金。本金回收情景在现金达到初始本金2倍时提取初始本金一次，其余继续；未达到不算已出本。未知/未到期即停止，不假设卖掉后继续。closedDrawdown仅平仓节点回撤，不是期间最大回撤。未实现风险本金不能视作亏完，也不能视作已收回。\n\n|策略|模式|状态|入场数|已实现净额$|已提取$|现金$|在险本金$|最终权益$|\n|---|---|---|---:|---:|---:|---:|---:|---:|\n${accountText}\n\n## 具体退出例子（时间UTC）\n\n${exampleText}\n\n## 来源与边界\n\n- [Meteora官方策略](https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases)：Spot均匀、Curve中间集中、BidAsk边缘集中；窄范围与宽范围的取舍、DCA in/out。未把DLMM的分bin算法套到V3。\n- [LP Army公开策略库](https://www.lparmy.com/strategies)：CryptoWhiskers Rabbit摘要强调快进快出、成交量控制持时；Stakepanda提示库存/执行风险。仅核实公开摘要，截断内容不假装完整读过，社区盈利数字不是证据。\n- [Uniswap集中流动性](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity)与[Range Orders](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/range-orders)：区间分批转换、出区间停费；撤池不等于代币已经换回美元，卖出成本仍为情景。\n- [CJ方向性LP](https://suoha888.github.io/Trader-Archives/cj/#t-10)：方向与范围、费用覆盖、退出纪律。\n\n金额仍是费用分摊代理。不能从全池小时费用精确归因个人仓位，窄区间未虚构费用倍数。单边未触及时停费；端点在范围外时不分配该小时费用，无法辨认小时内来回越界，存在遗漏和高估两种可能。滑点、税、MEV、个人tick份额、真实执行延迟未验证。入场前本金占TVL超过5%会跳过；TVL缩水超过70%或持有期缺档会中止并标未知。边界理想入场和延迟1H分开，0/50/100%费用情景分别重算退出与轮换，不能混用路径。冻结小时曾后补，不证明当时信号实时可用。不承诺退出能保证收益。\n`;
if (efficiencyProfile) {
	const profitable = accounts.filter(
		(a) => a.finalEquity !== null && Number(a.finalEquity) > Number(a.scenario.capital),
	);
	const accountRows = accounts.filter(
		(a) =>
			a.scenario.capital === "200" &&
			a.scenario.delay === 0 &&
			a.scenario.capture === defaultCapture &&
			a.mode === "withdraw",
	);
	const summary200 = summaries.filter(
		(s) => s.capital === "200" && s.delay === 0 && s.capture === defaultCapture && s.half === "all",
	);
	report = `# 资金效率与端点波动：1–12H实验

冻结发布版${data.revision}；48完整小时、${data.pools.length}池、${signals.length}准入观察，其中${signals.filter((s) => s.features.motion4).length}有完整四小时端点波动。0.5H缺价格路径，未执行。

四类策略×1/2/4/6/12H上限×信号/压力两种退出，$100/$200/$1000，delay=0/1H，费用代理0/50/100%。每组分别重算退出和账户。

## $200默认结果

边界理想入场、50%费用代理、往返50bps+$1（$200为$2，非实测）。下表为每笔独立本金结果；账户单仓出利使用预留成本后的可投资本金。

|策略|尝试/可算|未知/跳过/未到期|每笔均值$|胜率|平均持有H|账户状态|账户交易数|账户最终权益$|
|---|---:|---:|---:|---:|---:|---|---:|---:|
${summary200
	.map((s) => {
		const a = accountRows.find((a) => a.book === s.book);
		return `|${serialBooks.find((b) => b.id === s.book)?.name}|${s.attempts}/${s.modeled}|${s.unknown}/${s.skipped}/${s.censored}|${s.mean?.toFixed(2) ?? "—"}|${s.modeled ? ((100 * s.wins) / s.modeled).toFixed(1) + "%" : "—"}|${s.meanHours?.toFixed(2) ?? "—"}|${a?.status}|${a?.trades.length}|${a?.finalEquity == null ? "未知" : Number(a.finalEquity).toFixed(2)}|`;
	})
	.join("\n")}

## 退出与成本诊断

信号退出取消旧库存压力门槛，其余退出不变；压力退出保留。默认情景下信号退出与压力退出平均持时分别为${summaries
		.filter(
			(s) =>
				s.half === "all" &&
				s.capital === "200" &&
				s.delay === 0 &&
				s.capture === defaultCapture &&
				s.book.endsWith("-signal"),
		)
		.map((s) => s.meanHours?.toFixed(2) ?? "—")
		.join(" / ")}H 与 ${summaries
		.filter(
			(s) =>
				s.half === "all" &&
				s.capital === "200" &&
				s.delay === 0 &&
				s.capture === defaultCapture &&
				!s.book.endsWith("-signal"),
		)
		.map((s) => s.meanHours?.toFixed(2) ?? "—")
		.join(
			" / ",
		)}H（按策略表顺序）。交易CSV的breakEvenTotalCost是库存损益+该情景费用代理，正值表示该笔路径最多能承担的总成本；负值表示这条路径在零成本下也亏，不能靠降低成本变为盈利。

## 全参数结果与限制

${profitable.length}/${accounts.length}个账户情景在完整48H闭环后最终权益为正增长。不同费用假设、本金和出利方式相关，不能说成这么多独立盈利策略。前后24H各至少10笔可算且均值为正的配置${good.length}个。这是探索性样本，不是稳定盈利证明。

手续费仍按本金/全池TVL分摊，未还原真实个人活跃tick份额；窄区间实际费用可能与代理差异很大。端点RMS可发现小时之间往返，但不能发现小时内往返，非分钟高低点。止损/止盈只在小时末触发，无法保证成交。缺档/撤池为未知，未到期不视为亏损或已退出。真实钱包校准未完成。

## 规则

${serialBooks.map((b) => `- **${b.name}**：入场${b.entry}；范围${b.rangeText}；退出${b.exit}。`).join("\n")}

## 核查入口

同目录index.html可切换策略、本金、费用、延迟及前后24H；trades.csv含逐笔库存、费用与盈亏平衡可承受成本，checkpoints.csv含资金效率保留及端点RMS，accounts.csv含资金轮换。控制组与动态同入场/区间/上限，仅出区间/到期，不把配对收益当可执行账户。
`;
}
const pageData = {
	...result,
	pairs: pairs.map((r) => {
		const { features: _, ...dynamic } = r.dynamic;
		const t = r.control;
		return {
			...r,
			dynamic: efficiencyProfile ? { ...dynamic, features: r.dynamic.features } : dynamic,
			control: {
				status: t.status,
				capital: t.capital,
				inventoryPnl: t.inventoryPnl,
				feeProxy: t.feeProxy,
			},
		};
	}),
	accounts: accounts.map((a) => ({
		...a,
		trades: a.trades.map((t) => ({
			pair: t.pair,
			entryTime: t.entryTime,
			exitTime: t.exitTime,
			capital: t.capital,
			reason: t.reason,
		})),
	})),
};
if (data.calibration) {
	report = `> ${data.calibration.label}。原策略参数、费用代理和成本保持不变；个人净利润未确认。真实仓位基准及原/新对照见 wallet-calibration/integration-results.html。\n\n${report}`;
	if (data.calibration.scope === "event")
		report = report
			.replaceAll("48完整小时", `${(data.end - data.start) / 3600}完整小时`)
			.replaceAll("前后24H", "前24H与其余时段");
}
if (data.positionFeeGrowth) {
	const defaults = summaries.filter(
		(s) =>
			s.capital === (efficiencyProfile ? "200" : "1000") &&
			s.delay === 0 &&
			s.capture === 1 &&
			s.half === "all",
	);
	report = `# ${efficiencyProfile ? "资金效率与波动" : "完整LP策略"}：实盘校验后的区间手续费模型

实际70笔交易和11次仓位修改已通过共享feeGrowth公式重放。新增费用2.214229052274746233 HYPE + 392.162611772675927052 KNTQ。它们只校验算法，不按比例分给假设策略。

本次策略手续费=对应tick区间的官方feeGrowth增量×假设仓位流动性/Q128，逐币向下取整。没有50%或本金/TVL分摊。出区间前累积的手续费不会被抹零。必须核实tick持有小时内持续初始化；缺证据记未知。

新仓位模型沿用历史市场路径，未模拟新资金改变价格/活跃流动性，不是链上执行净到账。入场、范围、退出参数不变；成本仍为50bps+$1的显式情景，不能当实测。默认本金$${efficiencyProfile ? "200" : "1000"}、边界理想入场。

|策略|尝试|可计算|在险未知|入场跳过|未到期|每笔模型净额均值$|
|---|---:|---:|---:|---:|---:|---:|
${defaults.map((s) => `|${serialBooks.find((b) => b.id === s.book)?.name}|${s.attempts}|${s.modeled}|${s.unknown}|${s.skipped}|${s.censored}|${s.mean?.toFixed(2) ?? "—"}|`).join("\n")}

## 固定策略规则

${serialBooks.map((b) => `### ${b.name}\n\n入场：${b.entry}；范围：${b.rangeText}；退出：${b.exit}`).join("\n\n")}

完整逐笔及账户见同目录results.json、trades.csv与accounts.csv；unknown不能按亏损统计，未触发不等于入场后亏损。旧代理结果与原始输入仍保留用于对照。
`;
}
let template = await fs.readFile(path.join(root, "research/lifecycle.html"), "utf8");
template = template.replace(
	"/*__SIGNAL_INDEX__*/",
	path
		.relative(output, path.join(root, "outputs/signal-research/index.html"))
		.replaceAll("\\", "/"),
);
if (data.positionFeeGrowth) {
	template = template
		.replace(
			"输入估值已接入；个人收益算法尚未校准。",
			"手续费公式已用你的实盘校验，实验已改用区间feeGrowth。",
		)
		.replace(
			"下方净额仍为原费用代理及成本情景；真实费用与新区间缺少完整逐笔分配，个人策略净利润未确认。小时末出区间而将整小时代理费记零，也可能漏掉出区间前赚取的费用。",
			"每个假设区间按历史每单位流动性手续费增长计算，不按全池TVL分摊、不乘50%，出区间前的增长仍计入。缺少边界或tick持续初始化证据时保留未知。新仓位为市场路径不变的边际模型，成本仍是假设，不是实盘净到账。",
		)
		.replace(
			"个人手续费以全池小时费用按资金/较大TVL分摊，不人为给窄区间乘倍数。0/50/100%各自重算路径；费用仍为估算代理。",
			"手续费使用对应区间官方feeGrowth增量×仓位流动性/Q128，按token取整；缺少持续初始化证据保留未知。新资金对历史路径的反作用未模拟，不能当真实可执行净收益。",
		)
		.replaceAll("原48H与重估48H同条件对照", "旧TVL代理与区间feeGrowth对照")
		.replaceAll("重估模型均值", "区间费用模型均值")
		.replace(
			"same(o)&&o.book",
			"o.capital===$('capital').value&&o.delay===Number($('delay').value)&&o.capture===0.5&&o.book",
		)
		.replaceAll("原模型均值", "旧50%代理均值");
	template = template
		.replace(
			'<option value="0">0%</option><option value="0.5" selected>50%</option><option value="1">100%</option>',
			'<option value="1" selected>区间feeGrowth · 不打折</option>',
		)
		.replaceAll("费用代理情景（重新计算退出路径）", "手续费算法")
		.replaceAll("费用代理", "区间费用模型")
		.replaceAll("$('capture').value='0.5'", "$('capture').value='1'")
		.replaceAll("Number($('capture').value)", "1");
	report = `> 手续费已改为对应区间官方feeGrowth×仓位流动性，不再使用本金/TVL或50%。只在tick持续初始化证据齐全时计算，其他保留未知。新仓位为历史路径不变的边际模型，执行成本仍是假设。\n\n${report}`;
}
template = template.replace(
	'href="../dataset.json"',
	`href="${path.relative(output, input).replaceAll("\\", "/")}"`,
);
if (data.calibration?.scope === "event")
	template = template
		.replaceAll("两日全部", "事件期全部")
		.replaceAll("后24H", "其余时段")
		.replaceAll("完整48H", "完整事件期")
		.replaceAll("前24H", "首24H");
if (efficiencyProfile)
	template = template
		.replaceAll("完整策略与滚动研究", "资金效率与波动 · 1–12H研究")
		.replace("十一套完整策略", "四类策略 × 五个持仓上限 × 两种退出")
		.replace(
			'value="100">$100</option>',
			'value="100">$100</option><option value="200" selected>$200</option>',
		)

		.replaceAll("或4H上限", "或对应持仓上限")
		.replace("let chosen='flat-medium'", "let chosen=R.books[0].id")
		.replace("chosen='flat-medium';", "chosen=R.books[0].id;")
		.replace("$('capital').value='1000';", "$('capital').value='200';")
		.replace("股票式日内最高最低、分钟波动", "小时内最高最低、分钟波动")
		.replace("<th>成交保留</th>", "<th>资金效率保留 / 端点RMS</th><th>成交保留</th>")
		.replace(
			"<td>'+pct(c.volumeRatio)",
			"<td>'+pct(c.efficiencyRatio)+' / '+pct(c.endpointRms)+'</td><td>'+pct(c.volumeRatio)",
		)
		.replace('colspan="9"', 'colspan="10"')
		.replace("<th>库存损益 $</th>", "<th>效率 / 端点RMS / 振幅</th><th>库存损益 $</th>")
		.replace(
			"<td>'+money(t.inventoryPnl)",
			"<td>'+money(t.features?.efficiency)+' / '+pct(t.features?.motion4?.rms)+' / '+pct(t.features?.motion4?.excursion)+'</td><td>'+money(t.inventoryPnl)",
		)
		.replace(
			"本页为小时级离线情景；",
			"本页持仓上限1/2/4/6/12H，每小时观察；半小时未测试。波动是4H采样端点RMS及振幅，非小时内真实波动；",
		);
await fs.mkdir(output, { recursive: true });
await Promise.all([
	fs.writeFile(path.join(output, "results.json"), JSON.stringify(result)),
	fs.writeFile(path.join(output, "summary.csv"), csv(summaries)),
	fs.writeFile(path.join(output, "trades.csv"), csv(trades)),
	fs.writeFile(path.join(output, "checkpoints.csv"), csv(checks)),
	fs.writeFile(
		path.join(output, "accounts.csv"),
		csv(accounts.map(({ trades: _, ...a }) => ({ ...a, scenario: a.scenario }))),
	),
	fs.writeFile(path.join(output, "report.md"), "\uFEFF" + report, "utf8"),
	fs.writeFile(
		path.join(output, "index.html"),
		template.replace("/*__DATA__*/null", JSON.stringify(pageData).replaceAll("<", "\\u003c")),
	),
]);
console.log(
	JSON.stringify({
		pairs: pairs.length,
		accounts: accounts.length,
		good: good.length,
		output,
		reasons,
	}),
);
