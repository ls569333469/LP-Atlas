import Decimal from "decimal.js";
import type { MeteoraPoolMetadata } from "../../../shared/meteora.ts";
import { solanaPoolStorageKey } from "../../../shared/pool-identity.ts";
import { solanaPublicKey } from "../../../shared/solana-identifiers.ts";
import type { SourceObservation } from "../../../shared/source-contracts.ts";
import type { StoredOfficialWindow } from "../../../store/types.ts";
import { OfficialIndexError, queryOfficialJson } from "../../official-index.ts";
import { createPlaceholderAdapter, createReadyAdapter } from "../../venue-adapter.ts";

const ORIGIN = "https://dlmm.datapi.meteora.ag";
const HOUR = 3600;
export const METEORA_HISTORY_SCHEMA = "datapi-volume-history-candidate-v1";
type ReadOptions = {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	filterBy?: string;
	sortBy?: string;
	budget?: MeteoraRequestBudget;
	onInvalidPool?: (message: string) => void;
	now?: () => Date;
};

export type { MeteoraPoolMetadata } from "../../../shared/meteora.ts";

/** One queue for every DLMM endpoint, including retries and historical backfill. */
export class MeteoraRequestBudget {
	private active = 0;
	private nextStart = 0;
	private waiting: (() => void)[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly concurrency = 8,
		private readonly rps = 16,
	) {
		if (
			!Number.isInteger(concurrency) ||
			concurrency < 1 ||
			!Number.isFinite(rps) ||
			rps <= 0 ||
			rps > 30
		)
			throw new Error("Invalid Meteora shared request budget");
	}

	async run<T>(request: () => Promise<T>): Promise<T> {
		await new Promise<void>((resolve) => {
			this.waiting.push(resolve);
			this.pump();
		});
		try {
			return await request();
		} finally {
			this.active--;
			this.pump();
		}
	}

	defer(ms: number): void {
		this.nextStart = Math.max(this.nextStart, Date.now() + ms);
	}

	private pump(): void {
		if (this.timer || this.active >= this.concurrency || this.waiting.length === 0) return;
		const delay = this.nextStart - Date.now();
		if (delay > 0) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.pump();
			}, delay);
			return;
		}
		this.active++;
		this.nextStart = Date.now() + 1000 / this.rps;
		this.waiting.shift()?.();
		this.pump();
	}
}

const sharedBudget = new MeteoraRequestBudget();

async function queryMeteora(url: URL, options: ReadOptions): Promise<unknown> {
	const budget = options.budget ?? sharedBudget;
	for (let attempt = 0; ; attempt++) {
		try {
			return await budget.run(() => queryOfficialJson(url, options));
		} catch (error) {
			if (
				!(error instanceof OfficialIndexError) ||
				(error.code !== "index_rate_limited" && error.code !== "index_down") ||
				attempt >= 1
			)
				throw error;
			const delay = Math.max(500, error.retryAfterMs ?? 0);
			// A long server cooldown ends this request instead of holding the chain indefinitely.
			if (delay > (options.timeoutMs ?? 18_000)) throw error;
			budget.defer(delay);
		}
	}
}
export type MeteoraHistoryHour = {
	startUnix: number;
	volumeUsd: string;
	reportedFeesUsd: string | null;
	reportedProtocolFeesUsd: string | null;
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
function optionalAmount(value: unknown): string | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? amount(value) : null;
}
function optionalText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function optionalInteger(value: unknown, min = 0): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}
function optionalKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		return solanaPublicKey(value);
	} catch {
		return null;
	}
}
function statistics(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, v]) => {
			const parsed = optionalAmount(v);
			return parsed === null ? [] : [[key, parsed]];
		}),
	);
}
function token(value: unknown): MeteoraPoolMetadata["tokenX"] {
	const v = object(value);
	return {
		address: solanaPublicKey(text(v.address)),
		symbol: text(v.symbol),
		decimals: integer(v.decimals, 0, 255),
		name: optionalText(v.name),
		priceUsd: optionalAmount(v.price),
		marketCapUsd: optionalAmount(v.market_cap),
		totalSupply: optionalAmount(v.total_supply),
		holders: optionalInteger(v.holders),
		isVerified: typeof v.is_verified === "boolean" ? v.is_verified : null,
		freezeAuthorityDisabled:
			typeof v.freeze_authority_disabled === "boolean" ? v.freeze_authority_disabled : null,
	};
}
function poolMetadata(value: unknown): MeteoraPoolMetadata {
	const v = object(value);
	const config = v.pool_config ? object(v.pool_config) : {};
	const createdAtMs = optionalInteger(v.created_at);
	return {
		address: solanaPublicKey(text(v.address)),
		name: optionalText(v.name),
		tokenX: token(v.token_x),
		tokenY: token(v.token_y),
		reserveX: optionalKey(v.reserve_x),
		reserveY: optionalKey(v.reserve_y),
		tokenXAmount: optionalAmount(v.token_x_amount),
		tokenYAmount: optionalAmount(v.token_y_amount),
		binStep: optionalInteger(config.bin_step, 1),
		collectFeeMode: optionalInteger(config.collect_fee_mode),
		pairType: optionalInteger(config.pair_type),
		baseFeePercent: optionalAmount(config.base_fee_pct),
		maxFeePercent: optionalAmount(config.max_fee_pct),
		protocolFeePercent: optionalAmount(config.protocol_fee_pct),
		dynamicFeePercent: optionalAmount(v.dynamic_fee_pct),
		currentTvlUsd: amount(v.tvl),
		currentPrice: optionalAmount(v.current_price),
		createdAtUnix: createdAtMs === null ? null : Math.floor(createdAtMs / 1000),
		hasFarm: typeof v.has_farm === "boolean" ? v.has_farm : null,
		farmApr: optionalAmount(v.farm_apr),
		farmApy: optionalAmount(v.farm_apy),
		rewardMintX: optionalKey(v.reward_mint_x),
		rewardMintY: optionalKey(v.reward_mint_y),
		isBlacklisted: typeof v.is_blacklisted === "boolean" ? v.is_blacklisted : null,
		launchpad: optionalText(v.launchpad),
		tags: Array.isArray(v.tags)
			? v.tags.filter((tag): tag is string => typeof tag === "string")
			: [],
		reportedStatistics: {
			volume: statistics(v.volume),
			fees: statistics(v.fees),
			protocolFees: statistics(v.protocol_fees),
			feeTvlRatio: statistics(v.fee_tvl_ratio),
			cumulative: statistics(v.cumulative_metrics),
			apr: optionalAmount(v.apr),
			apy: optionalAmount(v.apy),
		},
		accountVerification: "unverified",
	};
}

