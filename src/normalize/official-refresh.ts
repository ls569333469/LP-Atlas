import { errorText } from "../adapters/errors.ts";
import {
	createMeteoraAdapter,
	METEORA_HISTORY_SCHEMA,
	type MeteoraHistoryBatch,
	type MeteoraRequestBudget,
	type MeteoraRequestTimings,
	meteoraCandidateWindows,
	readMeteoraCandidates,
	readMeteoraHistory,
} from "../adapters/venues/solana/meteora-dlmm.ts";
import type { MeteoraPoolMetadata } from "../shared/meteora.ts";
import { solanaPoolStorageKey } from "../shared/pool-identity.ts";
import type { RpcSourceInfo } from "../shared/types.ts";
import type { AppDatabase } from "../store/db.ts";
import { finishRefreshRun, insertRefreshRun } from "../store/repositories.ts";
import type { StoredOfficialWindow, StoredSolanaScannedHour } from "../store/types.ts";
import { commitHourCheckpoint } from "./refresh-pipeline.ts";

export const METEORA_SOURCE: RpcSourceInfo = {
	kind: "official_index",
	label: "Meteora DLMM Data API",
};
export type MeteoraRefreshConfig = {
	fetchImpl?: typeof fetch;
	budget?: MeteoraRequestBudget;
	now?: () => Date;
	historyPoolBudget?: number;
	roundBudgetMs?: number;
};

