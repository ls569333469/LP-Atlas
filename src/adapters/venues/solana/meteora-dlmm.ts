import Decimal from "decimal.js";
import { solanaPoolStorageKey } from "../../../shared/pool-identity.ts";
import { solanaPublicKey } from "../../../shared/solana-identifiers.ts";
import type { SourceObservation } from "../../../shared/source-contracts.ts";
import type { StoredOfficialWindow } from "../../../store/types.ts";
import { queryOfficialJson } from "../../official-index.ts";
import { createPlaceholderAdapter } from "../../venue-adapter.ts";

const ORIGIN = "https://dlmm.datapi.meteora.ag";
const HOUR = 3600;
export const METEORA_HISTORY_SCHEMA = "datapi-volume-history-candidate-v1";
type ReadOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };
export type MeteoraPoolMetadata = {
	address: string;
	tokenX: { address: string; symbol: string; decimals: number };
	tokenY: { address: string; symbol: string; decimals: number };
	binStep: number;
	collectFeeMode: number;
	currentTvlUsd: string;
	accountVerification: "unverified";
};
export type MeteoraHistoryHour = {
	startUnix: number;
	volumeUsd: string;
	reportedFeesUsd: string;
	reportedProtocolFeesUsd: string;
};
export type MeteoraHistoryBatch = {
	poolId: string;
	startUnix: number;
	endUnix: number;
	observation: SourceObservation;
	hours: MeteoraHistoryHour[];
	missingHours: number[];
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid Meteora object");
	return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error("Invalid Meteora integer");
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Invalid Meteora text");
	return value;
}
function amount(value: unknown): string {
	// Datapi publishes JSON doubles, not raw token integers. Preserve only its reported precision.
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new Error("Invalid Meteora amount");
	return new Decimal(value).toString();
}
function token(value: unknown): MeteoraPoolMetadata["tokenX"] {
	const v = object(value);
	return {
		address: solanaPublicKey(text(v.address)),
		symbol: text(v.symbol),
		decimals: integer(v.decimals, 0, 255),
	};
}
function poolMetadata(value: unknown): MeteoraPoolMetadata {
	const v = object(value);
	const config = object(v.pool_config);
	return {
		address: solanaPublicKey(text(v.address)),
		tokenX: token(v.token_x),
		tokenY: token(v.token_y),
		binStep: integer(config.bin_step, 1),
		collectFeeMode: integer(config.collect_fee_mode, 0),
		currentTvlUsd: amount(v.tvl),
		accountVerification: "unverified",
	};
}

export async function readMeteoraPool(poolId: string, options: ReadOptions = {}) {
	const id = solanaPublicKey(poolId);
	const pool = poolMetadata(await queryOfficialJson(new URL(`/pools/${id}`, ORIGIN), options));
	if (pool.address !== id) throw new Error("Meteora pool identity mismatch");
	return pool;
}

/** One explicit page, never an implicit full-directory crawl. */
export async function readMeteoraPoolPage(
	page: number,
	pageSize: number,
	options: ReadOptions = {},
) {
	integer(page, 1);
	integer(pageSize, 1, 1000);
	const url = new URL("/pools", ORIGIN);
	url.searchParams.set("page", String(page));
	url.searchParams.set("page_size", String(pageSize));
	const v = object(await queryOfficialJson(url, options));
	if (!Array.isArray(v.data) || v.data.length > pageSize || v.current_page !== page)
		throw new Error("Invalid Meteora page");
	const total = integer(v.total, 0);
	const pages = integer(v.pages, 0);
	if (v.page_size !== pageSize) throw new Error("Meteora page size mismatch");
	if (pages !== Math.ceil(total / pageSize) || (total > 0 && page > pages) || v.data.length > total)
		throw new Error("Meteora pagination totals mismatch");
	const pools = v.data.map(poolMetadata);
	if (new Set(pools.map((p) => p.address)).size !== pools.length)
		throw new Error("Duplicate Meteora pool in page");
	return { pools, total, page, nextPage: page < pages ? page + 1 : null };
}

function hourRange(startUnix: number, endUnix: number): void {
	integer(startUnix, 0);
	integer(endUnix, startUnix + HOUR);
	if (startUnix % HOUR || endUnix % HOUR || endUnix - startUnix > 96 * HOUR)
		throw new Error("Meteora history requires aligned hours within four days");
}

