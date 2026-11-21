import type { VenuePoolCount } from "../shared/catalog.ts";
import { type ChainSelector, chainRef, storedChain } from "../shared/chain-ref.ts";
import {
	METRIC_SOURCE_OFFICIAL_INDEX,
	METRIC_SOURCE_SELF_BUILT,
	METRIC_SOURCE_UNOFFICIAL,
} from "../shared/constants.ts";
import { solanaPoolStorageKey } from "../shared/pool-identity.ts";
import { solanaPublicKey } from "../shared/solana-identifiers.ts";
import { assertSourceCompletion, sourceObservation } from "../shared/source-contracts.ts";
import type { MetricSource, ProtocolId } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";
import { rowNumber, rowString } from "./db.ts";
import type {
	StoredEvmPool,
	StoredEvmScannedHour,
	StoredNativeWindow,
	StoredPool,
	StoredRefreshRun,
	StoredScannedHour,
	StoredToken,
	StoredWindow,
} from "./types.ts";

const TOKEN_UPSERT = `
			INSERT INTO tokens (chain_key, chain_id, address, symbol, decimals, name)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(chain_key, address) DO UPDATE SET
				symbol = excluded.symbol,
				decimals = excluded.decimals,
				name = excluded.name
		`;

function tokenArgs(token: StoredToken) {
	const ref = storedChain(token);
	if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
		throw new Error("Invalid token decimals");
	if (ref.chain === "solana") solanaPublicKey(token.address);
	return [ref.chain, ref.evmChainId, token.address, token.symbol, token.decimals, token.name];
}

export async function upsertToken(db: AppDatabase, token: StoredToken): Promise<void> {
	await db.execute({
		sql: TOKEN_UPSERT,
		args: tokenArgs(token),
	});
}

export async function upsertTokens(db: AppDatabase, tokens: StoredToken[]): Promise<void> {
	for (let i = 0; i < tokens.length; i += 400) {
		await db.batch(
			tokens.slice(i, i + 400).map((token) => ({
				sql: TOKEN_UPSERT,
				args: tokenArgs(token),
			})),
			"write",
		);
	}
}

export async function getToken(
	db: AppDatabase,
	chainId: ChainSelector,
	address: string,
): Promise<StoredToken | undefined> {
	const result = await db.execute({
		sql: "SELECT chain_key AS chain, chain_id AS chainId, address, symbol, decimals, name FROM tokens WHERE chain_key = ? AND address = ?",
		args: [chainRef(chainId).chain, address],
	});
	const row = result.rows[0];
	return row ? mapToken(row) : undefined;
}

export async function listTokens(
	db: Pick<AppDatabase, "execute">,
	chainId?: ChainSelector,
): Promise<StoredToken[]> {
	const result =
		chainId === undefined
			? await db.execute(
					"SELECT chain_key AS chain, chain_id AS chainId, address, symbol, decimals, name FROM tokens",
				)
			: await db.execute({
					sql: "SELECT chain_key AS chain, chain_id AS chainId, address, symbol, decimals, name FROM tokens WHERE chain_key = ?",
					args: [chainRef(chainId).chain],
				});
	return result.rows.map(mapToken);
}

export async function getTokens(
	db: AppDatabase,
	chainId: ChainSelector,
	addresses: string[],
): Promise<StoredToken[]> {
	if (!addresses.length) return [];
	const result = await db.execute({
		sql: `SELECT chain_key AS chain, chain_id AS chainId, address, symbol, decimals, name FROM tokens
			WHERE chain_key = ? AND address IN (SELECT value FROM json_each(?))`,
		args: [chainRef(chainId).chain, JSON.stringify(addresses)],
	});
	return result.rows.map(mapToken);
}

function mapToken(row: Record<string, unknown>): StoredToken {
	const common = {
		address: String(row.address),
		symbol: String(row.symbol),
		decimals: Number(row.decimals),
		name: rowString(row.name),
	};
	const ref = chainRef({ chain: String(row.chain), evmChainId: rowNumber(row.chainId) });
	if (ref.evmChainId === null) {
		if (ref.chain !== "solana") throw new Error("Unsupported non-EVM chain");
		return { ...common, chain: "solana", chainId: null, evmChainId: null };
	}
	return { ...common, chain: ref.chain, chainId: ref.evmChainId, evmChainId: ref.evmChainId };
}

export async function upsertPool(
	db: AppDatabase,
	pool: StoredPool,
	discoveredAt: string,
): Promise<void> {
	const ref = storedChain(pool);
	const nativeId = pool.nativePoolId ?? pool.poolId.slice(pool.poolId.lastIndexOf(":") + 1);
	if (ref.chain === "solana") {
		if (pool.tickSpacing !== null || pool.createdBlock !== null)
			throw new Error("Solana must not fabricate EVM state");
		if (pool.poolAddress !== null) solanaPublicKey(pool.poolAddress);
		solanaPublicKey(nativeId);
		solanaPublicKey(pool.token0);
		solanaPublicKey(pool.token1);
		if (pool.poolId !== solanaPoolStorageKey(pool.protocol, nativeId))
			throw new Error("Invalid Solana physical key");
	} else if (nativeId !== pool.poolId.slice(pool.poolId.lastIndexOf(":") + 1)) {
		throw new Error("Legacy EVM native ID must match existing external identity");
	}

	const result = await db.execute({
		sql: `
			INSERT INTO pools (
				pool_id, chain_id, protocol, token0, token1, fee_pips, tick_spacing,
				hooks, pool_address, created_block, created_at_unix, discovered_at, chain_key, native_pool_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(pool_id) DO UPDATE SET
				created_at_unix = COALESCE(pools.created_at_unix, excluded.created_at_unix)
			WHERE pools.chain_key=excluded.chain_key AND pools.protocol=excluded.protocol AND pools.native_pool_id=excluded.native_pool_id
		`,
		args: [
			pool.poolId,
			pool.chainId,
			pool.protocol,
			pool.token0,
			pool.token1,
			pool.feePips,
			pool.tickSpacing,
			pool.hooks,
			pool.poolAddress,
			pool.createdBlock,
			pool.createdAtUnix,
			discoveredAt,
			ref.chain,
			nativeId,
		],
	});
	if (result.rowsAffected !== 1)
		throw new Error("Physical pool key already belongs to another identity");
}

