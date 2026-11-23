import Fastify from "fastify";
import { errorText } from "../adapters/errors.ts";
import type { ElysiumRpc } from "../adapters/rpc.ts";
import { readBoard, toBoardRefreshState } from "../normalize/board.ts";
import {
	METEORA_SOURCE,
	type MeteoraRefreshConfig,
	runMeteoraRefresh,
} from "../normalize/official-refresh.ts";
import { runRefreshPipeline } from "../normalize/refresh-pipeline.ts";
import {
	enabledVenues,
	productCatalog,
	type RefreshScope,
	resolveRefreshScope,
} from "../shared/catalog.ts";
import { CHAIN_ID_ELYSIUM } from "../shared/constants.ts";
import type {
	ChainRpcSource,
	HealthResponse,
	RefreshRequest,
	RefreshResponse,
	RefreshSuccessResponse,
} from "../shared/types.ts";
import type { UsdQuoteSource } from "../shared/usd-quotes.ts";
import type { AppDatabase } from "../store/db.ts";
import {
	latestPublicationRevision,
	latestRefreshRun,
	latestSuccessfulRefresh,
} from "../store/repositories.ts";
import { type AutoScanConfig, createAutoScanner, scanStorageBlockReason } from "./auto-scan.ts";
import { BoardPageError, createBoardPager } from "./board-pages.ts";
import { parseBoardMetricFilters, parseBoardSelection } from "./board-query.ts";
import { startTokenSupplyTask } from "./token-supply.ts";

export function chainRpcSourcesFor(rpc: ElysiumRpc, robinhoodRpc?: ElysiumRpc): ChainRpcSource[] {
	return [
		{
			chain: "elysium",
			evmChainId: CHAIN_ID_ELYSIUM,
			rpcSource: rpc.source,
		},
		...(robinhoodRpc
			? [{ chain: "robinhood", evmChainId: 4663, rpcSource: robinhoodRpc.source }]
			: []),
	];
}

