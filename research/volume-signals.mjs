import assert from "node:assert/strict";
import fs from "node:fs";
import { isHypeLike, isOfficialUsdStable } from "../src/normalize/prices.ts";
import { feeDataUsable } from "../src/shared/fee-quality.ts";
import { netPnl, ResearchEngine } from "./engine.ts";

const root = "outputs/signal-research",
	dir = `${root}/wallet-calibration`,
	H = 3600;
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const median = (xs) => {
	const a = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
	return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null;
};
const fmt = (n) => (n === null ? "缺数据" : Number(n).toFixed(2));
const pct = (n) => (n === null ? "缺数据" : `${fmt(n * 100)}%`);
const date = (n) =>
	new Date(n * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const ratio = (a, b) => (a !== null && b !== null && b > 0 ? a / b : null);
const number = (v) => (v === null || v === undefined ? null : Number(v));
const state = (f) =>
	f.price1 === null
		? "价格缺失"
		: f.price4 === null
			? "仅有1H方向"
			: Math.abs(f.price1) <= 0.02 && Math.abs(f.price4) <= 0.04
				? "横盘端点"
				: f.price1 > 0 && f.price4 > 0
					? "1H与4H同涨"
					: f.price1 > 0
						? "反弹：1H涨、4H未涨"
						: "转弱或下跌";
const efficiencyBand = (e) =>
	e === null
		? "缺失"
		: e < 0.5
			? "<0.5"
			: e < 1
				? "0.5–1"
				: e < 3
					? "1–3"
					: e < 10
						? "3–10"
						: "≥10";

const allMarket = process.argv.includes("--all-pools");
const result = {
	method: allMarket
		? "all_historically_qualified_pool_hours"
		: "completed_hour_volume_fee_acceleration_and_efficiency_growth",
	datasets: [],
};
for (const [label, file] of [
	["原48H", `${root}/dataset-growth.json`],
	["KNTQ事件期", `${dir}/event-growth-dataset.json`],
]) {
	if (allMarket && label !== "原48H") continue;
	const data = load(file),
		engine = new ResearchEngine(data),
		pools = new Map(data.pools.map((p) => [p.poolId, p]));
	const signals = engine.signals();
	const coverage = new Set(
		data.coverage
			.filter((h) => h.complete && !h.gapReason)
			.map((h) => `${h.chainId}:${h.protocol}:${h.windowStart}`),
	);
	const valid = (p, t) => {
		const r = engine.row(p, t);
		return r?.complete &&
			coverage.has(`${p.chainId}:${p.protocol}:${t}`) &&
			feeDataUsable(r.feeStatus ?? "legacy_unverified") &&
			r.volumeUsd !== null &&
			r.lpFeesUsd !== null &&
			Number(r.tvlUsd) > 0
			? r
			: null;
	};
	const metrics = (p, t) => {
		const r = valid(p, t),
			a = valid(p, t - H),
			b = valid(p, t - 2 * H);
		if (!r || !a || !b) return null;
		return {
			volume: ratio(number(r.volumeUsd), (Number(a.volumeUsd) + Number(b.volumeUsd)) / 2),
			fees: ratio(number(r.lpFeesUsd), (Number(a.lpFeesUsd) + Number(b.lpFeesUsd)) / 2),
			efficiency: ratio(
				Number(r.volumeUsd) / Number(r.tvlUsd),
				Number(a.volumeUsd) / Number(a.tvlUsd),
			),
		};
	};
	const passes = (m, k) =>
		!!m &&
		m.volume !== null &&
		m.fees !== null &&
		m.efficiency !== null &&
		m.volume >= k &&
		m.fees >= k &&
		m.efficiency > 1;
	const forward = (s, n) => {
		const p = pools.get(s.poolId),
			start = s.start + H,
			base = valid(p, s.start);
		if (start + n * H > data.end) return { status: "未到期" };
		const rows = Array.from({ length: n }, (_, i) => valid(p, start + i * H));
		if (rows.some((r) => !r)) return { status: "缺档" };
		const fees = rows.reduce((v, r) => v + Number(r.lpFeesUsd), 0),
			volume = rows.reduce((v, r) => v + Number(r.volumeUsd), 0);
		const first = engine.row(p, start),
			last = engine.row(p, start + (n - 1) * H);
		const quote0 =
			isOfficialUsdStable(p.token0) || (!isOfficialUsdStable(p.token1) && isHypeLike(p.token0));
		const a = number(first?.sqrtPriceStart),
			b = number(last?.sqrtPriceEnd);
		const price = a > 0 && b > 0 ? (quote0 ? (a / b) ** 2 : (b / a) ** 2) - 1 : null;
		return {
			status: "可观察",
			hourlyFeeRetention: fees / n / Number(base.lpFeesUsd),
			hourlyVolumeRetention: volume / n / Number(base.volumeUsd),
			cumulativeFeesPerEntryTvl: fees / Number(base.tvlUsd),
			quotePriceReturn: price,
		};
	};
	const rows = signals.map((s) => ({
		...s,
		time: s.start + H,
		state: state(s.features),
		efficiencyBand: efficiencyBand(s.features.efficiency),
		metrics: metrics(pools.get(s.poolId), s.start),
	}));
	const summarize = (xs) => {
		const periods = {};
		for (const n of [1, 4]) {
			const obs = xs.map((s) => forward(s, n)),
				good = obs.filter((x) => x.status === "可观察");
			periods[n] = {
				observed: good.length,
				missing: obs.filter((x) => x.status === "缺档").length,
				censored: obs.filter((x) => x.status === "未到期").length,
				feeRetention: median(good.map((x) => x.hourlyFeeRetention)),
				volumeRetention: median(good.map((x) => x.hourlyVolumeRetention)),
				feesPerTvl: median(good.map((x) => x.cumulativeFeesPerEntryTvl)),
				priceReturn: median(good.map((x) => x.quotePriceReturn)),
				feeNotHalved: good.length
					? good.filter((x) => x.hourlyFeeRetention >= 0.5).length / good.length
					: null,
			};
		}
		return { signals: xs.length, pools: new Set(xs.map((x) => x.poolId)).size, periods };
	};
	const thresholds = [1.5, 2, 3].map((k) => {
		let previousUnknown = 0;
		const selected = rows.filter((s) => {
			if (!passes(s.metrics, k)) return false;
			const previous = metrics(pools.get(s.poolId), s.start - H);
			if (!previous || Object.values(previous).some((x) => x === null)) {
				previousUnknown++;
				return false;
			}
			return !passes(previous, k);
		});
		return {
			threshold: k,
			previousUnknown,
			...summarize(selected),
			signalsDetail: selected.map((s) => ({
				...s,
				forward1: forward(s, 1),
				forward4: forward(s, 4),
			})),
		};
	});
	const primary = allMarket ? rows : thresholds.find((t) => t.threshold === 2).signalsDetail;
	const groups = {};
	for (const field of ["state", "efficiencyBand"])
		groups[field] = [...new Set(primary.map((s) => s[field]))].map((value) => ({
			value,
			...summarize(primary.filter((s) => s[field] === value)),
		}));
	const halves = [0, 1].map((i) => ({
		half: i === 0 ? "首24H" : "其余时段",
		...summarize(
			primary.filter((s) =>
				i === 0 ? s.time <= data.start + 24 * H : s.time > data.start + 24 * H,
			),
		),
	}));
	// These are independent opportunities, not an executable single-wallet portfolio.
	const trials = [];
	for (const s of primary)
		for (const width of [0.01, 0.02, 0.04, 0.08]) {
			assert(s.time <= data.end);
			const trial = engine.trial(s, `volume-${width}`, {
				width,
				holdHours: 4,
				delayHours: 0,
				capital: "200",
				lifecycle: {
					range: s.state === "1H与4H同涨" ? "up" : "symmetric",
					dynamic: false,
					capture: 1,
					costBps: 50,
					fixedCost: "1",
					stop: 0.02,
					take: 0.02,
					trail: 0.01,
					coverageExit: false,
				},
			});
			assert.equal(trial.feeBasis, "position_growth");
			if (trial.status === "modeled") {
				assert(trial.exitTime > trial.entryTime && trial.entryTime >= s.time);
				const expected = Number(trial.inventoryPnl) + Number(trial.feeProxy) - 2;
				assert(Math.abs(Number(netPnl(trial, "200", 1, 50, "1")) - expected) < 1e-8);
			}
			trials.push({
				width,
				state: s.state,
				...trial,
				actualWidth:
					trial.lower === null
						? null
						: (Number(trial.upper) - Number(trial.lower)) / Number(trial.entryPrice),
				net: trial.status === "modeled" ? netPnl(trial, "200", 1, 50, "1").toString() : null,
				relativeToHold:
					trial.status === "modeled" ? Number(trial.divergence) + Number(trial.feeProxy) - 2 : null,
			});
		}
	const ranges = [0.01, 0.02, 0.04, 0.08].map((width) => {
		const xs = trials.filter((t) => t.width === width),
			good = xs.filter((t) => t.net !== null);
		return {
			width,
			attempts: xs.length,
			modeled: good.length,
			unknown: xs.filter((t) => t.status === "unknown").length,
			censored: xs.filter((t) => t.status === "censored").length,
			positive: good.filter((t) => Number(t.net) > 0).length,
			medianNet: median(good.map((t) => Number(t.net))),
			medianRelativeToHold: median(good.map((t) => t.relativeToHold)),
		};
	});
	result.datasets.push({
		label,
		start: data.start,
		end: data.end,
		baseline: summarize(rows),
		catalogPools: data.pools.map((p) => ({
			poolId: p.poolId,
			pair: engine.pair(p),
			protocol: p.protocol,
			signalCount: rows.filter((s) => s.poolId === p.poolId).length,
		})),
		thresholds,
		groups,
		halves,
		ranges,
		trials,
	});
}

const escapeHtml = (s) =>
	String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const table = (headers, rows) =>
	`<div class="scroll"><table><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
let html = `<h1>放量信号：先发现机会，再核对区间收益</h1><p>规则只用已结束小时：成交与LP手续费同时达到此前2小时均值的1.5/2/3倍，且资金效率高于前1小时。连续满足只取已知前态不满足的首次。没有效率≥1或上涨幅度上限。2倍只是统一观察组，未按利润挑选。</p><p>这是候选量能研究，不是盈利保证。1H数据在小时结束才知道，无法提前识别同小时爆发，插针和首次触边需要更细数据。事件期已看过，只作校准。原48H其他池计价未全部重估。费用/TVL是全池收费密度，不是个人收益率。</p>`;
if (!allMarket) {
	const eventExample = result.datasets[1].trials.find(
		(t) =>
			t.poolId.startsWith("0xc96bfd21") &&
			t.signalTime === Date.parse("2026-11-10T09:00:00+08:00") / 1000 &&
			t.width === 0.01,
	);
	assert(eventExample?.status === "modeled", "User event must remain auditable");
	html += `<h2>先看用户指定的KNTQ起量样本</h2><p>候选信号：成交与费用均达到此前2H均值的2倍，效率上升；再按价格状态选择范围。不是只看效率绝对值。11月10日09点，1%池成交约44.92倍、费用约45.18倍，效率约28.10，1H/4H价格同涨。该小时收盘后触发，未倒推08点已知。</p>`;
	html += table(
		["入场→观察退出", "本金", "目标/实际总宽", "库存损益", "区间手续费", "假设成本", "模型净利润"],
		[
			[
				"11月10日09点→10点",
				"$200",
				`1% / ${pct(eventExample.actualWidth)}`,
				fmt(eventExample.inventoryPnl),
				fmt(eventExample.feeProxy),
				"$2",
				fmt(eventExample.net),
			],
		],
	);
	html += `<p>这一笔手续费覆盖了库存下跌和成本，最终模型资产$${fmt(200 + Number(eventExample.net))}。实际区间${eventExample.lower}—${eventExample.upper} HYPE/KNTQ；tick间隔导致目标1%与2%落在同一组边界，不能当两笔独立证据。10点为小时末发现向下出区间，不是首次触边立即退出；全程仍用历史市场不变的边际模型，没有模拟新资金稀释，不能当可执行实收。它证明此样本有收费机会，不证明每次放量都盈利。</p>`;
}
for (const d of result.datasets) {
	html += `<h2>${escapeHtml(d.label)}：${date(d.start)}—${date(d.end)}</h2>`;
	const all = [{ threshold: "全部合格池小时", ...d.baseline }, ...d.thresholds];
	html += table(
		[
			"信号",
			"次数/池",
			"下1H可观察/缺档/末端",
			"下1H成交保留中位数",
			"下1H手续费保留中位数",
			"下1H费用/信号TVL中位数",
			"下1H手续费未减半比例",
		],
		all.map((t) => {
			const o = t.periods[1];
			return [
				t.threshold,
				t.signals + " / " + t.pools,
				`${o.observed}/${o.missing}/${o.censored}`,
				pct(o.volumeRetention),
				pct(o.feeRetention),
				pct(o.feesPerTvl),
				pct(o.feeNotHalved),
			];
		}),
	);
	for (const [field, title] of [
		["state", allMarket ? "全部合格小时：价格状态" : "2倍信号：价格状态"],
		["efficiencyBand", allMarket ? "全部合格小时：效率水平" : "2倍信号：效率水平"],
	]) {
		html +=
			`<h3>${title}</h3>` +
			table(
				["组别", "次数/池", "下1H可观察", "下1H费用/TVL中位数", "下4H平均手续费保留中位数"],
				d.groups[field].map((g) => [
					g.value,
					`${g.signals}/${g.pools}`,
					g.periods[1].observed,
					pct(g.periods[1].feesPerTvl),
					pct(g.periods[4].feeRetention),
				]),
			);
	}
	html +=
		"<h3>前后时段检查：同一批样本内部对照</h3>" +
		table(
			["时段", "信号次数", "下1H可观察", "手续费保留中位数"],
			d.halves.map((g) => [
				g.half,
				g.signals,
				g.periods[1].observed,
				pct(g.periods[1].feeRetention),
			]),
		);
	html +=
		"<h3>同一信号开$200 LP：最多4H、小时末出区间退出</h3><p>上涨组下侧20%/上侧80%，其他组对称；总宽经tick外扩，实际宽度见JSON。往返成本假设$2；不模拟复投迁移。未知不是亏损；可算小子集不能代表全部候选。</p>" +
		table(
			[
				"目标总宽",
				"尝试",
				"可算",
				"未知",
				"未到期",
				"可算中正净额",
				"可算净额中位数$",
				"相对持币净额中位数$",
			],
			d.ranges.map((r) => [
				pct(r.width),
				r.attempts,
				r.modeled,
				r.unknown,
				r.censored,
				r.positive,
				fmt(r.medianNet),
				fmt(r.medianRelativeToHold),
			]),
		);
	html +=
		"<details><summary>2倍候选逐条时间、指标及后续表现</summary>" +
		table(
			[
				"信号可用时间",
				"池/费率",
				"状态",
				"效率",
				"成交倍数",
				"费用倍数",
				"下1H费用保留",
				"下1H费用/TVL",
			],
			d.thresholds
				.find((t) => t.threshold === 2)
				.signalsDetail.map((s) => [
					date(s.time),
					`${s.pair} · ${s.poolId.slice(0, 12)}`,
					s.state,
					fmt(s.features.efficiency),
					fmt(s.metrics.volume),
					fmt(s.metrics.fees),
					pct(s.forward1.hourlyFeeRetention ?? null),
					pct(s.forward1.cumulativeFeesPerEntryTvl ?? null),
				]),
		) +
		"</details>";
}
if (allMarket) {
	html =
		`<h1>全部历史合格池：逐池跑策略</h1><p>范围为11月11日13点—13日13点冻结历史。全集按原1H三准入，不额外要求放量倍率；不是KNTQ双池专项。全部合格池小时均比较四档目标范围、最多4H、小时末出区间退出，固定$200/次，往返成本假设$2。不模拟单钱包复投迁移，独立机会有重叠，禁止合计为单账户利润。收益算法是区间feeGrowth边际模型。</p>` +
		html.slice(html.indexOf("<h2>原48H"));
	const d = result.datasets[0];
	const perPool = d.catalogPools.map((p) => {
		const xs = d.trials.filter((t) => t.poolId === p.poolId),
			good = xs.filter((t) => t.net !== null);
		const reasons = [...new Set(xs.filter((t) => t.net === null).map((t) => t.reason))].join("；");
		return {
			...p,
			attempts: xs.length,
			modeled: good.length,
			positive: good.filter((t) => Number(t.net) > 0).length,
			medianNet: median(good.map((t) => Number(t.net))),
			reasons,
		};
	});
	d.perPool = perPool;
	html +=
		"<h2>全池清单：不删除未知池</h2>" +
		table(
			["池", "协议", "完整准入小时", "四范围尝试", "可算", "正净额", "可算净额中位数$", "未算原因"],
			perPool.map((p) => [
				`${p.pair} ${p.poolId}`,
				p.protocol,
				p.signalCount,
				p.attempts,
				p.modeled,
				p.positive,
				fmt(p.medianNet),
				p.signalCount === 0 ? "无可用完整准入信号，当前小时或覆盖不足" : p.reasons,
			]),
		);
	html +=
		"<h2>全部逐笔结果</h2><p>目标范围不等于tick对齐后的实际宽度。下面保留入场跳过/未知，不能按亏损。每个信号四个独立对照不能算四份独立证据。</p>" +
		table(
			["池", "入场→退出", "目标/实际宽度", "状态/原因", "库存损益$", "区间费用$", "净额$"],
			d.trials.map((t) => [
				`${t.pair} ${t.poolId.slice(0, 12)}`,
				`${date(t.entryTime)} → ${t.exitTime === null ? "未知" : date(t.exitTime)}`,
				`${pct(t.width)} / ${pct(t.actualWidth)}`,
				`${t.status} ${t.reason}`,
				fmt(t.inventoryPnl),
				fmt(t.feeProxy),
				fmt(t.net),
			]),
		);
}
html +=
	"<p>结论边界：比较的是已收盘后出现的量能信号，不能倒填为提前预测。样本重复、组间费率差异、缺档与小样本都会影响统计，不能由此直接设生产阈值。区间未初始化或小时内清零的费用需要逐笔路径证据，禁止用全池分摊补出收益。</p><p><a href='volume-signals.json'>逐条信号与区间结果JSON</a> · <a href='../efficiency/'>原效率实验</a> · <a href='integration-results.html'>手续费算法核对</a></p>";
const outputName = allMarket ? "all-pool-strategies" : "volume-signals";
html = html.replaceAll("href='volume-signals.json'", `href='${outputName}.json'`);
fs.writeFileSync(`${dir}/${outputName}.json`, JSON.stringify(result, null, 2), "utf8");
fs.writeFileSync(
	`${dir}/${outputName}.html`,
	`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LP Atlas · 放量信号复盘</title><style>body{max-width:1350px;margin:30px auto;padding:0 24px;font:16px/1.8 system-ui,"Microsoft YaHei";background:#0b1412;color:#e0eae3}h1{font-size:26px}h2{margin-top:40px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:10px;border:1px solid #3b5746;text-align:left}th{background:#1e3025}.scroll{overflow:auto}a,summary{color:#c6ff6e}summary{cursor:pointer}</style>${html}</html>`,
	"utf8",
);
console.log(
	JSON.stringify(
		result.datasets.map((d) => ({
			label: d.label,
			thresholds: d.thresholds.map(({ signalsDetail, ...s }) => s),
			ranges: d.ranges,
			halves: d.halves,
		})),
		null,
		2,
	),
);