function mapPool(row: Record<string, unknown>): StoredPool {
	const common = {
		poolId: String(row.poolId),
		nativePoolId: String(row.nativePoolId),
		protocol: String(row.protocol),
		token0: String(row.token0),
		token1: String(row.token1),
		hooks: rowString(row.hooks),
		poolAddress: rowString(row.poolAddress),
		createdAtUnix: rowNumber(row.createdAtUnix),
	};
	const ref = chainRef({ chain: String(row.chain), evmChainId: rowNumber(row.chainId) });
	if (ref.evmChainId === null)
		return {
			...common,
			chain: "solana",
			chainId: null,
			evmChainId: null,
			feePips: rowNumber(row.feePips),
			tickSpacing: null,
			createdBlock: null,
		};
	return {
		...common,
		chain: ref.chain,
		chainId: ref.evmChainId,
		evmChainId: ref.evmChainId,
		feePips: Number(row.feePips),
		tickSpacing: Number(row.tickSpacing),
		createdBlock: Number(row.createdBlock),
	};
}

const POOL_SELECT = `
	SELECT pool_id AS poolId, chain_key AS chain, native_pool_id AS nativePoolId, chain_id AS chainId, protocol, token0, token1,
		fee_pips AS feePips, tick_spacing AS tickSpacing, hooks,
		pool_address AS poolAddress, created_block AS createdBlock,
		created_at_unix AS createdAtUnix
	FROM pools
`;

export function listPools(db: AppDatabase, chainId: number): Promise<StoredEvmPool[]>;
export function listPools(db: AppDatabase, chainId?: ChainSelector): Promise<StoredPool[]>;
export async function listPools(db: AppDatabase, chainId?: ChainSelector): Promise<StoredPool[]> {
	const result = await db.execute({
		sql: `${POOL_SELECT}${chainId === undefined ? "" : " WHERE chain_key = ? ORDER BY protocol, rowid"}`,
		args: chainId === undefined ? [] : [chainRef(chainId).chain],
	});
	return result.rows.map(mapPool);
}

/** Catalog entries are append-only; mutable pool ages are refreshed separately. */
export function listPoolAdditions(
	db: AppDatabase,
	chainId: number,
	afterRowId: number,
	protocol?: string | null,
): Promise<{ pools: StoredEvmPool[]; rowIds: number[]; lastRowId: number }>;
export function listPoolAdditions(
	db: AppDatabase,
	chainId: ChainSelector,
	afterRowId: number,
	protocol?: string | null,
): Promise<{ pools: StoredPool[]; rowIds: number[]; lastRowId: number }>;
export async function listPoolAdditions(
	db: AppDatabase,
	chainId: ChainSelector,
	afterRowId: number,
	protocol?: string | null,
): Promise<{ pools: StoredPool[]; rowIds: number[]; lastRowId: number }> {
	const result = await db.execute({
		sql: `${POOL_SELECT.replace("SELECT pool_id", "SELECT rowid AS catalogRowId, pool_id")}
			WHERE chain_key = ? AND rowid > ? ${protocol ? "AND protocol = ?" : ""} ORDER BY rowid`,
		args: protocol
			? [chainRef(chainId).chain, afterRowId, protocol]
			: [chainRef(chainId).chain, afterRowId],
	});
	return {
		pools: result.rows.map(mapPool),
		rowIds: result.rows.map((row) => Number(row.catalogRowId)),
		lastRowId: Number(result.rows.at(-1)?.catalogRowId ?? afterRowId),
	};
}

export async function listPoolsByIds(
	db: Pick<AppDatabase, "execute">,
	ids: string[],
): Promise<StoredPool[]> {
	if (ids.length === 0) {
		return [];
	}
	const result = await db.execute({
		sql: `${POOL_SELECT} WHERE pool_id IN (SELECT value FROM json_each(?))`,
		args: [JSON.stringify(ids)],
	});
	return result.rows.map(mapPool);
}

export async function listTokensForPools(
	db: Pick<AppDatabase, "execute">,
	ids: string[],
): Promise<StoredToken[]> {
	if (!ids.length) return [];
	const result = await db.execute({
		sql: `SELECT DISTINCT t.chain_key AS chain, t.chain_id AS chainId, t.address, t.symbol, t.decimals, t.name
   FROM tokens t JOIN pools p ON p.chain_key = t.chain_key AND (t.address = p.token0 OR t.address = p.token1)
   WHERE p.pool_id IN (SELECT value FROM json_each(?))`,
		args: [JSON.stringify(ids)],
	});
	return result.rows.map(mapToken);
}

export async function listPoolWindowsInRange(
	db: Pick<AppDatabase, "execute">,
	ids: string[],
	start: number,
	end: number,
): Promise<StoredWindow[]> {
	if (!ids.length) return [];
	const result = await db.execute({
		sql: `${WINDOW_SELECT} WHERE pool_id IN (SELECT value FROM json_each(?)) AND window_start >= ? AND window_start < ?`,
		args: [JSON.stringify(ids), start, end],
	});
	return result.rows.map(mapWindow);
}

const poolCounts = new WeakMap<
	Pick<AppDatabase, "execute">,
	{ revision: number; counts: VenuePoolCount[] }
>();

