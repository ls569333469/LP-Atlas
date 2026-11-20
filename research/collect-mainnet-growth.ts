import fs from "node:fs";
import path from "node:path";
import { createPublicClient, custom, parseAbi, parseAbiItem } from "viem";
import { getLogsPaginated } from "../src/adapters/logs.ts";
import {
	ELYSIUM_MULTICALL3_ADDRESS,
	ELYSIUM_PUBLIC_RPC_URL,
	UNISWAP_V4_ELYSIUM,
} from "../src/shared/constants.ts";
import type { StoredPool } from "../src/store/types.ts";
import type { PositionFeeHour } from "./position-fees.ts";

export type GrowthPlan = {
	poolId: string;
	lower: number;
	upper: number;
	time: number;
	block: string;
};
type StateRow = GrowthPlan & {
	growth0: string;
	growth1: string;
	grossLower: string;
	grossUpper: string;
};

const PUBLIC_URLS = [ELYSIUM_PUBLIC_RPC_URL, "https://rpc.agoradex.app"] as const;
const v4Abi = parseAbi([
	"function getFeeGrowthInside(bytes32,int24,int24) view returns(uint256,uint256)",
	"function getTickInfo(bytes32,int24) view returns(uint128,int128,uint256,uint256)",
]);
const v3Abi = parseAbi([
	"function feeGrowthGlobal0X128() view returns(uint256)",
	"function feeGrowthGlobal1X128() view returns(uint256)",
	"function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
	"function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
]);
const mod256 = (x: bigint) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);

