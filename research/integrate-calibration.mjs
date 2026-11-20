import assert from "node:assert/strict";
import fs from "node:fs";

const root = "outputs/signal-research";
const dir = `${root}/wallet-calibration`;
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const save = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const normalizeHour = (r) => ({
	poolId: r.pool_id,
	windowStart: r.window_start,
	windowEnd: r.window_end,
	complete: r.complete === 1,
	volume0: r.volume0,
	volume1: r.volume1,
	lpFees0: r.lp_fees0,
	lpFees1: r.lp_fees1,
	swapCount: r.swap_count,
	volumeUsd: r.volume_usd,
	lpFeesUsd: r.lp_fees_usd,
	feeStatus: r.fee_status,
	tvlUsd: r.tvl_usd,
	sqrtPriceStart: r.sqrt_price_start,
	sqrtPriceEnd: r.sqrt_price_end,
	source: "self_built",
	asOf: r.as_of,
	gapReason: r.gap_reason,
});
const original = load(`${root}/dataset.json`);
const audit = load(`${dir}/usd-audit.json`).hours.filter((h) => h.status === "observed");
const ids = [...new Set(audit.flatMap((h) => h.normalized.map((r) => r.pool_id)))];
const checked = new Map(
	audit.flatMap((h) => h.normalized.map((r) => [`${r.pool_id}:${r.window_start}`, r])),
);
const boundaries = audit.flatMap((h) =>
	h.normalized.map((r) => ({
		poolId: r.pool_id,
		time: r.window_end,
		hypeUsd: h.prices["0x0000000000000000000000000000000000000000"],
		block: h.atBlock,
	})),
);
const replacements = [];
const hours = original.hours.map((h) => {
	const r = checked.get(`${h.poolId}:${h.windowStart}`);
	if (!r) return h;
	const revised = { ...normalizeHour(r), source: h.source };
	replacements.push({ poolId: h.poolId, hour: h.windowStart, before: h, after: revised });
	return revised;
});
const end = Math.floor(load(`${dir}/exit-boundary.json`).removal.actualTime / 3600) * 3600;
const eventHours = [...checked.values()]
	.filter((r) => r.complete === 1 && r.window_end <= end)
	.map((r) => ({ ...normalizeHour(r), source: "self_built" }));
const pools = ids.map(
	(id) =>
		original.pools.find((p) => p.poolId === id) ?? {
			// Identity read from the existing catalog; this is the separately held 0.8% pool, not the 1% pool.
			poolId: id,
			chainId: 99901,
			protocol: "uniswap_v4",
			token0: "0x0000000000000000000000000000000000000000",
			token1: "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0",
			feePips: 8000,
			tickSpacing: 120,
			hooks: "0x0000000000000000000000000000000000000000",
			poolAddress: null,
			createdBlock: 2568482,
			createdAtUnix: 1794162595,
		},
);
assert.equal(pools.length, 2);
const start = Math.min(...eventHours.map((h) => h.windowStart));
const event = {
	...original,
	start,
	end,
	hours: eventHours,
	pools,
	coverage: [...new Set(eventHours.map((h) => h.windowStart))].map((t) => ({
		chainId: 99901,
		protocol: "uniswap_v4",
		windowStart: t,
		windowEnd: t + 3600,
		complete: true,
		fromBlock: "0",
		toBlock: "0",
		priceBoundaryVersion: 1,
		asOf: original.asOf,
		gapReason: null,
	})),
	calibration: {
		label: "KNTQ双池事件期 · 同区块直接桥重估，个人费用未校准",
		scope: "event",
		boundaries,
	},
};
const samePeriod = {
	...original,
	hours,
	calibration: {
		label: "原48H · 仅已核对KNTQ小时重估，其余池未校准",
		scope: "same_period",
		boundaries,
	},
};
assert.equal(samePeriod.start, original.start);
assert.equal(samePeriod.end, original.end);
assert.equal(samePeriod.hours.length, original.hours.length);
for (let i = 0; i < hours.length; i++)
	if (!checked.has(`${hours[i].poolId}:${hours[i].windowStart}`))
		assert.deepEqual(hours[i], original.hours[i]);
for (const p of pools)
	for (let t = start; t < end; t += 3600)
		assert(
			eventHours.some((h) => h.poolId === p.poolId && h.windowStart === t),
			`Missing ${p.poolId}:${t}`,
		);
const baselineFile = `${dir}/integration-baseline.json`;
if (!fs.existsSync(baselineFile)) {
	const baseline = {};
	for (const profile of ["lifecycle", "efficiency"]) {
		const r = load(`${root}/${profile}/results.json`);
		assert(!r.calibration, "Original baseline must precede calibration");
		baseline[profile] = {
			data: r.data,
			summaries: r.summaries,
			accounts: r.accounts.map(({ trades, ...a }) => ({ ...a, tradeCount: trades.length })),
			pairs: r.pairs.map((p) => ({
				book: p.book,
				scenario: p.scenario,
				poolId: p.dynamic.poolId,
				signalTime: p.dynamic.signalTime,
				entryTime: p.dynamic.entryTime,
				exitTime: p.dynamic.exitTime,
				lower: p.dynamic.lower,
				upper: p.dynamic.upper,
				status: p.dynamic.status,
				reason: p.dynamic.reason,
				inventoryPnl: p.dynamic.inventoryPnl,
				feeProxy: p.dynamic.feeProxy,
			})),
		};
	}
	save(baselineFile, baseline);
}
save(`${root}/dataset-calibrated.json`, samePeriod);
save(`${dir}/event-dataset.json`, event);
save(`${dir}/input-replacements.json`, replacements);
console.log(
	JSON.stringify({
		replacedHours: replacements.length,
		eventHours: eventHours.length,
		start,
		end,
		unchangedOtherPools: true,
		personalFeesCalibrated: false,
	}),
);