export async function countPoolsByVenue(
	db: Pick<AppDatabase, "execute">,
	cacheOwner: Pick<AppDatabase, "execute"> = db,
): Promise<VenuePoolCount[]> {
	const revision = Number(
		(await db.execute("SELECT COALESCE(MAX(rowid), 0) AS revision FROM pools")).rows[0]?.revision,
	);
	const cached = poolCounts.get(cacheOwner);
	if (cached?.revision === revision) return cached.counts;
	const result = await db.execute(
		"SELECT chain_key AS chain, chain_id AS chainId, protocol, COUNT(*) AS count FROM pools GROUP BY chain_key, protocol",
	);
	const counts: VenuePoolCount[] = [];
	for (const row of result.rows) {
		const evmChainId = rowNumber(row.chainId);
		counts.push({
			chain: String(row.chain),
			evmChainId,
			protocol: String(row.protocol),
			count: Number(row.count),
		});
	}
	poolCounts.set(cacheOwner, { revision, counts });
	return counts;
}

export async function upsertWindow(
	db: Pick<AppDatabase, "execute">,
	window: StoredWindow,
): Promise<void> {
	if (window.representation === "official_usd") {
		const observation = sourceObservation(window.sourceObservation);
		assertSourceCompletion(observation, window.complete, window.windowEnd);
		if (observation.feeAttribution !== "ordinary_lp_verified" && window.lpFeesUsd !== null) {
			throw new Error("Unverified ordinary LP fee attribution");
		}
		const pool = (
			await db.execute({
				sql: "SELECT chain_key FROM pools WHERE pool_id=?",
				args: [window.poolId],
			})
		).rows[0];
		if (pool?.chain_key !== "solana")
			throw new Error("Official USD representation requires a non-EVM pool identity");
	}

	const result = await db.execute({
		sql: `
			INSERT INTO window_aggregates (
				pool_id, window_start, window_end, complete, volume0, volume1, lp_fees0, lp_fees1,
				swap_count, volume_usd, lp_fees_usd, tvl_usd, sqrt_price_start, sqrt_price_end,
				source, as_of, gap_reason, fee_status, usd_valuation_version, representation, source_observation
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(pool_id, window_start) DO UPDATE SET
				window_end = excluded.window_end,
				complete = excluded.complete,
				volume0 = excluded.volume0,
				volume1 = excluded.volume1,
				lp_fees0 = excluded.lp_fees0,
				lp_fees1 = excluded.lp_fees1,
				swap_count = excluded.swap_count,
				volume_usd = excluded.volume_usd,
				lp_fees_usd = excluded.lp_fees_usd,
				tvl_usd = excluded.tvl_usd,
				sqrt_price_start = excluded.sqrt_price_start,
				sqrt_price_end = excluded.sqrt_price_end,
				source = excluded.source,
				as_of = excluded.as_of,
				gap_reason = excluded.gap_reason,
				fee_status = excluded.fee_status, usd_valuation_version = excluded.usd_valuation_version, representation = excluded.representation, source_observation = excluded.source_observation
			WHERE window_aggregates.representation=excluded.representation AND
			(window_aggregates.representation='native_amounts' OR
			 (json_extract(window_aggregates.source_observation,'$.source')=json_extract(excluded.source_observation,'$.source')
			  AND json_extract(window_aggregates.source_observation,'$.schemaVersion')=json_extract(excluded.source_observation,'$.schemaVersion')
			  AND julianday(COALESCE(json_extract(window_aggregates.source_observation,'$.requestStartedAt'),json_extract(window_aggregates.source_observation,'$.observedAt'))) <= julianday(COALESCE(json_extract(excluded.source_observation,'$.requestStartedAt'),json_extract(excluded.source_observation,'$.observedAt')))))
		`,
		args: [
			window.poolId,
			window.windowStart,
			window.windowEnd,
			window.complete ? 1 : 0,
			window.volume0,
			window.volume1,
			window.lpFees0,
			window.lpFees1,
			window.swapCount,
			window.volumeUsd,
			window.lpFeesUsd,
			window.tvlUsd,
			window.sqrtPriceStart,
			window.sqrtPriceEnd,
			window.source,
			window.asOf,
			window.gapReason,
			window.feeStatus ?? "legacy_unverified",
			window.usdValuationVersion ?? null,
			window.representation ?? "native_amounts",
			window.sourceObservation ? JSON.stringify(window.sourceObservation) : null,
		],
	});
	if (result.rowsAffected !== 1)
		throw new Error("Window source/schema/representation transition requires an explicit policy");
}

function mapWindow(row: Record<string, unknown>): StoredWindow {
	const common = {
		...(row.sourceObservation
			? { sourceObservation: sourceObservation(JSON.parse(String(row.sourceObservation))) }
			: {}),
		poolId: String(row.poolId),
		windowStart: Number(row.windowStart),
		windowEnd: Number(row.windowEnd),
		complete: Number(row.complete) === 1,
		volumeUsd: rowString(row.volumeUsd),
		lpFeesUsd: rowString(row.lpFeesUsd),
		feeStatus: parseFeeStatus(row.feeStatus),
		usdValuationVersion: rowNumber(row.usdValuationVersion),
		tvlUsd: rowString(row.tvlUsd),
		sqrtPriceStart: rowString(row.sqrtPriceStart),
		sqrtPriceEnd: rowString(row.sqrtPriceEnd),
		source: parseMetricSource(row.source),
		asOf: String(row.asOf),
		gapReason: rowString(row.gapReason),
	};
	if (row.representation === "official_usd")
		return {
			...common,
			representation: "official_usd",
			usdValuationVersion: null,
			sourceObservation: sourceObservation(JSON.parse(String(row.sourceObservation))),
			volume0: null,
			volume1: null,
			lpFees0: null,
			lpFees1: null,
			swapCount: null,
		};
	if (
		[row.volume0, row.volume1, row.lpFees0, row.lpFees1, row.swapCount].some(
			(value) => value === null,
		)
	) {
		throw new Error("Native window missing raw amounts");
	}
	return {
		...common,
		representation: "native_amounts",
		volume0: String(row.volume0),
		volume1: String(row.volume1),
		lpFees0: String(row.lpFees0),
		lpFees1: String(row.lpFees1),
		swapCount: Number(row.swapCount),
	};
}