export async function collectPositionFeeGrowth(input: {
	plans: GrowthPlan[];
	pools: StoredPool[];
	cacheDir: string;
	deadlineAtMs?: number;
	label?: string;
}): Promise<{
	basis: string;
	hours: PositionFeeHour[];
	planned: number;
	states: number;
	usable: number;
	unknown: number;
}> {
	const dir = input.cacheDir;
	fs.mkdirSync(dir, { recursive: true });
	const load = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
	const write = (p: string, v: unknown) =>
		fs.writeFileSync(
			p,
			JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)),
		);
	const cachePath = path.join(dir, "rpc-cache.json");
	const stateFile = path.join(dir, "states.json");
	const modFile = path.join(dir, "modifications.json");
	const cache: Record<string, unknown> = fs.existsSync(cachePath) ? load(cachePath) : {};
	const states: Record<string, StateRow> = fs.existsSync(stateFile) ? load(stateFile) : {};
	const mods: Record<
		string,
		Array<{
			poolId: string;
			lower: number;
			upper: number;
			delta: string;
			block: string;
			transactionIndex: number;
			logIndex: number;
		}>
	> = fs.existsSync(modFile) ? load(modFile) : {};
	const pools = new Map(input.pools.map((p) => [p.poolId, p]));
	let calls = 0;
	const CONCURRENCY = 2;
	let active = 0;
	const waiters: Array<() => void> = [];
	const acquire = () =>
		new Promise<void>((resolve) => {
			if (active < CONCURRENCY) {
				active++;
				resolve();
			} else waiters.push(resolve);
		});
	const release = () => {
		const next = waiters.shift();
		if (next) next();
		else active--;
	};
	const client = createPublicClient({
		transport: custom(
			{
				request: async (request) => {
					const key = JSON.stringify(request);
					if (cache[key] !== undefined) return cache[key];
					await acquire();
					try {
						let last: unknown;
						for (const url of PUBLIC_URLS) {
							try {
								const response = await fetch(url, {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }),
									signal: AbortSignal.timeout(15000),
								});
								if (!response.ok) throw new Error(`HTTP ${response.status}`);
								const data = (await response.json()) as { error?: unknown; result: unknown };
								if (data.error) throw new Error(JSON.stringify(data.error));
								cache[key] = data.result;
								calls++;
								return data.result;
							} catch (e) {
								last = e;
							}
						}
						throw last;
					} finally {
						await new Promise((r) => setTimeout(r, 250));
						release();
					}
				},
			},
			{ retryCount: 0 },
		),
	});

	const unique = new Map<string, GrowthPlan>();
	for (const p of input.plans) {
		if (!p.block || !pools.has(p.poolId)) continue;
		unique.set(`${p.poolId}:${p.lower}:${p.upper}:${p.time}`, p);
	}
	const byTime = new Map<number, GrowthPlan[]>();
	for (const p of unique.values()) {
		if (states[`${p.poolId}:${p.lower}:${p.upper}:${p.time}`]) continue;
		const list = byTime.get(p.time) ?? [];
		list.push(p);
		byTime.set(p.time, list);
	}
	let completed = 0;
	const runHour = async (time: number, items: GrowthPlan[]): Promise<"ok" | "deadline"> => {
		if (input.deadlineAtMs && Date.now() > input.deadlineAtMs) return "deadline";
		const batchStarted = Date.now();
		const contracts: object[] = [];
		const offsets: number[] = [];
		for (const p of items) {
			offsets.push(contracts.length);
			const pool = pools.get(p.poolId);
			if (!pool) continue;
			if (pool.protocol === "uniswap_v3" && pool.poolAddress) {
				contracts.push(
					...["feeGrowthGlobal0X128", "feeGrowthGlobal1X128", "slot0"].map((functionName) => ({
						address: pool.poolAddress,
						abi: v3Abi,
						functionName,
					})),
					...[p.lower, p.upper].map((tick) => ({
						address: pool.poolAddress,
						abi: v3Abi,
						functionName: "ticks",
						args: [tick],
					})),
				);
			} else {
				contracts.push(
					{
						address: UNISWAP_V4_ELYSIUM.stateView,
						abi: v4Abi,
						functionName: "getFeeGrowthInside",
						args: [p.poolId, p.lower, p.upper],
					},
					...[p.lower, p.upper].map((tick) => ({
						address: UNISWAP_V4_ELYSIUM.stateView,
						abi: v4Abi,
						functionName: "getTickInfo",
						args: [p.poolId, tick],
					})),
				);
			}
		}
		if (!contracts.length) return "ok";
		const results = (await client.multicall({
			contracts: contracts as never,
			allowFailure: true,
			blockNumber: BigInt(items[0]?.block ?? "0"),
			multicallAddress: ELYSIUM_MULTICALL3_ADDRESS,
			batchSize: 24000,
		})) as Array<{ status: string; result?: unknown }>;
		for (let i = 0; i < items.length; i++) {
			const p = items[i];
			if (!p) continue;
			const pool = pools.get(p.poolId);
			if (!pool) continue;
			const res = results.slice(offsets[i] as number, offsets[i + 1] ?? results.length);
			if (!res.every((x) => x.status === "success")) continue;
			let growth0: bigint;
			let growth1: bigint;
			let low: unknown;
			let up: unknown;
			if (pool.protocol === "uniswap_v3") {
				const [g0, g1, slot, lo, hi] = res.map((x) => x.result) as [
					bigint,
					bigint,
					[bigint, number],
					[bigint, bigint, bigint, bigint],
					[bigint, bigint, bigint, bigint],
				];
				low = lo;
				up = hi;
				const inside = (g: bigint, j: 2 | 3) =>
					mod256(
						g -
							(slot[1] >= p.lower ? lo[j] : mod256(g - lo[j])) -
							(slot[1] < p.upper ? hi[j] : mod256(g - hi[j])),
					);
				growth0 = inside(g0, 2);
				growth1 = inside(g1, 3);
			} else {
				const [g, lo, hi] = res.map((x) => x.result) as [[bigint, bigint], [bigint], [bigint]];
				growth0 = g[0];
				growth1 = g[1];
				low = lo;
				up = hi;
			}
			const l = low as [bigint];
			const u = up as [bigint];
			states[`${p.poolId}:${p.lower}:${p.upper}:${p.time}`] = {
				...p,
				growth0: String(growth0),
				growth1: String(growth1),
				grossLower: String(l[0]),
				grossUpper: String(u[0]),
			};
		}
		write(stateFile, states);
		completed++;
		console.log(
			JSON.stringify({
				label: input.label ?? "growth",
				blockBatches: completed,
				total: byTime.size,
				hour: time,
				items: items.length,
				calls,
				concurrency: CONCURRENCY,
				ms: Date.now() - batchStarted,
			}),
		);
		if (completed % 10 === 0) write(cachePath, cache);
		return "ok";
	};
	const pendingTimes = [...byTime.keys()];
	for (let i = 0; i < pendingTimes.length; i += CONCURRENCY) {
		if (input.deadlineAtMs && Date.now() > input.deadlineAtMs) {
			console.log(
				JSON.stringify({
					label: input.label ?? "growth",
					phase: "state-deadline",
					blockBatches: completed,
					total: byTime.size,
					calls,
				}),
			);
			break;
		}
		const chunk = pendingTimes.slice(i, i + CONCURRENCY);
		const results = await Promise.all(chunk.map((time) => runHour(time, byTime.get(time) ?? [])));
		if (results.includes("deadline")) {
			console.log(
				JSON.stringify({
					label: input.label ?? "growth",
					phase: "state-deadline",
					blockBatches: completed,
					total: byTime.size,
					calls,
				}),
			);
			break;
		}
	}
	write(cachePath, cache);

	const viable: Array<{ s: StateRow; next: StateRow }> = [];
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
	const times = [...new Set(viable.map((v) => v.s.time))].sort((a, b) => a - b);
	for (const time of times) {
		if (mods[String(time)]) continue;
		if (input.deadlineAtMs && Date.now() > input.deadlineAtMs) break;
		const current = viable.filter((v) => v.s.time === time);
		const first = current[0];
		if (!first) continue;
		const ids = [...new Set(current.map((v) => v.s.poolId))];
		const fromBlock = BigInt(first.s.block) + 1n;
		const toBlock = BigInt(first.next.block);
		const normalized: Array<{
			poolId: string;
			lower: number;
			upper: number;
			delta: string;
			block: string;
			transactionIndex: number;
			logIndex: number;
		}> = [];
		const v4Ids = ids.filter((id) => pools.get(id)?.protocol === "uniswap_v4");
		if (v4Ids.length) {
			const eventAbi = parseAbiItem(
				"event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
			);
			const filtered = {
				...client,
				getLogs: (params: object) => client.getLogs({ ...params, args: { id: v4Ids } } as never),
			};
			const logs = await getLogsPaginated({
				client: filtered as never,
				address: UNISWAP_V4_ELYSIUM.poolManager,
				event: eventAbi,
				fromBlock,
				toBlock,
				chunkSize: 8000n,
			});
			for (const log of logs) {
				const args = (log as typeof log & { args: unknown }).args as {
					id: string;
					tickLower: number;
					tickUpper: number;
					liquidityDelta: bigint;
				};
				normalized.push({
					poolId: String(args.id),
					lower: Number(args.tickLower),
					upper: Number(args.tickUpper),
					delta: String(args.liquidityDelta),
					block: String(log.blockNumber),
					transactionIndex: log.transactionIndex ?? 0,
					logIndex: log.logIndex ?? 0,
				});
			}
		}
		const v3 = ids
			.map((id) => pools.get(id))
			.filter((p): p is StoredPool => p?.protocol === "uniswap_v3" && !!p.poolAddress);
		if (v3.length) {
			for (const [definition, sign] of [
				[
					"event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
					1n,
				],
				[
					"event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
					-1n,
				],
			] as const) {
				const logs = await getLogsPaginated({
					client,
					address: v3.map((p) => p.poolAddress as `0x${string}`),
					event: parseAbiItem(definition),
					fromBlock,
					toBlock,
					chunkSize: 8000n,
				});
				for (const log of logs) {
					const pool = v3.find((p) => p.poolAddress?.toLowerCase() === log.address.toLowerCase());
					const args = (log as typeof log & { args: unknown }).args as {
						tickLower: number;
						tickUpper: number;
						amount: bigint;
					};
					if (!pool) continue;
					normalized.push({
						poolId: pool.poolId,
						lower: Number(args.tickLower),
						upper: Number(args.tickUpper),
						delta: String(args.amount * sign),
						block: String(log.blockNumber),
						transactionIndex: log.transactionIndex ?? 0,
						logIndex: log.logIndex ?? 0,
					});
				}
			}
		}
		mods[String(time)] = normalized;
		write(modFile, mods);
	}

	const hours: PositionFeeHour[] = [];
	for (const s of Object.values(states)) {
		const next = states[`${s.poolId}:${s.lower}:${s.upper}:${s.time + 3600}`];
		if (!next) continue;
		const modifications = mods[String(s.time)];
		let reason: string | null = null;
		if (
			[s.grossLower, s.grossUpper, next.grossLower, next.grossUpper].some((g) => BigInt(g) === 0n)
		)
			reason = "range_tick_not_initialized_at_boundary";
		else if (!modifications) reason = "tick_continuity_not_checked";
		else {
			let low = BigInt(s.grossLower);
			let high = BigInt(s.grossUpper);
			for (const m of [...modifications].sort(
				(a, b) =>
					Number(BigInt(a.block) - BigInt(b.block)) ||
					a.transactionIndex - b.transactionIndex ||
					a.logIndex - b.logIndex,
			)) {
				if (m.poolId.toLowerCase() !== s.poolId.toLowerCase()) continue;
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
		planned: unique.size,
		states: Object.keys(states).length,
		usable: hours.filter((h) => h.status === "usable").length,
		unknown: hours.filter((h) => h.status !== "usable").length,
	};
	write(path.join(dir, "position-fee-hours.json"), evidence);
	return evidence;
}
