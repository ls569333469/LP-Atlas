import type { Address, Log, PublicClient } from "viem";
import { getAddress } from "viem";
import { cacheBlockStates } from "../adapters/block-state-cache.ts";
import { readBlockTimestamp, readChainHead } from "../adapters/blocks.ts";
import { errorText, RpcFailureError } from "../adapters/errors.ts";
import type { PoolPrice, PoolQuote } from "../adapters/pool-price-reader.ts";
import type { ElysiumRpc } from "../adapters/rpc.ts";
import { publicRpcWarning } from "../adapters/rpc.ts";
import { knownToken, loadTokenMetadata, normalizeTokenAddress } from "../adapters/tokens.ts";
import type {
	DecodedSwap,
	DiscoveredPool,
	TokenMetadata,
	V3PoolState,
	V4PoolState,
} from "../adapters/types.ts";
import * as elysiumV3 from "../adapters/venues/elysium/uniswap-v3.ts";
import * as elysiumV4 from "../adapters/venues/elysium/uniswap-v4.ts";
import * as robinhoodV3 from "../adapters/venues/robinhood/uniswap-v3.ts";
import * as robinhoodV4 from "../adapters/venues/robinhood/uniswap-v4.ts";
import { findChain, type VenuePoolCount } from "../shared/catalog.ts";
import {
	CHAIN_ID_ELYSIUM,
	HOUR_SECONDS,
	METRIC_SOURCE_SELF_BUILT,
	ZERO_ADDRESS,
} from "../shared/constants.ts";
import { combineFeeStatuses, feeDataUsable } from "../shared/fee-quality.ts";
import type { UsdQuoteSource } from "../shared/usd-quotes.ts";
import type { AppDatabase } from "../store/db.ts";
import { getMeta, setMeta } from "../store/db.ts";
import { pruneHourlyCache } from "../store/prune.ts";
import {
	countPoolsByVenue,
	deferUsdRepair,
	finishRefreshRun,
	getTokens,
	insertRefreshRun,
	knownPoolBlockTimes,
	listDeferredUsdRepairs,
	listRepairHourKeys,
	listScannedHours,
	listStaleUsdHourStarts,
	listUsdRepairHourKeys,
	listWindowPoolIds,
	listWindowsForStarts,
	updatePoolAges,
	upsertScannedHour,
	upsertTokens,
	upsertWindow,
} from "../store/repositories.ts";
import type {
	StoredScannedHour as AnyScannedHour,
	StoredWindow as AnyStoredWindow,
	StoredOfficialWindow,
	StoredEvmPool as StoredPool,
	StoredEvmScannedHour as StoredScannedHour,
	StoredSolanaScannedHour,
	StoredNativeWindow as StoredWindow,
} from "../store/types.ts";
import { isPricingAnchor, loadCatalog } from "./catalog-cache.ts";
import { poolFeeStatus } from "./fee-quality.ts";
import { hourContinuation, mergeHourContinuation } from "./hour-continuation.ts";
import { createHourPrefetch } from "./hour-prefetch.ts";
import { supplementUsdPrices } from "./price-bridges.ts";
import { buildUsdPrices, sumUsd, valueRawUsd } from "./prices.ts";
import { loadUsdPricePolicy } from "./pricing-policy.ts";
import {
	lookbackHourStarts,
	refreshLimits,
	resolveOneHour,
	selectRefreshHours,
} from "./refresh-hours.ts";
import { repairClosedHour, tvlForPool } from "./repair-hour.ts";
import {
	accumulateSwapWindows,
	applyV4ProtocolFees,
	type BlockBoundedWindow,
} from "./windows-from-swaps.ts";

export type RefreshPipelineResult = {
	ok: true;
	asOf: string;
	blockNumber: string;
	windowsBuilt: number;
	discoveredPoolCount: VenuePoolCount[];
	gaps: string[];
	warnings: string[];
	durationMs: number;
};

function toAddress(value: string): Address {
	return getAddress(value);
}

