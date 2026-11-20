import fs from "node:fs";
import Decimal from "decimal.js";
import { createPublicClient, custom, parseAbi, parseAbiItem } from "viem";
import { getLogsPaginated } from "../src/adapters/logs.ts";
import { isHypeLike, isOfficialUsdStable } from "../src/normalize/prices.ts";
import { ELYSIUM_MULTICALL3_ADDRESS, UNISWAP_V4_ELYSIUM } from "../src/shared/constants.ts";

const root = "outputs/signal-research",
	dir = `${root}/wallet-calibration`;
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) =>
	fs.writeFileSync(
		p,
		JSON.stringify(v, (_, v) => (typeof v === "bigint" ? String(v) : v)),
	);
const audit = load(`${dir}/usd-audit.json`).hours.filter((h) => h.status === "observed");
const event = load(`${dir}/event-dataset.json`);
const twoDay = process.argv.includes("--two-day");
const original = load(`${root}/dataset-calibrated.json`);
const allPools = new Map([...original.pools, ...event.pools].map((p) => [p.poolId, p]));
const tokenMap = new Map(original.tokens.map((t) => [t.address.toLowerCase(), t]));
const blockAt = new Map(audit.map((h) => [h.windowStart + 3600, h.atBlock]));
for (const h of original.coverage)
	if (h.complete && !blockAt.has(h.windowEnd)) blockAt.set(h.windowEnd, h.toBlock);
const plans = new Map();
// Freeze candidate ranges from both original experiments before replacing their results.
for (const [file, dataset] of [
	...["lifecycle", "efficiency"].map((profile) => [`${dir}/event-${profile}/results.json`, event]),
	...(twoDay
		? ["lifecycle", "efficiency"].map((profile) => [`${root}/${profile}/results.json`, original])
		: []),
	...(process.argv.includes("--all-pools") ? [[`${dir}/all-pool-strategies.json`, original]] : []),
]) {
	const data = load(file);
	const trials = data.pairs
		? data.pairs.map((p) => p.dynamic)
		: data.datasets.flatMap((d) => d.trials);
	for (const t of trials) {
		if (t.lower === null) continue;
		const pool = allPools.get(t.poolId),
			a = tokenMap.get(pool.token0.toLowerCase()),
			b = tokenMap.get(pool.token1.toLowerCase());
		const quote0 = isOfficialUsdStable(pool.token0)
			? true
			: isOfficialUsdStable(pool.token1)
				? false
				: isHypeLike(pool.token0)
					? true
					: isHypeLike(pool.token1)
						? false
						: null;
		if (quote0 === null) continue;
		const rawLower = (quote0 ? new Decimal(1).div(t.upper) : new Decimal(t.lower)).div(
			new Decimal(10).pow(a.decimals - b.decimals),
		);
		const rawUpper = (quote0 ? new Decimal(1).div(t.lower) : new Decimal(t.upper)).div(
			new Decimal(10).pow(a.decimals - b.decimals),
		);
		const lower = Math.round(rawLower.ln().div(new Decimal("1.0001").ln()).toNumber());
		const upper = Math.round(rawUpper.ln().div(new Decimal("1.0001").ln()).toNumber());
		if (lower % pool.tickSpacing || upper % pool.tickSpacing)
			throw Error("Tick reconstruction mismatch");
		for (
			let time = t.entryTime - 3600;
			time <= Math.min(t.entryTime + t.holdHours * 3600, dataset.end);
			time += 3600
		) {
			const block = blockAt.get(time);
			if (block)
				plans.set(`${t.poolId}:${lower}:${upper}:${time}`, {
					poolId: t.poolId,
					lower,
					upper,
					time,
					block,
				});
		}
	}
}
const planFile = `${dir}/position-fee-plan${twoDay ? "-full" : ""}.json`;
if (fs.existsSync(planFile))
	for (const p of load(planFile)) plans.set(`${p.poolId}:${p.lower}:${p.upper}:${p.time}`, p);
write(planFile, [...plans.values()]);
const cachePath = `${dir}/position-fee-rpc.json`;
const cache = fs.existsSync(cachePath) ? load(cachePath) : {};
let calls = 0,
	queue = Promise.resolve();
