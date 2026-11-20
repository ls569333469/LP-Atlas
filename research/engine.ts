import Decimal from "decimal.js";
import { composeFromHours } from "../src/metrics/compose-windows.ts";
import {
	annualizeFeesApr,
	capitalEfficiency,
	priceChangeRatio,
	relativeChange,
} from "../src/metrics/fees-apr.ts";
import { poolFeeStatus } from "../src/normalize/fee-quality.ts";
import {
	isHypeLike,
	isOfficialUsdStable,
	rawPriceToken1PerToken0,
} from "../src/normalize/prices.ts";
import {
	BOARD_WINDOWS,
	DEFAULT_BOARD_FILTERS,
	HOUR_SECONDS as H,
} from "../src/shared/constants.ts";
import { feeDataUsable } from "../src/shared/fee-quality.ts";
import type {
	StoredPool,
	StoredScannedHour,
	StoredToken,
	StoredWindow,
} from "../src/store/types.ts";
import { type PositionFeeHour, positionFeeDelta } from "./position-fees.ts";

export type Dataset = {
	schema: 1;
	exportedAt: string;
	revision: number;
	asOf: string;
	start: number;
	end: number;
	pools: StoredPool[];
	tokens: StoredToken[];
	hours: StoredWindow[];
	coverage: StoredScannedHour[];
	bridges: { pools: StoredPool[]; hours: StoredWindow[] };
	positionFeeGrowth?: { basis: string; hours: PositionFeeHour[] };
	calibration?: {
		label: string;
		scope: "same_period" | "event";
		boundaries: { poolId: string; time: number; hypeUsd: string; block: string }[];
	};
};
export type Motion = { rms: number; excursion: number; recentRms: number; priorRms: number };
export type Features = {
	motion4?: Motion | null;
	feeRate: number | null;
	apr: number | null;
	efficiency: number | null;
	price1: number | null;
	price4: number | null;
	growth: number | null;
	feeAcceleration: number | null;
	volumeAcceleration: number | null;
	tvlRatio: number | null;
	ageHours: number | null;
	consecutive: number;
	fee24Rate: number | null;
	fee6Rate: number | null;
	price2: number | null;
	price6: number | null;
	price24: number | null;
};
export type Strategy = {
	id: string;
	name: string;
	rule: string;
	rationale: string;
	test: (f: Features, p: StoredPool) => boolean;
};
const atLeast = (x: number | null, n: number): boolean => x !== null && x >= n;
const absAtMost = (x: number | null, n: number): boolean => x !== null && Math.abs(x) <= n;
export const STRATEGIES: Strategy[] = [
	{
		id: "baseline",
		name: "01 原准入基准",
		rule: "仅现行三门槛",
		rationale: "判断新增指标是否优于原始入库信号。",
		test: () => true,
	},
	{
		id: "fee-10bp",
		name: "02 费用强度",
		rule: "1H费用/TVL≥0.1%",
		rationale: "观察绝对费用能否转成足够的单位资金收益。",
		test: (f) => atLeast(f.feeRate, 0.001),
	},
	{
		id: "fee-30bp",
		name: "03 高费用强度",
		rule: "1H费用/TVL≥0.3%",
		rationale: "检验更高费用能否补偿高风险。",
		test: (f) => atLeast(f.feeRate, 0.003),
	},
	{
		id: "apr-3000",
		name: "04 CJ APR门槛对照",
		rule: "完整1H APR≥3000%",
		rationale: "原资料的经验门槛，仅作为单指标实验。",
		test: (f) => atLeast(f.apr, 30),
	},
	{
		id: "turnover",
		name: "05 高换手",
		rule: "1H成交量/TVL≥1",
		rationale: "观察高换手是否持续带来收益，而非只有年化高。",
		test: (f) => atLeast(f.efficiency, 1),
	},
	{
		id: "sustained-2",
		name: "06 连续两小时",
		rule: "连续2H均满足三门槛",
		rationale: "降低只活跃几分钟的新池干扰。",
		test: (f) => f.consecutive >= 2,
	},
	{
		id: "sustained-4",
		name: "07 连续四小时",
		rule: "连续4H均满足三门槛",
		rationale: "用更长的活跃确认交换入场速度。",
		test: (f) => f.consecutive >= 4,
	},
	{
		id: "fee-growth",
		name: "08 手续费加速",
		rule: "1H费用环比≥50%且上一小时费用>0",
		rationale: "寻找费用起量，排除从零起步的无限环比。",
		test: (f) => atLeast(f.growth, 0.5),
	},
	{
		id: "volume-growth",
		name: "09 成交加速",
		rule: "当前1H成交/前2H小时均值≥1.5",
		rationale: "测试成交起量是否领先于收益机会。",
		test: (f) => atLeast(f.volumeAcceleration, 1.5),
	},
	{
		id: "fee-multitime",
		name: "10 多窗费用加速",
		rule: "当前费用/前2H小时均值≥1.5，且连续2H合格",
		rationale: "用基线与持续性过滤单次尖峰。",
		test: (f) => atLeast(f.feeAcceleration, 1.5) && f.consecutive >= 2,
	},
	{
		id: "flat-1h",
		name: "11 单窗横盘",
		rule: "|1H价格变化|≤2%",
		rationale: "检验横盘是否比追逐APR更适合收手续费。",
		test: (f) => absAtMost(f.price1, 0.02),
	},
	{
		id: "flat-4h",
		name: "12 多窗横盘",
		rule: "|1H涨跌|≤2%，|4H涨跌|≤5%",
		rationale: "用两种时间尺度排除单小时伪横盘。",
		test: (f) => absAtMost(f.price1, 0.02) && absAtMost(f.price4, 0.05),
	},
	{
		id: "pullback",
		name: "13 温和回撤",
		rule: "1H涨跌在-5%至-1%，连续2H合格",
		rationale: "测试回撤承接；不假定下跌必然反弹。",
		test: (f) => f.price1 !== null && f.price1 >= -0.05 && f.price1 <= -0.01 && f.consecutive >= 2,
	},
	{
		id: "momentum",
		name: "14 温和动量",
		rule: "1H上涨1%至5%，费用环比≥0",
		rationale: "比较温和上涨与追高风险。",
		test: (f) => f.price1 !== null && f.price1 >= 0.01 && f.price1 <= 0.05 && atLeast(f.growth, 0),
	},
	{
		id: "tvl-retained",
		name: "15 流动性稳定",
		rule: "TVL≥$10,000，较前小时保留≥90%",
		rationale: "识别资金撤出，TVL增长也可能来自价格而非净入金。",
		test: (f) => atLeast(f.tvlRatio, 0.9) && atLeast(f.ageHours, 2),
	},
	{
		id: "age-6",
		name: "16 池龄过滤",
		rule: "池龄≥6H",
		rationale: "检验排除刚发射池能否减少流动性骤降。",
		test: (f) => atLeast(f.ageHours, 6),
	},
	{
		id: "age-24",
		name: "17 成熟池",
		rule: "池龄≥24H，连续2H合格",
		rationale: "以更成熟样本作生存性对照。",
		test: (f) => atLeast(f.ageHours, 24) && f.consecutive >= 2,
	},
	{
		id: "zero-hook",
		name: "18 零Hook对照",
		rule: "无Hook",
		rationale: "只做机制分组，不把所有Hook归为不可用。",
		test: (_f, p) => !p.hooks || /^0x0+$/.test(p.hooks),
	},
	{
		id: "stable-income",
		name: "19 收费横盘组合",
		rule: "费用/TVL≥0.1%，效率≥0.3，连续2H，|1H|≤2%，池龄≥6H",
		rationale: "同时要求收费、真实换手、持续性与价格稳定。",
		test: (f) =>
			atLeast(f.feeRate, 0.001) &&
			atLeast(f.efficiency, 0.3) &&
			f.consecutive >= 2 &&
			absAtMost(f.price1, 0.02) &&
			atLeast(f.ageHours, 6),
	},
	{
		id: "hot-confirmed",
		name: "20 起量确认组合",
		rule: "费用环比≥50%，效率≥1，连续2H，|1H|≤10%，池龄≥3H",
		rationale: "更快切入热度，但限制极端价格变化和瞬时新池。",
		test: (f) =>
			atLeast(f.growth, 0.5) &&
			atLeast(f.efficiency, 1) &&
			f.consecutive >= 2 &&
			absAtMost(f.price1, 0.1) &&
			atLeast(f.ageHours, 3),
	},
	{
		id: "defensive",
		name: "21 防撤池组合",
		rule: "TVL≥$25,000，保留≥90%，池龄≥24H，连续2H，|1H|≤3%",
		rationale: "比较减少脆弱池的效果与信号数量损失。",
		test: (f) =>
			atLeast(f.tvlRatio, 0.9) &&
			atLeast(f.ageHours, 24) &&
			f.consecutive >= 2 &&
			absAtMost(f.price1, 0.03),
	},
	{
		id: "multi-6-24",
		name: "22 6H/24H持续收费",
		rule: "6H和24H每小时费用/TVL均≥0.05%，1H强度≥0.1%",
		rationale: "长窗确认，不把一天总费用误认为当前小时热度。",
		test: (f) =>
			atLeast(f.fee6Rate, 0.0005) && atLeast(f.fee24Rate, 0.0005) && atLeast(f.feeRate, 0.001),
	},
	{
		id: "fee-vs-stress",
		name: "23 费用覆盖波动压力",
		rule: "1H费用/TVL≥0.1%，且≥全范围50/50 IL基准的2倍，连续2H",
		rationale: "用现有波动作费用覆盖测试；集中区间IL可能更高，不把过去波动当未来预测。",
		test: (f) =>
			f.price1 !== null &&
			atLeast(f.feeRate, 0.001) &&
			f.consecutive >= 2 &&
			atLeast(f.feeRate, 2 * (1 - (2 * Math.sqrt(Math.max(0, 1 + f.price1))) / (2 + f.price1))),
	},
	{
		id: "cooling",
		name: "24 热度温和降温",
		rule: "费用环比-50%至0，连续2H，|1H|≤3%",
		rationale: "对照急涨起量，检验热度稍降但仍活跃的状态。",
		test: (f) =>
			f.growth !== null &&
			f.growth >= -0.5 &&
			f.growth <= 0 &&
			f.consecutive >= 2 &&
			absAtMost(f.price1, 0.03),
	},
];

