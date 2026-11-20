import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient, type InValue } from "@libsql/client";
import { isHypeLike, isOfficialUsdStable } from "../src/normalize/prices.ts";
import { HOUR_SECONDS as H } from "../src/shared/constants.ts";
import {
	latestSuccessfulRefresh,
	listPoolsByIds,
	listScannedHours,
	listTokensForPools,
	listWindowsInRange,
} from "../src/store/repositories.ts";
import type { StoredPool, StoredWindow } from "../src/store/types.ts";
import { type Dataset, normalizeHour, qualifies } from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "outputs/signal-research/v2026-11-13-mainnet");
const dbPath = path.resolve(root, "data/lp-atlas.db");
const snapPath = path.join(outDir, "snapshot.db");

/** 2026-11-09 22:00 Asia/Shanghai. Public mainnet day, first hour already in the local DB. */
const LOCAL_START = Date.parse("2026-11-09T14:00:00.000Z") / 1000;
/** Discovery set ends at 2026-11-11 12:00 Asia/Shanghai (last included hour starts 11:00). */
const DISCOVERY_END = Date.parse("2026-11-11T04:00:00.000Z") / 1000;
/** Outflow pressure set starts 2026-11-11 13:00 Asia/Shanghai. */
const OUTFLOW_START = Date.parse("2026-11-11T05:00:00.000Z") / 1000;
/** Mainnet-day gap to probe later: 2026-11-09 00:00–21:00 Asia/Shanghai. */
const GAP_START = Date.parse("2026-11-08T16:00:00.000Z") / 1000;
const GAP_END = LOCAL_START;

const EXTREME = 1e12;
const SUSPICIOUS_VOLUME = 1e8;
const SUSPICIOUS_FEES = 1e6;
const SUSPICIOUS_TVL = 1e8;

const shanghai = (unix: number): string =>
	new Date((unix + 8 * H) * 1000).toISOString().replace("T", " ").slice(0, 16);