function parseFeeStatus(value: unknown): import("../shared/fee-quality.ts").FeeDataStatus {
	switch (value) {
		case "verified_zero":
		case "estimated":
		case "hook_unresolved":
		case "protocol_state_missing":
			return value;
		default:
			return "legacy_unverified";
	}
}

function parseMetricSource(value: unknown): MetricSource {
	const text = String(value);
	if (
		text === METRIC_SOURCE_SELF_BUILT ||
		text === METRIC_SOURCE_OFFICIAL_INDEX ||
		text === METRIC_SOURCE_UNOFFICIAL
	) {
		return text;
	}
	return METRIC_SOURCE_SELF_BUILT;
}

const WINDOW_SELECT = `
	SELECT pool_id AS poolId, window_start AS windowStart, window_end AS windowEnd,
		complete, volume0, volume1, lp_fees0 AS lpFees0, lp_fees1 AS lpFees1,
		swap_count AS swapCount, volume_usd AS volumeUsd, lp_fees_usd AS lpFeesUsd,
		tvl_usd AS tvlUsd, sqrt_price_start AS sqrtPriceStart, sqrt_price_end AS sqrtPriceEnd,
		source, representation, source_observation AS sourceObservation, as_of AS asOf, gap_reason AS gapReason, fee_status AS feeStatus, usd_valuation_version AS usdValuationVersion
	FROM window_aggregates
`;

export function listWindowsForStarts(
	db: AppDatabase,
	starts: number[],
	scope: { chainId: number; protocol?: string | null },
): Promise<StoredNativeWindow[]>;
export function listWindowsForStarts(
	db: AppDatabase,
	starts: number[],
	scope?: { chainId: ChainSelector; protocol?: string | null },
): Promise<StoredWindow[]>;

export async function listWindowsForStarts(
	db: AppDatabase,
	starts: number[],
	scope?: { chainId: ChainSelector; protocol?: string | null },
): Promise<StoredWindow[]> {
	if (starts.length === 0) {
		return [];
	}
	const placeholders = starts.map(() => "?").join(", ");
	const result = await db.execute({
		sql: `${WINDOW_SELECT} WHERE window_start IN (${placeholders})${scope ? ` AND EXISTS (SELECT 1 FROM pools p WHERE p.pool_id = window_aggregates.pool_id AND p.chain_key = ?${scope.protocol ? " AND p.protocol = ?" : ""})` : ""}`,
		args: [
			...starts,
			...(scope
				? [chainRef(scope.chainId).chain, ...(scope.protocol ? [scope.protocol] : [])]
				: []),
		],
	});
	return result.rows.map(mapWindow).map((window) => {
		if (typeof scope?.chainId === "number" && window.representation === "official_usd")
			throw new Error("EVM raw-amount consumer cannot read official USD window");
		return window;
	});
}

export async function listWindowPoolIds(
	db: AppDatabase,
	chainId: ChainSelector,
	protocol?: string | null,
): Promise<Set<string>> {
	const result = await db.execute({
		sql: `SELECT p.pool_id AS poolId FROM (SELECT DISTINCT pool_id FROM window_aggregates) w
			CROSS JOIN pools p ON p.pool_id = w.pool_id WHERE p.chain_key = ?
			${protocol ? "AND p.protocol = ?" : ""}
			`,
		args: protocol ? [chainRef(chainId).chain, protocol] : [chainRef(chainId).chain],
	});
	return new Set(result.rows.map((row) => String(row.poolId)));
}

export async function knownPoolBlockTimes(
	db: AppDatabase,
	chainId: number,
	blocks: number[],
): Promise<Map<number, number>> {
	if (!blocks.length) return new Map();
	const result = await db.execute({
		sql: `SELECT created_block AS block, MIN(created_at_unix) AS timestamp FROM pools
			WHERE chain_id = ? AND created_at_unix IS NOT NULL
			AND created_block IN (SELECT value FROM json_each(?)) GROUP BY created_block
			HAVING MIN(created_at_unix) = MAX(created_at_unix)`,
		args: [chainId, JSON.stringify(blocks)],
	});
	return new Map(result.rows.map((row) => [Number(row.block), Number(row.timestamp)]));
}

export async function updatePoolAges(
	db: AppDatabase,
	ages: { poolId: string; timestamp: number }[],
): Promise<void> {
	for (let i = 0; i < ages.length; i += 400) {
		await db.batch(
			ages.slice(i, i + 400).map(({ poolId, timestamp }) => ({
				sql: "UPDATE pools SET created_at_unix = ? WHERE pool_id = ? AND created_at_unix IS NULL",
				args: [timestamp, poolId],
			})),
			"write",
		);
	}
}

export function listWindowsInRange(
	db: Pick<AppDatabase, "execute">,
	startUnix: number,
	endUnixExclusive: number,
	chainId: number,
): Promise<StoredNativeWindow[]>;
export function listWindowsInRange(
	db: Pick<AppDatabase, "execute">,
	startUnix: number,
	endUnixExclusive: number,
	chainId?: ChainSelector,
): Promise<StoredWindow[]>;
export async function listWindowsInRange(
	db: Pick<AppDatabase, "execute">,
	startUnix: number,
	endUnixExclusive: number,
	chainId?: ChainSelector,
): Promise<StoredWindow[]> {
	const result = await db.execute({
		sql: `${WINDOW_SELECT} WHERE window_start >= ? AND window_start < ? ${chainId === undefined ? "" : "AND EXISTS (SELECT 1 FROM pools p WHERE p.pool_id = window_aggregates.pool_id AND p.chain_key = ?)"}`,
		args:
			chainId === undefined
				? [startUnix, endUnixExclusive]
				: [startUnix, endUnixExclusive, chainRef(chainId).chain],
	});
	return result.rows.map(mapWindow).map((window) => {
		if (typeof chainId === "number" && window.representation === "official_usd")
			throw new Error("EVM raw-amount consumer cannot read official USD window");
		return window;
	});
}