export function qualifies(row: StoredWindow): boolean {
	return (
		feeDataUsable(row.feeStatus ?? "legacy_unverified") &&
		row.tvlUsd !== null &&
		row.volumeUsd !== null &&
		row.lpFeesUsd !== null &&
		new Decimal(row.tvlUsd).gte(DEFAULT_BOARD_FILTERS.minTvlUsd) &&
		new Decimal(row.volumeUsd).gte(DEFAULT_BOARD_FILTERS.minWindowVolumeUsd) &&
		new Decimal(row.lpFeesUsd).gte(DEFAULT_BOARD_FILTERS.minLpFees1hUsd)
	);
}
export function normalizeHour(row: StoredWindow, pool: StoredPool): StoredWindow {
	return { ...row, feeStatus: poolFeeStatus(pool, row) };
}

export type Signal = {
	poolId: string;
	chainId: number;
	protocol: string;
	pair: string;
	start: number;
	features: Features;
	strategies: string[];
	windows: Record<
		string,
		{ volume: string | null; fees: string | null; priceChange: string | null }
	>;
};
export type LifecyclePolicy = {
	range: "symmetric" | "up" | "down" | "sell" | "buy";
	dynamic: boolean;
	capture: number;
	costBps: number;
	fixedCost: string;
	stop: number;
	take: number;
	trail: number;
	coverageExit: boolean;
	preflight?: boolean;
	efficiencyDecay?: number;
	volatilityExpansion?: number;
	edgeBuffer?: number;
	autoRebalance?: boolean;
	useStops?: boolean;
};
export type Checkpoint = {
	time: number;
	price: string;
	inventoryPnl: string;
	feeProxy: string;
	net: string;
	expectedFee: string;
	nextLossStress: string;
	volumeRatio: string | null;
	feeRatio: string | null;
	tvlRetention: string;
	action: string;
	efficiencyRatio?: string | null;
	endpointRms?: number | null;
};
export type Config = {
	width: number;
	holdHours: number;
	delayHours: number;
	capital: string;
	lifecycle?: LifecyclePolicy;
};
export type ForwardObservation = {
	poolId: string;
	pair: string;
	signalTime: number;
	horizon: number;
	status: "observed" | "missing" | "censored";
	priceReturn: string | null;
	tvlRetention: string | null;
	futureFeeRate: string | null;
	priceStress: boolean | null;
	liquidityStress: boolean | null;
	strategies: string[];
};
export type Trial = {
	feeBasis?: "position_growth";
	entered?: boolean;
	checkpoints?: Checkpoint[];
	strategy: string;
	capital: string;
	poolId: string;
	pair: string;
	signalTime: number;
	entryTime: number;
	exitTime: number | null;
	half: "first" | "second";
	width: number;
	holdHours: number;
	status: "modeled" | "unknown" | "censored";
	reason: string;
	entryPrice: string | null;
	lower: string | null;
	upper: string | null;
	tickLower?: number;
	tickUpper?: number;
	inventoryPnl: string | null;
	hodlPnl: string | null;
	divergence: string | null;
	feeProxy: string | null;
	observedDrop: string | null;
	features: Features;
};
type Quote = { baseIndex: 0 | 1; dec0: number; dec1: number; quoteNative: boolean };
const num = (x: Decimal | null | undefined): number | null => (x?.isFinite() ? x.toNumber() : null);
const dec = (x: string | null | undefined): Decimal | null => (x == null ? null : new Decimal(x));