/** Official cumulative ingestion uses the existing hourly checkpoint and chain publisher. */
export async function runMeteoraRefresh(input: {
	db: AppDatabase;
	config: MeteoraRefreshConfig;
	checkStorage?: () => Promise<string | null>;
	onTimings?: (
		summary: Record<string, number | string | Record<string, MeteoraRequestTimings>>,
	) => void;
}) {
	const started = Date.now();
	createMeteoraAdapter(true).assertCanRefresh();
	const asOf = (input.config.now?.() ?? new Date()).toISOString();
	const H = Math.floor(Date.parse(asOf) / 3_600_000) * 3600;
	const coldLimit = input.config.historyPoolBudget ?? 128;
	const deadline = started + (input.config.roundBudgetMs ?? 240_000);
	if (
		!Number.isSafeInteger(coldLimit) ||
		coldLimit < 0 ||
		!Number.isFinite(deadline) ||
		deadline <= started
	)
		throw new Error("Invalid Meteora round budget");
	const runId = await insertRefreshRun(input.db, {
		startedAt: asOf,
		status: "running",
		rpcSourceKind: METEORA_SOURCE.kind,
		rpcSourceLabel: METEORA_SOURCE.label,
		scopeChain: "solana",
		scopeProtocol: "meteora_dlmm",
	});
	const options = { fetchImpl: input.config.fetchImpl, budget: input.config.budget };
	const emptyRequestTimings = (): MeteoraRequestTimings => ({
		requests: 0,
		retries: 0,
		rateLimited: 0,
		timeouts: 0,
		lateResponses: 0,
		queueMs: 0,
		httpMs: 0,
		maxHttpMs: 0,
		parseMs: 0,
		bytes: 0,
	});
	const discoveryRequests = emptyRequestTimings();
	const warmRequests = emptyRequestTimings();
	const historyRequests = emptyRequestTimings();
	const gaps: string[] = [];
	const warnings: string[] = [];
	const recordMissingHours = (pool: MeteoraPoolMetadata, batch: MeteoraHistoryBatch) => {
		const missing = batch.missingHours.filter(
			(t) => pool.createdAtUnix === null || t + 3600 > pool.createdAtUnix,
		);
		const first = missing[0];
		const last = missing.at(-1);
		if (first !== undefined && last !== undefined)
			gaps.push(
				`${pool.address}: 官方小时缺档 ${missing.length} 条，范围 ${new Date(first * 1000).toISOString()} 至 ${new Date(last * 1000).toISOString()}`,
			);
	};
	let windowsBuilt = 0;
	let published = false;
	let pools: MeteoraPoolMetadata[] = [];
	const timings: Record<string, number> = {};
	let historyAttempted = 0;
	let checkpointCount = 0;
	let checkpointMs = 0;
	let deferredHistory = 0;
	const reportTimings = (status: string) =>
		input.onTimings?.({
			runId,
			status,
			candidates: pools.length,
			historyAttempted,
			windowsBuilt,
			gaps: gaps.length,
			deferredHistory,
			checkpointCount,
			checkpointMs,
			requests: { discovery: discoveryRequests, warm: warmRequests, history: historyRequests },
			durationMs: Date.now() - started,
			...timings,
		});
	try {
		const storageError = await input.checkStorage?.();
		if (storageError) throw new Error(storageError);
		const discoveryStarted = Date.now();
		pools = await readMeteoraCandidates({
			...options,
			requestTimings: discoveryRequests,
			now: input.config.now,
			onInvalidPool: (message) => gaps.push(message),
		});
		timings.discoveryMs = Date.now() - discoveryStarted;
		const warmStarted = Date.now();
		const warm: StoredOfficialWindow[] = [];
		// Keep eight workers supplied without waiting for the slowest request in each batch.
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(8, pools.length) }, async () => {
				while (cursor < pools.length && Date.now() < deadline) {
					const pool = pools[cursor++];
					if (!pool) break;
					try {
						const batch = await readMeteoraHistory(pool.address, H - 7200, H + 3600, {
							...options,
							requestTimings: warmRequests,
						});
						recordMissingHours(pool, batch);
						warm.push(...meteoraCandidateWindows(batch));
					} catch (error) {
						gaps.push(`${pool.address}: ${errorText(error)}`);
					}
				}
			}),
		);
		if (cursor < pools.length) gaps.push("当前小时请求达到本轮时间预算，未处理部分保留旧结果");
		if (pools.length > 0 && warm.length === 0)
			throw new Error(gaps.join("；") || "官方小时数据未返回");
		for (const pool of pools) {
			const key = solanaPoolStorageKey("meteora_dlmm", pool.address);
			if (!warm.some((w) => w.poolId === key && w.windowStart === H))
				gaps.push(`${pool.address}: 当前小时缺失，未以滚动1H代替`);
		}
		const commit = async (windows: StoredOfficialWindow[], directory = false) => {
			const hours: StoredSolanaScannedHour[] = windows.map((w) => ({
				chain: "solana",
				chainId: null,
				evmChainId: null,
				protocol: "meteora_dlmm",
				coverageScope: w.poolId,
				sourceObservation: w.sourceObservation,
				windowStart: w.windowStart,
				windowEnd: w.windowEnd,
				complete: false,
				fromBlock: null,
				toBlock: null,
				asOf: w.asOf,
				gapReason: null,
			}));
			const starts = [...new Set(windows.map((w) => w.windowStart))].sort((a, b) => b - a);
			if (directory && !starts.includes(H)) starts.unshift(H);
			for (const start of starts) {
				const checkpointStarted = Date.now();
				await commitHourCheckpoint(input.db, windows, hours, start, {
					chain: "solana",
					runId,
					savedHours: [],
					gaps,
					warnings,
					officialAsOf: asOf,
					officialObservation: windows[0]?.sourceObservation ?? {
						source: "https://dlmm.datapi.meteora.ag",
						schemaVersion: METEORA_HISTORY_SCHEMA,
						observedAt: new Date().toISOString(),
						dataCutoff: null,
						finality: "unverified",
						feeAttribution: "unverified",
					},
					...(directory && start === H
						? {
								officialDirectory: { pools, asOf },
								onPriceSamplesSaved: (durationMs: number) => {
									timings.priceSamplesMs = Math.round(durationMs * 10) / 10;
								},
							}
						: {}),
				});
				checkpointCount++;
				checkpointMs += Date.now() - checkpointStarted;
				published = true;
				if (directory && start === H) timings.currentPublishedMs = Date.now() - started;
			}
		};
		windowsBuilt += warm.length;
		timings.warmFetchMs = Date.now() - warmStarted;
		await commit(warm, true);
		timings.warmMs = Date.now() - warmStarted;
		const historicalStarted = Date.now();
		const existing = await input.db.execute({
			// Start from the Solana directory instead of scanning the shared time index.
			sql: `SELECT w.pool_id, w.window_start
				FROM pools p CROSS JOIN window_aggregates w ON w.pool_id = p.pool_id
				WHERE p.chain_key = 'solana' AND w.window_start >= ? AND w.window_start < ?
				AND CASE WHEN json_valid(w.source_observation)
					THEN json_extract(w.source_observation, '$.coverage') = 'reported_hour' ELSE 0 END`,
			args: [H - 96 * 3600, H],
		});
		const covered = new Set(existing.rows.map((row) => `${row.pool_id}:${row.window_start}`));
		const pendingHistory = pools.filter((pool) => {
			const key = solanaPoolStorageKey("meteora_dlmm", pool.address);
			const start = Math.max(
				H - 96 * 3600,
				pool.createdAtUnix === null ? 0 : Math.floor(pool.createdAtUnix / 3600) * 3600,
			);
			for (let t = start; t < H; t += 3600) if (!covered.has(`${key}:${t}`)) return true;
			return false;
		});
		const needsHistory = pendingHistory.slice(0, coldLimit);
		timings.coverageMs = Date.now() - historicalStarted;
		for (let i = 0; i < needsHistory.length; i += 8) {
			if (Date.now() >= deadline) break;
			const results = await Promise.allSettled(
				needsHistory.slice(i, i + 8).map(async (pool) => {
					historyAttempted++;
					const batch = await readMeteoraHistory(pool.address, H - 96 * 3600, H, {
						...options,
						requestTimings: historyRequests,
					});
					recordMissingHours(pool, batch);
					return meteoraCandidateWindows(batch).filter(
						(w) => pool.createdAtUnix === null || w.windowEnd > pool.createdAtUnix,
					);
				}),
			);
			const successful: StoredOfficialWindow[] = [];
			for (const [offset, result] of results.entries()) {
				if (result.status === "rejected") {
					gaps.push(
						`${needsHistory[i + offset]?.address}: 历史补齐失败 ${errorText(result.reason)}`,
					);
					continue;
				}
				windowsBuilt += result.value.length;
				successful.push(...result.value);
			}
			await commit(successful);
		}
		deferredHistory = pendingHistory.length - historyAttempted;
		if (deferredHistory > 0)
			warnings.push(
				`pending_backfill: ${deferredHistory} 池历史待补，本轮预算未处理，不代表源缺档`,
			);
		timings.historyMs = Date.now() - historicalStarted;
		const cutoff = H - 96 * 3600;
		const pruneStarted = Date.now();
		const prune = await input.db.transaction("write");
		try {
			await prune.execute({
				sql: "DELETE FROM window_aggregates WHERE window_start<? AND pool_id IN (SELECT pool_id FROM pools WHERE chain_key='solana')",
				args: [cutoff],
			});
			await prune.execute({
				sql: "DELETE FROM scanned_hours WHERE chain_key='solana' AND window_start<?",
				args: [cutoff],
			});
			await prune.commit();
		} finally {
			prune.close();
		}
		timings.pruneMs = Date.now() - pruneStarted;
		const counts = [
			{ chain: "solana", evmChainId: null, protocol: "meteora_dlmm", count: pools.length },
		];
		await finishRefreshRun(input.db, runId, {
			status: gaps.length ? "partial" : "ok",
			finishedAt: new Date().toISOString(),
			blockTime: asOf,
			windowsBuilt,
			durationMs: Date.now() - started,
			poolCounts: counts,
			gaps: JSON.stringify(gaps),
			warnings: JSON.stringify(warnings),
		});
		reportTimings(gaps.length ? "partial" : "ok");
		return {
			ok: true as const,
			asOf,
			blockNumber: null,
			windowsBuilt,
			discoveredPoolCount: counts,
			gaps,
			warnings,
			durationMs: Date.now() - started,
			timings,
		};
	} catch (error) {
		await finishRefreshRun(input.db, runId, {
			status: published ? "partial" : "error",
			finishedAt: new Date().toISOString(),
			error: errorText(error),
			blockTime: published ? asOf : null,
			windowsBuilt,
			durationMs: Date.now() - started,
			gaps: JSON.stringify(gaps),
			warnings: JSON.stringify(warnings),
		});
		reportTimings(published ? "partial" : "error");
		throw error;
	}
}
