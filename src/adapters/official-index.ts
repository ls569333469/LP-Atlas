import Decimal from "decimal.js";
import { METRIC_SOURCE_OFFICIAL_INDEX } from "../shared/constants.ts";
import type { WindowId } from "../shared/types.ts";
import { BOARD_WINDOW_COMPOSITION_RULES } from "../shared/venue-sources.ts";
import type { StoredWindow } from "../store/types.ts";
import { DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_BASE_DELAY_MS, withRetry } from "./retry.ts";

export const GRAPH_GATEWAY_ORIGIN = "https://gateway.thegraph.com";
export const OFFICIAL_INDEX_TIMEOUT_MS = 20_000;
export const DAY_SECONDS = 86_400;

export type OfficialIndexErrorCode =
	| "missing_api_key"
	| "missing_subgraph_id"
	| "index_down"
	| "index_rate_limited"
	| "index_response"
	| "index_graphql";

export class OfficialIndexError extends Error {
	readonly code: OfficialIndexErrorCode;
	readonly retryAfterMs: number | undefined;

	constructor(
		code: OfficialIndexErrorCode,
		message: string,
		options?: { cause?: unknown; retryAfterMs?: number },
	) {
		super(message, options);
		this.name = "OfficialIndexError";
		this.code = code;
		this.retryAfterMs = options?.retryAfterMs;
	}
}

/** Bounded REST reads for official indexes; the deadline also covers the response body. */
export async function queryOfficialJson(
	url: URL,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		maxBytes?: number;
		onRequestTiming?: (timing: {
			httpMs: number;
			parseMs: number;
			bytes: number;
			timedOut: boolean;
			lateResponse: boolean;
		}) => void;
	} = {},
): Promise<unknown> {
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 18_000;
	const maxBytes = options.maxBytes ?? 900_000;
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0
	)
		throw new Error("Invalid official index request budget");
	const started = performance.now();
	let parseStarted: number | undefined;
	let bytes = 0;
	let timedOut = false;
	let lateResponse = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutError = new OfficialIndexError("index_down", "Official index request timed out");
	const expire = () => {
		timedOut = true;
		controller.abort();
	};
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			expire();
			reject(timeoutError);
		}, timeoutMs);
	});
	const checkResponseDeadline = () => {
		if (!timedOut && performance.now() - started < timeoutMs) return;
		lateResponse = true;
		if (!timedOut) expire();
		throw timeoutError;
	};
	const read = async () => {
		const response = await (options.fetchImpl ?? fetch)(url, {
			signal: controller.signal,
			headers: { accept: "application/json" },
			redirect: "error",
		});
		checkResponseDeadline();
		if (!response.ok) {
			const retryAfter = response.headers.get("retry-after");
			const retryAfterMs =
				retryAfter === null
					? undefined
					: /^\d+(\.\d+)?$/.test(retryAfter.trim())
						? Number(retryAfter) * 1000
						: Math.max(0, Date.parse(retryAfter) - Date.now());
			controller.abort();
			throw new OfficialIndexError(
				response.status === 429 ? "index_rate_limited" : "index_down",
				`Official index HTTP ${response.status}`,
				{ retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined },
			);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new OfficialIndexError("index_response", "Missing official index body");
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const next = await reader.read();
				checkResponseDeadline();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > maxBytes) {
					controller.abort();
					throw new OfficialIndexError("index_response", "Official index response exceeds budget");
				}
				chunks.push(next.value);
			}
		} finally {
			reader.releaseLock();
		}
		let data: unknown;
		try {
			parseStarted = performance.now();
			data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch (cause) {
			throw new OfficialIndexError("index_response", "Invalid official index JSON", { cause });
		}
		checkResponseDeadline();
		return data;
	};
	try {
		return await Promise.race([read(), deadline]);
	} catch (cause) {
		if (timedOut) throw timeoutError;
		if (cause instanceof OfficialIndexError) throw cause;
		throw new OfficialIndexError("index_down", "Official index request failed or timed out", {
			cause,
		});
	} finally {
		clearTimeout(timer);
		if (options.onRequestTiming) {
			const finished = performance.now();
			options.onRequestTiming({
				httpMs: (parseStarted ?? finished) - started,
				parseMs: parseStarted === undefined ? 0 : finished - parseStarted,
				bytes,
				timedOut,
				lateResponse,
			});
		}
	}
}