const dayOf = (unix: number): string => shanghai(unix).slice(0, 10);
const num = (value: string | null | undefined): number | null => {
	if (value == null || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};
function segmentOf(start: number): "discovery" | "boundary" | "outflow" | "outside" {
	if (start >= LOCAL_START && start < DISCOVERY_END) return "discovery";
	if (start === DISCOVERY_END) return "boundary";
	if (start >= OUTFLOW_START) return "outflow";
	return "outside";
}
type UsdFlag = "ok" | "extreme" | "suspicious" | "invalid";
function usdFlag(row: StoredWindow): UsdFlag {
	const volume = num(row.volumeUsd);
	const fees = num(row.lpFeesUsd);
	const tvl = num(row.tvlUsd);
	const fields = [row.volumeUsd, row.lpFeesUsd, row.tvlUsd];
	if (fields.some((v) => v != null && v !== "" && num(v) === null)) return "invalid";
	if ([volume, fees, tvl].some((v) => v != null && Math.abs(v) >= EXTREME)) return "extreme";
	if (
		(volume != null && Math.abs(volume) >= SUSPICIOUS_VOLUME) ||
		(fees != null && Math.abs(fees) >= SUSPICIOUS_FEES) ||
		(tvl != null && Math.abs(tvl) >= SUSPICIOUS_TVL)
	)
		return "suspicious";
	return "ok";
}
function csvEscape(value: unknown): string {
	const text = value == null ? "" : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function writeCsv(file: string, headers: string[], rows: Array<Array<unknown>>) {
	const body = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
	await fs.writeFile(file, `${body}\n`, "utf8");
}

await fs.mkdir(outDir, { recursive: true });
const db = createClient({ url: `file:${dbPath}` });
await db.execute("PRAGMA query_only=ON");
const tx = await db.transaction("read");

let dataset: Dataset;
let currentHour = 0;
let latestAsOf = "";
let revision = 0;
let rpcKind = "";
let rpcLabel = "";
try {
	const last = await latestSuccessfulRefresh(tx);
	if (!last?.blockTime) throw new Error("没有可发布数据");
	currentHour = Math.floor(Date.parse(last.blockTime) / 1000 / H) * H;
	if (currentHour < LOCAL_START + H) throw new Error("当前小时早于本地样本起点，无法冻结");
	const researchEnd = currentHour;
	latestAsOf = last.blockTime;
	revision = last.id;
	rpcKind = last.rpcSourceKind;
	rpcLabel = last.rpcSourceLabel;
	const all = await listWindowsInRange(tx, LOCAL_START, researchEnd + H);
	const coverage = await listScannedHours(tx, {
		startUnix: LOCAL_START,
		endUnixExclusive: researchEnd + H,
	});
	const hoursInWindow = all.filter(
		(h) => h.windowStart >= LOCAL_START && h.windowStart < researchEnd,
	);
	const catalogIds = [...new Set(all.map((h) => h.poolId))];
	const catalog = await listPoolsByIds(tx, catalogIds);
	const catalogMap = new Map(catalog.map((p) => [p.poolId, p]));
	const normalized = hoursInWindow.flatMap((h) => {
		const pool = catalogMap.get(h.poolId);
		return pool ? [normalizeHour(h, pool)] : [];
	});
	const candidateIds = [
		...new Set(normalized.filter((h) => h.complete && qualifies(h)).map((h) => h.poolId)),
	];
	const pools = await listPoolsByIds(tx, candidateIds);
	const poolMap = new Map(pools.map((p) => [p.poolId, p]));
	const bridgePools = catalog.filter(
		(p) =>
			(isHypeLike(p.token0) && isOfficialUsdStable(p.token1)) ||
			(isHypeLike(p.token1) && isOfficialUsdStable(p.token0)),
	);
	const bridgeSet = new Set(bridgePools.map((p) => p.poolId));
	const keepIds = [...new Set([...candidateIds, ...bridgeSet])];
	dataset = {
		schema: 1,
		exportedAt: new Date().toISOString(),
		revision,
		asOf: latestAsOf,
		start: LOCAL_START,
		end: researchEnd,
		pools,
		tokens: await listTokensForPools(tx, keepIds),
		hours: all
			.filter((h) => keepIds.includes(h.poolId))
			.flatMap((h) => {
				const pool = poolMap.get(h.poolId) ?? catalogMap.get(h.poolId);
				return pool ? [normalizeHour(h, pool)] : [];
			}),
		coverage,
		bridges: {
			pools: bridgePools,
			hours: all.filter((h) => bridgeSet.has(h.poolId)),
		},
	};
	await writeSnapshot(tx, {
		researchEnd,
		all,
		coverage,
		catalog,
		keepIds,
	});
	await writeCoverage({
		researchEnd,
		all,
		coverage,
		catalogMap,
		normalized,
		pools,
	});
} finally {
	tx.close();
	db.close();
}

await fs.writeFile(path.join(outDir, "dataset.json"), JSON.stringify(dataset));
await fs.writeFile(
	path.join(outDir, "manifest.json"),
	JSON.stringify(
		{
			version: "v2026-11-13-mainnet",
			exportedAt: dataset.exportedAt,
			timezone: "Asia/Shanghai",
			localStart: LOCAL_START,
			localStartLabel: shanghai(LOCAL_START),
			researchEnd: dataset.end,
			researchEndLabel: shanghai(dataset.end),
			latestCompleteHour: shanghai(dataset.end - H),
			currentIncompleteHour: shanghai(dataset.end),
			asOf: dataset.asOf,
			revision: dataset.revision,
			rpcSourceKind: rpcKind,
			rpcSourceLabel: rpcLabel.replace(/https?:\/\/\S+/g, "[public_temporary]"),
			discovery: {
				start: LOCAL_START,
				endExclusive: DISCOVERY_END,
				label: `${shanghai(LOCAL_START)} 至 ${shanghai(DISCOVERY_END)}（不含 12:00 这一小时）`,
			},
			boundaryHour: { start: DISCOVERY_END, label: shanghai(DISCOVERY_END) },
			outflow: {
				start: OUTFLOW_START,
				endExclusive: dataset.end,
				label: `${shanghai(OUTFLOW_START)} 至 ${shanghai(dataset.end - H)}`,
			},
			mainnetDayGap: {
				start: GAP_START,
				endExclusive: GAP_END,
				label: `${shanghai(GAP_START)} 至 ${shanghai(GAP_END - H)}`,
				status: "not_in_local_db",
				note: "公开主网上线日 00:00–21:00 不在本地小时档，需另做只读探测；未编造。",
			},
			preMainnet: {
				note: "2026-10-19 至 2026-11-08 为公开主网上线前，本快照不收录，不混进发现集。",
			},
			counts: {
				candidatePools: dataset.pools.length,
				hoursExported: dataset.hours.length,
				tokens: dataset.tokens.length,
				bridgePools: dataset.bridges.pools.length,
			},
			anomalyRules: {
				extreme: `任一美元字段绝对值 >= ${EXTREME}`,
				suspiciousVolume: SUSPICIOUS_VOLUME,
				suspiciousFees: SUSPICIOUS_FEES,
				suspiciousTvl: SUSPICIOUS_TVL,
				aggregatesExclude: "extreme、suspicious、invalid 均不进入金额汇总",
			},
			productionUntouched: true,
			oldPackageUntouched: "outputs/signal-research/ 根目录 48 小时包未覆盖",
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify(
		{
			outDir,
			start: shanghai(dataset.start),
			endExclusive: shanghai(dataset.end),
			latestCompleteHour: shanghai(dataset.end - H),
			pools: dataset.pools.length,
			hours: dataset.hours.length,
			tokens: dataset.tokens.length,
			coverageHours: dataset.coverage.length,
		},
		null,
		2,
	),
);

async function writeSnapshot(
	tx: Pick<Client, "execute">,
	input: {
		researchEnd: number;
		all: StoredWindow[];
		coverage: Dataset["coverage"];
		catalog: StoredPool[];
		keepIds: string[];
	},
) {
	try {
		await fs.unlink(snapPath);
	} catch {
		// first freeze
	}
	const snap = createClient({ url: `file:${snapPath}` });
	try {
		await snap.execute("PRAGMA journal_mode=WAL");
		await snap.execute(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		await snap.execute(`CREATE TABLE pools (
			pool_id TEXT PRIMARY KEY, chain_id INTEGER, protocol TEXT, token0 TEXT, token1 TEXT,
			fee_pips INTEGER, tick_spacing INTEGER, hooks TEXT, pool_address TEXT,
			created_block INTEGER, created_at_unix INTEGER
		)`);
		await snap.execute(`CREATE TABLE tokens (
			chain_id INTEGER, address TEXT, symbol TEXT, decimals INTEGER, name TEXT,
			PRIMARY KEY (chain_id, address)
		)`);
		await snap.execute(`CREATE TABLE window_aggregates (
			pool_id TEXT NOT NULL, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
			complete INTEGER, volume0 TEXT, volume1 TEXT, lp_fees0 TEXT, lp_fees1 TEXT,
			swap_count INTEGER, volume_usd TEXT, lp_fees_usd TEXT, tvl_usd TEXT,
			sqrt_price_start TEXT, sqrt_price_end TEXT, source TEXT, as_of TEXT,
			gap_reason TEXT, fee_status TEXT, PRIMARY KEY (pool_id, window_start)
		)`);
		await snap.execute(`CREATE TABLE scanned_hours (
			chain_id INTEGER, protocol TEXT, window_start INTEGER, window_end INTEGER,
			complete INTEGER, from_block TEXT, to_block TEXT, as_of TEXT, gap_reason TEXT,
			state_block_number TEXT, price_boundary_version INTEGER, usd_bridge_version INTEGER,
			PRIMARY KEY (chain_id, protocol, window_start)
		)`);
		const tokens = await listTokensForPools(tx, [...new Set(input.all.map((h) => h.poolId))]);
		const insert = async (sql: string, args: InValue[]) => snap.execute({ sql, args });
		for (const [k, v] of Object.entries({
			frozen_at: new Date().toISOString(),
			local_start: String(LOCAL_START),
			research_end: String(input.researchEnd),
			revision: String(revision),
			as_of: latestAsOf,
			rpc_source_kind: rpcKind,
			note: "research snapshot; not the production database",
		})) {
			await insert("INSERT INTO meta(key,value) VALUES(?,?)", [k, v]);
		}
		for (const p of input.catalog) {
			await insert(`INSERT INTO pools VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
				p.poolId,
				p.chainId,
				p.protocol,
				p.token0,
				p.token1,
				p.feePips,
				p.tickSpacing,
				p.hooks,
				p.poolAddress,
				p.createdBlock,
				p.createdAtUnix,
			]);
		}
		for (const t of tokens) {
			await insert("INSERT INTO tokens VALUES (?,?,?,?,?)", [
				t.chainId,
				t.address,
				t.symbol,
				t.decimals,
				t.name,
			]);
		}
		for (const h of input.all) {
			await insert(`INSERT INTO window_aggregates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
				h.poolId,
				h.windowStart,
				h.windowEnd,
				h.complete ? 1 : 0,
				h.volume0,
				h.volume1,
				h.lpFees0,
				h.lpFees1,
				h.swapCount,
				h.volumeUsd,
				h.lpFeesUsd,
				h.tvlUsd,
				h.sqrtPriceStart,
				h.sqrtPriceEnd,
				h.source,
				h.asOf,
				h.gapReason,
				h.feeStatus ?? null,
			]);
		}
		for (const h of input.coverage) {
			await insert(`INSERT INTO scanned_hours VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
				h.chainId,
				h.protocol,
				h.windowStart,
				h.windowEnd,
				h.complete ? 1 : 0,
				h.fromBlock,
				h.toBlock,
				h.asOf,
				h.gapReason,
				h.stateBlockNumber ?? null,
				h.priceBoundaryVersion ?? null,
				h.usdBridgeVersion ?? null,
			]);
		}
	} finally {
		snap.close();
	}
}

async function writeCoverage(input: {
	researchEnd: number;
	all: StoredWindow[];
	coverage: Dataset["coverage"];
	catalogMap: Map<string, StoredPool>;
	normalized: StoredWindow[];
	pools: StoredPool[];
}) {
	const { researchEnd, coverage, normalized, pools } = input;
	const expectedHours: number[] = [];
	for (let t = LOCAL_START; t < researchEnd; t += H) expectedHours.push(t);
	const protocols = ["uniswap_v3", "uniswap_v4"];
	const missing: Array<Array<unknown>> = [];
	const coverageRows: Array<Array<unknown>> = [];
	for (const protocol of protocols) {
		const rows = coverage.filter((h) => h.protocol === protocol);
		const byStart = new Map(rows.map((h) => [h.windowStart, h]));
		for (const t of expectedHours) {
			const row = byStart.get(t);
			if (!row) {
				missing.push([
					protocol,
					t,
					shanghai(t),
					"missing_scanned_hour",
					"本地库没有该小时扫描记录",
				]);
				continue;
			}
			coverageRows.push([
				protocol,
				t,
				shanghai(t),
				row.complete ? "complete" : "incomplete",
				row.gapReason ?? "",
				row.fromBlock,
				row.toBlock,
				row.stateBlockNumber ?? "",
				row.priceBoundaryVersion ?? "",
				row.usdBridgeVersion ?? "",
			]);
		}
		const current = byStart.get(researchEnd);
		if (current) {
			coverageRows.push([
				protocol,
				researchEnd,
				shanghai(researchEnd),
				current.complete ? "complete" : "incomplete_current",
				current.gapReason ?? "",
				current.fromBlock,
				current.toBlock,
				current.stateBlockNumber ?? "",
				current.priceBoundaryVersion ?? "",
				current.usdBridgeVersion ?? "",
			]);
		} else {
			missing.push([
				protocol,
				researchEnd,
				shanghai(researchEnd),
				"missing_current",
				"当前未完成小时无扫描行",
			]);
		}
	}

	const qualifying = normalized.filter((h) => h.complete && qualifies(h));
	const byDay = new Map<
		string,
		{
			qualHours: number;
			qualPools: Set<string>;
			extreme: number;
			suspicious: number;
			invalid: number;
			volume: number;
			fees: number;
			tvlHours: number;
			completeHours: number;
			discoveryQual: number;
			outflowQual: number;
			boundaryQual: number;
		}
	>();
	const bump = (day: string) => {
		let row = byDay.get(day);
		if (!row) {
			row = {
				qualHours: 0,
				qualPools: new Set(),
				extreme: 0,
				suspicious: 0,
				invalid: 0,
				volume: 0,
				fees: 0,
				tvlHours: 0,
				completeHours: 0,
				discoveryQual: 0,
				outflowQual: 0,
				boundaryQual: 0,
			};
			byDay.set(day, row);
		}
		return row;
	};
	for (const h of normalized.filter(
		(h) => h.windowStart >= LOCAL_START && h.windowStart < researchEnd && h.complete,
	)) {
		bump(dayOf(h.windowStart)).completeHours++;
	}
	const anomalies: Array<Array<unknown>> = [];
	for (const h of qualifying) {
		const flag = usdFlag(h);
		const day = dayOf(h.windowStart);
		const row = bump(day);
		row.qualHours++;
		row.qualPools.add(h.poolId);
		const seg = segmentOf(h.windowStart);
		if (seg === "discovery") row.discoveryQual++;
		else if (seg === "outflow") row.outflowQual++;
		else if (seg === "boundary") row.boundaryQual++;
		if (flag === "extreme") row.extreme++;
		else if (flag === "suspicious") row.suspicious++;
		else if (flag === "invalid") row.invalid++;
		else {
			row.volume += num(h.volumeUsd) ?? 0;
			row.fees += num(h.lpFeesUsd) ?? 0;
			row.tvlHours++;
		}
		if (flag !== "ok") {
			anomalies.push([
				h.poolId,
				h.windowStart,
				shanghai(h.windowStart),
				seg,
				flag,
				h.volumeUsd,
				h.lpFeesUsd,
				h.tvlUsd,
				h.swapCount,
				h.feeStatus ?? "",
			]);
		}
	}

	const notQualReasons = new Map<string, number>();
	for (const h of normalized.filter(
		(h) =>
			h.windowStart >= LOCAL_START && h.windowStart < researchEnd && h.complete && !qualifies(h),
	)) {
		const tvl = num(h.tvlUsd);
		const volume = num(h.volumeUsd);
		const fees = num(h.lpFeesUsd);
		let reason = "other";
		if (h.feeStatus && h.feeStatus !== "estimated" && h.feeStatus !== "verified_zero")
			reason = `fee_unusable:${h.feeStatus}`;
		else if (tvl == null) reason = "tvl_missing";
		else if (tvl < 1000) reason = "tvl_below_1000";
		else if (volume == null) reason = "volume_missing";
		else if (volume < 100) reason = "volume_below_100";
		else if (fees == null) reason = "fees_missing";
		else if (fees < 10) reason = "fees_below_10";
		notQualReasons.set(reason, (notQualReasons.get(reason) ?? 0) + 1);
	}

	const poolRows = pools.map((p) => {
		const hours = qualifying.filter((h) => h.poolId === p.poolId);
		const first = hours[0]?.windowStart ?? null;
		const last = hours.at(-1)?.windowStart ?? null;
		const discovery = hours.filter((h) => segmentOf(h.windowStart) === "discovery").length;
		const outflow = hours.filter((h) => segmentOf(h.windowStart) === "outflow").length;
		const laterCool =
			hours.length > 0 &&
			last != null &&
			last < researchEnd - H &&
			!qualifies(
				normalized.find((h) => h.poolId === p.poolId && h.windowStart === researchEnd - H) ??
					({} as StoredWindow),
			);
		return [
			p.poolId,
			p.protocol,
			p.feePips,
			p.tickSpacing,
			p.hooks ?? "",
			hours.length,
			discovery,
			outflow,
			first != null ? shanghai(first) : "",
			last != null ? shanghai(last) : "",
			laterCool ? "cooled_or_absent_at_end" : "still_or_unknown",
		];
	});

	await writeCsv(
		path.join(outDir, "coverage-by-day.csv"),
		[
			"day",
			"complete_pool_hours",
			"qual_hours",
			"qual_pools",
			"discovery_qual_hours",
			"boundary_qual_hours",
			"outflow_qual_hours",
			"extreme_usd",
			"suspicious_usd",
			"invalid_usd",
			"sum_volume_usd_clean",
			"sum_lp_fees_usd_clean",
			"clean_qual_hours",
		],
		[...byDay.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([day, r]) => [
				day,
				r.completeHours,
				r.qualHours,
				r.qualPools.size,
				r.discoveryQual,
				r.boundaryQual,
				r.outflowQual,
				r.extreme,
				r.suspicious,
				r.invalid,
				r.volume,
				r.fees,
				r.tvlHours,
			]),
	);
	await writeCsv(
		path.join(outDir, "coverage-by-status.csv"),
		["status", "count", "note"],
		[
			["candidate_pools", pools.length, "研究窗内至少 1 个完整小时达到统一 1H 准入"],
			[
				"qualifying_hours",
				qualifying.length,
				"完整小时且 TVL>=1000、成交量>=100、普通 LP 手续费>=10、费用状态可用",
			],
			[
				"discovery_qual_hours",
				qualifying.filter((h) => segmentOf(h.windowStart) === "discovery").length,
				"11-09 22:00 至 11-11 11:00",
			],
			[
				"boundary_qual_hours",
				qualifying.filter((h) => segmentOf(h.windowStart) === "boundary").length,
				"11-11 12:00 既不进发现集也不进外流集",
			],
			[
				"outflow_qual_hours",
				qualifying.filter((h) => segmentOf(h.windowStart) === "outflow").length,
				"11-11 13:00 至最近已完成小时",
			],
			[
				"extreme_usd_qual_hours",
				anomalies.filter((r) => r[4] === "extreme").length,
				"合格观察中美元字段达到万亿量级，金额汇总已剔除",
			],
			[
				"suspicious_usd_qual_hours",
				anomalies.filter((r) => r[4] === "suspicious").length,
				"合格观察中成交/费用/TVL 超过可疑阈值，金额汇总已剔除",
			],
			[
				"invalid_usd_qual_hours",
				anomalies.filter((r) => r[4] === "invalid").length,
				"美元字段非有限数字",
			],
			["missing_scanned_hours", missing.length, "本地已有窗内按协议计的缺档"],
			["mainnet_day_gap_hours", (GAP_END - GAP_START) / H, "11-09 00:00–21:00，不在本库，待探测"],
			...[...notQualReasons.entries()].map(([reason, n]) => [
				`not_qualifying:${reason}`,
				n,
				"完整但未达准入的池小时",
			]),
		],
	);
	await writeCsv(
		path.join(outDir, "anomalies.csv"),
		[
			"pool_id",
			"window_start",
			"shanghai",
			"segment",
			"flag",
			"volume_usd",
			"lp_fees_usd",
			"tvl_usd",
			"swap_count",
			"fee_status",
		],
		anomalies,
	);
	await writeCsv(
		path.join(outDir, "missing-hours.csv"),
		["protocol", "window_start", "shanghai", "kind", "note"],
		missing,
	);
	await writeCsv(
		path.join(outDir, "scanned-hours.csv"),
		[
			"protocol",
			"window_start",
			"shanghai",
			"status",
			"gap_reason",
			"from_block",
			"to_block",
			"state_block",
			"price_boundary_version",
			"usd_bridge_version",
		],
		coverageRows,
	);
	await writeCsv(
		path.join(outDir, "pools.csv"),
		[
			"pool_id",
			"protocol",
			"fee_pips",
			"tick_spacing",
			"hooks",
			"qual_hours",
			"discovery_qual_hours",
			"outflow_qual_hours",
			"first_qual",
			"last_qual",
			"end_state",
		],
		poolRows,
	);

	const discPools = new Set(
		qualifying.filter((h) => segmentOf(h.windowStart) === "discovery").map((h) => h.poolId),
	);
	const outflowPools = new Set(
		qualifying.filter((h) => segmentOf(h.windowStart) === "outflow").map((h) => h.poolId),
	);
	const dayLines = [...byDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([day, r]) =>
				`| ${day} | ${r.qualHours} | ${r.qualPools.size} | ${r.discoveryQual} | ${r.boundaryQual} | ${r.outflowQual} | ${r.extreme} | ${r.suspicious} | ${r.volume.toFixed(2)} | ${r.fees.toFixed(2)} |`,
		);
	const report = `# 本地全集冻结覆盖报告

日期：冻结时刻见 manifest.json（Asia/Shanghai）。本文件对应方案 [08-entry-signal-and-strategy.md](../../../docs/03-data/08-entry-signal-and-strategy.md) 第 6 节第 1 步。只读导出生产库已有完整小时，不重采已在库且完整的小时，不修改生产采集、默认过滤、定时扫描、看板 API 或钱包开仓，也不覆盖旧的 \`outputs/signal-research/\` 48 小时包。

## 时间边界

- 时区：Asia/Shanghai。
- 本地已有全集：${shanghai(LOCAL_START)} 至最近已完成小时 ${shanghai(researchEnd - H)}。当前未完成小时 ${shanghai(researchEnd)} 已导出扫描行，但不进入正式合格样本。
- 发现集：${shanghai(LOCAL_START)} 至 ${shanghai(DISCOVERY_END - H)}（到 11 月 11 日 12:00 为止，含 11:00 这一完整小时）。
- 边界小时：${shanghai(DISCOVERY_END)}（11:00 之后、13:00 之前），既不进发现集也不进外流集。
- 外流压力集：${shanghai(OUTFLOW_START)} 至 ${shanghai(researchEnd - H)}。只作压力对照，不在这一段上调整门槛。
- 上线日缺口：${shanghai(GAP_START)} 至 ${shanghai(GAP_END - H)}（11 月 9 日 00:00–21:00）不在本库，本报告只标明缺口，不编造。公开主网上线前（10 月 19 日至 11 月 8 日）未收录。

生产刷新版本：#${revision}，asOf=${latestAsOf}，RPC 来源类型：${rpcKind}（公共 RPC 标 public_temporary）。

## 合格观察（统一 1H 准入）

门槛：完整小时，TVL 至少 1000 美元，成交量至少 100 美元，普通 LP 手续费至少 10 美元，费用状态为 usable（estimated 或 verified_zero，并经池级 normalize）。金额汇总已剔除异常/可疑/非法计价，CAST 为实数后求和。

| 日期 | 合格小时 | 合格池数 | 发现集小时 | 边界小时 | 外流小时 | 极端计价 | 可疑计价 | 清洁成交额美元 | 清洁手续费美元 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${dayLines.join("\n")}
| 合计 | ${qualifying.length} | ${pools.length}（去重） | ${qualifying.filter((h) => segmentOf(h.windowStart) === "discovery").length} | ${qualifying.filter((h) => segmentOf(h.windowStart) === "boundary").length} | ${qualifying.filter((h) => segmentOf(h.windowStart) === "outflow").length} | ${anomalies.filter((r) => r[4] === "extreme").length} | ${anomalies.filter((r) => r[4] === "suspicious").length} | | |

- 发现集池数（去重）：${discPools.size}。
- 外流集池数（去重）：${outflowPools.size}。
- 导出小时档（含候选池后来退热、以及桥接报价池）：${dataset.hours.length}。
- 代币资料：${dataset.tokens.length}。

## 异常计价

规则：任一美元字段无法解析为有限数字，记 invalid；绝对值达到 ${EXTREME}（万亿）记 extreme；否则成交额达到 ${SUSPICIOUS_VOLUME}、手续费达到 ${SUSPICIOUS_FEES} 或 TVL 达到 ${SUSPICIOUS_TVL} 记 suspicious。上表人数含这些合格观察，但金额汇总已剔除。明细见 anomalies.csv。

## 缺档

- 本地已有窗内（${shanghai(LOCAL_START)} 至 ${shanghai(researchEnd - H)}，两协议）缺扫描记录：${missing.filter((r) => r[3] === "missing_scanned_hour").length} 条。
- 上线日 00:00–21:00 共 ${(GAP_END - GAP_START) / H} 个小时不在库中，待第 2 步只读探测，本步未回补。

## 文件

- \`dataset.json\`：研究引擎可加载的冻结样本（schema 1）。
- \`snapshot.db\`：同时冻结的研究库副本，含时间窗内全部小时汇总与扫描覆盖，不替代生产库，也不被生产 4 天清理。
- \`manifest.json\`：版本与分层定义。
- 本报告及 CSV：按日、按状态、异常、缺档、候选池。

本步未跑回测，未宣布可执行信号。
`;
	await fs.writeFile(path.join(outDir, "coverage-report.md"), report, "utf8");
}