export async function runRefreshPipeline(input: {
	db: AppDatabase;
	rpc: ElysiumRpc;
	scope?: { chain: string | null; protocol: string | null };
	checkStorage?: () => Promise<string | null>;
	quoteSource?: UsdQuoteSource;
}): Promise<RefreshPipelineResult> {
	const chain = findChain(input.scope?.chain ?? "elysium")!;
	const chainId = chain.evmChainId!;
	const isElysium = chainId === CHAIN_ID_ELYSIUM;
	const v3 = isElysium ? elysiumV3 : robinhoodV3;
	const v4 = isElysium ? elysiumV4 : robinhoodV4;
	const { loadV3Swaps } = v3;
	const { toV4PoolState, loadV4Swaps } = v4;
	const readV3PoolStates = isElysium
		? v3.readV3PoolStates
		: cacheBlockStates(
				(pool: Parameters<typeof v3.readV3PoolStates>[1][number]) => pool.poolAddress.toLowerCase(),
				v3.readV3PoolStates,
			);
	const readV4Slot0s = isElysium
		? v4.readV4Slot0s
		: cacheBlockStates((id: string) => id, v4.readV4Slot0s);
	const cachedReserves = cacheBlockStates(
		(pool: Parameters<typeof v4.readV4Reserves>[1][number]) => pool.poolId,
		(client, pools, block) => v4.readV4Reserves(client, pools, undefined, block),
		(state) => !state.gap?.startsWith("官方 ReservesLens"),
	);
	const readV4Reserves: typeof v4.readV4Reserves = isElysium
		? v4.readV4Reserves
		: (client, pools, concurrency, block) =>
				concurrency === undefined
					? cachedReserves(client, pools, block)
					: v4.readV4Reserves(client, pools, concurrency, block);
	const priceReaders = isElysium
		? undefined
		: {
				v3: robinhoodV3.createV3PriceReader(),
				v4: robinhoodV4.createV4PriceReader(),
			};
	const checkStorage = async () => {
		const blocked = await input.checkStorage?.();
		if (blocked) throw new Error(blocked);
	};
	const pricingAnchor = (token0: string, token1: string) =>
		isPricingAnchor(token0, token1, isElysium);
	const started = Date.now();
	const startedAt = new Date().toISOString();
	const runId = await insertRefreshRun(input.db, {
		startedAt,
		status: "running",
		rpcSourceKind: input.rpc.source.kind,
		rpcSourceLabel: input.rpc.source.label,
		scopeChain: chain.id,
		scopeProtocol: input.scope?.protocol ?? null,
	});
	const gaps: string[] = [];
	const warnings: string[] = [];
	let pruneAsOfUnix: number | null = null;
	const publicWarning = publicRpcWarning(input.rpc.source);
	if (publicWarning) {
		warnings.push(publicWarning);
	}

	const measurePhase = async <T>(
		window: BlockBoundedWindow,
		phase: string,
		operation: () => Promise<T>,
	): Promise<T> => {
		const phaseStarted = Date.now();
		let status = "error";
		try {
			const result = await operation();
			status = "ok";
			return result;
		} finally {
			console.info(
				JSON.stringify({
					event: "scan_hour_phase",
					runId,
					chain: chain.id,
					hour: new Date(window.startUnix * 1000).toISOString(),
					phase,
					startedAt: new Date(phaseStarted).toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - phaseStarted,
					status,
				}),
			);
		}
	};
	const measureRunPhase = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
		const phaseStarted = Date.now();
		let status = "error";
		try {
			const result = await operation();
			status = "ok";
			return result;
		} finally {
			console.info(
				JSON.stringify({
					event: "scan_run_phase",
					runId,
					chain: chain.id,
					phase,
					startedAt: new Date(phaseStarted).toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - phaseStarted,
					status,
				}),
			);
		}
	};
	let drainPrefetch = async (): Promise<void> => {};
	try {
		await checkStorage();
		if (!isElysium && (await input.rpc.client.getChainId()) !== chainId)
			throw new Error("RPC chainId 与场所不一致");
		const head = await measureRunPhase("head", () => readChainHead(input.rpc.client));
		pruneAsOfUnix = head.timestamp;
		const asOf = new Date(head.timestamp * 1000).toISOString();
		const limits = refreshLimits(input.rpc.source.kind);

		const protocolFailures: string[] = await measureRunPhase("discovery", () =>
			discoverIncremental(input.db, input.rpc.client, head.blockNumber, gaps, input.scope, {
				chainId,
				v3,
				v4,
				checkStorage,
			}),
		);

		const catalog = await measureRunPhase("catalog", () =>
			loadCatalog(input.db, chainId, input.scope?.protocol),
		);
		const { pools, v3Pools, v4Pools, v3ByAddress, catalogOrder, poolById } = catalog;
		const priceIndex = isElysium ? undefined : catalog.priceIndex;
		console.info(
			JSON.stringify({
				event: "scan_catalog",
				runId,
				chain: chain.id,
				added: catalog.added,
				total: pools.length,
				loadedMs: catalog.loadedMs,
				indexedMs: catalog.indexedMs,
				rss: process.memoryUsage().rss,
			}),
		);
		const pricingV3 = isElysium ? [] : catalog.pricingV3;
		const inCatalogOrder = (selected: StoredPool[]) =>
			uniquePools(selected).sort(
				(a, b) =>
					a.protocol.localeCompare(b.protocol) ||
					(catalogOrder.get(a.poolId) ?? 0) - (catalogOrder.get(b.poolId) ?? 0),
			);

		const scannedRows = await measureRunPhase("hour_coverage", () =>
			listScannedHours(input.db, {
				startUnix: 0,
				endUnixExclusive: head.timestamp + 1,
				chainId,
			}),
		);
		const wantedProtocols = [
			...(!input.scope?.protocol || input.scope.protocol === "uniswap_v3" ? ["uniswap_v3"] : []),
			...(!input.scope?.protocol || input.scope.protocol === "uniswap_v4" ? ["uniswap_v4"] : []),
		];
		const currentStart = lookbackHourStarts(head.timestamp).currentStart;
		const countsAsScanned = (hour: (typeof scannedRows)[number]): boolean =>
			(hour.complete || hour.windowStart === currentStart) &&
			hour.stateBlockNumber === hour.toBlock &&
			hour.priceBoundaryVersion === 1;
		const scannedByProtocol = new Map<string, Set<number>>();
		for (const hour of scannedRows) {
			if (!countsAsScanned(hour)) {
				continue;
			}
			const set = scannedByProtocol.get(hour.protocol) ?? new Set<number>();
			set.add(hour.windowStart);
			scannedByProtocol.set(hour.protocol, set);
		}
		const fullyScanned = new Set<number>();
		const repairHours = await measureRunPhase("repair_hours", () =>
			listRepairHourKeys(input.db, chainId),
		);
		const usdRepairHours = input.quoteSource
			? await listUsdRepairHourKeys(input.db, chainId)
			: new Set<string>();
		const deferredUsd = input.quoteSource
			? await listDeferredUsdRepairs(input.db, chainId)
			: new Map<number, Set<string>>();
		for (const hour of scannedRows) {
			if (
				input.quoteSource &&
				(usdRepairHours.has(`${hour.protocol}:${hour.windowStart}`) || !hour.usdQuote)
			)
				repairHours.add(`${hour.protocol}:${hour.windowStart}`);
			if (
				countsAsScanned(hour) &&
				wantedProtocols.every(
					(protocol) =>
						scannedByProtocol.get(protocol)?.has(hour.windowStart) &&
						!repairHours.has(`${protocol}:${hour.windowStart}`),
				)
			) {
				fullyScanned.add(hour.windowStart);
			}
		}
		const fullyCovered = new Set(
			scannedRows
				.filter((hour) =>
					wantedProtocols.every((protocol) =>
						scannedRows.some(
							(other) =>
								other.protocol === protocol &&
								other.windowStart === hour.windowStart &&
								(other.complete || other.windowStart === currentStart),
						),
					),
				)
				.map((hour) => hour.windowStart),
		);
		let selectedHours = selectRefreshHours({
			asOfUnix: head.timestamp,
			scannedStarts: fullyScanned,
			coveredStarts: fullyCovered,
			maxHours: input.quoteSource ? 96 : limits.maxHours,
			visibleOnly: !isElysium,
			unfinishedStarts: new Set(
				scannedRows.filter((hour) => !hour.complete).map((hour) => hour.windowStart),
			),
		});
		if (input.quoteSource) {
			const staleUsdHours = await listStaleUsdHourStarts(input.db, chainId);
			const retainedRepairs = [
				...new Set(
					scannedRows
						.filter(
							(hour) =>
								hour.complete &&
								(usdRepairHours.has(`${hour.protocol}:${hour.windowStart}`) || !hour.usdQuote) &&
								hour.windowStart >= currentStart - 4 * 86400 &&
								!selectedHours.includes(hour.windowStart),
						)
						.map((hour) => hour.windowStart),
				),
			].sort((a, b) => b - a);
			const attempted = new Set(
				scannedRows.filter((hour) => hour.usdQuote).map((hour) => hour.windowStart),
			);
			selectedHours = [...selectedHours, ...retainedRepairs]
				.sort((a, b) => {
					const priority = (start: number) =>
						start >= currentStart - 3600 || !fullyCovered.has(start)
							? 0
							: !attempted.has(start)
								? 1
								: staleUsdHours.has(start)
									? 2
									: 3;
					return priority(a) - priority(b);
				})
				.slice(0, limits.maxHours);
		}
		if (selectedHours.length === 0) {
			gaps.push("当前已定窗口的小时档都已扫描，无需再拉。");
		}

		const existingWindowIds = await measureRunPhase("window_pool_ids", () =>
			listWindowPoolIds(input.db, chainId, input.scope?.protocol),
		);

		const v4States = new Map<string, V4PoolState>();
		const v4Slot0s: Awaited<ReturnType<typeof readV4Slot0s>> = new Map();
		const pricingV4 = catalog.pricingV4;
		let sawSwaps = false;
		const tokenCache = new Map<string, TokenMetadata>();
		let v4ToRead: StoredPool[] = [...pricingV4];
		let windowsBuilt = 0;
		const pendingWindows: StoredWindow[] = [];
		const pendingHours: StoredScannedHour[] = [];
		const hoursWritten: BlockBoundedWindow[] = [];
		let committedHours = 0;
		const checkpointHour = async (
			window: BlockBoundedWindow,
			savedHours: StoredScannedHour[],
			usdDeferrals?: Parameters<typeof deferUsdRepair>[1][],
		): Promise<void> => {
			if (
				await measurePhase(window, "checkpoint", () =>
					commitHourCheckpoint(input.db, pendingWindows, pendingHours, window.startUnix, {
						chain: chain.id,
						usdDeferrals,
						runId,
						savedHours,
						gaps: refreshDiagnostics(gaps, warnings).gaps,
						warnings: refreshDiagnostics(gaps, warnings).warnings,
					}),
				)
			)
				committedHours += 1;
		};

		const ensureV4States = async (
			activeIds: Set<string>,
			window: BlockBoundedWindow,
		): Promise<void> => {
			const blockNumber = window.toBlock;
			if (protocolFailures.includes("uniswap_v4")) {
				return;
			}
			const needed = uniquePools([
				...(isElysium
					? v4Pools.filter((pool) => activeIds.has(pool.poolId))
					: inCatalogOrder(
							[...activeIds].flatMap((id) => {
								const pool = poolById.get(id);
								return pool?.protocol === "uniswap_v4" ? [pool] : [];
							}),
						)),
				...pricingV4,
			]).filter((pool) => BigInt(pool.createdBlock) <= blockNumber);
			if (needed.length === 0) {
				return;
			}
			const reads = await Promise.allSettled([
				measurePhase(window, "v4_state", () =>
					readV4Slot0s(
						input.rpc.client,
						needed.map((pool) => pool.poolId),
						blockNumber,
					),
				),
				measurePhase(window, "v4_reserves", () =>
					readV4Reserves(
						input.rpc.client,
						needed
							.filter((pool) => activeIds.has(pool.poolId))
							.map((pool) => ({
								poolId: pool.poolId,
								token0: toAddress(pool.token0),
								token1: toAddress(pool.token1),
								feePips: pool.feePips,
								tickSpacing: pool.tickSpacing,
								hooks: pool.hooks ? toAddress(pool.hooks) : null,
							})),
						undefined,
						blockNumber,
					),
				),
			]);
			const [slotRead, reserveRead] = reads;
			if (slotRead.status === "rejected") throw slotRead.reason;
			if (reserveRead.status === "rejected") throw reserveRead.reason;
			const slot0s = slotRead.value;
			const reserves = reserveRead.value;
			for (const [poolId, slot] of slot0s) v4Slot0s.set(poolId, slot);
			priceReaders?.v4.seed(blockNumber, slot0s);
			for (const [poolId, reserve] of reserves) {
				if (reserve.gap) {
					gaps.push(`${poolId}: ${reserve.gap}`);
				}
			}
			for (const pool of needed) {
				const state = toV4PoolState(
					pool.poolId,
					v4Slot0s.get(pool.poolId),
					reserves.get(pool.poolId),
				);
				if (state) {
					v4States.set(pool.poolId, state);
				}
			}
			v4ToRead = needed;
		};

		// Adjacent natural hours share the exact same block boundary.
		const hourBounds = new Map(
			scannedRows
				.filter((hour) => BigInt(hour.fromBlock) > 0n)
				.map((hour) => [
					hour.windowStart,
					{
						fromBlock: hour.fromBlock,
						toBlock: hour.toBlock,
						complete: hour.complete,
					},
				]),
		);

		const prepareHour = async (startUnix: number) => {
			const window = await measureRunPhase("hour_bounds", () =>
				resolveOneHour({
					client: input.rpc.client,
					head,
					startUnix,
					knownBounds: hourBounds.get(startUnix),
					previousBounds: hourBounds.get(startUnix - HOUR_SECONDS),
					nextBounds: hourBounds.get(startUnix + HOUR_SECONDS),
				}),
			);
			if (!window) return null;
			const savedHours = scannedRows.filter(
				(hour) => hour.windowStart === startUnix && wantedProtocols.includes(hour.protocol),
			);
			const savedWindows = (
				await measurePhase(window, "saved_windows", () =>
					listWindowsForStarts(input.db, [startUnix], {
						chainId,
						protocol: input.scope?.protocol,
					}),
				)
			).filter((row) => poolById.has(row.poolId));
			const canRepair =
				window.complete &&
				wantedProtocols.every((protocol) =>
					savedHours.some(
						(hour) =>
							hour.protocol === protocol &&
							hour.complete &&
							hour.stateBlockNumber === hour.toBlock &&
							hour.fromBlock === window.fromBlock.toString() &&
							hour.toBlock === window.toBlock.toString(),
					),
				) &&
				savedWindows.every(
					(row) =>
						row.complete &&
						(feeDataUsable(row.feeStatus ?? "legacy_unverified") ||
							(Boolean(input.quoteSource) && row.usdValuationVersion !== 2)),
				) &&
				!wantedProtocols.some((protocol) => protocolFailures.includes(protocol));
			hourBounds.set(startUnix, {
				fromBlock: window.fromBlock.toString(),
				toBlock: window.toBlock.toString(),
				complete: window.complete,
			});
			const continuation = new Map(
				wantedProtocols.map((protocol) => {
					const saved = savedHours.find((hour) => hour.protocol === protocol);
					const segment = hourContinuation(
						window,
						saved,
						savedWindows.filter((row) => poolById.get(row.poolId)?.protocol === protocol),
					);
					if (
						saved?.complete &&
						countsAsScanned(saved) &&
						!repairHours.has(`${protocol}:${startUnix}`)
					)
						segment.fromBlock = window.toBlock + 1n;
					return [protocol, segment] as const;
				}),
			);
			return { window, savedHours, savedWindows, canRepair, continuation };
		};
		type HourLogs = {
			v3: Promise<PromiseSettledResult<Log[] | undefined>>;
			v4: Promise<PromiseSettledResult<DecodedSwap[] | undefined>>;
		};
		const pendingReads = new Set<Promise<unknown>>();
		const settleRead = <T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> => {
			const result: Promise<PromiseSettledResult<T>> = operation.then(
				(value) => ({ status: "fulfilled", value }),
				(reason) => ({ status: "rejected", reason }),
			);
			pendingReads.add(result);
			void result.then(() => pendingReads.delete(result));
			return result;
		};
		const readHourLogs = (
			prepared: NonNullable<Awaited<ReturnType<typeof prepareHour>>>,
		): HourLogs => {
			const { window, continuation } = prepared;
			const v3From = continuation.get("uniswap_v3")?.fromBlock ?? window.fromBlock;
			const v4From = continuation.get("uniswap_v4")?.fromBlock ?? window.fromBlock;
			return {
				v3: settleRead(
					wantedProtocols.includes("uniswap_v3") && !protocolFailures.includes("uniswap_v3")
						? measurePhase(window, "v3_logs", () =>
								v3From > window.toBlock
									? Promise.resolve([])
									: robinhoodV3.loadV3SwapLogs(input.rpc.client, v3From, window.toBlock),
							)
						: Promise.resolve(undefined),
				),
				v4: settleRead(
					wantedProtocols.includes("uniswap_v4") && !protocolFailures.includes("uniswap_v4")
						? measurePhase(window, "v4_logs", () =>
								v4From > window.toBlock
									? Promise.resolve([])
									: loadV4Swaps(input.rpc.client, v4From, window.toBlock, new Map()),
							)
						: Promise.resolve(undefined),
				),
			};
		};
		const prefetch = createHourPrefetch<{
			prepared: Awaited<ReturnType<typeof prepareHour>>;
			logs?: HourLogs;
		}>();
		drainPrefetch = async () => {
			await prefetch.close();
			await Promise.all([...pendingReads]);
		};

		for (const [hourIndex, startUnix] of selectedHours.entries()) {
			const hourStarted = Date.now();
			const hourProgress = (status: string) =>
				console.info(
					JSON.stringify({
						event: "scan_hour",
						runId,
						chain: chain.id,
						hour: new Date(startUnix * 1000).toISOString(),
						status,
						durationMs: Date.now() - hourStarted,
						selected: selectedHours.length,
						processed: hoursWritten.length,
						pendingHours: pendingHours.length,
						committedHours,
						pendingWindows: pendingWindows.length,
					}),
				);
			hourProgress("started");
			await checkStorage();

			let prepared: Awaited<ReturnType<typeof prepareHour>>;
			let logs: HourLogs | undefined;
			try {
				const ahead = await prefetch.take(startUnix);
				if (ahead && "error" in ahead) throw ahead.error;
				prepared = ahead ? ahead.value.prepared : await prepareHour(startUnix);
				logs = ahead?.value.logs;
			} catch (error) {
				gaps.push(
					`小时档 ${new Date(startUnix * 1000).toISOString()} 准备失败：${errorText(error)}`,
				);
				hourProgress("prepare_failed");
				continue;
			}
			if (!prepared) continue;
			const { window, savedHours, savedWindows, canRepair, continuation } = prepared;
			const hourAsOf = new Date(
				(window.toBlock === head.blockNumber
					? head.timestamp
					: await readBlockTimestamp(input.rpc.client, window.toBlock)) * 1000,
			).toISOString();
			const v3Continuation = continuation.get("uniswap_v3");
			const v4Continuation = continuation.get("uniswap_v4");
			const baseWindows = new Map(
				[...continuation.values()]
					.flatMap((segment) => segment.base)
					.map((row) => [row.poolId, row]),
			);
			const v3From = v3Continuation?.fromBlock ?? window.fromBlock;
			const v4From = v4Continuation?.fromBlock ?? window.fromBlock;
			const unchanged = new Set(
				wantedProtocols.filter((protocol) => {
					const previous = savedHours.find((hour) => hour.protocol === protocol);
					return (
						(continuation.get(protocol)?.fromBlock ?? window.fromBlock) > window.toBlock &&
						previous?.complete === window.complete
					);
				}),
			);
			if (wantedProtocols.every((protocol) => unchanged.has(protocol)) && !canRepair) {
				hoursWritten.push(window);
				hourProgress("unchanged");
				continue;
			}
			console.info(
				JSON.stringify({
					event: "scan_hour_segments",
					runId,
					chain: chain.id,
					hour: startUnix,
					protocols: wantedProtocols.map((protocol) => ({
						protocol,
						fromBlock: continuation.get(protocol)?.fromBlock.toString(),
						toBlock: window.toBlock.toString(),
						basePools: continuation.get(protocol)?.base.length,
						unchanged: unchanged.has(protocol),
					})),
				}),
			);

			if (canRepair) {
				const pricePolicy = await loadUsdPricePolicy(
					input.rpc.client,
					chainId,
					window.toBlock,
					(message) => gaps.push(message),
					input.quoteSource
						? { source: input.quoteSource, targetAt: Math.floor(Date.parse(hourAsOf) / 1000) }
						: undefined,
				);
				const repaired = await measurePhase(window, "repair", () =>
					repairClosedHour({
						pricePolicy,
						readers: { readV3PoolStates, readV4Slot0s, readV4Reserves, toV4PoolState },
						priceReaders,
						client: input.rpc.client,
						pools,
						poolById: isElysium ? undefined : poolById,
						priceIndex,
						pricingPools: isElysium
							? undefined
							: inCatalogOrder([
									...savedWindows.flatMap((row) => {
										const pool = poolById.get(row.poolId);
										return pool ? [pool] : [];
									}),
									...pricingV3,
									...pricingV4,
								]),
						windows: savedWindows,
						deferredUsdPoolIds: deferredUsd.get(startUnix),
						completeCatalog: !input.scope?.protocol,
						hours: savedHours,
						pricingAnchor,
						loadDecimals: async (addresses) => {
							const tokens = await loadAndStoreTokens(
								input.db,
								input.rpc.client,
								addresses,
								tokenCache,
								chainId,
							);
							return new Map([...tokens].map(([address, token]) => [address, token.decimals]));
						},
					}),
				);
				pendingWindows.push(...repaired.windows);
				pendingHours.push(...repaired.hours);
				windowsBuilt += repaired.windows.length;
				gaps.push(...repaired.gaps);
				hoursWritten.push(window);
				await checkpointHour(
					window,
					savedHours,
					repaired.deferrals?.map(({ window: row, reason }) => ({
						poolId: row.poolId,
						windowStart: row.windowStart,
						toBlock: window.toBlock.toString(),
						windowAsOf: row.asOf,
						window: row,
						catalogRowId: catalog.lastRowId,
						reason,
						evidence:
							"repair-hour: historical state and decimals available; missing token price after bridge attempt; reason-specific zero liquidity or exhausted historical catalog component; rule 2",
					})),
				);
				hourProgress("repaired");
				continue;
			}

			hourBounds.set(startUnix, {
				fromBlock: window.fromBlock.toString(),
				toBlock: window.toBlock.toString(),
				complete: window.complete,
			});
			// Historical USD amounts must use this hour's state, not the latest round's state.
			const v3SwapInputs: Array<{
				poolAddress: Address;
				feePips: number;
				feeProtocol0: number;
				feeProtocol1: number;
			}> = [];
			let v3States = new Map<string, V3PoolState>();
			let v3QuoteStates = new Map<string, PoolQuote>();
			let hourV3Pools: StoredPool[] = isElysium ? v3Pools : [];
			v4States.clear();
			v4Slot0s.clear();
			v4ToRead = [...pricingV4];

			let hourV3: DecodedSwap[] = [];
			let hourV4: DecodedSwap[] = [];
			let hourV3Ok =
				!protocolFailures.includes("uniswap_v3") &&
				wantedProtocols.includes("uniswap_v3") &&
				!unchanged.has("uniswap_v3");
			let hourV4Ok =
				!protocolFailures.includes("uniswap_v4") &&
				wantedProtocols.includes("uniswap_v4") &&
				!unchanged.has("uniswap_v4");

			if (!isElysium) {
				logs ??= await readHourLogs(prepared);
				const nextStart = selectedHours[hourIndex + 1];
				if (nextStart !== undefined)
					prefetch.start(nextStart, async () => {
						const next = await prepareHour(nextStart);
						return {
							prepared: next,
							logs: next && !next.canRepair ? await readHourLogs(next) : undefined,
						};
					});
			}

			const pricePolicyRead = settleRead(
				measurePhase(window, "usd_anchor", async () => {
					const messages: string[] = [];
					const policy = await loadUsdPricePolicy(
						input.rpc.client,
						chainId,
						window.toBlock,
						(message) => messages.push(message),
						input.quoteSource
							? { source: input.quoteSource, targetAt: Math.floor(Date.parse(hourAsOf) / 1000) }
							: undefined,
					);
					return { policy, messages };
				}),
			);

			const readHourV3 = async () => {
				if (hourV3Ok) {
					try {
						const v3LogResult = await logs?.v3;
						if (v3LogResult?.status === "rejected") throw v3LogResult.reason;
						const prefetchedLogs =
							v3LogResult?.status === "fulfilled" ? v3LogResult.value : undefined;
						const activeAddresses = prefetchedLogs
							? new Set(prefetchedLogs.map((log) => log.address.toLowerCase()))
							: undefined;
						for (const row of v3Continuation?.base ?? []) {
							const address = poolById.get(row.poolId)?.poolAddress;
							if (address) activeAddresses?.add(address.toLowerCase());
						}
						if (activeAddresses) {
							hourV3Pools = inCatalogOrder([
								...[...activeAddresses].flatMap((address) => {
									const pool = v3ByAddress.get(address);
									return pool ? [pool] : [];
								}),
								...pricingV3,
							]);
						}
						v3States = await measurePhase(window, "v3_state", () =>
							readV3PoolStates(
								input.rpc.client,
								hourV3Pools
									.filter(
										(pool) =>
											BigInt(pool.createdBlock) <= window.toBlock &&
											(!activeAddresses ||
												activeAddresses.has((pool.poolAddress as string).toLowerCase())),
									)
									.map((pool) => ({
										poolAddress: toAddress(pool.poolAddress as string),
										token0: toAddress(pool.token0),
										token1: toAddress(pool.token1),
									})),
								window.toBlock,
							),
						);
						if (priceReaders) {
							priceReaders.v3.seed(window.toBlock, v3States);
							v3QuoteStates = await measurePhase(window, "v3_quotes", () =>
								priceReaders.v3.readQuotes(
									input.rpc.client,
									hourV3Pools
										.filter(
											(pool) =>
												BigInt(pool.createdBlock) <= window.toBlock &&
												!activeAddresses?.has((pool.poolAddress as string).toLowerCase()),
										)
										.map((pool) => pool.poolAddress as string),
									window.toBlock,
								),
							);
						}
						if (
							v3States.size === 0 &&
							hourV3Pools.some(
								(pool) =>
									!activeAddresses ||
									activeAddresses.has((pool.poolAddress as string).toLowerCase()),
							)
						) {
							gaps.push("已发现 Uniswap V3 池，但当前节点没有返回任何池状态。");
						}
						for (const pool of hourV3Pools) {
							const address = pool.poolAddress;
							if (!address) {
								continue;
							}
							const state = v3States.get(address.toLowerCase());
							v3SwapInputs.push({
								poolAddress: toAddress(address),
								feePips: pool.feePips,
								feeProtocol0: state?.feeProtocol0 ?? 0,
								feeProtocol1: state?.feeProtocol1 ?? 0,
							});
						}
						hourV3 =
							v3From > window.toBlock
								? []
								: await loadV3Swaps(
										input.rpc.client,
										v3SwapInputs,
										v3From,
										window.toBlock,
										undefined,
										prefetchedLogs,
									);
					} catch (error) {
						hourV3Ok = false;
						hourV3 = [];
						if (isElysium) protocolFailures.push("uniswap_v3");
						gaps.push(
							`Uniswap V3 小时 ${new Date(window.startUnix * 1000).toISOString()} 窗口拉取失败，已隔离，未改写其他协议：${errorText(error)}`,
						);
					}
				}
			};
			const readHourV4 = async () => {
				if (hourV4Ok) {
					try {
						const v4LogResult = await logs?.v4;
						if (v4LogResult?.status === "rejected") throw v4LogResult.reason;
						hourV4 =
							v4From > window.toBlock
								? []
								: v4LogResult?.status === "fulfilled" && v4LogResult.value !== undefined
									? v4LogResult.value
									: await loadV4Swaps(input.rpc.client, v4From, window.toBlock, new Map());
						const activeV4Ids = new Set(hourV4.map((swap) => swap.poolId));
						for (const row of v4Continuation?.base ?? []) activeV4Ids.add(row.poolId);
						await measurePhase(window, "v4_state_reserves", () =>
							ensureV4States(activeV4Ids, window),
						);
						const protocolFeeByPool = new Map<string, number>();
						for (const [poolId, slot] of v4Slot0s) {
							protocolFeeByPool.set(poolId, slot.protocolFee);
						}
						applyV4ProtocolFees(hourV4, protocolFeeByPool);
					} catch (error) {
						hourV4Ok = false;
						hourV4 = [];
						if (isElysium) protocolFailures.push("uniswap_v4");
						gaps.push(
							`Uniswap V4 小时 ${new Date(window.startUnix * 1000).toISOString()} 窗口拉取失败，已隔离，未改写其他协议：${errorText(error)}`,
						);
					}
				}
			};
			if (isElysium) {
				await readHourV3();
				await readHourV4();
			} else {
				await Promise.all([readHourV3(), readHourV4()]);
			}

			if (!hourV3Ok && !hourV4Ok) {
				hourProgress("protocols_failed");
				continue;
			}

			sawSwaps ||= hourV3.length > 0 || hourV4.length > 0;

			const tokenAddresses = new Set<string>();
			for (const pool of [...hourV3Pools, ...v4ToRead]) {
				tokenAddresses.add(normalizeTokenAddress(pool.token0));
				tokenAddresses.add(normalizeTokenAddress(pool.token1));
			}
			const tokenMap = await measurePhase(window, "metadata", () =>
				loadAndStoreTokens(input.db, input.rpc.client, [...tokenAddresses], tokenCache, chainId),
			);
			const decimals = new Map<string, number>();
			for (const [address, token] of tokenMap) {
				decimals.set(address, token.decimals);
			}

			const aggregated = await measurePhase(window, "aggregate", async () =>
				accumulateSwapWindows([...hourV3, ...hourV4], [window]),
			);
			if (hourV3Ok) mergeHourContinuation(aggregated, v3Continuation?.base ?? [], "uniswap_v3");
			if (hourV4Ok) mergeHourContinuation(aggregated, v4Continuation?.base ?? [], "uniswap_v4");
			const boundaryBlock = window.fromBlock - 1n;
			const activeIds = new Set([...aggregated.values()].map((acc) => acc.poolId));
			const activePools = isElysium
				? pools
				: inCatalogOrder(
						[...activeIds].flatMap((id) => {
							const pool = poolById.get(id);
							return pool ? [pool] : [];
						}),
					);
			const boundaryV3Pools = (
				isElysium ? v3Pools : activePools.filter((pool) => pool.protocol === "uniswap_v3")
			).filter(
				(pool) =>
					activeIds.has(pool.poolId) &&
					BigInt(pool.createdBlock) <= boundaryBlock &&
					!baseWindows.get(pool.poolId)?.sqrtPriceStart,
			);
			const boundaryV4Pools = (
				isElysium ? v4Pools : activePools.filter((pool) => pool.protocol === "uniswap_v4")
			).filter(
				(pool) =>
					activeIds.has(pool.poolId) &&
					BigInt(pool.createdBlock) <= boundaryBlock &&
					!baseWindows.get(pool.poolId)?.sqrtPriceStart,
			);
			let boundaryV3 = new Map<string, PoolPrice>();
			let boundaryV4 = new Map<string, PoolPrice>();
			await Promise.allSettled([
				(async () => {
					try {
						boundaryV3 = priceReaders
							? await measurePhase(window, "v3_boundary", () =>
									priceReaders.v3.readBoundaries(
										input.rpc.client,
										boundaryV3Pools.map((pool) => (pool.poolAddress as string).toLowerCase()),
										boundaryBlock,
									),
								)
							: await readV3PoolStates(
									input.rpc.client,
									boundaryV3Pools.map((pool) => ({
										poolAddress: toAddress(pool.poolAddress as string),
										token0: toAddress(pool.token0),
										token1: toAddress(pool.token1),
									})),
									boundaryBlock,
								);
					} catch (error) {
						gaps.push(`V3 起始价格读取失败：${errorText(error)}`);
					}
				})(),
				(async () => {
					try {
						boundaryV4 = priceReaders
							? await measurePhase(window, "v4_boundary", () =>
									priceReaders.v4.readBoundaries(
										input.rpc.client,
										boundaryV4Pools.map((pool) => pool.poolId),
										boundaryBlock,
									),
								)
							: await readV4Slot0s(
									input.rpc.client,
									boundaryV4Pools.map((pool) => pool.poolId),
									boundaryBlock,
								);
					} catch (error) {
						gaps.push(`V4 起始价格读取失败：${errorText(error)}`);
					}
				})(),
			]);
			const anchorRead = await pricePolicyRead;
			if (anchorRead.status === "rejected") throw anchorRead.reason;
			gaps.push(...anchorRead.value.messages);
			const pricePolicy = anchorRead.value.policy;
			const v3BoundaryComplete = boundaryV3Pools.every((pool) =>
				boundaryV3.has((pool.poolAddress as string).toLowerCase()),
			);
			const v4BoundaryComplete = boundaryV4Pools.every((pool) => boundaryV4.has(pool.poolId));
			const pricedPools = [
				...(isElysium ? v3Pools : hourV3Pools).flatMap((pool) => {
					const state =
						v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase()) ??
						v3QuoteStates.get((pool.poolAddress ?? pool.poolId).toLowerCase());
					if (!state) {
						return [];
					}
					return [
						{
							poolId: pool.poolId,
							token0: pool.token0,
							token1: pool.token1,
							sqrtPriceX96: state.sqrtPriceX96,
							liquidity: state.liquidity,
						},
					];
				}),
				...v4ToRead.flatMap((pool) => {
					const state = v4States.get(pool.poolId) ?? v4Slot0s.get(pool.poolId);
					if (!state) {
						return [];
					}
					return [
						{
							poolId: pool.poolId,
							token0: pool.token0,
							token1: pool.token1,
							sqrtPriceX96: state.sqrtPriceX96,
							liquidity: "liquidity" in state ? state.liquidity : 0n,
						},
					];
				}),
			];
			for (const acc of aggregated.values()) {
				const pool = poolById.get(acc.poolId);
				if (!pool || !acc.sqrtPriceEnd) continue;
				const hasState =
					pool.protocol === "uniswap_v3"
						? v3States.has((pool.poolAddress ?? pool.poolId).toLowerCase())
						: v4States.has(pool.poolId) || v4Slot0s.has(pool.poolId);
				if (hasState) continue;
				// Same-hour Swap pricing fills a failed state read without inventing balances or fees.
				pricedPools.push({
					poolId: pool.poolId,
					token0: pool.token0,
					token1: pool.token1,
					sqrtPriceX96: acc.sqrtPriceEnd,
					liquidity: 0n,
				});
			}
			let usdPrices = buildUsdPrices(pricedPools, decimals, undefined, pricePolicy);
			let usdBridgeComplete = false;
			try {
				if (pricePolicy.stable.length > 0) {
					const supplement = await measurePhase(window, "usd_bridges", () =>
						supplementUsdPrices({
							pricePolicy,
							readSlots: readV4Slot0s,
							readV3States: priceReaders
								? (client, pools, block) =>
										priceReaders.v3.readQuotes(
											client,
											pools.map((pool) => pool.poolAddress),
											block,
										)
								: undefined,
							readV4Quotes: priceReaders?.v4.readQuotes,
							client: input.rpc.client,
							pools,
							index: priceIndex,
							blockNumber: window.toBlock,
							prices: usdPrices,
							pricedPools,
							loadedPoolIds: new Set([
								...(isElysium ? v3Pools : hourV3Pools)
									.filter(
										(pool) =>
											v3States.has((pool.poolAddress ?? pool.poolId).toLowerCase()) ||
											v3QuoteStates.has((pool.poolAddress ?? pool.poolId).toLowerCase()),
									)
									.map((pool) => pool.poolId),
								...v4Slot0s.keys(),
							]),
							neededTokens: [...activeIds].flatMap((id) => {
								const pool = poolById.get(id);
								return pool ? [pool.token0, pool.token1] : [];
							}),
							decimals,
							loadDecimals: async (addresses) => {
								const tokens = await loadAndStoreTokens(
									input.db,
									input.rpc.client,
									addresses,
									tokenCache,
									chainId,
								);
								return new Map([...tokens].map(([address, token]) => [address, token.decimals]));
							},
						}),
					);
					usdPrices = supplement.prices;
					usdBridgeComplete = supplement.complete;
					if (!supplement.complete) gaps.push(`小时 ${startUnix} 美元报价桥状态或代币资料仍缺失`);
				}
			} catch (error) {
				gaps.push(`小时 ${startUnix} 美元报价桥补读失败：${errorText(error)}`);
			}
			const missingAnchor = isElysium
				? "缺少官方 USDC 定价锚点，美元指标会留空。"
				: `Robinhood 小时 ${startUnix} 区块 ${window.toBlock} 的 USDG 锚状态不可用，原币数据保留，美元指标留空。`;
			if (pricePolicy.stable.length === 0 && !gaps.includes(missingAnchor)) {
				gaps.push(missingAnchor);
			}

			for (const acc of aggregated.values()) {
				const pool = poolById.get(acc.poolId);
				if (!pool) {
					continue;
				}
				const tvlUsd = tvlForPool(pool, v3States, v4States, usdPrices, decimals);
				const volumeUsd = sumUsd(
					valueRawUsd(acc.volume0, pool.token0, usdPrices, decimals),
					valueRawUsd(acc.volume1, pool.token1, usdPrices, decimals),
				);
				const volumeUsdHonest = volumeUsd?.gt(0) ? volumeUsd.div(2) : volumeUsd;
				const feesUsd = sumUsd(
					valueRawUsd(acc.lpFees0, pool.token0, usdPrices, decimals),
					valueRawUsd(acc.lpFees1, pool.token1, usdPrices, decimals),
				);
				const valuationGaps: string[] = [];
				if (tvlUsd === null) valuationGaps.push("TVL 无法计算");
				if (volumeUsdHonest === null || feesUsd === null) {
					const missing = [pool.token0, pool.token1].filter(
						(token) => !usdPrices.has(token.toLowerCase()),
					);
					const metadata = [pool.token0, pool.token1].filter(
						(token) => !decimals.has(token.toLowerCase()),
					);
					if (missing.length) valuationGaps.push(`结束区块缺美元报价：${missing.join("、")}`);
					if (metadata.length) valuationGaps.push(`缺代币小数位：${metadata.join("、")}`);
				}
				const base = baseWindows.get(acc.poolId);
				const feeStatus = combineFeeStatuses([
					...(base ? [base.feeStatus ?? "legacy_unverified"] : []),
					poolFeeStatus(pool, {
						feeStatus:
							(pool.protocol === "uniswap_v4" && !v4Slot0s.has(pool.poolId)) ||
							(pool.protocol === "uniswap_v3" &&
								!v3States.has((pool.poolAddress ?? pool.poolId).toLowerCase()))
								? "protocol_state_missing"
								: "estimated",
						lpFees0: acc.lpFees0.toString(),
						lpFees1: acc.lpFees1.toString(),
					}),
				]);
				pendingWindows.push({
					usdValuationVersion: pricePolicy.valuationVersion ?? null,
					poolId: acc.poolId,
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: window.complete,
					volume0: acc.volume0.toString(),
					volume1: acc.volume1.toString(),
					lpFees0: acc.lpFees0.toString(),
					lpFees1: acc.lpFees1.toString(),
					swapCount: acc.swapCount,
					volumeUsd: volumeUsdHonest?.toString() ?? null,
					lpFeesUsd: feesUsd?.toString() ?? null,
					feeStatus,
					tvlUsd: tvlUsd?.toString() ?? null,
					sqrtPriceStart:
						base?.sqrtPriceStart ??
						(pool.protocol === "uniswap_v3"
							? boundaryV3.get((pool.poolAddress ?? pool.poolId).toLowerCase())?.sqrtPriceX96
							: boundaryV4.get(pool.poolId)?.sqrtPriceX96
						)?.toString() ??
						null,
					sqrtPriceEnd:
						(pool.protocol === "uniswap_v3"
							? v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase())?.sqrtPriceX96
							: v4Slot0s.get(pool.poolId)?.sqrtPriceX96
						)?.toString() ??
						acc.sqrtPriceEnd?.toString() ??
						null,
					source: METRIC_SOURCE_SELF_BUILT,
					asOf: hourAsOf,
					gapReason: valuationGaps.length ? valuationGaps.join("；") : null,
				});
				windowsBuilt += 1;
				existingWindowIds.add(acc.poolId);
			}
			const activeRows = pendingWindows.filter(
				(row) => row.windowStart === startUnix && row.swapCount > 0,
			);
			const missingVolume = activeRows.filter((row) => row.volumeUsd === null).length;
			const missingFees = activeRows.filter((row) => row.lpFeesUsd === null).length;
			if (missingVolume || missingFees) {
				warnings.push(
					`小时 ${startUnix} 金额可用性：有成交 ${activeRows.length} 池，美元成交量缺 ${missingVolume} 池，美元手续费缺 ${missingFees} 池；小时覆盖标记不代表金额全部可用。`,
				);
			}

			if (hourV3Ok && (!input.scope?.protocol || input.scope.protocol === "uniswap_v3")) {
				pendingHours.push({
					chainId,
					protocol: "uniswap_v3",
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: window.complete,
					fromBlock: window.fromBlock.toString(),
					toBlock: window.toBlock.toString(),
					stateBlockNumber: window.toBlock.toString(),
					priceBoundaryVersion: v3BoundaryComplete ? 1 : 2,
					usdBridgeVersion: usdBridgeComplete ? 1 : null,
					usdValuationVersion: pricePolicy.valuationVersion ?? null,
					usdQuote: pricePolicy.quote ?? null,
					asOf: hourAsOf,
					gapReason: null,
				});
			}
			if (hourV4Ok && (!input.scope?.protocol || input.scope.protocol === "uniswap_v4")) {
				pendingHours.push({
					chainId,
					protocol: "uniswap_v4",
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: window.complete,
					fromBlock: window.fromBlock.toString(),
					toBlock: window.toBlock.toString(),
					stateBlockNumber: window.toBlock.toString(),
					priceBoundaryVersion: v4BoundaryComplete ? 1 : 2,
					usdBridgeVersion: usdBridgeComplete ? 1 : null,
					usdValuationVersion: pricePolicy.valuationVersion ?? null,
					usdQuote: pricePolicy.quote ?? null,
					asOf: hourAsOf,
					gapReason: null,
				});
			}
			hoursWritten.push(window);
			await checkpointHour(window, savedHours);
			hourProgress("processed");
		}

		await drainPrefetch();
		const unwrittenHours = selectedHours.filter(
			(start) => !hoursWritten.some((hour) => hour.startUnix === start),
		);
		if (unwrittenHours.length > 0) {
			gaps.push(
				`本轮有 ${unwrittenHours.length} 个小时档未能完成扫描，已留空，不会用已有窗口冒充。可再次手动刷新继续补齐。`,
			);
		}
		if (hoursWritten.length === 0 && selectedHours.length > 0) {
			throw new RpcFailureError(
				"rpc_range_limited",
				"无法用当前节点对齐到独立的小时区块范围，拒绝用其它窗口冒充。",
			);
		}

		await measureRunPhase("pool_ages", () =>
			backfillPoolAges(
				input.db,
				input.rpc.client,
				isElysium
					? pools
					: [...existingWindowIds].flatMap((id) => {
							const pool = poolById.get(id);
							return pool ? [pool] : [];
						}),
				existingWindowIds,
				chainId,
				(stats) =>
					console.info(
						JSON.stringify({ event: "scan_pool_ages", runId, chain: chain.id, ...stats }),
					),
			),
		);

		const discoveredPoolCount = await measureRunPhase("catalog_counts", () =>
			countPoolsByVenue(input.db),
		);
		let durationMs = Date.now() - started;
		if (protocolFailures.length > 0 && windowsBuilt === 0 && !sawSwaps) {
			const message = `刷新失败：${protocolFailures.join("、")} 均未能拉到可用窗口。未使用过期数据冒充新结果。`;
			await finishRefreshRun(input.db, runId, {
				finishedAt: new Date().toISOString(),
				status: "error",
				blockNumber: head.blockNumber.toString(),
				blockTime: asOf,
				error: message,
				gaps: JSON.stringify(refreshGaps(gaps)),
				warnings: JSON.stringify(dedupe(warnings)),
				poolCounts: discoveredPoolCount,
				windowsBuilt,
				durationMs,
			});
			throw new RpcFailureError("rpc_down", message);
		}
		const diagnostics = refreshDiagnostics(gaps, warnings);
		gaps.splice(0, gaps.length, ...diagnostics.gaps);
		warnings.splice(0, warnings.length, ...diagnostics.warnings);
		const status = gaps.length > 0 || protocolFailures.length > 0 ? "partial" : "ok";
		await checkStorage();
		const publication = await input.db.transaction("write");
		try {
			for (const window of pendingWindows) await upsertWindow(publication, window);
			for (const hour of pendingHours) await upsertScannedHour(publication, hour);
			await finishRefreshRun(publication, runId, {
				finishedAt: new Date().toISOString(),
				status,
				blockNumber: head.blockNumber.toString(),
				blockTime: asOf,
				gaps: JSON.stringify(refreshGaps(gaps)),
				warnings: JSON.stringify(dedupe(warnings)),
				poolCounts: discoveredPoolCount,
				windowsBuilt,
				durationMs,
			});
			await publication.commit();
		} catch (error) {
			await publication.rollback();
			throw error;
		} finally {
			publication.close();
		}
		await measureRunPhase("prune", () => pruneHourlyCache(input.db, pruneAsOfUnix));
		durationMs = Date.now() - started;
		await input.db.execute({
			sql: "UPDATE refresh_runs SET finished_at = ?, duration_ms = ? WHERE id = ?",
			args: [new Date().toISOString(), durationMs, runId],
		});
		console.info(
			JSON.stringify({
				event: "scan_run_finished",
				runId,
				chain: chain.id,
				status,
				finishedAt: new Date().toISOString(),
				durationMs: Date.now() - started,
				windowsBuilt,
			}),
		);
		return {
			ok: true,
			asOf,
			blockNumber: head.blockNumber.toString(),
			windowsBuilt,
			discoveredPoolCount,
			gaps: refreshGaps(gaps),
			warnings: dedupe(warnings),
			durationMs,
		};
	} catch (error) {
		const message =
			error instanceof RpcFailureError ? error.message : `刷新失败：${errorText(error)}`;
		const diagnostics = refreshDiagnostics(gaps, warnings);
		await finishRefreshRun(input.db, runId, {
			finishedAt: new Date().toISOString(),
			status: "error",
			error: message,
			gaps: JSON.stringify(diagnostics.gaps),
			warnings: JSON.stringify(diagnostics.warnings),
			durationMs: Date.now() - started,
		});
		await pruneHourlyCache(input.db, pruneAsOfUnix);
		console.info(
			JSON.stringify({
				event: "scan_run_finished",
				runId,
				chain: chain.id,
				status: "error",
				finishedAt: new Date().toISOString(),
				durationMs: Date.now() - started,
			}),
		);
		throw error instanceof RpcFailureError
			? error
			: new RpcFailureError("rpc_down", message, { cause: error });
	} finally {
		await drainPrefetch();
	}
}