export class ResearchEngine {
	private byPool = new Map<string, Map<number, StoredWindow>>();
	private poolById = new Map<string, StoredPool>();
	private coverage = new Map<string, Set<number>>();
	private boundaries = new Set<string>();
	private tokenMap: Map<string, StoredToken>;
	readonly pricing = new Map<
		string,
		{
			hour: number;
			edge: string;
			poolId: string;
			hypeUsd: string;
			priorTvl: string;
			priceBasis: string;
		}
	>();
	constructor(readonly data: Dataset) {
		this.poolById = new Map(data.pools.map((p) => [p.poolId, p]));
		this.tokenMap = new Map(data.tokens.map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t]));
		for (const row of data.hours) {
			let m = this.byPool.get(row.poolId);
			if (!m) {
				m = new Map();
				this.byPool.set(row.poolId, m);
			}
			m.set(row.windowStart, row);
		}
		for (const h of data.coverage) {
			if (h.priceBoundaryVersion != null)
				this.boundaries.add(`${h.chainId}:${h.protocol}:${h.windowStart}`);
			if (!h.complete || h.gapReason) continue;
			const key = `${h.chainId}:${h.protocol}`;
			let set = this.coverage.get(key);
			if (!set) {
				set = new Set();
				this.coverage.set(key, set);
			}
			set.add(h.windowStart);
		}
	}
	row(pool: StoredPool, t: number): StoredWindow | undefined {
		const row = this.byPool.get(pool.poolId)?.get(t);
		return row
			? {
					...row,
					sqrtPriceStart: this.boundaries.has(`${pool.chainId}:${pool.protocol}:${t}`)
						? row.sqrtPriceStart
						: null,
				}
			: undefined;
	}
	pair(pool: StoredPool): string {
		return [pool.token0, pool.token1]
			.map((a) => this.tokenMap.get(`${pool.chainId}:${a.toLowerCase()}`)?.symbol ?? a)
			.join("/");
	}
	private range(pool: StoredPool, t: number, n: number): StoredWindow | null {
		const set = this.coverage.get(`${pool.chainId}:${pool.protocol}`) ?? new Set<number>();
		const m = this.byPool.get(pool.poolId);
		const hours: StoredWindow[] = [];
		if (m) {
			for (let i = 0; i < n; i++) {
				const h = m.get(t - i * H);
				if (!h) continue;
				hours.push({
					...h,
					sqrtPriceStart: this.boundaries.has(`${pool.chainId}:${pool.protocol}:${h.windowStart}`)
						? h.sqrtPriceStart
						: null,
				});
			}
			hours.sort((a, b) => a.windowStart - b.windowStart);
		}
		return composeFromHours(
			hours,
			{ startUnix: t - (n - 1) * H, endUnix: t + H, complete: true },
			set,
		);
	}
	signals(): Signal[] {
		const result: Signal[] = [];
		for (const pool of this.data.pools) {
			for (let t = this.data.start; t < this.data.end; t += H) {
				const row = this.row(pool, t);
				if (!row?.complete || !qualifies(row)) continue;
				const current = this.range(pool, t, 1);
				if (!current) continue;
				const previous = this.range(pool, t - H, 1);
				const prev2 = this.range(pool, t - H, 2);
				const windows = new Map(
					BOARD_WINDOWS.map((w) => [w.id, this.range(pool, t, w.seconds / H)]),
				);
				const tvl = dec(row.tvlUsd);
				const fee = dec(row.lpFeesUsd);
				const volume = dec(row.volumeUsd);
				const ratio = (a: Decimal | null, b: Decimal | null): number | null =>
					a && b?.gt(0) ? num(a.div(b)) : null;
				let consecutive = 0;
				for (let j = t; j >= t - 23 * H; j -= H) {
					const h = this.row(pool, j);
					if (!h?.complete || !qualifies(h) || !this.range(pool, j, 1)) break;
					consecutive++;
				}
				const price = (n: number): Decimal | null => {
					const w = windows.get(BOARD_WINDOWS.find((v) => v.seconds === n * H)?.id ?? "1h");
					if (
						!w?.sqrtPriceStart ||
						!w.sqrtPriceEnd ||
						pool.createdAtUnix === null ||
						pool.createdAtUnix > w.windowStart
					)
						return null;
					let a = rawPriceToken1PerToken0(BigInt(w.sqrtPriceStart)),
						b = rawPriceToken1PerToken0(BigInt(w.sqrtPriceEnd));
					if (this.quote(pool)?.baseIndex === 1) {
						a = new Decimal(1).div(a);
						b = new Decimal(1).div(b);
					}
					return priceChangeRatio(a, b);
				};
				const f: Features = {
					feeRate: ratio(fee, tvl),
					apr:
						fee && tvl
							? num(annualizeFeesApr({ lpFeesUsd: fee, tvlUsd: tvl, windowDurationSeconds: H }))
							: null,
					efficiency: volume && tvl ? num(capitalEfficiency(volume, tvl)) : null,
					price1: num(price(1)),
					price2: num(price(2)),
					price4: num(price(4)),
					price6: num(price(6)),
					price24: num(price(24)),
					growth:
						fee && previous?.lpFeesUsd
							? num(relativeChange(fee, new Decimal(previous.lpFeesUsd)))
							: null,
					feeAcceleration: ratio(
						fee,
						prev2?.lpFeesUsd ? new Decimal(prev2.lpFeesUsd).div(2) : null,
					),
					volumeAcceleration: ratio(
						volume,
						prev2?.volumeUsd ? new Decimal(prev2.volumeUsd).div(2) : null,
					),
					tvlRatio: ratio(tvl, dec(previous?.tvlUsd)),
					ageHours: pool.createdAtUnix === null ? null : (t + H - pool.createdAtUnix) / H,
					consecutive,
					fee24Rate: ratio(dec(windows.get("24h")?.lpFeesUsd)?.div(24) ?? null, tvl),
					fee6Rate: ratio(dec(windows.get("6h")?.lpFeesUsd)?.div(6) ?? null, tvl),
				};
				const selected = STRATEGIES.filter(
					(s) =>
						s.test(f, pool) &&
						(!(s.id === "tvl-retained") || tvl?.gte(10000)) &&
						(!(s.id === "defensive") || tvl?.gte(25000)),
				).map((s) => s.id);
				result.push({
					poolId: pool.poolId,
					chainId: pool.chainId,
					protocol: pool.protocol,
					pair: this.pair(pool),
					start: t,
					features: f,
					strategies: selected,
					windows: Object.fromEntries(
						[...windows].map(([k, w]) => [
							k,
							{
								volume: w?.volumeUsd ?? null,
								fees: w?.lpFeesUsd ?? null,
								priceChange:
									w?.sqrtPriceStart && w.sqrtPriceEnd
										? (priceChangeRatio(
												rawPriceToken1PerToken0(BigInt(w.sqrtPriceStart)),
												rawPriceToken1PerToken0(BigInt(w.sqrtPriceEnd)),
											)?.toString() ?? null)
										: null,
							},
						]),
					),
				});
			}
		}
		return result.sort((a, b) => a.start - b.start || a.poolId.localeCompare(b.poolId));
	}
	motion(pool: StoredPool, t: number): Motion | null {
		const returns: number[] = [],
			prices: number[] = [];
		for (let j = t - 3 * H; j <= t; j += H) {
			const row = this.row(pool, j);
			if (!row?.complete || !this.range(pool, j, 1) || !row.sqrtPriceStart || !row.sqrtPriceEnd)
				return null;
			const a = rawPriceToken1PerToken0(BigInt(row.sqrtPriceStart));
			const b = rawPriceToken1PerToken0(BigInt(row.sqrtPriceEnd));
			if (!a.gt(0) || !b.gt(0)) return null;
			returns.push(b.div(a).ln().toNumber());
			prices.push(a.ln().toNumber(), b.ln().toNumber());
		}
		const rms = (xs: number[]) => Math.sqrt(xs.reduce((sum, x) => sum + x * x, 0) / xs.length);
		return {
			rms: rms(returns),
			excursion: Math.expm1(Math.max(...prices) - Math.min(...prices)),
			recentRms: rms(returns.slice(2)),
			priorRms: rms(returns.slice(0, 2)),
		};
	}
	private quote(pool: StoredPool): Quote | null {
		if (pool.chainId !== 99901) return null;
		const t0 = this.tokenMap.get(`${pool.chainId}:${pool.token0.toLowerCase()}`),
			t1 = this.tokenMap.get(`${pool.chainId}:${pool.token1.toLowerCase()}`);
		if (!t0 || !t1) return null;
		const q0 = isOfficialUsdStable(pool.token0)
			? true
			: isOfficialUsdStable(pool.token1)
				? false
				: isHypeLike(pool.token0)
					? true
					: isHypeLike(pool.token1)
						? false
						: null;
		if (q0 === null) return null;
		return {
			baseIndex: q0 ? 1 : 0,
			dec0: t0.decimals,
			dec1: t1.decimals,
			quoteNative: isHypeLike(q0 ? pool.token0 : pool.token1),
		};
	}
	private mark(
		pool: StoredPool,
		t: number,
		edge: "start" | "end",
		quote: Quote,
	): { price: Decimal; quoteUsd: Decimal } | null {
		const row = this.row(pool, t),
			next = this.row(pool, t + H);
		const sqrt =
			edge === "start" ? row?.sqrtPriceStart : (next?.sqrtPriceStart ?? row?.sqrtPriceEnd);
		if (!sqrt || BigInt(sqrt) === 0n) return null;
		const raw = rawPriceToken1PerToken0(BigInt(sqrt));
		const human = raw.mul(new Decimal(10).pow(quote.dec0 - quote.dec1));
		const price = quote.baseIndex === 1 ? new Decimal(1).div(human) : human;
		let quoteUsd = new Decimal(1);
		if (quote.quoteNative) {
			const boundary = this.data.calibration?.boundaries.find(
				(b) => b.poolId === pool.poolId && b.time === t + (edge === "end" ? H : 0),
			);
			if (boundary) {
				quoteUsd = new Decimal(boundary.hypeUsd);
				this.pricing.set(`${pool.poolId}:${t}:${edge}`, {
					hour: t,
					edge,
					poolId: pool.poolId,
					hypeUsd: boundary.hypeUsd,
					priorTvl: "0",
					priceBasis: `audited_direct_bridge_block_${boundary.block}`,
				});
				return price.gt(0) && quoteUsd.gt(0) ? { price, quoteUsd } : null;
			}
			if (this.data.calibration?.scope === "event") return null;
			const prior = new Map(
				this.data.bridges.hours
					.filter((h) => h.windowStart === t - H && h.complete && h.tvlUsd !== null)
					.map((h) => [h.poolId, h.tvlUsd as string]),
			);
			const bridges = this.data.bridges.hours.filter(
				(h) =>
					h.windowStart === t &&
					h.complete &&
					prior.has(h.poolId) &&
					new Decimal(prior.get(h.poolId) ?? 0).gte(DEFAULT_BOARD_FILTERS.minTvlUsd),
			);
			const ranked = bridges.sort(
				(a, b) =>
					new Decimal(prior.get(b.poolId) ?? 0).cmp(prior.get(a.poolId) ?? 0) ||
					a.poolId.localeCompare(b.poolId),
			);
			let found = false;
			for (const h of ranked) {
				const p = this.data.bridges.pools.find(
					(v) => v.poolId === h.poolId && v.chainId === pool.chainId,
				);
				if (!p) continue;
				const following = this.data.bridges.hours.find(
					(v) => v.poolId === h.poolId && v.windowStart === t + H,
				);
				const s =
					edge === "start" ? h.sqrtPriceStart : (following?.sqrtPriceStart ?? h.sqrtPriceEnd);
				if (!s || BigInt(s) === 0n) continue;
				const a = this.tokenMap.get(`${p.chainId}:${p.token0.toLowerCase()}`),
					b = this.tokenMap.get(`${p.chainId}:${p.token1.toLowerCase()}`);
				if (!a || !b) continue;
				const humanBridge = rawPriceToken1PerToken0(BigInt(s)).mul(
					new Decimal(10).pow(a.decimals - b.decimals),
				);
				quoteUsd = isHypeLike(p.token0) ? humanBridge : new Decimal(1).div(humanBridge);
				this.pricing.set(`${pool.chainId}:${t}:${edge}`, {
					hour: t,
					edge,
					poolId: p.poolId,
					hypeUsd: quoteUsd.toString(),
					priorTvl: prior.get(h.poolId) ?? "0",
					priceBasis:
						edge === "start" || following?.sqrtPriceStart ? "exact_boundary" : "last_swap_fallback",
				});
				found = true;
				break;
			}
			if (!found) return null;
		}
		return price.gt(0) && price.isFinite() && quoteUsd.gt(0) && quoteUsd.isFinite()
			? { price, quoteUsd }
			: null;
	}
	trial(signal: Signal, strategy: string, cfg: Config): Trial {
		const pool = this.poolById.get(signal.poolId);
		if (!pool) throw new Error("Unknown pool");
		const entryTime = signal.start + (1 + cfg.delayHours) * H;
		const out: Trial = {
			...(this.data.positionFeeGrowth ? { feeBasis: "position_growth" as const } : {}),
			strategy,
			capital: cfg.capital,
			poolId: pool.poolId,
			pair: signal.pair,
			signalTime: signal.start + H,
			entryTime,
			exitTime: null,
			half: signal.start < this.data.start + 24 * H ? "first" : "second",
			width: cfg.width,
			holdHours: cfg.holdHours,
			status: "unknown",
			reason: "",
			entryPrice: null,
			lower: null,
			upper: null,
			inventoryPnl: null,
			hodlPnl: null,
			divergence: null,
			feeProxy: null,
			observedDrop: null,
			features: signal.features,
		};
		if (entryTime + H > this.data.end) {
			out.status = "censored";
			out.reason = "尚无完整入场后小时";
			return out;
		}
		const q = this.quote(pool);
		if (!q) {
			out.reason = "无受支持的同链官方美元定价路径";
			return out;
		}
		const entry = this.mark(pool, entryTime, "start", q);
		if (!entry) {
			out.reason = "缺少入场边界价格或官方美元桥接价";
			return out;
		}
		const entryRow = this.row(pool, entryTime);
		const latestBeforeEntry = this.row(pool, entryTime - H);
		if (cfg.lifecycle && (!latestBeforeEntry?.complete || !qualifies(latestBeforeEntry))) {
			out.reason = "入场前最新完整小时不再合格，取消入场";
			return out;
		}
		const entryTvl = dec(this.row(pool, entryTime - H)?.tvlUsd);
		if ((!cfg.lifecycle && !entryRow?.complete) || !entryTvl?.gt(0)) {
			out.reason = "缺少入场小时或入场前TVL";
			return out;
		}
		const cap = new Decimal(cfg.capital);
		if (cap.div(entryTvl).gt(0.05)) {
			out.reason = "研究本金超过入场前TVL的5%，小额无冲击假设不适用";
			return out;
		}
		// Tick alignment uses the pool's raw token1/token0 convention, even for reversed display quotes.
		const rawEntry = q.baseIndex === 1 ? new Decimal(1).div(entry.price) : entry.price;
		const rawRatio = rawEntry.div(new Decimal(10).pow(q.dec0 - q.dec1));
		const shape = cfg.lifecycle?.range ?? "symmetric";
		const loFactor =
			shape === "sell"
				? 1
				: shape === "buy"
					? 1 - cfg.width
					: shape === "up"
						? 1 - cfg.width * 0.2
						: shape === "down"
							? 1 - cfg.width * 0.8
							: 1 - cfg.width / 2;
		const hiFactor =
			shape === "buy"
				? 1
				: shape === "sell"
					? 1 + cfg.width
					: shape === "up"
						? 1 + cfg.width * 0.8
						: shape === "down"
							? 1 + cfg.width * 0.2
							: 1 + cfg.width / 2;
		const rawLo =
				cfg.lifecycle && q.baseIndex === 1 ? rawRatio.div(hiFactor) : rawRatio.mul(loFactor),
			rawHi = cfg.lifecycle && q.baseIndex === 1 ? rawRatio.div(loFactor) : rawRatio.mul(hiFactor);
		const tickLo =
			((shape === "sell" && q.baseIndex === 0) || (shape === "buy" && q.baseIndex === 1)
				? Math.ceil
				: Math.floor)(rawLo.ln().div(new Decimal("1.0001").ln()).toNumber() / pool.tickSpacing) *
			pool.tickSpacing;
		const tickHi =
			((shape === "buy" && q.baseIndex === 0) || (shape === "sell" && q.baseIndex === 1)
				? Math.floor
				: Math.ceil)(rawHi.ln().div(new Decimal("1.0001").ln()).toNumber() / pool.tickSpacing) *
			pool.tickSpacing;
		const humanLo = new Decimal("1.0001")
			.pow(Math.max(-887272, tickLo))
			.mul(new Decimal(10).pow(q.dec0 - q.dec1));
		const humanHi = new Decimal("1.0001")
			.pow(Math.min(887272, tickHi))
			.mul(new Decimal(10).pow(q.dec0 - q.dec1));
		const lower = q.baseIndex === 1 ? new Decimal(1).div(humanHi) : humanLo;
		const upper = q.baseIndex === 1 ? new Decimal(1).div(humanLo) : humanHi;
		if (
			!lower.lt(upper) ||
			(!cfg.lifecycle && (!lower.lt(entry.price) || !upper.gt(entry.price)))
		) {
			out.reason = "区间无法包含入场价";
			return out;
		}
		out.entryPrice = entry.price.toString();
		out.lower = lower.toString();
		out.upper = upper.toString();
		out.tickLower = Math.max(-887272, tickLo);
		out.tickUpper = Math.min(887272, tickHi);
		const unit = inventory(entry.price, lower, upper, new Decimal(1));
		const liq = cap.div(unit.base.mul(entry.price).plus(unit.quote).mul(entry.quoteUsd));
		const initial = inventory(entry.price, lower, upper, liq);
		const rangeFee = (
			time: number,
			mark: { price: Decimal; quoteUsd: Decimal },
		): Decimal | null => {
			const evidence = this.data.positionFeeGrowth?.hours.find(
				(h) =>
					h.poolId === pool.poolId && h.lower === tickLo && h.upper === tickHi && h.start === time,
			);
			if (evidence?.status !== "usable") return null;
			const rawLiquidity = BigInt(
				liq.mul(new Decimal(10).pow((q.dec0 + q.dec1) / 2)).toFixed(0, Decimal.ROUND_FLOOR),
			);
			const amount0 = new Decimal(
				positionFeeDelta(
					rawLiquidity,
					BigInt(evidence.growth0Start),
					BigInt(evidence.growth0End),
				).toString(),
			).div(new Decimal(10).pow(q.dec0));
			const amount1 = new Decimal(
				positionFeeDelta(
					rawLiquidity,
					BigInt(evidence.growth1Start),
					BigInt(evidence.growth1End),
				).toString(),
			).div(new Decimal(10).pow(q.dec1));
			return (
				q.baseIndex === 0
					? amount0.mul(mark.price).plus(amount1)
					: amount1.mul(mark.price).plus(amount0)
			).mul(mark.quoteUsd);
		};
		if (cfg.lifecycle?.preflight) {
			const expectedFee = this.data.positionFeeGrowth
				? rangeFee(entryTime - H, entry)
				: new Decimal(latestBeforeEntry?.lpFeesUsd ?? 0)
						.mul(cap.div(Decimal.max(cap, entryTvl)))
						.mul(cfg.lifecycle.capture);
			if (expectedFee === null) {
				out.reason = "入场前区间feeGrowth证据不足，未计算费用预算";
				return out;
			}
			const downside = inventory(lower, lower, upper, liq);
			const boundaryLoss = Decimal.max(
				0,
				cap.minus(downside.base.mul(lower).plus(downside.quote).mul(entry.quoteUsd)),
			);
			const roundTrip = cap.mul(cfg.lifecycle.costBps).div(10000).plus(cfg.lifecycle.fixedCost);
			if (expectedFee.lte(boundaryLoss.plus(roundTrip))) {
				out.reason = "入场前1H费用预算不足下边界库存损失与往返成本，跳过";
				return out;
			}
		}
		let fees = new Decimal(0);
		let peak = new Decimal(0);
		if (cfg.lifecycle) {
			out.entered = true;
			out.checkpoints = [];
		}
		const entryPrior = this.row(pool, entryTime - H);
		for (let i = 0; i < cfg.holdHours; i++) {
			const t = entryTime + i * H;
			if (t + H > this.data.end) {
				out.status = "censored";
				out.reason = "持有期触及数据截止";
				return out;
			}
			const row = this.row(pool, t);
			if (!row?.complete || !this.range(pool, t, 1)) {
				out.reason = "持有期缺少独立小时价格/状态档";
				return out;
			}
			const tvl = dec(row.tvlUsd);
			if (!tvl) {
				out.reason = "持有期TVL缺失";
				return out;
			}
			const retention = tvl.div(entryTvl);
			out.observedDrop = retention.toString();
			if (retention.lt(0.3)) {
				out.reason = "TVL不足入场前30%，退出可成交性未知";
				return out;
			}
			const mark = this.mark(pool, t, "end", q);
			if (!mark) {
				out.reason = "持有期价格边界或美元桥接价缺失";
				return out;
			}
			const policy = cfg.lifecycle;
			const inside = mark.price.gte(lower) && mark.price.lte(upper);
			const beyond = policy?.edgeBuffer
				? mark.price.lt(lower.mul(1 - policy.edgeBuffer)) ||
					mark.price.gt(upper.mul(1 + policy.edgeBuffer))
				: !inside;
			const feesBefore = fees;
			if (this.data.positionFeeGrowth) {
				const earned = rangeFee(t, mark);
				if (earned === null) {
					out.reason = "区间feeGrowth或tick连续性证据不足，手续费未计算";
					return out;
				}
				fees = fees.plus(earned);
			} else if (inside) {
				if (!feeDataUsable(row.feeStatus ?? "legacy_unverified") || row.lpFeesUsd === null) {
					out.reason = "持有期归LP费用不可用";
					return out;
				}
				fees = fees.plus(new Decimal(row.lpFeesUsd).mul(cap.div(Decimal.max(cap, entryTvl, tvl))));
			}
			const current = inventory(mark.price, lower, upper, liq);
			const value = current.base.mul(mark.price).plus(current.quote).mul(mark.quoteUsd);
			const hodl = initial.base.mul(mark.price).plus(initial.quote).mul(mark.quoteUsd);
			let exitReason =
				!inside && beyond
					? policy?.edgeBuffer
						? "出区间后再偏离约缓冲退出"
						: "小时末发现出区间（非即时止损）"
					: i === cfg.holdHours - 1
						? "到达持有上限（小时估值）"
						: "";
			if (policy) {
				const inventoryPnl = value.minus(cap);
				const net = inventoryPnl
					.plus(fees.mul(this.data.positionFeeGrowth ? 1 : policy.capture))
					.minus(cap.mul(policy.costBps).div(10000))
					.minus(policy.fixedCost);
				const expected = this.data.positionFeeGrowth
					? fees.minus(feesBefore)
					: new Decimal(row.lpFeesUsd ?? 0)
							.mul(cap.div(Decimal.max(cap, entryTvl, tvl)))
							.mul(policy.capture);
				const begin = this.mark(pool, t, "start", q);
				if (!begin) {
					out.reason = "缺少持有小时起始价格，无法评估退出";
					return out;
				}
				const move = mark.price.div(begin.price).minus(1);
				const stressPrice = mark.price.mul(
					Decimal.max(0.000001, new Decimal(1).minus(Decimal.max(0.005, move.abs()))),
				);
				const stressed = inventory(stressPrice, lower, upper, liq);
				const stressValue = stressed.base.mul(stressPrice).plus(stressed.quote).mul(mark.quoteUsd);
				const risk = Decimal.max(0, value.minus(stressValue));
				const volumeRatio =
					dec(entryPrior?.volumeUsd)?.gt(0) && row.volumeUsd !== null
						? new Decimal(row.volumeUsd).div(entryPrior?.volumeUsd ?? 1)
						: null;
				const entryRate = dec(entryPrior?.lpFeesUsd)?.div(entryTvl);
				const feeRatio =
					entryRate?.gt(0) && row.lpFeesUsd !== null
						? new Decimal(row.lpFeesUsd).div(tvl).div(entryRate)
						: null;
				const entryEfficiency = dec(entryPrior?.volumeUsd)?.div(entryTvl);
				const efficiencyRatio =
					entryEfficiency?.gt(0) && row.volumeUsd !== null && tvl.gt(0)
						? new Decimal(row.volumeUsd).div(tvl).div(entryEfficiency)
						: null;
				const motion = policy.volatilityExpansion ? this.motion(pool, t) : null;
				const entryMotion = policy.volatilityExpansion ? this.motion(pool, entryTime - H) : null;
				peak = Decimal.max(peak, net);
				if (inside && policy.dynamic) {
					if (policy.useStops !== false && net.lte(cap.mul(-policy.stop)))
						exitReason = "净损益触发止损";
					else if (policy.useStops !== false && net.gte(cap.mul(policy.take)))
						exitReason = "净损益触发止盈";
					else if (
						policy.useStops !== false &&
						peak.gte(cap.mul(0.01)) &&
						peak.minus(net).gte(cap.mul(policy.trail))
					)
						exitReason = "盈利回吐退出";
					else if (retention.lt(0.8)) exitReason = "TVL下降超过20%，撤出";
					else if (policy.efficiencyDecay && efficiencyRatio?.lt(policy.efficiencyDecay))
						exitReason = "资金效率不足入场前一半，撤出";
					else if (
						policy.volatilityExpansion &&
						motion &&
						entryMotion &&
						motion.rms > policy.volatilityExpansion * Math.max(0.005, entryMotion.rms)
					)
						exitReason = "端点波动扩大，撤出";
					else if (volumeRatio?.lt(0.5)) exitReason = "成交量不足入场前一半，撤出";
					else if (feeRatio?.lt(0.5)) exitReason = "手续费强度不足入场前一半，撤出";
					else if (
						policy.coverageExit &&
						expected.lte(
							risk
								.plus(cap.mul(policy.costBps / 2).div(10000))
								.plus(new Decimal(policy.fixedCost).div(2)),
						)
					)
						exitReason = "预估下一小时费用不足库存损失压力及退出成本";
				}
				out.checkpoints?.push({
					time: t + H,
					price: mark.price.toString(),
					inventoryPnl: inventoryPnl.toString(),
					feeProxy: fees.toString(),
					net: net.toString(),
					expectedFee: expected.toString(),
					nextLossStress: risk.toString(),
					volumeRatio: volumeRatio?.toString() ?? null,
					feeRatio: feeRatio?.toString() ?? null,
					tvlRetention: retention.toString(),
					action: exitReason || "继续持有",
					...(policy.efficiencyDecay
						? { efficiencyRatio: efficiencyRatio?.toString() ?? null }
						: {}),
					...(policy.volatilityExpansion ? { endpointRms: motion?.rms ?? null } : {}),
				});
			}
			if (exitReason) {
				out.status = "modeled";
				out.reason = exitReason;
				out.exitTime = t + H;
				out.inventoryPnl = value.minus(cap).toString();
				out.hodlPnl = hodl.minus(cap).toString();
				out.divergence = value.minus(hodl).toString();
				out.feeProxy = fees.toString();
				return out;
			}
		}
		return out;
	}
	forward(signal: Signal, horizon: number): ForwardObservation {
		const pool = this.data.pools.find((p) => p.poolId === signal.poolId);
		if (!pool) throw new Error("Unknown pool");
		const out: ForwardObservation = {
			poolId: pool.poolId,
			pair: signal.pair,
			signalTime: signal.start + H,
			horizon,
			status: "missing",
			priceReturn: null,
			tvlRetention: null,
			futureFeeRate: null,
			priceStress: null,
			liquidityStress: null,
			strategies: signal.strategies,
		};
		const t = signal.start + 2 * H;
		if (t + horizon * H > this.data.end) {
			out.status = "censored";
			return out;
		}
		const first = this.row(pool, t - H),
			last = this.row(pool, t + (horizon - 1) * H);
		const a = dec(first?.tvlUsd),
			b = dec(last?.tvlUsd);
		if (a?.gt(0) && b !== null) {
			out.tvlRetention = b.div(a).toString();
			out.liquidityStress = b.div(a).lt(0.3);
		}
		const quote = this.quote(pool),
			entry = quote ? this.mark(pool, t, "start", quote) : null,
			exit = quote ? this.mark(pool, t + (horizon - 1) * H, "end", quote) : null;
		if (entry && exit) {
			out.priceReturn = exit.price
				.mul(exit.quoteUsd)
				.div(entry.price.mul(entry.quoteUsd))
				.minus(1)
				.toString();
			out.priceStress = new Decimal(out.priceReturn).lte(-0.1);
		}
		const range = this.range(pool, t + (horizon - 1) * H, horizon);
		if (
			a?.gt(0) &&
			range?.lpFeesUsd !== null &&
			range?.lpFeesUsd !== undefined &&
			feeDataUsable(range.feeStatus ?? "legacy_unverified")
		) {
			out.futureFeeRate = new Decimal(range.lpFeesUsd).div(a).div(horizon).toString();
		}
		if (out.priceReturn !== null && out.tvlRetention !== null && out.futureFeeRate !== null)
			out.status = "observed";
		return out;
	}
	run(signals: Signal[], cfg: Config): Trial[] {
		const results: Trial[] = [];
		for (const strategy of STRATEGIES) {
			const busy = new Map<string, number>();
			for (const signal of signals) {
				if (
					!signal.strategies.includes(strategy.id) ||
					signal.start + H < (busy.get(signal.poolId) ?? 0)
				)
					continue;
				const trial = this.trial(signal, strategy.id, cfg);
				results.push(trial);
				busy.set(
					signal.poolId,
					trial.status === "modeled" && trial.exitTime
						? trial.exitTime
						: trial.entryTime + cfg.holdHours * H,
				);
			}
		}
		return results;
	}
}

export function inventory(
	price: Decimal,
	lower: Decimal,
	upper: Decimal,
	liquidity: Decimal,
): { base: Decimal; quote: Decimal } {
	const s = Decimal.max(lower, Decimal.min(upper, price)).sqrt(),
		a = lower.sqrt(),
		b = upper.sqrt();
	return { base: liquidity.mul(b.minus(s)).div(s.mul(b)), quote: liquidity.mul(s.minus(a)) };
}

export function netPnl(
	trial: Trial,
	capital: string,
	capture: number,
	costBps: number,
	fixedCost: string,
): Decimal | null {
	if (trial.status !== "modeled" || trial.inventoryPnl === null || trial.feeProxy === null)
		return null;
	return new Decimal(trial.inventoryPnl)
		.plus(new Decimal(trial.feeProxy).mul(trial.feeBasis === "position_growth" ? 1 : capture))
		.minus(new Decimal(capital).mul(costBps).div(10000))
		.minus(fixedCost);
}