export type MeteoraCurrentTokenAccount = {
	mint: string;
	reserve: string;
	tokenProgram: string;
	decimals: number;
	amount: string;
	state: string;
	compatibility: "standard_spl_current_only" | "token2022_unverified";
	extensions: { extension: string; state: Record<string, unknown> | null }[];
};

/** Current RPC identity evidence only; this does not decode historical DLMM liquidity. */
export function parseMeteoraCurrentAccounts(
	value: unknown,
	requestedAddresses: readonly string[],
	pool: MeteoraPoolMetadata,
): {
	slot: number;
	poolId: string;
	tokenX: MeteoraCurrentTokenAccount;
	tokenY: MeteoraCurrentTokenAccount;
} {
	if (!pool.reserveX || !pool.reserveY)
		throw new Error("Meteora reserve identity unavailable for account verification");
	if (requestedAddresses.length === 0 || requestedAddresses.length > 100)
		throw new Error("Invalid Solana account batch size");
	const addresses = requestedAddresses.map(solanaPublicKey);
	if (new Set(addresses).size !== addresses.length)
		throw new Error("Duplicate Solana account request");
	const envelope = object(value);
	if (envelope.error !== undefined) throw new Error("Solana account RPC failed");
	const result = object(envelope.result);
	const slot = integer(object(result.context).slot, 0);
	if (!Array.isArray(result.value) || result.value.length !== addresses.length)
		throw new Error("Solana account response count mismatch");
	const values = result.value;
	const accounts = new Map(addresses.map((address, i) => [address, values[i]]));
	const poolAccount = object(accounts.get(pool.address));
	if (
		poolAccount.owner !== "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" ||
		poolAccount.executable !== false
	)
		throw new Error("Meteora current pool owner mismatch");
	return {
		slot,
		poolId: pool.address,
		tokenX: currentTokenAccount(accounts, pool.tokenX, pool.reserveX, pool.address),
		tokenY: currentTokenAccount(accounts, pool.tokenY, pool.reserveY, pool.address),
	};
}