type HourCheckpointPublication = {
	chain: string;
	runId: number;
	savedHours: StoredScannedHour[];
	usdDeferrals?: Parameters<typeof deferUsdRepair>[1][];
	gaps: string[];
	warnings: string[];
};

export function commitHourCheckpoint(
	db: AppDatabase,
	pendingWindows: StoredWindow[],
	pendingHours: StoredScannedHour[],
	startUnix: number,
	publication?: HourCheckpointPublication,
): Promise<boolean>;
export function commitHourCheckpoint(
	db: AppDatabase,
	pendingWindows: StoredOfficialWindow[],
	pendingHours: StoredSolanaScannedHour[],
	startUnix: number,
): Promise<boolean>;
export async function commitHourCheckpoint(
	db: AppDatabase,
	pendingWindows: AnyStoredWindow[],
	pendingHours: AnyScannedHour[],
	startUnix: number,
	publication?: HourCheckpointPublication,
): Promise<boolean> {
	const windows = pendingWindows.filter((row) => row.windowStart === startUnix);
	const hours = pendingHours.filter((row) => row.windowStart === startUnix);
	if (windows.length === 0 && hours.length === 0) return false;
	const tx = await db.transaction("write");
	try {
		if (publication) {
			for (const hour of hours) {
				if (hour.chainId === null) throw new Error("Non-EVM publication requires the S3 contract");
				const current = await listScannedHours(tx, {
					chainId: hour.chainId,
					protocol: hour.protocol,
					startUnix,
					endUnixExclusive: startUnix + HOUR_SECONDS,
				});
				const expected = publication.savedHours.find(
					(saved) => saved.protocol === hour.protocol,
				)?.toBlock;
				if (current[0]?.toBlock !== expected)
					throw new Error("小时提交游标已变化，未重复累计，请重试刷新。");
			}
		}
		for (const row of windows) await upsertWindow(tx, row);
		for (const row of hours) await upsertScannedHour(tx, row);
		for (const decision of publication?.usdDeferrals ?? []) await deferUsdRepair(tx, decision);
		if (publication && hours.length > 0) {
			const newest = hours.reduce((last, hour) =>
				Date.parse(hour.asOf) > Date.parse(last.asOf) ? hour : last,
			);
			await tx.execute({
				sql: `INSERT INTO chain_publications (chain, revision, run_id, block_number, block_time, published_at)
					VALUES (?, 1, ?, ?, ?, ?)
					ON CONFLICT(chain) DO UPDATE SET revision = chain_publications.revision + 1,
					run_id = excluded.run_id, published_at = excluded.published_at,
					block_number = CASE WHEN julianday(excluded.block_time) >= julianday(chain_publications.block_time) THEN excluded.block_number ELSE chain_publications.block_number END,
					block_time = CASE WHEN julianday(excluded.block_time) >= julianday(chain_publications.block_time) THEN excluded.block_time ELSE chain_publications.block_time END`,
				args: [
					publication.chain,
					publication.runId,
					newest.toBlock,
					newest.asOf,
					new Date().toISOString(),
				],
			});
			await finishRefreshRun(tx, publication.runId, {
				gaps: JSON.stringify(publication.gaps),
				warnings: JSON.stringify(publication.warnings),
			});
		}
		await tx.commit();
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
	for (let i = pendingWindows.length - 1; i >= 0; i--) {
		if (pendingWindows[i]!.windowStart === startUnix) pendingWindows.splice(i, 1);
	}
	for (let i = pendingHours.length - 1; i >= 0; i--) {
		if (pendingHours[i]!.windowStart === startUnix) pendingHours.splice(i, 1);
	}
	return true;
}

async function discoverIncremental(
	db: AppDatabase,
	client: PublicClient,
	head: bigint,
	gaps: string[],
	scope: { chain: string | null; protocol: string | null } | undefined,
	context: {
		chainId: number;
		v3: typeof elysiumV3 | typeof robinhoodV3;
		v4: typeof elysiumV4 | typeof robinhoodV4;
		checkStorage(): Promise<void>;
	},
): Promise<string[]> {
	const wantV3 = !scope?.protocol || scope.protocol === "uniswap_v3";
	const wantV4 = !scope?.protocol || scope.protocol === "uniswap_v4";
	const failures: string[] = [];
	for (const protocol of ["uniswap_v3", "uniswap_v4"] as const) {
		if (!(protocol === "uniswap_v3" ? wantV3 : wantV4)) continue;
		const key = `${context.chainId === 99901 ? "" : `${context.chainId}:`}${protocol === "uniswap_v3" ? "v3" : "v4"}_discover_block`;
		let from = BigInt((await getMeta(db, key)) ?? "0");
		try {
			const discover =
				protocol === "uniswap_v3" ? context.v3.discoverV3Pools : context.v4.discoverV4Pools;
			while (from <= head) {
				await context.checkStorage();
				const to = from + 2_000_000n - 1n < head ? from + 2_000_000n - 1n : head;
				const page = await discover(client, from, to);
				await context.checkStorage();
				await persistDiscovered(db, page, context.chainId);
				await setMeta(db, key, to.toString());
				from = to + 1n;
			}
		} catch (error) {
			failures.push(protocol);
			gaps.push(`${protocol} 工厂池清单未能完整拉取：${errorText(error)}`);
		}
	}
	const requested = (wantV3 ? 1 : 0) + (wantV4 ? 1 : 0);
	if (failures.length > 0 && failures.length === requested) {
		throw new RpcFailureError(
			"rpc_down",
			`刷新失败：${gaps[gaps.length - 1] ?? "已请求的协议均未能拉取工厂清单。"}`,
		);
	}
	return failures;
}

async function persistDiscovered(
	db: AppDatabase,
	pools: DiscoveredPool[],
	chainId: number,
): Promise<void> {
	const now = new Date().toISOString();
	const sql = `
		INSERT INTO pools (
			pool_id, chain_id, protocol, token0, token1, fee_pips, tick_spacing,
			hooks, pool_address, created_block, created_at_unix, discovered_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(pool_id) DO UPDATE SET
			created_at_unix = COALESCE(pools.created_at_unix, excluded.created_at_unix)
	`;
	const batchSize = 400;
	for (let i = 0; i < pools.length; i += batchSize) {
		const slice = pools.slice(i, i + batchSize);
		await db.batch(
			slice.map((pool) => ({
				sql,
				args: [
					pool.poolId,
					chainId,
					pool.protocol,
					pool.token0.toLowerCase(),
					pool.token1.toLowerCase(),
					pool.feePips,
					pool.tickSpacing,
					pool.hooks,
					pool.poolAddress,
					Number(pool.createdBlock),
					null,
					now,
				],
			})),
			"write",
		);
	}
}

function uniquePools(pools: StoredPool[]): StoredPool[] {
	const map = new Map<string, StoredPool>();
	for (const pool of pools) {
		map.set(pool.poolId, pool);
	}
	return [...map.values()];
}

async function loadAndStoreTokens(
	db: AppDatabase,
	client: PublicClient,
	addresses: string[],
	runCache: Map<string, TokenMetadata>,
	chainId: number = CHAIN_ID_ELYSIUM,
): Promise<Map<string, TokenMetadata>> {
	const cached = new Map<string, TokenMetadata>();
	const persisted = new Set<string>();
	const wanted = [...new Set(addresses.map((address) => address.toLowerCase()))];
	const rows = new Map(
		(
			await getTokens(
				db,
				chainId,
				wanted.filter((address) => !runCache.has(`${chainId}:${address}`)),
			)
		).map((row) => [row.address, row]),
	);
	for (const raw of wanted) {
		const address = raw.toLowerCase();
		const inRun = runCache.get(`${chainId}:${address}`);
		if (inRun) {
			cached.set(address, inRun);
			persisted.add(address);
			continue;
		}
		const known = knownToken(address, chainId);
		if (known) {
			cached.set(address.toLowerCase(), known);
			const row = rows.get(address);
			if (
				row &&
				row.symbol === known.symbol &&
				row.decimals === known.decimals &&
				row.name === known.name
			)
				persisted.add(address);
		} else {
			const row = rows.get(address);
			if (row) {
				persisted.add(address);
				cached.set(address.toLowerCase(), {
					address: toAddress(row.address === ZERO_ADDRESS ? ZERO_ADDRESS : row.address),
					symbol: row.symbol,
					decimals: row.decimals,
					name: row.name,
				});
			}
		}
	}
	const loaded = await loadTokenMetadata(client, addresses, cached, chainId);
	const updates = [];
	for (const token of loaded.values()) {
		if (persisted.has(token.address.toLowerCase())) continue;
		updates.push({
			chainId,
			address: token.address.toLowerCase(),
			symbol: token.symbol,
			decimals: token.decimals,
			name: token.name,
		});
	}
	await upsertTokens(db, updates);
	for (const token of loaded.values())
		runCache.set(`${chainId}:${token.address.toLowerCase()}`, token);
	return loaded;
}

export async function backfillPoolAges(
	db: AppDatabase,
	client: PublicClient,
	pools: StoredPool[],
	needed: ReadonlySet<string>,
	chainId: number,
	report?: (stats: {
		missingPools: number;
		uniqueBlocks: number;
		reusedBlocks: number;
		failedBlocks: number;
		failures: { block: number; code: string }[];
		readMs: number;
		writeMs: number;
	}) => void,
): Promise<void> {
	const missing = pools.filter((pool) => needed.has(pool.poolId) && pool.createdAtUnix === null);
	const uniqueBlocks = [...new Set(missing.map((pool) => pool.createdBlock))];
	const readStarted = Date.now();
	const timestamps = await knownPoolBlockTimes(db, chainId, uniqueBlocks);
	const reusedBlocks = timestamps.size;
	const unread = uniqueBlocks.filter((block) => !timestamps.has(block));
	let failedBlocks = 0;
	const failures: { block: number; code: string }[] = [];
	const concurrency = 6;
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < unread.length) {
			const index = cursor;
			cursor += 1;
			const block = unread[index];
			if (block === undefined) {
				continue;
			}
			try {
				timestamps.set(block, await readBlockTimestamp(client, BigInt(block)));
			} catch (error) {
				failedBlocks += 1;
				if (failures.length < 16)
					failures.push({ block, code: error instanceof RpcFailureError ? error.code : "unknown" });
				// Age stays empty rather than guessed.
			}
		}
	};
	if (unread.length > 0) {
		await Promise.all(Array.from({ length: Math.min(concurrency, unread.length) }, () => worker()));
	}
	const readMs = Date.now() - readStarted;
	const writeStarted = Date.now();
	const ages = missing.flatMap((pool) => {
		const timestamp = timestamps.get(pool.createdBlock);
		return timestamp === undefined ? [] : [{ poolId: pool.poolId, timestamp }];
	});
	await updatePoolAges(db, ages);
	for (const pool of missing) {
		const timestamp = timestamps.get(pool.createdBlock);
		if (timestamp === undefined) {
			continue;
		}
		pool.createdAtUnix = timestamp;
	}
	report?.({
		missingPools: missing.length,
		uniqueBlocks: uniqueBlocks.length,
		reusedBlocks,
		failedBlocks,
		failures,
		readMs,
		writeMs: Date.now() - writeStarted,
	});
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

export function refreshGaps(values: string[]): string[] {
	// Keep scan failures and unfinished-hour diagnostics ahead of per-pool notices.
	return dedupe(values).sort((a, b) => {
		const rank = (value: string) =>
			!/^(?:\d+:[^:]+:)?0x/.test(value) ? 0 : /未能|失败|仍缺失|429|out of gas/.test(value) ? 1 : 2;
		return rank(a) - rank(b);
	});
}

/** Successful core reserve reads with Hook accounting limits are notices, not failed reads. */
export function refreshDiagnostics(gaps: string[], warnings: string[]) {
	const notices = dedupe(
		gaps.filter((value) =>
			value.endsWith("该池 hook 可能有自定义记账，ReservesLens 的 core 金额可能不是全部可兑换深度"),
		),
	);
	const noticeSet = new Set(notices);
	return {
		gaps: refreshGaps(gaps.filter((value) => !noticeSet.has(value))),
		warnings: dedupe([
			...warnings,
			...(notices.length
				? [`Hook 储备范围说明：${notices.length} 个池；以下为读取范围限制，不代表小时漏扫。`]
				: []),
			...notices,
		]),
	};
}