export type OfficialIndexToken = {
	id: string;
	symbol: string;
	decimals: string | number;
	name?: string | null;
};

export type OfficialIndexPool = {
	id: string;
	token0: OfficialIndexToken;
	token1: OfficialIndexToken;
	feeTier: string | number;
	createdAtTimestamp?: string | number | null;
	createdAtBlockNumber?: string | number | null;
	totalValueLockedUSD?: string | null;
	sqrtPrice?: string | null;
	volumeUSD?: string | null;
	feesUSD?: string | null;
};

/** Official subgraph PoolHourData. periodStartUnix is the hour start. */
export type OfficialIndexPoolHour = {
	poolId: string;
	periodStartUnix: number;
	volumeUSD?: string | null;
	feesUSD?: string | null;
	tvlUSD?: string | null;
	volumeToken0?: string | null;
	volumeToken1?: string | null;
	txCount?: string | number | null;
	sqrtPrice?: string | null;
};

/** Official subgraph PoolDayData. date is the UTC day start. */
export type OfficialIndexPoolDay = {
	poolId: string;
	date: number;
	volumeUSD?: string | null;
	feesUSD?: string | null;
	tvlUSD?: string | null;
	volumeToken0?: string | null;
	volumeToken1?: string | null;
	txCount?: string | number | null;
	sqrtPrice?: string | null;
};

export type OfficialComposeRange = {
	startUnix: number;
	endUnix: number;
	complete: boolean;
};

export type OfficialIndexQueryInput = {
	apiKey: string | undefined;
	subgraphId: string | undefined;
	query: string;
	variables?: Record<string, unknown>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

export function graphGatewayUrl(subgraphId: string): string {
	return `${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${encodeURIComponent(subgraphId)}`;
}

export function isRetryableOfficialIndexError(error: unknown): boolean {
	if (error instanceof OfficialIndexError) {
		return error.code === "index_down" || error.code === "index_rate_limited";
	}
	return false;
}

export function utcDayStart(unixSeconds: number): number {
	return Math.floor(unixSeconds / DAY_SECONDS) * DAY_SECONDS;
}

export function isExactUtcDayRange(startUnix: number, endUnix: number): boolean {
	const length = endUnix - startUnix;
	return startUnix % DAY_SECONDS === 0 && length > 0 && length % DAY_SECONDS === 0;
}

export function officialDayStarts(startUnix: number, endUnix: number): number[] | null {
	if (!isExactUtcDayRange(startUnix, endUnix)) {
		return null;
	}
	const starts: number[] = [];
	for (let cursor = startUnix; cursor < endUnix; cursor += DAY_SECONDS) {
		starts.push(cursor);
	}
	return starts;
}

export async function queryOfficialIndex<T>(input: OfficialIndexQueryInput): Promise<T> {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) {
		throw new OfficialIndexError(
			"missing_api_key",
			"未配置 THE_GRAPH_API_KEY，拒绝走公开非官方网关。",
		);
	}
	const subgraphId = input.subgraphId?.trim();
	if (!subgraphId) {
		throw new OfficialIndexError(
			"missing_subgraph_id",
			"未配置官方 subgraph ID，拒绝使用未确认或非官方部署。",
		);
	}

	return withRetry(
		() =>
			postOfficialIndex<T>({
				apiKey,
				subgraphId,
				query: input.query,
				variables: input.variables,
				timeoutMs: input.timeoutMs ?? OFFICIAL_INDEX_TIMEOUT_MS,
				fetchImpl: input.fetchImpl ?? fetch,
			}),
		{
			attempts: DEFAULT_RETRY_ATTEMPTS,
			baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
			shouldRetry: isRetryableOfficialIndexError,
			sleep: input.sleep,
		},
	);
}