function queryString(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

export function buildApp(input: {
	db: AppDatabase;
	rpc: ElysiumRpc;
	robinhoodRpc?: ElysiumRpc;
	quoteSource?: UsdQuoteSource;
	solanaDlmm?: MeteoraRefreshConfig;
	autoScan?: AutoScanConfig & { databasePath: string };
}) {
	const app = Fastify({
		logger: { level: "info" },
	});
	app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
		if (!body || body === "") {
			done(null, {});
			return;
		}
		try {
			done(null, JSON.parse(String(body)));
		} catch (error) {
			done(error as Error, undefined);
		}
	});

	const chainRpcSources = chainRpcSourcesFor(input.rpc, input.robinhoodRpc);
	if (input.solanaDlmm)
		chainRpcSources.push({ chain: "solana", evmChainId: null, rpcSource: METEORA_SOURCE });
	const runtimeVenues = { solanaDlmm: Boolean(input.solanaDlmm) };
	const refreshByScope = new Map<string, Promise<RefreshSuccessResponse>>();
	const activeScopes = new Set<string>();
	const targets: { chain: string; rpc?: ElysiumRpc }[] = [
		{ chain: "elysium", rpc: input.rpc },
		...(input.robinhoodRpc ? [{ chain: "robinhood", rpc: input.robinhoodRpc }] : []),
		...(input.solanaDlmm ? [{ chain: "solana" }] : []),
	];
	const pageBoard = createBoardPager();

	async function currentRefreshState() {
		return toBoardRefreshState({
			latest: await latestRefreshRun(input.db),
			lastSuccess: await latestSuccessfulRefresh(input.db),
		});
	}

	function startRefresh(scope: RefreshScope) {
		const scopeKey = `${scope.chain ?? "*"}:${scope.protocol ?? "*"}`;
		const conflicts = [...activeScopes].some((key) => scopesOverlap(key, scopeKey));
		if (conflicts && !refreshByScope.has(scopeKey)) {
			return { conflict: true as const };
		}
		let pending = refreshByScope.get(scopeKey);
		const alreadyRunning = Boolean(pending);
		if (!pending) {
			pending = (async (): Promise<RefreshSuccessResponse> => {
				const started = Date.now();
				const selected = targets.filter(
					(target) =>
						(!scope.chain || target.chain === scope.chain) &&
						(target.chain === "solana"
							? !scope.protocol || scope.protocol === "meteora_dlmm"
							: scope.protocol !== "meteora_dlmm"),
				);
				if (selected.length === 0) throw new Error("该链没有配置运行中的扫描客户端");
				const results = await Promise.allSettled(
					selected.map(async (target) => {
						const key = `${target.chain}:${scope.protocol ?? "*"}`;
						activeScopes.add(key);
						try {
							if (target.chain === "solana")
								return await runMeteoraRefresh({
									db: input.db,
									config: input.solanaDlmm!,
									onTimings: (summary) => app.log.info({ event: "meteora_refresh", ...summary }),
									checkStorage: input.autoScan
										? () => scanStorageBlockReason(input.autoScan!.databasePath, input.autoScan!)
										: undefined,
								});
							return await runRefreshPipeline({
								db: input.db,
								rpc: target.rpc!,
								quoteSource: input.quoteSource,
								scope: { ...scope, chain: target.chain },
								checkStorage: input.autoScan
									? () => scanStorageBlockReason(input.autoScan!.databasePath, input.autoScan!)
									: undefined,
							});
						} finally {
							activeScopes.delete(key);
						}
					}),
				);
				const successful = results.flatMap((result) =>
					result.status === "fulfilled" ? [result.value] : [],
				);
				if (successful.length === 0) throw (results[0] as PromiseRejectedResult).reason;
				const result = successful[0]!;
				const failures = results.flatMap((result, i) =>
					result.status === "rejected"
						? [`${selected[i]!.chain} 刷新失败，保留该链上次成功数据：${errorText(result.reason)}`]
						: [],
				);
				return {
					...result,
					windowsBuilt: successful.reduce((sum, item) => sum + item.windowsBuilt, 0),
					durationMs: Date.now() - started,
					gaps: [...successful.flatMap((item) => item.gaps), ...failures],
					warnings: successful.flatMap((item) => item.warnings),
					rpcSource: input.rpc.source,
					chainRpcSources,
					refresh: await currentRefreshState(),
				};
			})().finally(() => {
				refreshByScope.delete(scopeKey);
			});
			refreshByScope.set(scopeKey, pending);
			void pending.catch((error) => app.log.error(errorText(error)));
		}
		return { conflict: false as const, pending, alreadyRunning };
	}

	const autoScanConfig = input.autoScan;
	const autoScanner = autoScanConfig
		? createAutoScanner({
				enabled: autoScanConfig.enabled,
				allowConcurrentTicks: true,
				isRefreshing: () =>
					targets.every((target) =>
						[...activeScopes].some((key) => scopesOverlap(key, `${target.chain}:*`)),
					),
				checkStorage: () => scanStorageBlockReason(autoScanConfig.databasePath, autoScanConfig),
				async refresh() {
					if (activeScopes.size === 0) {
						const started = startRefresh({ chain: null, protocol: null });
						if (!started.conflict) return (await started.pending).refresh.status;
					}
					const results = await Promise.allSettled(
						targets.flatMap((target) => {
							const key = `${target.chain}:*`;
							if ([...activeScopes].some((active) => scopesOverlap(active, key))) {
								app.log.info({ chain: target.chain }, "automatic scan skipped busy chain");
								return [];
							}
							const started = startRefresh({ chain: target.chain, protocol: null });
							return started.conflict ? [] : [started.pending];
						}),
					);
					return results.some(
						(result) => result.status === "rejected" || result.value.refresh.status !== "ok",
					)
						? "partial"
						: "ok";
				},
				log: (state) => app.log.info({ autoScan: state }, "automatic scan"),
			})
		: undefined;
	let stopTokenSupply: ReturnType<typeof startTokenSupplyTask> | undefined;
	app.addHook("onListen", async () => {
		autoScanner?.start();
		if (!autoScanConfig?.enabled) return;
		stopTokenSupply = startTokenSupplyTask({
			db: input.db,
			chains: targets.flatMap(({ chain, rpc }) => rpc ? [{ chain, client: rpc.client }] : []),
			isScanning: (chain) => [...activeScopes].some((scope) => scopesOverlap(scope, `${chain}:*`)),
			onBatch: (chain, attempted, saved) => app.log.info({ event: "fdv_supply_batch", chain, attempted, saved }),
			onError: (chain, error) => app.log.warn({ event: "fdv_supply_failed", chain, message: errorText(error) }),
		});
	});
	app.addHook("onClose", async () => {
		await Promise.all([autoScanner?.stop(), stopTokenSupply?.()]);
		await Promise.allSettled([...refreshByScope.values()]);
		input.rpc.close?.();
		input.robinhoodRpc?.close?.();
	});

	app.get(
		"/api/v1/health",
		async (): Promise<HealthResponse> => ({
			ok: true,
			service: "lp-atlas",
			phase: "1",
			dataRevision: await latestPublicationRevision(
				input.db,
				chainRpcSources.map((source) => source.chain),
			),
			autoScan: autoScanner?.getState(),
			catalog: productCatalog(runtimeVenues),
			enabledVenues: enabledVenues(runtimeVenues),
			chainRpcSources: await Promise.all(
				chainRpcSources.map(async (source) => ({
					...source,
					refresh: toBoardRefreshState({
						latest: await latestRefreshRun(input.db, source.chain),
						lastSuccess: await latestSuccessfulRefresh(input.db, source.chain),
					}),
				})),
			),
			refresh: await currentRefreshState(),
			time: new Date().toISOString(),
		}),
	);

	for (const apiVersion of [1, 2]) {
		app.get(`/api/v${apiVersion}/board`, async (request, reply) => {
			const query = request.query as Record<string, string | string[] | undefined>;
			if (queryString(query.window) === "7d") {
				void reply.code(400);
				return { ok: false, error: "7d 窗口已停用，请使用 3d。" };
			}
			let selection: ReturnType<typeof parseBoardSelection> &
				ReturnType<typeof parseBoardMetricFilters> = {};
			if (apiVersion === 2) {
				try {
					selection = { ...parseBoardSelection(query), ...parseBoardMetricFilters(query) };
				} catch (error) {
					if (!(error instanceof BoardPageError)) throw error;
					return reply.code(error.statusCode).send({ ok: false, error: error.message });
				}
			}
			const boardQuery = {
				...selection,
				minTvlUsd: queryString(query.minTvlUsd),
				minWindowVolumeUsd: queryString(query.minWindowVolumeUsd),
				chain: queryString(query.chain),
				protocol: queryString(query.protocol),
				feeTierPips: queryString(query.feeTierPips),
				search: queryString(query.search),
				sortField: queryString(query.sortField),
				sortDirection: queryString(query.sortDirection),
				window: queryString(query.window),
			};
			if (query.poolKeys !== undefined && (apiVersion !== 2 || query.snapshotId === undefined)) {
				return reply.code(400).send({ ok: false, error: "候选查询必须提供 v2 查询快照" });
			}
			const read = () =>
				readBoard({
					db: input.db,
					rpcSource: input.rpc.source,
					chainRpcSources,
					query: boardQuery,
					legacyWindowFilter: apiVersion === 1,
				});
			if (
				query.page === undefined &&
				query.pageSize === undefined &&
				query.snapshotId === undefined &&
				selection.includeWindows !== "all"
			) {
				return read();
			}
			const revision = await latestPublicationRevision(
				input.db,
				chainRpcSources.map((source) => source.chain),
			);
			try {
				const board = await pageBoard({
					query: {
						page: queryString(query.page),
						pageSize: queryString(query.pageSize),
						snapshotId: queryString(query.snapshotId),
						poolKeys:
							apiVersion === 2 && query.poolKeys !== undefined
								? Array.isArray(query.poolKeys)
									? query.poolKeys
									: [query.poolKeys]
								: undefined,
					},
					key: JSON.stringify([apiVersion, boardQuery]),
					revision,
					read,
				});
				return board.ok ? { ...board, refresh: await currentRefreshState() } : board;
			} catch (error) {
				if (error instanceof BoardPageError) {
					void reply.code(error.statusCode);
					return { ok: false, error: error.message };
				}
				throw error;
			}
		});
	}

	app.post("/api/v1/refresh", async (request, reply): Promise<RefreshResponse> => {
		const body = (request.body ?? {}) as RefreshRequest;
		const scope = resolveRefreshScope(
			{ chain: body.chain, protocol: body.protocol },
			runtimeVenues,
		);
		if ("error" in scope) {
			void reply.code(400);
			return {
				ok: false,
				error: scope.error,
				rpcSource: input.rpc.source,
				chainRpcSources,
				refresh: await currentRefreshState(),
			};
		}
		const started = startRefresh(scope);
		if (started.conflict) {
			void reply.code(409);
			return {
				ok: false,
				error: "已有重叠范围的刷新在进行中，同一范围同一时间只跑一个刷新。",
				rpcSource: input.rpc.source,
				chainRpcSources,
				refresh: await currentRefreshState(),
			};
		}
		const refresh = await currentRefreshState();
		void reply.code(202);
		return {
			ok: true as const,
			accepted: true as const,
			alreadyRunning: started.alreadyRunning,
			rpcSource: input.rpc.source,
			chainRpcSources,
			refresh:
				refresh.status === "running"
					? refresh
					: {
							...refresh,
							status: "running" as const,
							startedAt: refresh.startedAt ?? new Date().toISOString(),
							error: null,
						},
		};
	});

	return app;
}

function scopesOverlap(left: string, right: string): boolean {
	const [leftChain, leftProtocol] = left.split(":");
	const [rightChain, rightProtocol] = right.split(":");
	const chainOverlap = leftChain === "*" || rightChain === "*" || leftChain === rightChain;
	const protocolOverlap =
		leftProtocol === "*" || rightProtocol === "*" || leftProtocol === rightProtocol;
	return chainOverlap && protocolOverlap;
}
