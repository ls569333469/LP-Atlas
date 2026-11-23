import Decimal from "decimal.js";
import { formatHookType } from "../adapters/hooks.ts";
import { knownToken } from "../adapters/tokens.ts";
import { composeFromHours, missingHourCount } from "../metrics/compose-windows.ts";
import {
	annualizeFeesApr,
	capitalEfficiency,
	priceChangeRatio,
	relativeChange,
	windowDurationSeconds,
} from "../metrics/fees-apr.ts";
import {
	defaultBoardFilters,
	parseBoardFilters,
	parseBoardSort,
	rowPassesFilters,
	rowPassesMetricConditions,
	sortBoardRows,
} from "../metrics/filter-sort.ts";
import {
	alignHourStart,
	currentAndPreviousWindows,
	hourStartsInWindow,
} from "../metrics/windows.ts";
import { chainByEvmId, enabledVenues, productCatalog } from "../shared/catalog.ts";
import { BOARD_COLUMNS, BOARD_WINDOWS, METRIC_SOURCE_SELF_BUILT } from "../shared/constants.ts";
import type { DlmmFilters } from "../shared/dlmm-filters.ts";
import { combineFeeStatuses, FEE_DATA_REASONS, feeDataUsable } from "../shared/fee-quality.ts";
import {
	formatFeeTierLabel,
	formatPairLabel,
	isDynamicFeeTier,
	protocolLabel,
} from "../shared/format.ts";
import type {
	BoardMetricCondition,
	BoardRefreshState,
	BoardResponse,
	BoardRow,
	BoardSuccessResponse,
	BoardWindowMeta,
	BoardWindowMetrics,
	ChainRpcSource,
	MetricSource,
	MetricValue,
	RpcSourceInfo,
	TokenRef,
	WindowId,
} from "../shared/types.ts";
import type { AppDatabase } from "../store/db.ts";
import {
	countPoolsByVenue,
	latestPublicationRevision,
	latestRefreshRun,
	latestSuccessfulRefresh,
	listPoolsByIds,
	listPoolWindowsInRange,
	listScannedHours,
	listTokensForPools,
	listWindowsInRange,
} from "../store/repositories.ts";
import type {
	StoredToken as AnyStoredToken,
	StoredEvmPool as StoredPool,
	StoredRefreshRun,
	StoredEvmToken as StoredToken,
	StoredWindow,
} from "../store/types.ts";
import { isEvmPool, isEvmToken } from "../store/types.ts";
import { poolFeeStatus } from "./fee-quality.ts";
import { readMeteoraBoardRows } from "./official-board.ts";
import { evaluatePoolRisks } from "./pool-risks.ts";
import { rawPriceToken1PerToken0 } from "./prices.ts";

export function toBoardRefreshState(input: {
	latest?: StoredRefreshRun;
	lastSuccess?: StoredRefreshRun;
}): BoardRefreshState {
	const latest = input.latest;
	const lastSuccess = input.lastSuccess;
	if (!latest && !lastSuccess) {
		return {
			status: "idle",
			startedAt: null,
			finishedAt: null,
			lastSuccessAt: null,
			error: null,
			scopeChain: null,
			scopeProtocol: null,
		};
	}
	return {
		status: latest?.status ?? "idle",
		startedAt: latest?.startedAt ?? null,
		finishedAt: latest?.finishedAt ?? null,
		lastSuccessAt: lastSuccess?.blockTime ?? lastSuccess?.finishedAt ?? null,
		error: latest?.status === "error" ? (latest.error ?? "刷新失败") : null,
		scopeChain: latest?.scopeChain ?? null,
		scopeProtocol: latest?.scopeProtocol ?? null,
	};
}

export function freshnessWarnings(refresh: BoardRefreshState): string[] {
	const lastSuccess = refresh.lastSuccessAt ?? "无";
	if (refresh.status === "running") {
		return [
			`刷新进行中（开始于 ${refresh.startedAt ?? "未知"}）。以下为已提交结果，数据截止：${lastSuccess}。`,
		];
	}
	if (refresh.status === "error") {
		return [
			`刷新失败：${refresh.error ?? "未知错误"}。以下保留已提交结果，数据截止：${lastSuccess}；失败片段未发布。`,
		];
	}
	return [];
}