const failures = [];
const client = createPublicClient({
	transport: custom(
		{
			request: (request) => {
				const key = JSON.stringify(request);
				if (cache[key] !== undefined) return Promise.resolve(cache[key]);
				const task = queue.then(async () => {
					let last;
					for (const url of ["https://rpc.agoradex.app", "https://rpc.elysium.kinetiq.xyz"])
						try {
							const response = await fetch(url, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }),
								signal: AbortSignal.timeout(15000),
							});
							if (!response.ok) throw Error(`HTTP ${response.status}`);
							const data = await response.json();
							if (data.error) throw Error(JSON.stringify(data.error));
							cache[key] = data.result;
							calls++;
							write(cachePath, cache);
							return data.result;
						} catch (e) {
							last = e;
							failures.push({ method: request.method, url, error: String(e).slice(0, 240) });
						}
					throw last;
				});
				queue = task.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 400)));
				return task;
			},
		},
		{ retryCount: 0 },
	),
});
const abi = parseAbi([
	"function getFeeGrowthInside(bytes32,int24,int24) view returns(uint256,uint256)",
	"function getTickInfo(bytes32,int24) view returns(uint128,int128,uint256,uint256)",
]);
const v3Abi = parseAbi([
	"function feeGrowthGlobal0X128() view returns(uint256)",
	"function feeGrowthGlobal1X128() view returns(uint256)",
	"function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
	"function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
]);
const mod256 = (x) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
const stateFile = `${dir}/position-fee-states.json`;
const states = fs.existsSync(stateFile) ? load(stateFile) : {};
const byTime = new Map();
for (const p of plans.values()) {
	if (states[`${p.poolId}:${p.lower}:${p.upper}:${p.time}`]) continue;
	const list = byTime.get(p.time) ?? [];
	list.push(p);
	byTime.set(p.time, list);
}
console.log(
	JSON.stringify({ plannedRangeBoundaries: plans.size, uncachedBlockBatches: byTime.size }),
);
let completed = 0;
for (const [time, items] of byTime) {
	const contracts = [],
		offsets = [];
	for (const p of items) {
		offsets.push(contracts.length);
		const pool = allPools.get(p.poolId);
		if (pool.protocol === "uniswap_v3") {
			contracts.push(
				...["feeGrowthGlobal0X128", "feeGrowthGlobal1X128", "slot0"].map((functionName) => ({
					address: pool.poolAddress,
					abi: v3Abi,
					functionName,
				})),
			);
			contracts.push(
				...[p.lower, p.upper].map((t) => ({
					address: pool.poolAddress,
					abi: v3Abi,
					functionName: "ticks",
					args: [t],
				})),
			);
		} else
			contracts.push(
				{
					address: UNISWAP_V4_ELYSIUM.stateView,
					abi,
					functionName: "getFeeGrowthInside",
					args: [p.poolId, p.lower, p.upper],
				},
				...[p.lower, p.upper].map((t) => ({
					address: UNISWAP_V4_ELYSIUM.stateView,
					abi,
					functionName: "getTickInfo",
					args: [p.poolId, t],
				})),
			);
	}
	const results = await client.multicall({
		contracts,
		allowFailure: true,
		blockNumber: BigInt(items[0].block),
		multicallAddress: ELYSIUM_MULTICALL3_ADDRESS,
		batchSize: 24000,
	});
	for (let i = 0; i < items.length; i++) {
		const p = items[i],
			pool = allPools.get(p.poolId);
		const res = results.slice(offsets[i], offsets[i + 1] ?? results.length);
		if (!res.every((x) => x.status === "success")) continue;
		let growth0, growth1, l, u;
		if (pool.protocol === "uniswap_v3") {
			const [g0, g1, slot, low, up] = res.map((x) => x.result);
			l = low;
			u = up;
			const inside = (g, j) =>
				mod256(
					g -
						(slot[1] >= p.lower ? l[j] : mod256(g - l[j])) -
						(slot[1] < p.upper ? u[j] : mod256(g - u[j])),
				);
			growth0 = inside(g0, 2);
			growth1 = inside(g1, 3);
		} else {
			const [g, low, up] = res.map((x) => x.result);
			[growth0, growth1] = g;
			l = low;
			u = up;
		}
		states[`${p.poolId}:${p.lower}:${p.upper}:${time}`] = {
			...p,
			growth0: String(growth0),
			growth1: String(growth1),
			grossLower: String(l[0]),
			grossUpper: String(u[0]),
		};
	}
	write(stateFile, states);
	completed++;
	if (completed % 15 === 0)
		console.log(JSON.stringify({ blockBatches: completed, total: byTime.size, calls }));
}
const viable = [];
for (const s of Object.values(states)) {
	const next = states[`${s.poolId}:${s.lower}:${s.upper}:${s.time + 3600}`];
	if (
		next &&
		BigInt(s.grossLower) > 0n &&
		BigInt(s.grossUpper) > 0n &&
		BigInt(next.grossLower) > 0n &&
		BigInt(next.grossUpper) > 0n
	)
		viable.push({ s, next });
}
// A tick clearing/reinitializing inside the hour invalidates simple endpoint subtraction.
const modFile = `${dir}/position-fee-modifications${twoDay ? "-full" : ""}.json`;
const mods = fs.existsSync(modFile) ? load(modFile) : {};
const eventAbi = parseAbiItem(
	"event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
);
const times = [...new Set(viable.map((v) => v.s.time))].sort((a, b) => a - b);
for (const time of times) {
	if (mods[time]) continue;
	const current = viable.filter((v) => v.s.time === time);
	const ids = [...new Set(current.map((v) => v.s.poolId))];
	const fromBlock = BigInt(current[0].s.block) + 1n,
		toBlock = BigInt(current[0].next.block);
	const v4Ids = ids.filter((id) => allPools.get(id).protocol === "uniswap_v4");
	let normalized = [];
	if (v4Ids.length) {
		const filtered = {
			...client,
			getLogs: (params) => client.getLogs({ ...params, args: { id: v4Ids } }),
		};
		const logs = await getLogsPaginated({
			client: filtered,
			address: UNISWAP_V4_ELYSIUM.poolManager,
			event: eventAbi,
			fromBlock,
			toBlock,
			chunkSize: 8000n,
		});
		normalized = logs.map((l) => ({
			poolId: l.args.id,
			lower: l.args.tickLower,
			upper: l.args.tickUpper,
			delta: String(l.args.liquidityDelta),
			block: String(l.blockNumber),
			transactionIndex: l.transactionIndex,
			logIndex: l.logIndex,
		}));
	}
	const v3 = ids.map((id) => allPools.get(id)).filter((p) => p.protocol === "uniswap_v3");
	if (v3.length)
		for (const [definition, sign] of [
			[
				"event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
				1n,
			],
			[
				"event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
				-1n,
			],
		]) {
			const logs = await getLogsPaginated({
				client,
				address: v3.map((p) => p.poolAddress),
				event: parseAbiItem(definition),
				fromBlock,
				toBlock,
				chunkSize: 8000n,
			});
			normalized.push(
				...logs.map((l) => ({
					poolId: v3.find((p) => p.poolAddress.toLowerCase() === l.address.toLowerCase()).poolId,
					lower: l.args.tickLower,
					upper: l.args.tickUpper,
					delta: String(l.args.amount * sign),
					block: String(l.blockNumber),
					transactionIndex: l.transactionIndex,
					logIndex: l.logIndex,
				})),
			);
		}
	mods[time] = normalized;
	write(modFile, mods);
	if (Object.keys(mods).length % 10 === 0)
		console.log(
			JSON.stringify({ modificationHours: Object.keys(mods).length, total: times.length, calls }),
		);
}
const hours = [];
for (const s of Object.values(states)) {
	const next = states[`${s.poolId}:${s.lower}:${s.upper}:${s.time + 3600}`];
	if (!next) continue;
	let reason = null;
	if ([s.grossLower, s.grossUpper, next.grossLower, next.grossUpper].some((g) => BigInt(g) === 0n))
		reason = "range_tick_not_initialized_at_boundary";
	else if (!mods[s.time]) reason = "tick_continuity_not_checked";
	else {
		let low = BigInt(s.grossLower),
			high = BigInt(s.grossUpper);
		for (const m of [...mods[s.time]].sort(
			(a, b) =>
				Number(BigInt(a.block) - BigInt(b.block)) ||
				a.transactionIndex - b.transactionIndex ||
				a.logIndex - b.logIndex,
		)) {
			if (m.poolId !== s.poolId) continue;
			if (m.lower === s.lower || m.upper === s.lower) low += BigInt(m.delta);
			if (m.lower === s.upper || m.upper === s.upper) high += BigInt(m.delta);
			if (low <= 0n || high <= 0n) reason = "range_tick_cleared_inside_hour";
		}
		if (low !== BigInt(next.grossLower) || high !== BigInt(next.grossUpper))
			reason = "tick_gross_log_reconciliation_failed";
	}
	hours.push({
		poolId: s.poolId,
		lower: s.lower,
		upper: s.upper,
		start: s.time,
		growth0Start: s.growth0,
		growth1Start: s.growth1,
		growth0End: next.growth0,
		growth1End: next.growth1,
		status: reason ? "unknown" : "usable",
		reason,
	});
}
const evidence = {
	basis: "official_feeGrowthInside_per_unit_historical_liquidity",
	hours,
	failures,
};
write(`${dir}/position-fee-hours.json`, evidence);
for (const [input, out] of [
	[`${dir}/event-dataset.json`, `${dir}/event-growth-dataset.json`],
	[`${root}/dataset-calibrated.json`, `${root}/dataset-growth.json`],
]) {
	const data = load(input);
	data.positionFeeGrowth = evidence;
	data.calibration.label += " · 区间feeGrowth模型，无固定捕获比例";
	write(out, data);
}
console.log(
	JSON.stringify({
		calls,
		hours: hours.length,
		usable: hours.filter((h) => h.status === "usable").length,
		unknown: hours.filter((h) => h.status !== "usable").length,
		failures: failures.length,
	}),
);
