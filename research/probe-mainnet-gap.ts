import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AbiEvent, type Address, createPublicClient, type Hex, http } from "viem";
import { stateViewAbi, v3PoolAbi, v4PoolManagerAbi } from "../src/adapters/abi.ts";
import { findBlockAtOrAfter, readBlockTimestamp, readChainHead } from "../src/adapters/blocks.ts";
import { classifyRpcError } from "../src/adapters/errors.ts";
import { getLogsPaginated } from "../src/adapters/logs.ts";
import { elysiumMainnet } from "../src/shared/chain.ts";
import {
	ELYSIUM_PUBLIC_RPC_URL,
	HOUR_SECONDS as H,
	RPC_SOURCE_PUBLIC_TEMPORARY,
	UNISWAP_V4_ELYSIUM,
} from "../src/shared/constants.ts";
import type { Dataset } from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "outputs/signal-research/v2026-11-13-mainnet");
const GAP_START = Date.parse("2026-11-08T16:00:00.000Z") / 1000;
const GAP_END = Date.parse("2026-11-09T14:00:00.000Z") / 1000;
const shanghai = (unix: number): string =>
	new Date((unix + 8 * H) * 1000).toISOString().replace("T", " ").slice(0, 16);
const PUBLIC_URLS = [ELYSIUM_PUBLIC_RPC_URL, "https://rpc.agoradex.app"] as const;

function hostOf(url: string): string {
	return new URL(url).host;
}
function errInfo(error: unknown): { message: string; code?: string } {
	const classified = classifyRpcError(error);
	return { message: classified.message.slice(0, 400), code: classified.code };
}

function clientOf(url: string) {
	return createPublicClient({
		chain: elysiumMainnet,
		transport: http(url, {
			timeout: 20_000,
			fetchOptions: { headers: { "user-agent": "lp-atlas-research/mainnet-gap-probe" } },
			retryCount: 0,
		}),
	});
}

const dataset = JSON.parse(await fs.readFile(path.join(outDir, "dataset.json"), "utf8")) as Dataset;
const firstHour = dataset.start;
const v3Sample = dataset.pools.find((p) => p.protocol === "uniswap_v3" && p.poolAddress);
const v4Sample = dataset.pools.find((p) => p.protocol === "uniswap_v4");
const results: Record<string, unknown> = {
	probedAt: new Date().toISOString(),
	rpcKind: RPC_SOURCE_PUBLIC_TEMPORARY,
	endpoints: PUBLIC_URLS.map(hostOf),
	gap: {
		start: GAP_START,
		endExclusive: GAP_END,
		startLabel: shanghai(GAP_START),
		endLabel: shanghai(GAP_END - H),
		hours: (GAP_END - GAP_START) / H,
	},
	samples: {
		v3: v3Sample
			? { poolId: v3Sample.poolId, poolAddress: v3Sample.poolAddress, protocol: v3Sample.protocol }
			: null,
		v4: v4Sample ? { poolId: v4Sample.poolId, protocol: v4Sample.protocol } : null,
		firstLocalHour: shanghai(firstHour),
	},
};

const heads: Record<string, unknown> = {};
for (const url of PUBLIC_URLS) {
	const started = Date.now();
	try {
		const head = await readChainHead(clientOf(url));
		heads[hostOf(url)] = {
			ok: true,
			ms: Date.now() - started,
			blockNumber: head.blockNumber.toString(),
			timestamp: head.timestamp,
			timestampLabel: shanghai(head.timestamp),
		};
	} catch (error) {
		heads[hostOf(url)] = { ok: false, ms: Date.now() - started, ...errInfo(error) };
	}
}
results.heads = heads;

const workingUrl = PUBLIC_URLS.find((url) => (heads[hostOf(url)] as { ok?: boolean })?.ok);
if (!workingUrl) {
	results.status = "blocked_rpc_head";
	await writeProbe(results, "所有公共 RPC 都无法读取链头，缺口探测受阻，未回补。");
	process.exit(0);
}