export type BoardReadInput = {
	db: AppDatabase;
	rpcSource: RpcSourceInfo;
	chainRpcSources: ChainRpcSource[];
	legacyWindowFilter?: boolean;
	query: {
		dlmmFilters?: DlmmFilters;
		hideLpRestrictions?: boolean;
		minLpFees1hUsd?: string;
		metricConditions?: BoardMetricCondition[];
		minTvlUsd?: string;
		minWindowVolumeUsd?: string;
		chain?: string;
		protocol?: string;
		chains?: string[];
		protocols?: string[];
		includeWindows?: "all";
		feeTierPips?: string;
		search?: string;
		sortField?: string;
		sortDirection?: string;
		window?: string;
	};
};

export async function readBoard(input: BoardReadInput): Promise<BoardResponse> {
	const transaction = await input.db.transaction("read");
	try {
		const sources = input.chainRpcSources;
		const discoveredPoolCount = await countPoolsByVenue(transaction, input.db);
		if (sources.length <= 1)
			return await readBoardSnapshot({
				...input,
				db: transaction,
				discoveredPoolCount,
				readChain: sources[0]?.chain ?? "elysium",
			});
		// Read each chain at its own last successful cutoff in one SQLite snapshot.
		const boards = [];
		const chainRpcSources: ChainRpcSource[] = [];
		for (const source of sources) {
			const board = await readBoardSnapshot({
				...input,
				db: transaction,
				discoveredPoolCount,
				readChain: source.chain,
			});
			chainRpcSources.push({ ...source, refresh: board.refresh, windowsMeta: board.windowsMeta });
			boards.push(board);
		}
		const base = boards.find((board) => board.asOf !== null) ?? boards[0]!;
		const rows = boards.flatMap((board) => board.rows);
		const sort = base.sort;
		const lastSuccess = await latestSuccessfulRefresh(transaction);
		return {
			...base,
			dataRevision: await latestPublicationRevision(
				transaction,
				sources.map((source) => source.chain),
			),
			asOf: lastSuccess?.blockTime ?? base.asOf,
			refresh: toBoardRefreshState({ latest: await latestRefreshRun(transaction), lastSuccess }),
			chainRpcSources,
			rows: sortBoardRows(rows, sort),
			rowCountBeforeFilter: boards.reduce((sum, board) => sum + board.rowCountBeforeFilter, 0),
			gaps: boards.flatMap((board, i) => board.gaps.map((gap) => `${sources[i]!.chain}: ${gap}`)),
			warnings: boards.flatMap((board, i) =>
				board.warnings.map((warning) => `${sources[i]!.chain}: ${warning}`),
			),
		};
	} finally {
		transaction.close();
	}
}