export function stringifyPoolCounts(counts: VenuePoolCount[] | null | undefined): string | null {
	return counts ? JSON.stringify(counts) : null;
}

export function parsePoolCounts(value: string | null): VenuePoolCount[] | null {
	if (!value) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) {
			return null;
		}
		return parsed.map((item) => {
			const row = item as Record<string, unknown>;
			return {
				chain: String(row.chain),
				evmChainId:
					row.evmChainId === null || row.evmChainId === undefined ? null : Number(row.evmChainId),
				protocol: String(row.protocol),
				count: Number(row.count),
			};
		});
	} catch {
		return null;
	}
}

export async function insertRefreshRun(
	db: AppDatabase,
	run: Pick<
		StoredRefreshRun,
		"startedAt" | "status" | "rpcSourceKind" | "rpcSourceLabel" | "scopeChain" | "scopeProtocol"
	>,
): Promise<number> {
	const result = await db.execute({
		sql: `
			INSERT INTO refresh_runs (
				started_at, status, rpc_source_kind, rpc_source_label, scope_chain, scope_protocol
			) VALUES (?, ?, ?, ?, ?, ?)
		`,
		args: [
			run.startedAt,
			run.status,
			run.rpcSourceKind,
			run.rpcSourceLabel,
			run.scopeChain,
			run.scopeProtocol,
		],
	});
	return Number(result.lastInsertRowid);
}

export async function interruptStaleRefreshRuns(db: AppDatabase, error: string): Promise<void> {
	await db.execute({
		sql: `
			UPDATE refresh_runs
			SET status = 'error',
				error = ?,
				finished_at = COALESCE(finished_at, ?)
			WHERE status = 'running'
		`,
		args: [error, new Date().toISOString()],
	});
}

export async function finishRefreshRun(
	db: Pick<AppDatabase, "execute">,
	id: number,
	update: Partial<Omit<StoredRefreshRun, "id" | "startedAt">>,
): Promise<void> {
	await db.execute({
		sql: `
			UPDATE refresh_runs SET
				finished_at = COALESCE(?, finished_at),
				status = COALESCE(?, status),
				block_number = COALESCE(?, block_number),
				block_time = COALESCE(?, block_time),
				error = ?,
				gaps = ?,
				warnings = ?,
				pool_counts = ?,
				windows_built = ?,
				duration_ms = ?
			WHERE id = ?
		`,
		args: [
			update.finishedAt ?? null,
			update.status ?? null,
			update.blockNumber ?? null,
			update.blockTime ?? null,
			update.error ?? null,
			update.gaps ?? null,
			update.warnings ?? null,
			update.poolCounts ? stringifyPoolCounts(update.poolCounts) : (update.poolCounts ?? null),
			update.windowsBuilt ?? null,
			update.durationMs ?? null,
			id,
		],
	});
}

function mapRefreshRun(row: Record<string, unknown>): StoredRefreshRun {
	return {
		id: Number(row.id),
		startedAt: String(row.startedAt),
		finishedAt: rowString(row.finishedAt),
		status: String(row.status) as StoredRefreshRun["status"],
		rpcSourceKind: String(row.rpcSourceKind),
		rpcSourceLabel: String(row.rpcSourceLabel),
		blockNumber: rowString(row.blockNumber),
		blockTime: rowString(row.blockTime),
		error: rowString(row.error),
		gaps: rowString(row.gaps),
		warnings: rowString(row.warnings),
		poolCounts: parsePoolCounts(rowString(row.poolCounts)),
		windowsBuilt: rowNumber(row.windowsBuilt),
		durationMs: rowNumber(row.durationMs),
		scopeChain: rowString(row.scopeChain),
		scopeProtocol: rowString(row.scopeProtocol),
	};
}

const REFRESH_SELECT = `
	SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
		rpc_source_kind AS rpcSourceKind, rpc_source_label AS rpcSourceLabel,
		block_number AS blockNumber, block_time AS blockTime, error, gaps, warnings,
		pool_counts AS poolCounts, windows_built AS windowsBuilt,
		duration_ms AS durationMs, scope_chain AS scopeChain, scope_protocol AS scopeProtocol
	FROM refresh_runs
`;

