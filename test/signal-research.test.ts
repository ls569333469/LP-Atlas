// biome-ignore-all lint/style/noNonNullAssertion: Fixed fixture contents and modeled-result fields are explicitly asserted by these tests.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { EFFICIENCY_BOOKS, efficiencySignals } from "../research/efficiency.ts";
import { type Dataset, inventory, netPnl, qualifies, ResearchEngine } from "../research/engine.ts";
import { PLAYBOOKS, rollAccount, simulate } from "../research/lifecycle.ts";
import { positionFeeDelta } from "../research/position-fees.ts";
import { ELYSIUM_USDC_ADDRESS, ZERO_ADDRESS } from "../src/shared/constants.ts";
import type { StoredNativeWindow as StoredWindow } from "../src/store/types.ts";

const H = 3600,
	start = 1794402000;
const sqrt = (price: number): string =>
	new Decimal(price).mul("1e-12").sqrt().mul(new Decimal(2).pow(96)).toFixed(0);
const hour = (t: number, price = 100): StoredWindow => ({
	poolId: "test",
	windowStart: t,
	windowEnd: t + H,
	complete: true,
	volume0: "100000000000000000000",
	volume1: "10000000000",
	lpFees0: "10000000000000000",
	lpFees1: "10000000",
	swapCount: 10,
	volumeUsd: "10000",
	lpFeesUsd: "100",
	feeStatus: "estimated",
	tvlUsd: "100000",
	sqrtPriceStart: sqrt(price),
	sqrtPriceEnd: sqrt(price),
	source: "self_built",
	asOf: new Date((t + H) * 1000).toISOString(),
	gapReason: null,
});
function data(): Dataset {
	const pool = {
		poolId: "test",
		chainId: 99901,
		protocol: "uniswap_v4" as const,
		token0: ZERO_ADDRESS,
		token1: ELYSIUM_USDC_ADDRESS,
		feePips: 3000,
		tickSpacing: 60,
		hooks: ZERO_ADDRESS,
		poolAddress: null,
		createdBlock: 1,
		createdAtUnix: start - 30 * H,
	};
	const hours = Array.from({ length: 36 }, (_, i) => hour(start + (i - 24) * H));
	return {
		schema: 1,
		revision: 1,
		exportedAt: "2026-11-13T00:00:00Z",
		asOf: new Date((start + 12 * H) * 1000).toISOString(),
		start,
		end: start + 12 * H,
		pools: [pool],
		tokens: [
			{ chainId: 99901, address: ZERO_ADDRESS, symbol: "HYPE", decimals: 18, name: null },
			{ chainId: 99901, address: ELYSIUM_USDC_ADDRESS, symbol: "USDC", decimals: 6, name: null },
		],
		hours,
		coverage: hours.map((h) => ({
			chainId: 99901,
			protocol: "uniswap_v4",
			windowStart: h.windowStart,
			windowEnd: h.windowEnd,
			complete: true,
			fromBlock: "1",
			toBlock: "2",
			stateBlockNumber: "2",
			priceBoundaryVersion: 2,
			asOf: h.asOf,
			gapReason: null,
		})),
		bridges: { pools: [], hours: [] },
	};
}
describe("complete lifecycle research", () => {
	it("settles actual liquidity against unsigned growth with integer rounding", () => {
		const q = 1n << 128n;
		expect(positionFeeDelta(101n, 0n, q / 2n)).toBe(50n);
		expect(positionFeeDelta(100n, (1n << 256n) - q, 0n)).toBe(100n);
		expect(positionFeeDelta(0n, 123n, 456n)).toBe(0n);
	});
	it("keeps fees accrued before an hourly exit and does not apply capture to growth fees", () => {
		const d = data();
		const engine = new ResearchEngine(d),
			signal = engine.signals().find((s) => s.start === start)!;
		const cfg = { capital: "100", width: 0.02, holdHours: 1, delayHours: 0 };
		const old = engine.trial(signal, "baseline", cfg);
		const lower = Math.round(Math.log(Number(old.lower) * 1e-12) / Math.log(1.0001));
		const upper = Math.round(Math.log(Number(old.upper) * 1e-12) / Math.log(1.0001));
		d.positionFeeGrowth = {
			basis: "fixture",
			hours: [
				{
					poolId: "test",
					lower,
					upper,
					start: start + H,
					growth0Start: "0",
					growth1Start: "0",
					growth0End: (1n << 100n).toString(),
					growth1End: "0",
					status: "usable",
					reason: null,
				},
			],
		};
		d.hours.find((h) => h.windowStart === start + 2 * H)!.sqrtPriceStart = sqrt(200);
		const result = new ResearchEngine(d).trial(signal, "baseline", cfg);
		expect(result.status).toBe("modeled");
		expect(result.reason).toContain("出区间");
		expect(Number(result.feeProxy)).toBeGreaterThan(0);
		expect(netPnl(result, "100", 0.5, 0, "0")!.toString()).toBe(
			netPnl(result, "100", 1, 0, "0")!.toString(),
		);
	});
	it("uses only the audited boundary at entry and requires missing event boundaries", () => {
		const d = data();
		const token = "0x1111111111111111111111111111111111111111";
		d.pools[0]!.token1 = token;
		d.tokens[1] = { chainId: 99901, address: token, symbol: "KNTQ", decimals: 18, name: null };
		d.calibration = {
			label: "test",
			scope: "event",
			boundaries: [
				{ poolId: "test", time: start + H, hypeUsd: "100", block: "1" },
				{ poolId: "test", time: start + 2 * H, hypeUsd: "100", block: "2" },
				{ poolId: "test", time: start + 3 * H, hypeUsd: "999", block: "3" },
			],
		};
		const engine = new ResearchEngine(d);
		const signal = engine.signals().find((s) => s.start === start)!;
		const config = { capital: "100", width: 0.1, holdHours: 1, delayHours: 0 };
		const trial = engine.trial(signal, "baseline", config);
		expect(trial.status).toBe("modeled");
		expect(Number(trial.inventoryPnl)).toBeCloseTo(0, 10);
		expect([...engine.pricing.values()].every((p) => p.hypeUsd === "100")).toBe(true);
		d.calibration.boundaries = d.calibration.boundaries.filter((b) => b.time !== start + H);
		const missing = new ResearchEngine(d).trial(signal, "baseline", config);
		expect(missing.status).toBe("unknown");
		expect(missing.reason).toContain("缺少入场边界");
	});
	it("detects sampled round trips even when four-hour net return is zero", () => {
		const d = data();
		for (const [i, prices] of [
			[100, 110],
			[110, 100],
			[100, 110],
			[110, 100],
		].entries()) {
			const h = d.hours.find((h) => h.windowStart === start + (i - 3) * H)!;
			h.sqrtPriceStart = sqrt(prices[0]!);
			h.sqrtPriceEnd = sqrt(prices[1]!);
		}
		const motion = new ResearchEngine(d).motion(d.pools[0]!, start)!;
		expect(motion.rms).toBeCloseTo(Math.log(1.1), 8);
		expect(motion.excursion).toBeCloseTo(0.1, 8);
		d.coverage = d.coverage.filter((h) => h.windowStart !== start - H);
		expect(new ResearchEngine(d).motion(d.pools[0]!, start)).toBeNull();
	});
	it("uses capital efficiency for entries and sampled volatility for range width without future data", () => {
		const d = data(),
			e = new ResearchEngine(d),
			s = efficiencySignals(e)[0]!;
		const book = EFFICIENCY_BOOKS[0]!;
		expect(book.test(s)).toBe(false);
		const eligible = { ...s, features: { ...s.features, efficiency: 1 } };
		expect(book.test(eligible)).toBe(true);
		expect(book.width(eligible.features)).toBe(0.02);
		expect(
			book.width({
				...eligible.features,
				motion4: { rms: 0.02, excursion: 0.03, priorRms: 0.02, recentRms: 0.02 },
			}),
		).toBe(0.08);
		for (const h of d.hours)
			if (h.windowStart > start) {
				h.sqrtPriceEnd = sqrt(900);
				h.volumeUsd = "1";
			}
		expect(efficiencySignals(new ResearchEngine(d))[0]).toEqual(s);
	});
	it("exits for declining capital efficiency even when absolute volume does not decline", () => {
		const d = data();
		for (const h of d.hours) {
			h.volumeUsd = "100000";
			h.lpFeesUsd = "1000";
		}
		const h = d.hours.find((h) => h.windowStart === start + H)!;
		h.tvlUsd = "300000";
		h.lpFeesUsd = "3000";
		const e = new ResearchEngine(d),
			s = efficiencySignals(e)[0]!;
		const t = simulate(e, s, EFFICIENCY_BOOKS[2]!, { capital: "200", delay: 0, capture: 0.5 });
		expect(t.reason).toContain("资金效率");
		expect(Number(t.checkpoints![0]!.efficiencyRatio)).toBeCloseTo(1 / 3);
	});
	it("supports twelve-hour limits without silently retaining the old four-hour cap", () => {
		const d = data();
		d.end = start + 13 * H;
		const h = hour(start + 12 * H);
		d.hours.push(h);
		d.coverage.push({ ...d.coverage[0]!, windowStart: h.windowStart, windowEnd: h.windowEnd });
		const e = new ResearchEngine(d),
			s = efficiencySignals(e)[0]!;
		const t = simulate(
			e,
			s,
			EFFICIENCY_BOOKS[4]!,
			{ capital: "200", delay: 0, capture: 0.5 },
			false,
		);
		expect(t.status).toBe("modeled");
		expect(t.exitTime! - t.entryTime).toBe(12 * H);
	});
	it("recovers initial principal once and continues only with remaining cash", () => {
		const d = data();
		for (const h of d.hours) {
			h.lpFeesUsd = "200000";
			h.volumeUsd = "1000000";
		}
		const e = new ResearchEngine(d),
			book = { ...PLAYBOOKS[1]!, test: () => true };
		const a = rollAccount(
			e,
			e.signals(),
			book,
			{ capital: "1000", delay: 0, capture: 0.5 },
			"recover",
		);
		expect(a.withdrawn).toBe("1000");
		expect(a.trades.length).toBeGreaterThan(2);
		expect(Number(a.cash)).toBeGreaterThan(0);
	});
	it("skips insufficient entry fee budget and allows supported fee budget", () => {
		const d = data(),
			engine = new ResearchEngine(d),
			s = engine.signals()[0]!;
		const skipped = simulate(engine, s, PLAYBOOKS[10]!, {
			capital: "1000",
			delay: 0,
			capture: 0.5,
		});
		expect(skipped.entered).not.toBe(true);
		expect(skipped.reason).toContain("入场前1H费用预算不足");
		d.hours.find((h) => h.windowStart === start)!.lpFeesUsd = "10000";
		const funded = simulate(new ResearchEngine(d), s, PLAYBOOKS[10]!, {
			capital: "1000",
			delay: 0,
			capture: 0.5,
		});
		expect(funded.entered).toBe(true);
	});
	const scene = { capital: "1000", delay: 0, capture: 0.5 };
	it("exits when volume halves and compares identical entry with the fixed control", () => {
		const d = data();
		const row = d.hours.find((h) => h.windowStart === start + H)!;
		row.volumeUsd = "1000";
		const engine = new ResearchEngine(d),
			s = engine.signals()[0]!,
			book = PLAYBOOKS[1]!;
		const active = simulate(engine, s, book, scene),
			control = simulate(engine, s, book, scene, false);
		expect(active.reason).toContain("成交量不足");
		expect(active.exitTime).toBe(start + 2 * H);
		expect(control.exitTime).toBe(start + 5 * H);
		expect(active.entryTime).toBe(control.entryTime);
		expect(active.lower).toBe(control.lower);
		expect(active.checkpoints).toHaveLength(1);
	});
	it("uses net fees and costs for take profit, without waiting for the hold cap", () => {
		const d = data();
		d.hours.find((h) => h.windowStart === start + H)!.lpFeesUsd = "10000";
		const engine = new ResearchEngine(d),
			t = simulate(engine, engine.signals()[0]!, PLAYBOOKS[1]!, scene);
		expect(t.reason).toBe("净损益触发止盈");
		expect(t.exitTime).toBe(start + 2 * H);
		expect(Number(t.checkpoints![0]!.net)).toBeCloseTo(44, 6);
	});
	it("evaluates fee support after the observed hour and does not read a future hour to decide", () => {
		const d = data(),
			engine = new ResearchEngine(d),
			s = engine.signals()[0]!;
		const first = simulate(engine, s, PLAYBOOKS[8]!, scene);
		expect(first.reason).toContain("预估下一小时费用不足");
		d.hours.find((h) => h.windowStart === start + 2 * H)!.lpFeesUsd = "999999";
		const second = simulate(new ResearchEngine(d), s, PLAYBOOKS[8]!, scene);
		expect(first.exitTime).toBe(second.exitTime);
		expect(first.feeProxy).toBe(second.feeProxy);
	});
	it("does not assign fees to untouched single-sided orders", () => {
		const d = data(),
			engine = new ResearchEngine(d),
			s = engine.signals()[0]!;
		const sell = simulate(engine, s, PLAYBOOKS[5]!, scene),
			buy = simulate(engine, s, PLAYBOOKS[7]!, scene);
		expect(Number(sell.lower)).toBeGreaterThanOrEqual(100);
		expect(Number(buy.upper)).toBeLessThanOrEqual(100);
		expect(Number(sell.feeProxy)).toBe(0);
		expect(Number(buy.feeProxy)).toBe(0);
	});
	it("stops rotation on an unpriceable exit and preserves at-risk principal", () => {
		const d = data();
		d.hours.find((h) => h.windowStart === start + H)!.tvlUsd = "10000";
		const engine = new ResearchEngine(d);
		const a = rollAccount(
			engine,
			engine.signals(),
			{ ...PLAYBOOKS[1]!, test: () => true },
			scene,
			"compound",
		);
		expect(a.status).toBe("unknown");
		expect(a.trades).toHaveLength(1);
		expect(Number(a.atRisk)).toBeCloseTo(999 / 1.005, 6);
		expect(Number(a.cash)).toBeGreaterThan(0);
		expect(a.finalEquity).toBeNull();
	});
	it("withdraws profit without funding losses, and compounds only realized proceeds", () => {
		const d = data();
		for (const h of d.hours) h.lpFeesUsd = "10000";
		const engine = new ResearchEngine(d),
			book = { ...PLAYBOOKS[1]!, test: () => true };
		const a = rollAccount(engine, engine.signals(), book, scene, "withdraw"),
			b = rollAccount(engine, engine.signals(), book, scene, "compound");
		expect(Number(a.withdrawn)).toBeGreaterThan(0);
		expect(a.trades[1]!.capital).toBe(a.trades[0]!.capital);
		expect(Number(b.trades[1]!.capital)).toBeGreaterThan(Number(b.trades[0]!.capital));
		for (let i = 1; i < b.trades.length; i++)
			expect(b.trades[i]!.entryTime).toBeGreaterThanOrEqual(b.trades[i - 1]!.exitTime! + H);
	});
	it("keeps a position entered when later hour coverage is missing", () => {
		const d = data();
		d.hours.find((h) => h.windowStart === start + H)!.complete = false;
		const engine = new ResearchEngine(d),
			s = engine.signals()[0]!,
			t = simulate(engine, s, PLAYBOOKS[1]!, scene);
		expect(t.entered).toBe(true);
		expect(t.status).toBe("unknown");
		expect(t.inventoryPnl).toBeNull();
	});
});
describe("offline signal research", () => {
	it("prices HYPE through prior-depth bridge instead of a dust pool or future TVL", () => {
		const d = data(),
			bridge = { ...d.pools[0]!, poolId: "z-liquid" },
			dust = { ...bridge, poolId: "a-dust" };
		d.pools[0]!.token1 = "0x1111111111111111111111111111111111111111";
		d.tokens.push({
			chainId: 99901,
			address: d.pools[0]!.token1,
			symbol: "TEST",
			decimals: 18,
			name: null,
		});
		d.bridges = {
			pools: [bridge, dust],
			hours: d.hours.flatMap((h) => [
				{ ...h, poolId: bridge.poolId },
				{
					...h,
					poolId: dust.poolId,
					tvlUsd: h.windowStart === start + 2 * H ? "1e30" : "1",
					sqrtPriceStart: sqrt(1e60),
					sqrtPriceEnd: sqrt(1e60),
				},
			]),
		};
		const e = new ResearchEngine(d),
			t = e.trial(e.signals()[0]!, "baseline", {
				width: 0.1,
				holdHours: 1,
				delayHours: 1,
				capital: "1000",
			});
		expect(t.status).toBe("modeled");
		expect(new Decimal(t.inventoryPnl!).abs().lt("1e-10")).toBe(true);
		expect([...e.pricing.values()].every((p) => p.poolId === bridge.poolId)).toBe(true);
	});
	it("uses exact existing eligibility boundaries and rejects unknown fees", () => {
		const h = { ...hour(start), tvlUsd: "1000", volumeUsd: "100", lpFeesUsd: "10" };
		expect(qualifies(h)).toBe(true);
		expect(qualifies({ ...h, lpFeesUsd: "9.99999999999999999" })).toBe(false);
		expect(qualifies({ ...h, feeStatus: "protocol_state_missing" })).toBe(false);
	});
	it("does not use future outcomes to change a historical signal", () => {
		const a = data(),
			first = new ResearchEngine(a).signals()[0]!;
		const b = structuredClone(a);
		for (const h of b.hours)
			if (h.windowStart > start) {
				h.lpFeesUsd = "900000";
				h.sqrtPriceEnd = sqrt(1);
				h.tvlUsd = "0";
			}
		expect(new ResearchEngine(b).signals()[0]).toEqual(first);
	});
	it("excludes partial and uncovered signal hours", () => {
		const a = data();
		a.hours.find((h) => h.windowStart === start)!.complete = false;
		expect(new ResearchEngine(a).signals().some((s) => s.start === start)).toBe(false);
		const b = data();
		b.coverage = b.coverage.filter((h) => h.windowStart !== start);
		expect(new ResearchEngine(b).signals().some((s) => s.start === start)).toBe(false);
	});
	it("does not use an unversioned legacy start price as a verified entry boundary", () => {
		const d = data();
		d.coverage.find((h) => h.windowStart === start + 2 * H)!.priceBoundaryVersion = null;
		const e = new ResearchEngine(d);
		expect(
			e.trial(e.signals()[0]!, "baseline", {
				width: 0.1,
				holdHours: 1,
				delayHours: 1,
				capital: "1000",
			}).status,
		).toBe("unknown");
	});
	it("values fixed-price inventory consistently and applies actual cost arithmetic", () => {
		const e = new ResearchEngine(data()),
			s = e.signals()[0]!;
		const t = e.trial(s, "baseline", { width: 0.1, holdHours: 2, delayHours: 1, capital: "1000" });
		expect(t.entryTime).toBe(s.start + 2 * H);
		expect(t.exitTime).toBe(s.start + 4 * H);
		expect(t.status).toBe("modeled");
		expect(new Decimal(t.inventoryPnl!).abs().lt("1e-12")).toBe(true);
		expect(t.feeProxy).toBe("2");
		expect(netPnl(t, "1000", 0.5, 50, "1")!.toNumber()).toBeCloseTo(-5, 10);
		expect(new Decimal(t.lower!).lt(t.entryPrice!)).toBe(true);
		expect(new Decimal(t.upper!).gt(t.entryPrice!)).toBe(true);
	});
	it("returns one asset outside range rather than full-range IL shortcut", () => {
		const p = new Decimal(100),
			lo = new Decimal(90),
			hi = new Decimal(110),
			l = new Decimal(100);
		expect(inventory(new Decimal(80), lo, hi, l).quote.isZero()).toBe(true);
		expect(inventory(new Decimal(120), lo, hi, l).base.isZero()).toBe(true);
		const at = inventory(p, lo, hi, l);
		expect(at.base.gt(0) && at.quote.gt(0)).toBe(true);
	});
	it("does not turn a drained pool or a missing hour into a successful exit", () => {
		const a = data();
		a.hours.find((h) => h.windowStart === start + 2 * H)!.tvlUsd = "0";
		const e = new ResearchEngine(a),
			t = e.trial(e.signals()[0]!, "baseline", {
				width: 0.1,
				holdHours: 1,
				delayHours: 1,
				capital: "1000",
			});
		expect(t.status).toBe("unknown");
		expect(t.inventoryPnl).toBe(null);
		expect(netPnl(t, "1000", 1, 0, "0")).toBe(null);
		const b = data();
		b.hours = b.hours.filter((h) => h.windowStart !== start + 2 * H);
		const eb = new ResearchEngine(b);
		expect(
			eb.trial(eb.signals()[0]!, "baseline", {
				width: 0.1,
				holdHours: 1,
				delayHours: 1,
				capital: "1000",
			}).status,
		).toBe("unknown");
	});
	it("accounts for a price drop as capital loss even if HODL also falls", () => {
		const a = data();
		a.hours.find((h) => h.windowStart === start + 3 * H)!.sqrtPriceStart = sqrt(50);
		const e = new ResearchEngine(a),
			t = e.trial(e.signals()[0]!, "baseline", {
				width: 0.1,
				holdHours: 1,
				delayHours: 1,
				capital: "1000",
			});
		expect(t.status).toBe("modeled");
		expect(new Decimal(t.inventoryPnl!).lt(-100)).toBe(true);
		expect(new Decimal(t.divergence!).lt(0)).toBe(true);
	});
	it("separates observation cutoff and prevents overlapping simulated positions", () => {
		const e = new ResearchEngine(data()),
			signals = e.signals();
		expect(
			e.trial(signals.at(-1)!, "baseline", {
				width: 0.1,
				holdHours: 4,
				delayHours: 1,
				capital: "1000",
			}).status,
		).toBe("censored");
		const out = e
			.run(signals, { width: 0.1, holdHours: 2, delayHours: 1, capital: "1000" })
			.filter((t) => t.strategy === "baseline");
		for (let i = 1; i < out.length; i++)
			expect(out[i]!.signalTime).toBeGreaterThanOrEqual(
				out[i - 1]!.exitTime ?? out[i - 1]!.entryTime + 2 * H,
			);
	});
	it("records forward observations without requiring an LP allocation assumption", () => {
		const e = new ResearchEngine(data()),
			f = e.forward(e.signals()[0]!, 2);
		expect(f.status).toBe("observed");
		expect(f.priceReturn).toBe("0");
		expect(f.futureFeeRate).toBe("0.001");
		expect(f.tvlRetention).toBe("1");
	});
});