async function readBoardSnapshot(
	input: Omit<BoardReadInput, "db"> & {
		db: Pick<AppDatabase, "execute">;
		readChain: string;
		discoveredPoolCount: Awaited<ReturnType<typeof countPoolsByVenue>>;
	},
): Promise<BoardSuccessResponse> {
	const filters = parseBoardFilters({
		hideLpRestrictions: input.query.hideLpRestrictions,
		minLpFees1hUsd: input.query.minLpFees1hUsd,
		metricConditions: input.query.metricConditions,
		minTvlUsd: input.query.minTvlUsd,
		minWindowVolumeUsd: input.query.minWindowVolumeUsd,
		chain: input.query.chain,
		protocol: input.query.protocol,
		feeTierPips: input.query.feeTierPips,
		search: input.query.search,
	});
	if (input.query.chains) filters.chains = input.query.chains;
	if (input.query.protocols) filters.protocols = input.query.protocols;
	const allWindows =
		input.query.includeWindows === "all" || Boolean(filters.metricConditions?.length);
	const sort = parseBoardSort({
		field: input.query.sortField,
		direction: input.query.sortDirection,
		window: input.query.window,
	});
	const runtime = { solanaDlmm: input.chainRpcSources.some((source) => source.chain === "solana") };
	if (runtime.solanaDlmm && !input.legacyWindowFilter)
		filters.dlmmFilters = input.query.dlmmFilters ?? {};
	const catalog = productCatalog(runtime);
	const venues = enabledVenues(runtime);
	const lastSuccess = await latestSuccessfulRefresh(input.db, input.readChain);
	const latest = await latestRefreshRun(input.db, input.readChain);
	const refresh = toBoardRefreshState({ latest, lastSuccess });
	const discoveredPoolCount = input.discoveredPoolCount;
	const base = {
		ok: true as const,
		dataRevision: await latestPublicationRevision(input.db, [input.readChain]),
		...(allWindows ? { includeWindows: "all" as const } : {}),
		columns: BOARD_COLUMNS,
		catalog,
		enabledVenues: venues,
		chainRpcSources: input.chainRpcSources,
		defaultFilters: defaultBoardFilters(),
		appliedFilters: filters,
		sort,
		source: METRIC_SOURCE_SELF_BUILT as MetricSource,
		rpcSource: input.rpcSource,
		discoveredPoolCount,
		refresh,
	};

	if (!lastSuccess?.blockTime) {
		return {
			...base,
			rows: [],
			asOf: null,
			windowStart: null,
			windowEnd: null,
			currentHourComplete: false,
			rowCountBeforeFilter: 0,
			gaps: parseList(latest?.gaps ?? null),
			warnings: freshnessWarnings(refresh).length
				? freshnessWarnings(refresh)
				: ["尚未刷新。请点击「刷新」由服务端拉取并计算已定窗口。"],
		};
	}

	if (input.readChain === "solana") {
		const official = await readMeteoraBoardRows({
			db: input.db,
			asOf: lastSuccess.blockTime,
			filters,
			sort,
			allWindows,
		});
		const selectedWindow = official.windowsMeta[sort.window];
		return {
			...base,
			...official,
			source: "official_index",
			asOf: lastSuccess.blockTime,
			windowStart: selectedWindow.windowStart,
			windowEnd: selectedWindow.windowEnd,
			currentHourComplete: false,
			gaps: parseList(lastSuccess.gaps),
			warnings: [...parseList(lastSuccess.warnings), ...freshnessWarnings(refresh)],
		};
	}
	const asOfUnix = Math.floor(new Date(lastSuccess.blockTime).getTime() / 1000);
	const { current, previous } = currentAndPreviousWindows(asOfUnix, sort.window);
	const windowRanges = new Map(
		BOARD_WINDOWS.map((item) => [item.id, currentAndPreviousWindows(asOfUnix, item.id)]),
	);

	const readStart = allWindows
		? Math.min(...[...windowRanges.values()].map((range) => range.previous.startUnix))
		: previous.startUnix;

	const gaps = parseList(lastSuccess.gaps);
	const warnings = [...parseList(lastSuccess.warnings), ...freshnessWarnings(refresh)];
	if (latest?.status === "error" && latest.error) {
		// Keep the failed run's gaps visible, but do not treat lastSuccess asOf as a new cutoff.
		for (const gap of parseList(latest.gaps)) {
			if (!gaps.includes(gap)) {
				gaps.push(gap);
			}
		}
	}

	const neededStarts = [
		...hourStartsInWindow(previous.startUnix, previous.endUnix),
		...hourStartsInWindow(current.startUnix, current.endUnix),
	];
	const oneHour = input.legacyWindowFilter
		? current
		: currentAndPreviousWindows(asOfUnix, "1h").current;
	const windows = await listWindowsInRange(
		input.db,
		oneHour.startUnix,
		oneHour.endUnix,
		input.chainRpcSources.find((source) => source.chain === input.readChain)?.evmChainId ?? 99901,
	);
	const scanned = await listScannedHours(input.db, {
		chainId:
			input.chainRpcSources.find((source) => source.chain === input.readChain)?.evmChainId ?? 99901,
		startUnix: readStart,
		endUnixExclusive: current.endUnix,
	});
	const closedProtocols = new Set(
		scanned
			.filter((hour) => hour.windowStart === alignHourStart(asOfUnix) && hour.complete)
			.map((hour) => hour.protocol),
	);
	const chainVenues = venues.filter((venue) => venue.chain === input.readChain);
	const publishedHourComplete =
		chainVenues.length > 0 && chainVenues.every((venue) => closedProtocols.has(venue.protocol));
	current.complete = publishedHourComplete;
	for (const range of windowRanges.values()) range.current.complete = publishedHourComplete;
	const windowsMeta = Object.fromEntries(
		[...windowRanges].map(([id, range]) => [
			id,
			{
				windowStart: new Date(range.current.startUnix * 1000).toISOString(),
				windowEnd: new Date(range.current.endUnix * 1000).toISOString(),
				currentHourComplete: range.current.complete,
			},
		]),
	) as Record<WindowId, BoardWindowMeta>;
	const scannedByVenue = new Map<string, Set<number>>();
	const boundaryByVenue = new Map<string, Set<number>>();
	for (const hour of scanned) {
		if (!hour.complete && hour.windowEnd <= asOfUnix) {
			gaps.push(
				`${hour.protocol}：${new Date(hour.windowStart * 1000).toISOString()} 小时已结束但未补齐（仅扫描至 ${hour.asOf}），包含此档的窗口留空。`,
			);
			continue;
		}
		const key = `${hour.chainId}:${hour.protocol}`;
		const set = scannedByVenue.get(key) ?? new Set<number>();
		set.add(hour.windowStart);
		scannedByVenue.set(key, set);
		if (hour.priceBoundaryVersion != null) {
			const boundaries = boundaryByVenue.get(key) ?? new Set<number>();
			boundaries.add(hour.windowStart);
			boundaryByVenue.set(key, boundaries);
		}
	}
	const unionScanned = new Set(
		scanned
			.filter((hour) => hour.complete || hour.windowEnd > asOfUnix)
			.map((hour) => hour.windowStart),
	);
	const missing = missingHourCount(neededStarts, unionScanned);
	if (missing > 0) {
		const label = BOARD_WINDOWS.find((window) => window.id === sort.window)?.label ?? sort.window;
		gaps.push(
			`「${label}」及其上一同等窗口还缺 ${missing} 个自建小时档，缺档已留空，未用其他窗口冒充。`,
		);
	}

	const byPool = new Map<string, StoredWindow[]>();
	for (const window of windows) {
		const list = byPool.get(window.poolId) ?? [];
		list.push(window);
		byPool.set(window.poolId, list);
	}
	const candidateIds = [
		...new Set(
			windows
				.filter(
					(hour) => hour.windowStart >= oneHour.startUnix && hour.windowStart < oneHour.endUnix,
				)
				.map((hour) => hour.poolId),
		),
	];
	const pools = (await listPoolsByIds(input.db, candidateIds))
		.filter(isEvmPool)
		.filter((pool) => chainByEvmId(pool.chainId)?.id === input.readChain);
	const tokens = tokenMap(await listTokensForPools(input.db, candidateIds));
	const rows: BoardRow[] = [];
	let rowCountBeforeFilter = 0;
	const admitted: Array<{
		pool: StoredPool;
		admission: BoardRow;
		admissionWindow: StoredWindow;
		scannedStarts: Set<number>;
	}> = [];
	for (const pool of pools) {
		const scannedStarts =
			scannedByVenue.get(`${pool.chainId}:${pool.protocol}`) ?? new Set<number>();
		const poolWindows = (byPool.get(pool.poolId) ?? []).map((window) => ({
			...window,
			feeStatus: poolFeeStatus(pool, window),
			sqrtPriceStart: boundaryByVenue
				.get(`${pool.chainId}:${pool.protocol}`)
				?.has(window.windowStart)
				? window.sqrtPriceStart
				: null,
		}));
		const admissionWindow = composeFromHours(
			poolWindows,
			{ ...oneHour, complete: closedProtocols.has(pool.protocol) },
			scannedStarts,
		);
		if (!admissionWindow) continue;
		const admission = toRow({
			pool,
			current: { ...admissionWindow, startUnix: oneHour.startUnix },
			previous: undefined,
			tokens,
			asOf: admissionWindow.asOf,
		});
		rowCountBeforeFilter += 1;
		if (!rowPassesFilters(admission, filters, !input.legacyWindowFilter)) continue;

		admitted.push({ pool, admission, admissionWindow, scannedStarts });
	}
	const history = await listPoolWindowsInRange(
		input.db,
		admitted.map((item) => item.pool.poolId),
		readStart,
		current.endUnix,
	);
	byPool.clear();
	for (const hour of history) {
		const list = byPool.get(hour.poolId) ?? [];
		list.push(hour);
		byPool.set(hour.poolId, list);
	}
	for (const { pool, admission, admissionWindow, scannedStarts } of admitted) {
		const poolWindows = (byPool.get(pool.poolId) ?? []).map((hour) => ({
			...hour,
			feeStatus: poolFeeStatus(pool, hour),
			sqrtPriceStart: boundaryByVenue.get(`${pool.chainId}:${pool.protocol}`)?.has(hour.windowStart)
				? hour.sqrtPriceStart
				: null,
		}));
		const windowMetrics = {} as Record<WindowId, BoardWindowMetrics>;
		let selected = admission;
		for (const id of allWindows
			? BOARD_WINDOWS.map((item) => item.id)
			: !input.legacyWindowFilter && sort.window !== "1h"
				? (["1h", sort.window] as WindowId[])
				: [sort.window]) {
			const range = windowRanges.get(id);
			if (!range) continue;
			const currentValue =
				id === "1h" && !input.legacyWindowFilter
					? admissionWindow
					: composeFromHours(
							poolWindows,
							{ ...range.current, complete: closedProtocols.has(pool.protocol) },
							scannedStarts,
						);
			const previousValue = composeFromHours(poolWindows, range.previous, scannedStarts, {
				allowEmpty: true,
			});
			const empty: MetricValue = {
				value: null,
				source: METRIC_SOURCE_SELF_BUILT,
				asOf: lastSuccess.blockTime,
				complete: false,
			};
			const row = currentValue
				? toRow({
						pool,
						current: { ...currentValue, startUnix: range.current.startUnix },
						previous: previousValue
							? { ...previousValue, startUnix: range.previous.startUnix }
							: undefined,
						tokens,
						asOf: currentValue.asOf,
						tvlUsd: admission.tvlUsd.value,
					})
				: {
						...admission,
						volumeUsd: empty,
						feesUsd: empty,
						feesApr: empty,
						changeVsPrevWindow: empty,
						priceChange: empty,
						capitalEfficiency: empty,
					};
			windowMetrics[id] = {
				volumeUsd: row.volumeUsd,
				feesUsd: row.feesUsd,
				feesApr: row.feesApr,
				changeVsPrevWindow: row.changeVsPrevWindow,
				priceChange: row.priceChange,
				capitalEfficiency: row.capitalEfficiency,
			};
			if (id === sort.window) selected = row;
		}
		if (
			!input.legacyWindowFilter &&
			windowMetrics["1h"].changeVsPrevWindow.value === null &&
			windowMetrics["1h"].priceChange.value === null
		)
			continue;
		if (
			!rowPassesMetricConditions(
				{ ...selected, windows: windowMetrics },
				filters.metricConditions ?? [],
			)
		)
			continue;
		const risks = evaluatePoolRisks(pool);
		if (
			filters.hideLpRestrictions &&
			risks.riskNotices?.some((notice) => notice.kind === "entry" || notice.kind === "exit")
		)
			continue;
		rows.push({
			...(allWindows ? { ...selected, windows: windowMetrics } : selected),
			...risks,
		});
	}

	const visible = sortBoardRows(rows, sort);

	return {
		...base,
		rows: visible,
		...(allWindows ? { windowsMeta } : {}),
		asOf: lastSuccess.blockTime,
		windowStart: new Date(current.startUnix * 1000).toISOString(),
		windowEnd: new Date(current.endUnix * 1000).toISOString(),
		currentHourComplete: current.complete,
		rowCountBeforeFilter,
		gaps,
		warnings,
	};
}