const client = clientOf(workingUrl);
const head = await readChainHead(client);
results.workingEndpoint = hostOf(workingUrl);

const foundBlocks: Record<string, unknown> = {};
for (const [name, target] of Object.entries({
	gapStart: GAP_START,
	gapMid: GAP_START + 12 * H,
	gapEnd: GAP_END,
	localFirstHour: firstHour,
})) {
	const started = Date.now();
	try {
		const number = await findBlockAtOrAfter(client, target, head, 1n, Date.now() + 60_000);
		const timestamp = await readBlockTimestamp(client, number);
		const prev =
			number > 1n ? await readBlockTimestamp(client, number - 1n).catch(() => null) : null;
		foundBlocks[name] = {
			ok: true,
			ms: Date.now() - started,
			target,
			targetLabel: shanghai(target),
			blockNumber: number.toString(),
			timestamp,
			timestampLabel: shanghai(timestamp),
			previousTimestamp: prev,
			previousLabel: prev == null ? null : shanghai(prev),
			aligned: timestamp >= target && (prev == null || prev < target),
		};
	} catch (error) {
		foundBlocks[name] = {
			ok: false,
			ms: Date.now() - started,
			target,
			targetLabel: shanghai(target),
			...errInfo(error),
		};
	}
}
try {
	const genesis = await client.getBlock({ blockNumber: 1n });
	foundBlocks.block1 = {
		ok: true,
		blockNumber: "1",
		timestamp: Number(genesis.timestamp),
		timestampLabel: shanghai(Number(genesis.timestamp)),
		note: "区块 1 只说明链的更早时间，不是公开主网起点，本轮不回补上线前。",
	};
} catch (error) {
	foundBlocks.block1 = { ok: false, ...errInfo(error) };
}
results.blocks = foundBlocks;

const gapStartBlock = (foundBlocks.gapStart as { ok?: boolean; blockNumber?: string } | undefined)
	?.ok
	? BigInt((foundBlocks.gapStart as { blockNumber: string }).blockNumber)
	: null;
const localHourBlock = (
	foundBlocks.localFirstHour as { ok?: boolean; blockNumber?: string } | undefined
)?.ok
	? BigInt((foundBlocks.localFirstHour as { blockNumber: string }).blockNumber)
	: null;
const midBlock = (foundBlocks.gapMid as { ok?: boolean; blockNumber?: string } | undefined)?.ok
	? BigInt((foundBlocks.gapMid as { blockNumber: string }).blockNumber)
	: gapStartBlock;

const logProbes: Record<string, unknown> = {};
async function probeLogs(
	name: string,
	fromBlock: bigint | null,
	toBlock: bigint | null,
	address: Address,
	event: AbiEvent,
) {
	if (fromBlock == null || toBlock == null || toBlock < fromBlock) {
		logProbes[name] = { ok: false, error: "缺少区块边界，未请求日志" };
		return;
	}
	const started = Date.now();
	try {
		const logs = await getLogsPaginated({
			client,
			address,
			event,
			fromBlock,
			toBlock,
			chunkSize: 5_000n,
			deadlineAtMs: Date.now() + 90_000,
		});
		logProbes[name] = {
			ok: true,
			ms: Date.now() - started,
			fromBlock: fromBlock.toString(),
			toBlock: toBlock.toString(),
			logCount: logs.length,
			firstBlock: logs[0]?.blockNumber?.toString() ?? null,
			lastBlock: logs.at(-1)?.blockNumber?.toString() ?? null,
		};
	} catch (error) {
		logProbes[name] = {
			ok: false,
			ms: Date.now() - started,
			fromBlock: fromBlock.toString(),
			toBlock: toBlock.toString(),
			...errInfo(error),
		};
	}
}

const v4SwapEvent = v4PoolManagerAbi.find((x) => x.type === "event" && x.name === "Swap");
const v3SwapEvent = v3PoolAbi.find((x) => x.type === "event" && x.name === "Swap");
if (!v4SwapEvent || !v3SwapEvent) throw new Error("缺少 Swap 事件 ABI");