function currentTokenAccount(
	accounts: ReadonlyMap<string, unknown>,
	mint: MeteoraPoolMetadata["tokenX"],
	reserveAddress: string,
	poolAddress: string,
): MeteoraCurrentTokenAccount {
	const mintAccount = object(accounts.get(mint.address));
	const reserveAccount = object(accounts.get(reserveAddress));
	const tokenProgram = text(mintAccount.owner);
	const token2022 = tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
	if (
		(!token2022 && tokenProgram !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") ||
		reserveAccount.owner !== tokenProgram ||
		mintAccount.executable !== false ||
		reserveAccount.executable !== false
	)
		throw new Error("Meteora current token program mismatch");
	const mintData = object(object(mintAccount.data).parsed);
	const reserveData = object(object(reserveAccount.data).parsed);
	if (mintData.type !== "mint" || reserveData.type !== "account")
		throw new Error("Meteora current account type mismatch");
	const mintInfo = object(mintData.info);
	const reserveInfo = object(reserveData.info);
	const tokenAmount = object(reserveInfo.tokenAmount);
	if (
		mintInfo.isInitialized !== true ||
		mintInfo.decimals !== mint.decimals ||
		tokenAmount.decimals !== mint.decimals ||
		reserveInfo.mint !== mint.address ||
		reserveInfo.owner !== poolAddress
	)
		throw new Error("Meteora current mint or reserve identity mismatch");
	const amount = text(tokenAmount.amount);
	if (
		!/^(0|[1-9]\d*)$/.test(amount) ||
		amount.length > 20 ||
		BigInt(amount) > 18446744073709551615n
	)
		throw new Error("Invalid Solana raw token amount");
	const extensions = mintInfo.extensions ?? [];
	if (!Array.isArray(extensions)) throw new Error("Invalid Solana mint extensions");
	return {
		mint: mint.address,
		reserve: reserveAddress,
		tokenProgram,
		decimals: mint.decimals,
		amount,
		state: text(reserveInfo.state),
		compatibility: token2022 ? "token2022_unverified" : "standard_spl_current_only",
		extensions: extensions.map((entry) => {
			const extension = object(entry);
			return {
				extension: text(extension.extension),
				state: extension.state === undefined ? null : object(extension.state),
			};
		}),
	};
}

export async function readMeteoraPool(poolId: string, options: ReadOptions = {}) {
	const id = solanaPublicKey(poolId);
	const pool = poolMetadata(await queryMeteora(new URL(`/pools/${id}`, ORIGIN), options));
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
	if (options.filterBy) url.searchParams.set("filter_by", options.filterBy);
	if (options.sortBy) url.searchParams.set("sort_by", options.sortBy);
	const v = object(await queryMeteora(url, options));
	const priceObservedAt = (options.now?.() ?? new Date()).getTime();
	if (!Array.isArray(v.data) || v.data.length > pageSize || v.current_page !== page)
		throw new Error("Invalid Meteora page");
	const total = integer(v.total, 0);
	const pages = integer(v.pages, 0);
	if (v.page_size !== pageSize) throw new Error("Meteora page size mismatch");
	if (pages !== Math.ceil(total / pageSize) || (total > 0 && page > pages) || v.data.length > total)
		throw new Error("Meteora pagination totals mismatch");
	const pools: MeteoraPoolMetadata[] = [];
	for (const [index, entry] of v.data.entries()) {
		try {
			pools.push({ ...poolMetadata(entry), priceObservedAt });
		} catch (error) {
			if (!options.onInvalidPool) throw error;
			options.onInvalidPool(`Meteora page ${page} item ${index + 1}: invalid required pool fields`);
		}
	}
	if (new Set(pools.map((p) => p.address)).size !== pools.length)
		throw new Error("Duplicate Meteora pool in page");
	return {
		pools,
		total,
		page,
		entryCount: v.data.length,
		nextPage: page < pages ? page + 1 : null,
	};
}

/** A failed/moving page rejects discovery, so callers retain their last published directory. */
export async function readMeteoraCandidates(
	options: ReadOptions = {},
): Promise<MeteoraPoolMetadata[]> {
	const pools: MeteoraPoolMetadata[] = [];
	const seen = new Set<string>();
	let expectedTotal: number | undefined;
	let received = 0;
	let page: number | null = 1;
	while (page !== null) {
		const result = await readMeteoraPoolPage(page, 1000, {
			...options,
			filterBy: "tvl>=1000 && volume_1h>=100",
			sortBy: "volume_1h:desc",
			onInvalidPool: options.onInvalidPool ?? (() => {}),
		});
		if (expectedTotal !== undefined && result.total !== expectedTotal)
			throw new Error("Meteora discovery changed during pagination");
		expectedTotal = result.total;
		received += result.entryCount;
		for (const pool of result.pools) {
			if (seen.has(pool.address)) throw new Error("Duplicate Meteora pool across pages");
			seen.add(pool.address);
			pools.push(pool);
		}
		page = result.nextPage;
	}
	if (received !== expectedTotal) throw new Error("Incomplete Meteora discovery");
	return pools;
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
	const value = await queryMeteora(url, options);
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
			reportedFeesUsd: row.fees == null ? null : amount(row.fees),
			reportedProtocolFeesUsd: row.protocol_fees == null ? null : amount(row.protocol_fees),
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

/** Reported USD cumulative values remain separate from verified ordinary LP income. */
export function meteoraCandidateWindows(batch: MeteoraHistoryBatch): StoredOfficialWindow[] {
	return batch.hours.map((hour) => ({
		poolId: solanaPoolStorageKey("meteora_dlmm", batch.poolId),
		representation: "official_usd",
		sourceObservation: { ...batch.observation, coverage: "reported_hour" },
		windowStart: hour.startUnix,
		windowEnd: hour.startUnix + HOUR,
		complete: false,
		volume0: null,
		volume1: null,
		lpFees0: null,
		lpFees1: null,
		swapCount: null,
		volumeUsd: hour.volumeUsd,
		reportedFeesUsd: hour.reportedFeesUsd,
		reportedProtocolFeesUsd: hour.reportedProtocolFeesUsd,
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

export function createMeteoraAdapter(enabled = false) {
	return {
		...(enabled
			? createReadyAdapter("solana", "meteora_dlmm", { solanaDlmm: true })
			: createPlaceholderAdapter("solana", "meteora_dlmm")),
		readPool: readMeteoraPool,
		readPoolPage: readMeteoraPoolPage,
		readCandidates: readMeteoraCandidates,
		readHistory: readMeteoraHistory,
	};
}

export const venueAdapter = createMeteoraAdapter();