function toRow(input: {
	pool: StoredPool;
	current: StoredWindow & { startUnix: number };
	previous: (StoredWindow & { startUnix: number }) | undefined;
	tokens: Map<string, StoredToken>;
	asOf: string;
	tvlUsd?: string | null;
}): BoardRow {
	const token0 = toTokenRef(input.pool.chainId, input.pool.token0, input.tokens);
	const token1 = toTokenRef(input.pool.chainId, input.pool.token1, input.tokens);
	const asOfUnix = Math.floor(new Date(input.asOf).getTime() / 1000);
	const duration = windowDurationSeconds({
		windowStartUnix: input.current.windowStart,
		windowEndUnix: input.current.windowEnd,
		asOfUnix,
		complete: input.current.complete,
	});
	const tvl = decimalOrNull(input.tvlUsd === undefined ? input.current.tvlUsd : input.tvlUsd);
	const feeStatus = input.current.feeStatus ?? "legacy_unverified";
	const fees = feeDataUsable(feeStatus) ? decimalOrNull(input.current.lpFeesUsd) : null;
	const volume = decimalOrNull(input.current.volumeUsd);
	const prevFees = input.previous ? decimalOrNull(input.previous.lpFeesUsd) : null;
	const apr =
		fees && tvl
			? annualizeFeesApr({ lpFeesUsd: fees, tvlUsd: tvl, windowDurationSeconds: duration })
			: null;
	const efficiency = volume && tvl ? capitalEfficiency(volume, tvl) : null;
	const changeStatus = combineFeeStatuses([
		feeStatus,
		...(input.previous ? ([input.previous.feeStatus ?? "legacy_unverified"] as const) : []),
	]);
	const change =
		feeDataUsable(changeStatus) && fees && prevFees ? relativeChange(fees, prevFees) : null;
	const price =
		input.pool.createdAtUnix !== null && input.pool.createdAtUnix > input.current.startUnix
			? null
			: priceChangeForWindow(input.current);
	const age =
		input.pool.createdAtUnix !== null ? new Decimal(asOfUnix - input.pool.createdAtUnix) : null;
	const metric = (value: Decimal | null, complete = input.current.complete): MetricValue => ({
		value: value ? value.toString() : null,
		source: input.current.source,
		asOf: input.asOf,
		complete,
	});
	const chain = chainByEvmId(input.pool.chainId);
	const feeMetric = (value: Decimal | null, complete = input.current.complete): MetricValue => ({
		...metric(value, complete),
		feeStatus,
		reason: FEE_DATA_REASONS[feeStatus],
	});
	return {
		poolId:
			input.pool.nativePoolId ?? input.pool.poolId.slice(input.pool.poolId.lastIndexOf(":") + 1),
		chainId: input.pool.chainId,
		chain: chain?.id ?? String(input.pool.chainId),
		protocol: input.pool.protocol,
		pairLabel: formatPairLabel(token0.symbol, token1.symbol),
		token0,
		token1,
		feeTierPips: input.pool.feePips,
		feeTierLabel: formatFeeTierLabel(input.pool.feePips, {
			dynamic: isDynamicFeeTier(input.pool.feePips),
		}),
		hookType: formatHookType(input.pool.hooks),
		tvlUsd: metric(tvl, true),
		volumeUsd: metric(volume),
		feesUsd: feeMetric(fees),
		feesApr: feeMetric(apr),
		changeVsPrevWindow: {
			...metric(change, Boolean(input.previous?.complete) && feeDataUsable(changeStatus)),
			feeStatus: changeStatus,
			reason:
				input.previous && feeDataUsable(changeStatus) && prevFees?.isZero() && fees?.gt(0)
					? "previous_zero"
					: FEE_DATA_REASONS[changeStatus],
		},
		priceChange: metric(price),
		capitalEfficiency: metric(efficiency),
		poolAgeSeconds: metric(age, true),
	};
}