// First hour of the gap vs first hour already in the local DB, as a control.
const gapFirstHourEnd =
	midBlock != null && gapStartBlock != null && midBlock > gapStartBlock
		? gapStartBlock + (midBlock - gapStartBlock) / 12n
		: gapStartBlock != null
			? gapStartBlock + 2000n
			: null;
await probeLogs(
	"v4_swap_gap_first_hour_approx",
	gapStartBlock,
	gapFirstHourEnd,
	UNISWAP_V4_ELYSIUM.poolManager,
	v4SwapEvent,
);
await probeLogs(
	"v4_swap_local_first_hour_control",
	localHourBlock,
	localHourBlock != null ? localHourBlock + 2000n : null,
	UNISWAP_V4_ELYSIUM.poolManager,
	v4SwapEvent,
);

if (v3Sample?.poolAddress) {
	await probeLogs(
		"v3_swap_sample_gap_first_hour_approx",
		gapStartBlock,
		gapFirstHourEnd,
		v3Sample.poolAddress as Address,
		v3SwapEvent,
	);
	await probeLogs(
		"v3_swap_sample_local_first_hour_control",
		localHourBlock,
		localHourBlock != null ? localHourBlock + 2000n : null,
		v3Sample.poolAddress as Address,
		v3SwapEvent,
	);
}

// A slightly later slice inside the gap, around noon, if first-hour logs were empty or succeeded.
if (midBlock != null) {
	await probeLogs(
		"v4_swap_gap_mid_slice",
		midBlock,
		midBlock + 2000n,
		UNISWAP_V4_ELYSIUM.poolManager,
		v4SwapEvent,
	);
}
results.logs = logProbes;

const stateProbes: Record<string, unknown> = {};
async function probeState(name: string, blockNumber: bigint | null, work: () => Promise<unknown>) {
	if (blockNumber == null) {
		stateProbes[name] = { ok: false, error: "缺少历史区块" };
		return;
	}
	const started = Date.now();
	try {
		const value = await work();
		stateProbes[name] = {
			ok: true,
			ms: Date.now() - started,
			blockNumber: blockNumber.toString(),
			value,
		};
	} catch (error) {
		stateProbes[name] = {
			ok: false,
			ms: Date.now() - started,
			blockNumber: blockNumber.toString(),
			...errInfo(error),
		};
	}
}

if (v4Sample) {
	const id = v4Sample.poolId as Hex;
	await probeState("v4_slot0_gap_start", gapStartBlock, async () => {
		const [sqrtPriceX96, tick] = await client.readContract({
			address: UNISWAP_V4_ELYSIUM.stateView,
			abi: stateViewAbi,
			functionName: "getSlot0",
			args: [id],
			blockNumber: gapStartBlock as bigint,
		});
		return { sqrtPriceX96: sqrtPriceX96.toString(), tick: Number(tick) };
	});
	await probeState("v4_liquidity_gap_start", gapStartBlock, async () => {
		const liquidity = await client.readContract({
			address: UNISWAP_V4_ELYSIUM.stateView,
			abi: stateViewAbi,
			functionName: "getLiquidity",
			args: [id],
			blockNumber: gapStartBlock as bigint,
		});
		return { liquidity: liquidity.toString() };
	});
	await probeState("v4_slot0_local_first_control", localHourBlock, async () => {
		const [sqrtPriceX96, tick] = await client.readContract({
			address: UNISWAP_V4_ELYSIUM.stateView,
			abi: stateViewAbi,
			functionName: "getSlot0",
			args: [id],
			blockNumber: localHourBlock as bigint,
		});
		return { sqrtPriceX96: sqrtPriceX96.toString(), tick: Number(tick) };
	});
}
if (v3Sample?.poolAddress && gapStartBlock != null) {
	await probeState("v3_slot0_gap_start", gapStartBlock, async () => {
		const slot = await client.readContract({
			address: v3Sample.poolAddress as Address,
			abi: v3PoolAbi,
			functionName: "slot0",
			blockNumber: gapStartBlock,
		});
		return { sqrtPriceX96: slot[0].toString(), tick: Number(slot[1]) };
	});
}
results.state = stateProbes;