export async function latestRefreshRun(
	db: Pick<AppDatabase, "execute">,
	chain?: string,
): Promise<StoredRefreshRun | undefined> {
	const result = await db.execute({
		sql: `${REFRESH_SELECT} ${chain ? "WHERE COALESCE(scope_chain, 'elysium') = ?" : ""} ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
		args: chain ? [chain] : [],
	});
	const row = result.rows[0];
	return row ? mapRefreshRun(row) : undefined;
}

export async function latestSuccessfulRefresh(
	db: Pick<AppDatabase, "execute">,
	chain?: string,
): Promise<StoredRefreshRun | undefined> {
	const published = await db.execute({
		sql: `SELECT run_id, block_number, block_time FROM chain_publications
			${chain ? "WHERE chain = ?" : ""} ORDER BY published_at DESC, run_id DESC LIMIT 1`,
		args: chain ? [chain] : [],
	});
	const publication = published.rows[0];
	if (publication) {
		const result = await db.execute({
			sql: `${REFRESH_SELECT} WHERE id = ?`,
			args: [Number(publication.run_id)],
		});
		if (result.rows[0])
			return {
				...mapRefreshRun(result.rows[0]),
				blockNumber: rowString(publication.block_number),
				blockTime: rowString(publication.block_time),
			};
	}
	// IDs are allocated at start; parallel chains can publish in the opposite order.
	const result = await db.execute({
		sql: `${REFRESH_SELECT} WHERE status IN ('ok', 'partial') AND COALESCE(windows_built, 0) > 0 ${chain ? "AND COALESCE(scope_chain, 'elysium') = ?" : ""} ORDER BY ${chain ? "id DESC" : "finished_at DESC, id DESC"} LIMIT 1`,
		args: chain ? [chain] : [],
	});
	const row = result.rows[0];
	return row ? mapRefreshRun(row) : undefined;
}

/** Each chain can publish independently, including at an unchanged block-time cutoff. */
export async function latestPublicationRevision(
	db: Pick<AppDatabase, "execute">,
	chains: readonly string[],
): Promise<string> {
	const result = await db.execute(`SELECT COALESCE(scope_chain, 'elysium') AS chain, MAX(id) AS id
		FROM refresh_runs WHERE status IN ('ok', 'partial') AND COALESCE(windows_built, 0) > 0
		GROUP BY COALESCE(scope_chain, 'elysium')`);
	const ids = new Map(result.rows.map((row) => [String(row.chain), String(row.id)]));
	const publications = await db.execute("SELECT chain, run_id, revision FROM chain_publications");
	for (const row of publications.rows) {
		ids.set(
			String(row.chain),
			Number(row.revision) === 0 ? String(row.run_id) : `${row.run_id}.${row.revision}`,
		);
	}
	if (chains.length === 1) return ids.get(chains[0]!) ?? "idle";
	return chains.map((chain) => `${chain}:${ids.get(chain) ?? "idle"}`).join("|");
}

export async function updatePoolCreatedAt(
	db: AppDatabase,
	poolId: string,
	createdAtUnix: number,
): Promise<void> {
	await db.execute({
		sql: "UPDATE pools SET created_at_unix = ? WHERE pool_id = ? AND created_at_unix IS NULL",
		args: [createdAtUnix, poolId],
	});
}

export async function upsertScannedHour(
	db: Pick<AppDatabase, "execute">,
	hour: StoredScannedHour,
): Promise<void> {
	if (hour.chainId === null) {
		const observation = sourceObservation(hour.sourceObservation);
		assertSourceCompletion(observation, hour.complete, hour.windowEnd);
		const pool = (
			await db.execute({
				sql: "SELECT chain_key,protocol FROM pools WHERE pool_id=?",
				args: [hour.coverageScope],
			})
		).rows[0];
		if (pool?.chain_key !== "solana" || pool.protocol !== hour.protocol)
			throw new Error("Pool-scoped coverage identity mismatch");
	}

	const result = await db.execute({
		sql: `
			INSERT INTO scanned_hours (
				chain_key, chain_id, protocol, window_start, window_end, complete,
				from_block, to_block, as_of, gap_reason, state_block_number, price_boundary_version,
				usd_bridge_version, usd_valuation_version, usd_quote_json, coverage_scope, source_observation
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(chain_key, protocol, window_start, coverage_scope) DO UPDATE SET
				window_end = excluded.window_end,
				complete = excluded.complete,
				from_block = excluded.from_block,
				to_block = excluded.to_block,
				as_of = excluded.as_of,
				gap_reason = excluded.gap_reason,
				state_block_number = excluded.state_block_number,
				price_boundary_version = excluded.price_boundary_version,
				usd_bridge_version = excluded.usd_bridge_version,
				usd_valuation_version = excluded.usd_valuation_version,
				usd_quote_json = excluded.usd_quote_json, source_observation = excluded.source_observation
			WHERE excluded.chain_id IS NOT NULL OR
			 (json_extract(scanned_hours.source_observation,'$.source')=json_extract(excluded.source_observation,'$.source')
			  AND json_extract(scanned_hours.source_observation,'$.schemaVersion')=json_extract(excluded.source_observation,'$.schemaVersion')
			  AND julianday(COALESCE(json_extract(scanned_hours.source_observation,'$.requestStartedAt'),json_extract(scanned_hours.source_observation,'$.observedAt'))) <= julianday(COALESCE(json_extract(excluded.source_observation,'$.requestStartedAt'),json_extract(excluded.source_observation,'$.observedAt'))))
		`,
		args: [
			storedChain(hour).chain,
			hour.chainId,
			hour.protocol,
			hour.windowStart,
			hour.windowEnd,
			hour.complete ? 1 : 0,
			hour.fromBlock,
			hour.toBlock,
			hour.asOf,
			hour.gapReason,
			hour.stateBlockNumber ?? null,
			hour.priceBoundaryVersion ?? null,
			hour.usdBridgeVersion ?? null,
			hour.usdValuationVersion ?? null,
			hour.usdQuote ? JSON.stringify(hour.usdQuote) : null,
			hour.coverageScope ?? "venue",
			hour.chainId === null ? JSON.stringify(hour.sourceObservation) : null,
		],
	});
	if (result.rowsAffected !== 1)
		throw new Error("Stale coverage or source/schema transition requires an explicit policy");
}

export function listScannedHours(
	db: Pick<AppDatabase, "execute">,
	range: {
		startUnix: number;
		endUnixExclusive: number;
		chainId: number;
		protocol?: string;
		coverageScope?: "venue";
	},
): Promise<StoredEvmScannedHour[]>;
export function listScannedHours(
	db: Pick<AppDatabase, "execute">,
	range: {
		startUnix: number;
		endUnixExclusive: number;
		chainId?: ChainSelector;
		protocol?: string;
		coverageScope?: string;
	},
): Promise<StoredScannedHour[]>;

export async function listScannedHours(
	db: Pick<AppDatabase, "execute">,
	range: {
		startUnix: number;
		endUnixExclusive: number;
		chainId?: ChainSelector;
		protocol?: string;
		coverageScope?: string;
	},
): Promise<StoredScannedHour[]> {
	const clauses = ["window_start >= ?", "window_start < ?"];
	const args: Array<number | string> = [range.startUnix, range.endUnixExclusive];
	if (range.chainId !== undefined) {
		clauses.push("chain_key = ?");
		args.push(chainRef(range.chainId).chain);
	}
	if (range.coverageScope !== undefined) {
		clauses.push("coverage_scope = ?");
		args.push(range.coverageScope);
	}
	if (range.protocol) {
		clauses.push("protocol = ?");
		args.push(range.protocol);
	}
	const result = await db.execute({
		sql: `
			SELECT chain_key AS chain, chain_id AS chainId, coverage_scope AS coverageScope, source_observation AS sourceObservation, protocol, window_start AS windowStart, window_end AS windowEnd,
				complete, from_block AS fromBlock, to_block AS toBlock, as_of AS asOf, gap_reason AS gapReason,
				state_block_number AS stateBlockNumber, price_boundary_version AS priceBoundaryVersion,
				usd_bridge_version AS usdBridgeVersion, usd_valuation_version AS usdValuationVersion, usd_quote_json AS usdQuoteJson
			FROM scanned_hours
			WHERE ${clauses.join(" AND ")}
		`,
		args,
	});
	return result.rows.map((row): StoredScannedHour => {
		const common = {
			protocol: String(row.protocol),
			windowStart: Number(row.windowStart),
			windowEnd: Number(row.windowEnd),
			complete: Number(row.complete) === 1,
			stateBlockNumber: rowString(row.stateBlockNumber),
			priceBoundaryVersion: rowNumber(row.priceBoundaryVersion),
			usdBridgeVersion: rowNumber(row.usdBridgeVersion),
			usdValuationVersion: rowNumber(row.usdValuationVersion),
			usdQuote: row.usdQuoteJson ? JSON.parse(String(row.usdQuoteJson)) : null,
			asOf: String(row.asOf),
			gapReason: rowString(row.gapReason),
		};
		const ref = chainRef({ chain: String(row.chain), evmChainId: rowNumber(row.chainId) });
		if (ref.evmChainId === null)
			return {
				...common,
				chain: "solana",
				evmChainId: null,
				chainId: null,
				stateBlockNumber: null,
				priceBoundaryVersion: null,
				usdBridgeVersion: null,
				usdValuationVersion: null,
				usdQuote: null,
				coverageScope: String(row.coverageScope),
				sourceObservation: sourceObservation(JSON.parse(String(row.sourceObservation))),
				fromBlock: null,
				toBlock: null,
			};
		return {
			...common,
			chain: ref.chain,
			evmChainId: ref.evmChainId,
			chainId: ref.evmChainId,
			coverageScope: "venue",
			fromBlock: String(row.fromBlock),
			toBlock: String(row.toBlock),
		};
	});
}

export async function deleteExpiredHourlyRows(
	db: AppDatabase,
	input: { cutoff: number; keepRefreshRunId: number | null },
): Promise<{
	windowsDeleted: number;
	scannedHoursDeleted: number;
	refreshRunsDeleted: number;
}> {
	await db.execute({
		sql: "DELETE FROM usd_repair_deferrals WHERE window_start < ?",
		args: [input.cutoff],
	});
	const windows = await db.execute({
		sql: "DELETE FROM window_aggregates WHERE window_start < ?",
		args: [input.cutoff],
	});
	const hours = await db.execute({
		sql: "DELETE FROM scanned_hours WHERE window_start < ?",
		args: [input.cutoff],
	});
	const cutoffIso = new Date(input.cutoff * 1000).toISOString();
	const runs =
		input.keepRefreshRunId == null
			? await db.execute({
					sql: "DELETE FROM refresh_runs WHERE id NOT IN (SELECT run_id FROM chain_publications) AND status != 'running' AND COALESCE(block_time, finished_at, started_at) < ?",
					args: [cutoffIso],
				})
			: await db.execute({
					sql: "DELETE FROM refresh_runs WHERE id NOT IN (SELECT run_id FROM chain_publications) AND id != ? AND id NOT IN (SELECT MAX(id) FROM refresh_runs WHERE status IN ('ok','partial') AND COALESCE(windows_built,0)>0 GROUP BY COALESCE(scope_chain,'elysium'),COALESCE(scope_protocol,'*')) AND status != 'running' AND COALESCE(block_time, finished_at, started_at) < ?",
					args: [input.keepRefreshRunId, cutoffIso],
				});
	return {
		windowsDeleted: windows.rowsAffected,
		scannedHoursDeleted: hours.rowsAffected,
		refreshRunsDeleted: runs.rowsAffected,
	};
}

export type { ProtocolId };

// A decision applies only to the exact historical input that was investigated.
const USD_REPAIR_DEFERRED = `EXISTS (
 SELECT 1 FROM usd_repair_deferrals d
 JOIN scanned_hours h ON h.chain_key=p.chain_key AND h.protocol=p.protocol AND h.coverage_scope='venue'
  AND h.window_start=w.window_start
 WHERE d.pool_id=w.pool_id AND d.window_start=w.window_start
  AND d.window_as_of=w.as_of AND d.to_block=h.to_block
  AND d.window_input=json_array(w.volume0,w.volume1,w.lp_fees0,w.lp_fees1,w.swap_count,w.volume_usd,w.lp_fees_usd,w.tvl_usd,w.fee_status,w.sqrt_price_start,w.sqrt_price_end,w.usd_valuation_version)
  AND h.complete=1 AND d.valuation_version=2
  AND NOT EXISTS (SELECT 1 FROM pools added INDEXED BY idx_pools_chain WHERE added.chain_id=p.chain_id
   AND added.rowid>d.catalog_rowid AND added.created_block<=CAST(h.to_block AS INTEGER))
)`;

export async function deferUsdRepair(
	db: Pick<AppDatabase, "execute">,
	input: {
		poolId: string;
		windowStart: number;
		toBlock: string;
		windowAsOf: string;
		window: StoredWindow;
		catalogRowId: number;
		reason: "zero_end_liquidity" | "no_historical_path" | "zero_historical_bridges";
		evidence: string;
	},
): Promise<void> {
	if (input.window.representation === "official_usd")
		throw new Error("Cannot run EVM native revaluation on official USD window");
	await db.execute({
		sql: `INSERT INTO usd_repair_deferrals
 (pool_id,window_start,to_block,window_as_of,window_input,catalog_rowid,valuation_version,reason,evidence)
 VALUES (?,?,?,?,?,?,2,?,?) ON CONFLICT(pool_id,window_start) DO UPDATE SET
 to_block=excluded.to_block,window_as_of=excluded.window_as_of,window_input=excluded.window_input,catalog_rowid=excluded.catalog_rowid,
 valuation_version=excluded.valuation_version,reason=excluded.reason,evidence=excluded.evidence`,
		args: [
			input.poolId,
			input.windowStart,
			input.toBlock,
			input.windowAsOf,
			JSON.stringify([
				input.window.volume0,
				input.window.volume1,
				input.window.lpFees0,
				input.window.lpFees1,
				input.window.swapCount,
				input.window.volumeUsd,
				input.window.lpFeesUsd,
				input.window.tvlUsd,
				input.window.feeStatus ?? "legacy_unverified",
				input.window.sqrtPriceStart,
				input.window.sqrtPriceEnd,
				input.window.usdValuationVersion ?? null,
			]),
			input.catalogRowId,
			input.reason,
			input.evidence,
		],
	});
}

export async function listDeferredUsdRepairs(
	db: Pick<AppDatabase, "execute">,
	chainId: number,
): Promise<Map<number, Set<string>>> {
	const result = await db.execute({
		sql: `SELECT w.pool_id,w.window_start FROM usd_repair_deferrals d
 CROSS JOIN window_aggregates w ON w.pool_id=d.pool_id AND w.window_start=d.window_start
 CROSS JOIN pools p ON p.pool_id=w.pool_id WHERE p.chain_id=? AND ${USD_REPAIR_DEFERRED}`,
		args: [chainId],
	});
	const hours = new Map<number, Set<string>>();
	for (const row of result.rows) {
		const start = Number(row.window_start);
		const ids = hours.get(start) ?? new Set<string>();
		ids.add(String(row.pool_id));
		hours.set(start, ids);
	}
	return hours;
}

export async function listUsdRepairHourKeys(
	db: Pick<AppDatabase, "execute">,
	chainId: number,
): Promise<Set<string>> {
	const result = await db.execute({
		sql: `SELECT DISTINCT p.protocol,w.window_start FROM window_aggregates w
 CROSS JOIN pools p ON p.pool_id=w.pool_id WHERE p.chain_id=?
 AND w.representation='native_amounts' AND COALESCE(w.usd_valuation_version,0)<2 AND NOT ${USD_REPAIR_DEFERRED}`,
		args: [chainId],
	});
	return new Set(result.rows.map((row) => `${row.protocol}:${row.window_start}`));
}

// Reject healthy hour rows before joining the much larger pool catalog.
export async function listRepairHourKeys(
	db: Pick<AppDatabase, "execute">,
	chainId: number,
): Promise<Set<string>> {
	const result = await db.execute({
		sql: `SELECT DISTINCT w.window_start, p.protocol FROM window_aggregates w NOT INDEXED
				CROSS JOIN pools p ON p.pool_id = w.pool_id
				WHERE w.representation='native_amounts' AND (w.fee_status IN ('legacy_unverified', 'hook_unresolved', 'protocol_state_missing')
                    OR w.tvl_usd IS NULL OR w.volume_usd IS NULL OR w.lp_fees_usd IS NULL)
                AND p.chain_id = ? AND ((p.protocol = 'uniswap_v4' AND w.fee_status IN ('legacy_unverified', 'hook_unresolved'))
				OR w.fee_status = 'protocol_state_missing'
				OR (w.tvl_usd IS NULL AND w.volume_usd IS NOT NULL AND NOT ${USD_REPAIR_DEFERRED})
				OR ((w.volume_usd IS NULL OR w.lp_fees_usd IS NULL) AND NOT ${USD_REPAIR_DEFERRED} AND EXISTS (
					SELECT 1 FROM scanned_hours s WHERE s.chain_key=p.chain_key AND s.protocol=p.protocol AND s.coverage_scope='venue'
					AND s.window_start=w.window_start AND COALESCE(s.usd_bridge_version,0)<1)))`,
		args: [chainId],
	});
	return new Set(result.rows.map((row) => `${row.protocol}:${row.window_start}`));
}

export async function listStaleUsdHourStarts(
	db: Pick<AppDatabase, "execute">,
	chainId: number,
): Promise<Set<number>> {
	const result = await db.execute({
		sql: `SELECT DISTINCT w.window_start FROM window_aggregates w NOT INDEXED
			CROSS JOIN pools p ON p.pool_id=w.pool_id
			WHERE p.chain_id=? AND w.representation='native_amounts' AND COALESCE(w.usd_valuation_version,0)<2
			AND w.volume_usd IS NOT NULL AND NOT ${USD_REPAIR_DEFERRED}`,
		args: [chainId],
	});
	return new Set(result.rows.map((row) => Number(row.window_start)));
}