export async function readMeteoraHistory(
	poolId: string,
	startUnix: number,
	endUnix: number,
	options: ReadOptions = {},
): Promise<MeteoraHistoryBatch> {
	const id = solanaPublicKey(poolId);
	hourRange(startUnix, endUnix);
	const url = new URL(`/pools/${id}/volume/history`, ORIGIN);
	url.searchParams.set("timeframe", "1h");
	url.searchParams.set("start_time", String(startUnix));
	// End is inclusive upstream. Request the exact boundary and discard its terminal bucket.
	url.searchParams.set("end_time", String(endUnix));
	const requestStartedAt = new Date().toISOString();
	const value = await queryOfficialJson(url, options);
	const batch = parseMeteoraHistory(value, id, startUnix, endUnix, new Date().toISOString());
	batch.observation.requestStartedAt = requestStartedAt;
	return batch;
}

export function parseMeteoraHistory(
	value: unknown,
	poolId: string,
	startUnix: number,
	endUnix: number,
	observedAt: string,
): MeteoraHistoryBatch {
	solanaPublicKey(poolId);
	hourRange(startUnix, endUnix);
	if (!Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid observation time");
	const v = object(value);
	if (v.timeframe !== "1h" || v.start_time !== startUnix || v.end_time !== endUnix)
		throw new Error("Meteora history response range mismatch");
	if (!Array.isArray(v.data) || v.data.length > 97) throw new Error("Invalid Meteora history rows");
	const byHour = new Map<number, MeteoraHistoryHour>();
	for (const input of v.data) {
		const row = object(input);
		const timestamp = integer(row.timestamp, startUnix, endUnix);
		if (timestamp % HOUR || Date.parse(text(row.timestamp_str)) !== timestamp * 1000)
			throw new Error("Meteora history bucket mismatch");
		const hour = {
			startUnix: timestamp,
			volumeUsd: amount(row.volume),
			reportedFeesUsd: amount(row.fees),
			reportedProtocolFeesUsd: amount(row.protocol_fees),
		};
		const previous = byHour.get(timestamp);
		if (previous && JSON.stringify(previous) !== JSON.stringify(hour))
			throw new Error("Conflicting duplicate Meteora hour");
		byHour.set(timestamp, hour);
	}
	byHour.delete(endUnix);
	const missingHours: number[] = [];
	for (let t = startUnix; t < endUnix; t += HOUR) if (!byHour.has(t)) missingHours.push(t);
	return {
		poolId,
		startUnix,
		endUnix,
		observation: {
			source: ORIGIN,
			schemaVersion: METEORA_HISTORY_SCHEMA,
			observedAt,
			dataCutoff: null,
			finality: "unverified",
			feeAttribution: "unverified",
		},
		hours: [...byHour.values()].sort((a, b) => a.startUnix - b.startUnix),
		missingHours,
	};
}

/** Offline candidate mapping only: this does not approve official USD or enable ingestion. */
export function meteoraCandidateWindows(batch: MeteoraHistoryBatch): StoredOfficialWindow[] {
	return batch.hours.map((hour) => ({
		poolId: solanaPoolStorageKey("meteora_dlmm", batch.poolId),
		representation: "official_usd",
		sourceObservation: batch.observation,
		windowStart: hour.startUnix,
		windowEnd: hour.startUnix + HOUR,
		complete: false,
		volume0: null,
		volume1: null,
		lpFees0: null,
		lpFees1: null,
		swapCount: null,
		volumeUsd: hour.volumeUsd,
		lpFeesUsd: null,
		tvlUsd: null,
		sqrtPriceStart: null,
		sqrtPriceEnd: null,
		feeStatus: "protocol_state_missing",
		source: "official_index",
		asOf: batch.observation.observedAt,
		gapReason: "Meteora candidate: fee attribution, coverage and historical state unverified",
	}));
}

export const venueAdapter = {
	...createPlaceholderAdapter("solana", "meteora_dlmm"),
	readPool: readMeteoraPool,
	readPoolPage: readMeteoraPoolPage,
	readHistory: readMeteoraHistory,
};