const logOk = Object.values(logProbes).some((v) => (v as { ok?: boolean; logCount?: number }).ok);
const logHistory = Object.entries(logProbes)
	.filter(([k]) => k.includes("gap"))
	.some(([, v]) => (v as { ok?: boolean }).ok);
const stateHistory = Object.entries(stateProbes)
	.filter(([k]) => k.includes("gap"))
	.some(([, v]) => (v as { ok?: boolean }).ok);
const logHistoryFailed = Object.entries(logProbes)
	.filter(([k]) => k.includes("gap"))
	.every(([, v]) => (v as { ok?: boolean }).ok === false);
const stateHistoryFailed = Object.entries(stateProbes)
	.filter(([k]) => k.includes("gap"))
	.every(([, v]) => (v as { ok?: boolean }).ok === false);

let status = "blocked";
let conclusion = "";
if (!logHistory && !stateHistory) {
	status = "blocked";
	conclusion =
		"公共 RPC 无法稳定读取 11 月 9 日 00:00–21:00 的历史日志与状态，缺口回补受阻。发现集先用 11 月 9 日 22:00 起已有数据，不编造上线日上午。";
} else if (logHistory && stateHistory) {
	status = "reachable";
	conclusion =
		"公共 RPC 能够读取缺口时段的 Swap 日志和官方 StateView/slot0 状态。下一步如做有界回补，只写入研究快照，不改生产 4 天保留，也不把 10 月 19 日至 11 月 8 日上线前数据并入发现集。";
} else {
	status = "partial";
	conclusion = logHistory
		? "缺口时段日志可取，但历史状态读取失败或不全。回补小时汇总可能缺边界价格/TVL，需单独评估，未自动回补。"
		: "缺口时段状态可取，但历史日志读取失败。没有 Swap 日志无法重建小时成交与手续费，回补受阻。";
}
results.status = status;
results.conclusion = conclusion;
results.flags = { logOk, logHistory, stateHistory, logHistoryFailed, stateHistoryFailed };

await writeProbe(results, conclusion);

async function writeProbe(data: Record<string, unknown>, conclusionText: string) {
	await fs.writeFile(path.join(outDir, "gap-probe.json"), JSON.stringify(data, null, 2));
	const md = `# 上线日缺口只读探测

探测时刻：${new Date().toISOString()}（写入时为 UTC；下文时间标签为 Asia/Shanghai）。公共 RPC 来源类型：\`public_temporary\`。端点只记录主机名：${PUBLIC_URLS.map(hostOf).join("、")}。未把密钥或完整配置写入本报告。未修改生产库、生产采集或 4 天小时档保留。未把 2026-10-19 至 2026-11-08 上线前数据混入发现集。

## 目标缺口

- ${shanghai(GAP_START)} 至 ${shanghai(GAP_END - H)}，共 ${(GAP_END - GAP_START) / H} 个完整小时。
- 本地已有小时档从 ${shanghai(GAP_END)} 开始。

## 结论

状态：**${data.status}**。

${conclusionText}

## 链头与区块

工作端点：${data.workingEndpoint ?? "无"}。

\`\`\`json
${JSON.stringify({ heads: data.heads, blocks: data.blocks }, null, 2)}
\`\`\`

## 日志探测

\`\`\`json
${JSON.stringify(data.logs ?? {}, null, 2)}
\`\`\`

## 状态探测

\`\`\`json
${JSON.stringify(data.state ?? {}, null, 2)}
\`\`\`

若状态不是 reachable，发现集继续使用 11 月 9 日 22:00 起的冻结样本。本探测本身不写入生产扫描调度，不留下服务进程。
`;
	await fs.writeFile(path.join(outDir, "gap-probe.md"), md, "utf8");
	console.log(
		JSON.stringify(
			{
				status: data.status,
				workingEndpoint: data.workingEndpoint,
				conclusion: conclusionText,
				out: path.join(outDir, "gap-probe.md"),
			},
			null,
			2,
		),
	);
}