function priceChangeForWindow(window: StoredWindow): Decimal | null {
	if (!window.sqrtPriceStart || !window.sqrtPriceEnd) {
		return null;
	}
	try {
		const start = rawPriceToken1PerToken0(BigInt(window.sqrtPriceStart));
		const end = rawPriceToken1PerToken0(BigInt(window.sqrtPriceEnd));
		return priceChangeRatio(start, end);
	} catch {
		return null;
	}
}

export function tokenKey(chainId: number, address: string): string {
	return `${chainId}:${address.toLowerCase()}`;
}

function toTokenRef(chainId: number, address: string, tokens: Map<string, StoredToken>): TokenRef {
	const stored = tokens.get(tokenKey(chainId, address));
	if (stored) {
		return {
			chainId: stored.chainId,
			address: stored.address,
			symbol: stored.symbol,
			name: stored.name,
			decimals: stored.decimals,
		};
	}
	const known = knownToken(address, chainId);
	if (known) {
		return { chainId, address: known.address, symbol: known.symbol, decimals: known.decimals };
	}
	return { chainId, address, symbol: address.slice(0, 6).toUpperCase(), decimals: 18 };
}

function decimalOrNull(value: string | null): Decimal | null {
	if (value === null) {
		return null;
	}
	const parsed = new Decimal(value);
	return parsed.isFinite() ? parsed : null;
}

function tokenMap(rows: AnyStoredToken[]): Map<string, StoredToken> {
	return new Map(rows.filter(isEvmToken).map((row) => [tokenKey(row.chainId, row.address), row]));
}

function parseList(value: string | null): string[] {
	if (!value) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [value];
	} catch {
		return [value];
	}
}

export { parseBoardFilters, protocolLabel };