async function postOfficialIndex<T>(input: {
	apiKey: string;
	subgraphId: string;
	query: string;
	variables?: Record<string, unknown>;
	timeoutMs: number;
	fetchImpl: typeof fetch;
}): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.timeoutMs);
	try {
		const response = await input.fetchImpl(graphGatewayUrl(input.subgraphId), {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${input.apiKey}`,
			},
			body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
			signal: controller.signal,
		});
		if (response.status === 429) {
			throw new OfficialIndexError("index_rate_limited", "官方索引限流：429");
		}
		if (!response.ok) {
			const kind = response.status >= 500 ? "index_down" : "index_graphql";
			throw new OfficialIndexError(kind, `官方索引请求失败：${response.status}`);
		}
		const payload = (await response.json()) as {
			data?: T;
			errors?: Array<{ message?: string }>;
		};
		if (payload.errors?.length) {
			const message = payload.errors.map((error) => error.message ?? "未知错误").join("; ");
			throw new OfficialIndexError("index_graphql", `官方索引 GraphQL 错误：${message}`);
		}
		if (payload.data === undefined) {
			throw new OfficialIndexError("index_graphql", "官方索引返回空数据");
		}
		return payload.data;
	} catch (error) {
		if (error instanceof OfficialIndexError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new OfficialIndexError("index_down", "官方索引请求超时", { cause: error });
		}
		throw new OfficialIndexError(
			"index_down",
			`官方索引不可用或请求失败：${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		clearTimeout(timer);
	}
}

export function mapOfficialHourToWindow(
	hour: OfficialIndexPoolHour,
	options: { asOf: string; complete: boolean },
): StoredWindow {
	return officialBucketToWindow({
		poolId: hour.poolId,
		startUnix: hour.periodStartUnix,
		endUnix: hour.periodStartUnix + 3600,
		volumeUSD: hour.volumeUSD ?? null,
		feesUSD: hour.feesUSD ?? null,
		tvlUSD: hour.tvlUSD ?? null,
		txCount: hour.txCount ?? null,
		sqrtPriceEnd: hour.sqrtPrice ?? null,
		sqrtPriceStart: null,
		asOf: options.asOf,
		complete: options.complete,
	});
}

/**
 * Map official 1h / 1d buckets onto a determined board window.
 * Missing hours stay empty. A UTC-aligned 1d range may use official day
 * buckets only when 1h coverage is incomplete or absent. A rolling window
 * that is not UTC-day aligned must never be filled from a 1d bucket.
 *
 * Official feesUSD may include protocol fees. Do not wire this into fees APR
 * until the venue adapter has verified the field is LP-only or has subtracted
 * the protocol share.
 */
export function composeOfficialBoardWindow(input: {
	poolId: string;
	windowId: WindowId;
	range: OfficialComposeRange;
	hours: readonly OfficialIndexPoolHour[];
	days?: readonly OfficialIndexPoolDay[];
	asOf: string;
}): StoredWindow | null {
	const rule = BOARD_WINDOW_COMPOSITION_RULES.find((item) => item.windowId === input.windowId);
	if (!rule) {
		return null;
	}
	const length = input.range.endUnix - input.range.startUnix;
	if (length !== rule.hourCount * 3600) {
		return null;
	}

	const hourWindow = composeFromOfficialHours(input.poolId, input.range, input.hours, input.asOf);
	if (hourWindow) {
		return hourWindow;
	}
	if (rule.utcDayCount === null) {
		return null;
	}
	const dayStarts = officialDayStarts(input.range.startUnix, input.range.endUnix);
	if (!dayStarts || dayStarts.length !== rule.utcDayCount) {
		return null;
	}
	return composeFromOfficialDays(
		input.poolId,
		input.range,
		input.days ?? [],
		dayStarts,
		input.asOf,
	);
}

function composeFromOfficialHours(
	poolId: string,
	range: OfficialComposeRange,
	hours: readonly OfficialIndexPoolHour[],
	asOf: string,
): StoredWindow | null {
	const needed: number[] = [];
	for (let cursor = range.startUnix; cursor < range.endUnix; cursor += 3600) {
		needed.push(cursor);
	}
	const byStart = new Map(
		hours
			.filter((hour) => hour.poolId === poolId)
			.map((hour) => [hour.periodStartUnix, hour] as const),
	);
	const parts: OfficialIndexPoolHour[] = [];
	for (const start of needed) {
		const hour = byStart.get(start);
		if (!hour) {
			return null;
		}
		parts.push(hour);
	}
	return officialBucketToWindow({
		poolId,
		startUnix: range.startUnix,
		endUnix: range.endUnix,
		volumeUSD: sumDecimal(parts.map((part) => part.volumeUSD)),
		feesUSD: sumDecimal(parts.map((part) => part.feesUSD)),
		tvlUSD: lastPresent(parts.map((part) => part.tvlUSD)),
		txCount: parts.reduce((sum, part) => sum + toCount(part.txCount), 0),
		sqrtPriceStart: null,
		sqrtPriceEnd: lastPresent(parts.map((part) => part.sqrtPrice ?? null)),
		asOf,
		complete: range.complete,
	});
}

function composeFromOfficialDays(
	poolId: string,
	range: OfficialComposeRange,
	days: readonly OfficialIndexPoolDay[],
	dayStarts: readonly number[],
	asOf: string,
): StoredWindow | null {
	const byStart = new Map(
		days.filter((day) => day.poolId === poolId).map((day) => [day.date, day] as const),
	);
	const parts: OfficialIndexPoolDay[] = [];
	for (const start of dayStarts) {
		const day = byStart.get(start);
		if (!day) {
			return null;
		}
		parts.push(day);
	}
	return officialBucketToWindow({
		poolId,
		startUnix: range.startUnix,
		endUnix: range.endUnix,
		volumeUSD: sumDecimal(parts.map((part) => part.volumeUSD)),
		feesUSD: sumDecimal(parts.map((part) => part.feesUSD)),
		tvlUSD: lastPresent(parts.map((part) => part.tvlUSD)),
		txCount: parts.reduce((sum, part) => sum + toCount(part.txCount), 0),
		sqrtPriceStart: null,
		sqrtPriceEnd: lastPresent(parts.map((part) => part.sqrtPrice ?? null)),
		asOf,
		complete: range.complete,
	});
}

function officialBucketToWindow(input: {
	poolId: string;
	startUnix: number;
	endUnix: number;
	volumeUSD: string | null;
	feesUSD: string | null;
	tvlUSD: string | null;
	txCount: string | number | null;
	sqrtPriceStart: string | null;
	sqrtPriceEnd: string | null;
	asOf: string;
	complete: boolean;
}): StoredWindow {
	return {
		poolId: input.poolId,
		windowStart: input.startUnix,
		windowEnd: input.endUnix,
		complete: input.complete,
		volume0: "0",
		volume1: "0",
		lpFees0: "0",
		lpFees1: "0",
		swapCount: toCount(input.txCount),
		volumeUsd: input.volumeUSD,
		lpFeesUsd: input.feesUSD,
		tvlUsd: input.tvlUSD,
		sqrtPriceStart: input.sqrtPriceStart,
		sqrtPriceEnd: input.sqrtPriceEnd,
		source: METRIC_SOURCE_OFFICIAL_INDEX,
		asOf: input.asOf,
		gapReason: null,
	};
}

function toCount(value: string | number | null | undefined): number {
	if (value == null || value === "") {
		return 0;
	}
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function lastPresent(values: Array<string | null | undefined>): string | null {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const value = values[index];
		if (value != null && value !== "") {
			return value;
		}
	}
	return null;
}

function sumDecimal(values: Array<string | null | undefined>): string | null {
	let total = new Decimal(0);
	let sawValue = false;
	for (const value of values) {
		if (value == null || value === "") {
			continue;
		}
		total = total.plus(value);
		sawValue = true;
	}
	return sawValue ? total.toString() : null;
}
