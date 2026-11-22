import {
	BOARD_SORT_FIELDS,
	BOARD_WINDOWS,
	type BoardMetricCondition,
	type BoardRefreshState,
	type BoardRow,
	type BoardSuccessResponse,
	conditionToDisplay,
	DEFAULT_BOARD_FILTERS,
	DEFAULT_BOARD_SORT,
	enabledVenues as defaultEnabledVenues,
	feePercentToPips,
	feePipsToInput,
	poolIdentity,
	protocolLabel,
	QUERY_METRICS,
	RPC_SOURCE_PUBLIC_TEMPORARY,
	type SortDirection,
	type SortField,
	type WindowId,
} from "@lp-atlas/shared";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { fetchBoard, fetchHealth, requestRefresh } from "./api.ts";
import { BoardPagination } from "./BoardPagination.tsx";
import { splitGaps } from "./BoardTable.tsx";
import { boardNotices, refreshForSelection, userError } from "./data-notices.ts";
import { EntryPlaceholder } from "./EntryPlaceholder.tsx";
import { formatClock, formatTime } from "./format.ts";
import { draftConditions, filterDraft, QueryFilterDialog } from "./QueryFilterDialog.tsx";
import { PoolMetrics, SixWindowTable, WINDOW_METRICS } from "./SixWindowTable.tsx";

type LoadState =
	| { status: "loading"; board: BoardSuccessResponse | null }
	| { status: "empty"; board: BoardSuccessResponse }
	| { status: "ready"; board: BoardSuccessResponse }
	| { status: "error"; message: string; board: BoardSuccessResponse | null };

type AppliedFilters = {
	hideLpRestrictions: boolean;
	minLpFees1hUsd: string;
	metricConditions: BoardMetricCondition[];
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	chains: string[];
	protocols: string[];
	feeTierPips: string;
	search: string;
};

const INITIAL_FILTERS: AppliedFilters = {
	hideLpRestrictions: false,
	minLpFees1hUsd: DEFAULT_BOARD_FILTERS.minLpFees1hUsd,
	metricConditions: [],
	minTvlUsd: DEFAULT_BOARD_FILTERS.minTvlUsd,
	minWindowVolumeUsd: DEFAULT_BOARD_FILTERS.minWindowVolumeUsd,
	chains: [],
	protocols: [],
	feeTierPips: "",
	search: "",
};

function venueContext(board: BoardSuccessResponse | null): string {
	const venues = board?.enabledVenues ?? defaultEnabledVenues();
	if (venues.length === 0) {
		return "";
	}
	const byChain = new Map<string, string[]>();
	for (const venue of venues) {
		const list = byChain.get(venue.chain) ?? [];
		list.push(protocolLabel(venue.protocol));
		byChain.set(venue.chain, list);
	}
	return [...byChain.entries()]
		.map(([chainId, protocols]) => {
			const chainLabel =
				board?.catalog.chains.find((chain) => chain.id === chainId)?.label ?? chainId;
			return `${chainLabel} · ${protocols.join(" / ")}`;
		})
		.join("；");
}

function discoveredLabel(board: BoardSuccessResponse): string {
	if (board.discoveredPoolCount.length === 0) {
		return "—";
	}
	return board.discoveredPoolCount
		.map((item) => `${protocolLabel(item.protocol)} ${item.count}`)
		.join(" · ");
}

function discoveredTotal(board: BoardSuccessResponse): number {
	return board.discoveredPoolCount.reduce((sum, item) => sum + item.count, 0);
}

function rpcLabel(board: BoardSuccessResponse): string {
	return (
		board.chainRpcSources
			.map(
				(item) =>
					`${board.catalog.chains.find((chain) => chain.id === item.chain)?.label ?? item.chain}：${item.rpcSource.kind === RPC_SOURCE_PUBLIC_TEMPORARY ? "临时公共数据源" : "已配置数据源"}`,
			)
			.join("；") || "链上数据源"
	);
}

function isPublicTemporary(board: BoardSuccessResponse): boolean {
	const chains =
		board.appliedFilters.chains ?? (board.appliedFilters.chain ? [board.appliedFilters.chain] : []);
	return board.chainRpcSources.length
		? board.chainRpcSources.some(
				(item) =>
					(!chains.length || chains.includes(item.chain)) &&
					item.rpcSource.kind === RPC_SOURCE_PUBLIC_TEMPORARY,
			)
		: board.rpcSource.kind === RPC_SOURCE_PUBLIC_TEMPORARY;
}

function StatusStrip(props: {
	board: BoardSuccessResponse | null;
	loading: boolean;
	refreshing: boolean;
}): ReactElement {
	const { board } = props;
	return (
		<section className="status-strip" aria-live="polite">
			<span>
				<span className="status-dot" />{" "}
				{props.loading
					? "正在加载所选网络与条件，表格仍为原快照"
					: props.refreshing
						? "正在扫描，保留上次结果"
						: "已载入快照"}
			</span>
			<span>
				截止{" "}
				<strong>
					{formatTime(
						board
							? refreshForSelection(
									board,
									board.appliedFilters.chains ??
										(board.appliedFilters.chain ? [board.appliedFilters.chain] : []),
								).lastSuccessAt
							: null,
					)}
				</strong>{" "}
				· Asia/Shanghai
			</span>
			<span>
				{board?.appliedFilters.chain === "solana" ||
				(board?.appliedFilters.chains?.length === 1 && board.appliedFilters.chains[0] === "solana")
					? "官方小时档"
					: "自建小时档"}{" "}
				· 已发现 {board ? discoveredTotal(board).toLocaleString() : "—"} 池
			</span>
			{board && !board.currentHourComplete ? <span>当前小时未完成 *</span> : null}
			<span title={board ? rpcLabel(board) : undefined}>
				{board && isPublicTemporary(board) ? "公共 RPC · 临时非生产" : "服务端数据源"}
			</span>
		</section>
	);
}

function windowCoverageNote(board: BoardSuccessResponse | null, windowId: WindowId): string | null {
	if (!board) {
		return null;
	}
	const label = BOARD_WINDOWS.find((item) => item.id === windowId)?.label ?? windowId;
	const { coverage } = splitGaps(board.gaps);
	const parts = [
		`当前窗口是「${label}」`,
		board.windowStart
			? `时间 ${formatClock(board.windowStart)} – ${formatClock(board.windowEnd)}（Asia/Shanghai）`
			: null,
		board.currentHourComplete ? null : "当前小时尚未结束，数字带 * 表示为未完成小时",
		coverage.length ? "部分历史数据不完整，相关指标显示为 —" : null,
	].filter((item): item is string => Boolean(item));
	return `${parts.join("。")}。此窗口用于排序；目录同时展示六窗各自数据，缺档不使用其他窗口填补。`;
}

function readLocation() {
	const params = new URLSearchParams(location.search);
	let metricConditions: BoardMetricCondition[] = [];
	try {
		const parsed = JSON.parse(params.get("metricConditions") ?? "[]");
		if (
			Array.isArray(parsed) &&
			parsed.length <= 8 &&
			parsed.every(
				(c) =>
					c &&
					QUERY_METRICS.some((m) => m.field === c.field) &&
					typeof c.value === "string" &&
					c.value.length <= 80 &&
					/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(c.value) &&
					Number.isFinite(Number(c.value)) &&
					[">", ">=", "<", "<=", "="].includes(c.operator) &&
					(c.field === "tvl" || c.field === "poolAge"
						? c.window === null
						: BOARD_WINDOWS.some((w) => w.id === c.window)),
			) &&
			new Set(parsed.map((c) => c.field)).size === parsed.length
		)
			metricConditions = parsed;
	} catch {
		/* Invalid URL conditions are not used as editable numbers. */
	}
	const filters: AppliedFilters = {
		...INITIAL_FILTERS,
		hideLpRestrictions:
			(params.get("hideLpRestrictions") ?? params.get("hideConfirmedLpRestrictions")) === "true",
		minLpFees1hUsd: params.get("minLpFees1hUsd") ?? INITIAL_FILTERS.minLpFees1hUsd,
		metricConditions,
		minTvlUsd: params.get("minTvlUsd") ?? INITIAL_FILTERS.minTvlUsd,
		minWindowVolumeUsd: params.get("minWindowVolumeUsd") ?? INITIAL_FILTERS.minWindowVolumeUsd,
		chains: (params.has("chains") ? params.getAll("chains") : params.getAll("chain")).slice(-1),
		protocols: params.has("protocols") ? params.getAll("protocols") : params.getAll("protocol"),
		feeTierPips: params.get("feeTierPips") ?? "",
		search: params.get("search") ?? "",
	};
	const windowId =
		BOARD_WINDOWS.find((item) => item.id === params.get("window"))?.id ?? DEFAULT_BOARD_SORT.window;
	const sortField =
		BOARD_SORT_FIELDS.find((item) => item === params.get("sortField")) ?? DEFAULT_BOARD_SORT.field;
	const rawPage = Number(params.get("page") ?? 1);
	return {
		filters,
		windowId,
		sortField,
		sortDirection: params.get("sortDirection") === "asc" ? ("asc" as const) : ("desc" as const),
		page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
		pageSize: [50, 100, 200].find((size) => size === Number(params.get("pageSize"))) ?? 50,
		detail: params.get("pool"),
	};
}

export function BoardPage(): ReactElement {
	const [initial] = useState(readLocation);
	const [filterSettings, setFilterSettings] = useState(() => filterDraft(initial.filters));
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [chains, setChains] = useState<string[]>(initial.filters.chains);
	const [protocols, setProtocols] = useState<string[]>(initial.filters.protocols);
	const [feeInput, setFeeInput] = useState(() => feePipsToInput(initial.filters.feeTierPips));
	const [feeError, setFeeError] = useState("");
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const searchComposing = useRef(false);
	const searchInput = useRef<HTMLInputElement>(null);
	const settingsButton = useRef<HTMLButtonElement>(null);
	const [search, setSearch] = useState<string>(initial.filters.search);
	const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>(initial.filters);
	const [windowId, setWindowId] = useState<WindowId>(initial.windowId);
	const [sortField, setSortField] = useState<SortField>(initial.sortField);
	const [sortDirection, setSortDirection] = useState<SortDirection>(initial.sortDirection);
	const [state, setState] = useState<LoadState>({ status: "loading", board: null });
	const [refreshing, setRefreshing] = useState(false);
	const [healthRefresh, setHealthRefresh] = useState<BoardRefreshState | null>(null);
	const [page, setPage] = useState(initial.page);
	const [pageSize, setPageSize] = useState(initial.pageSize);
	const [selected, setSelected] = useState<string[]>([]);
	const [detail, setDetail] = useState<string | null>(initial.detail);
	const [orderOpen, setOrderOpen] = useState(true);
	const [comparison, setComparison] = useState<BoardSuccessResponse | null>(null);
	const [comparisonError, setComparisonError] = useState("");
	const scrollRef = useRef({ x: 0, y: 0 });
	const [reload, setReload] = useState(0);
	const requestRef = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
	const snapshotRef = useRef<{ key: string; id: string } | null>(null);
	const detailRecoveryRef = useRef<string | null>(null);
	const retryBoardLoad = useCallback(() => {
		snapshotRef.current = null;
		setState((current) => ({ status: "loading", board: current.board }));
		setPage(1);
		setReload((value) => value + 1);
	}, []);

	const boardQuery = useCallback(
		(filters: AppliedFilters, window: WindowId, field: SortField, direction: SortDirection) => {
			return {
				filters: {
					hideLpRestrictions: filters.hideLpRestrictions,
					minTvlUsd: filters.minTvlUsd,
					minLpFees1hUsd: filters.minLpFees1hUsd,
					metricConditions: filters.metricConditions,
					minWindowVolumeUsd: filters.minWindowVolumeUsd,
					chain: null,
					protocol: null,
					chains: filters.chains,
					protocols: filters.protocols,
					feeTierPips: filters.feeTierPips ? Number(filters.feeTierPips) : null,
					search: filters.search || null,
				},
				sort: {
					field,
					direction,
					window,
				},
			};
		},
		[],
	);

	const loadBoard = useCallback(
		async (
			filters: AppliedFilters,
			window: WindowId,
			field: SortField,
			direction: SortDirection,
			options?: { quiet?: boolean; page?: number; pageSize?: number },
		) => {
			requestRef.current.controller?.abort();
			const controller = new AbortController();
			const requestId = ++requestRef.current.id;
			requestRef.current.controller = controller;
			const query = boardQuery(filters, window, field, direction);
			const key = JSON.stringify(query);
			const snapshotId = snapshotRef.current?.key === key ? snapshotRef.current.id : undefined;
			if (!options?.quiet) {
				setState((current) => ({ status: "loading", board: current.board ?? null }));
			}
			try {
				const board = await fetchBoard({
					includeWindows: "all",
					...query,
					page: options?.page ?? 1,
					pageSize: options?.pageSize ?? 50,
					snapshotId,
					signal: controller.signal,
				});
				if (requestId !== requestRef.current.id || controller.signal.aborted) return;
				if (!board.ok) {
					setState((current) => ({
						status: "error",
						message: board.error,
						board: current.board ?? null,
					}));
					return;
				}
				if (board.pagination) snapshotRef.current = { key, id: board.pagination.snapshotId };
				const refresh = refreshForSelection(board, filters.chains);
				setHealthRefresh(refresh);
				if (refresh.status === "running") {
					setRefreshing(true);
				} else {
					setRefreshing(false);
				}
				if (board.rows.length === 0) {
					setState({ status: "empty", board });
					return;
				}
				setState({ status: "ready", board });
			} catch (error) {
				if (requestId !== requestRef.current.id || controller.signal.aborted) return;
				if (snapshotId && error instanceof Error && /快照.*失效/.test(error.message)) {
					retryBoardLoad();
					return;
				}
				setState((current) => ({
					status: "error",
					message: error instanceof Error ? error.message : "看板加载失败",
					board: current.board ?? null,
				}));
			}
		},
		[boardQuery, retryBoardLoad],
	);

	useEffect(() => {
		void reload;
		void loadBoard(appliedFilters, windowId, sortField, sortDirection, { page, pageSize });
		return () => requestRef.current.controller?.abort();
	}, [appliedFilters, windowId, sortField, sortDirection, page, pageSize, reload, loadBoard]);

	useEffect(() => {
		let cancelled = false;
		let timer: number;
		async function poll() {
			try {
				const health = await fetchHealth();
				if (cancelled) return;
				const refresh = refreshForSelection(health, appliedFilters.chains);
				setRefreshing(refresh.status === "running");
				setHealthRefresh(refresh);
				const newer =
					health.dataRevision !== undefined && state.board?.dataRevision !== undefined
						? health.dataRevision !== state.board.dataRevision
						: health.refresh.lastSuccessAt !== null &&
							Date.parse(health.refresh.lastSuccessAt) !== Date.parse(state.board?.asOf ?? "");
				if (newer) {
					snapshotRef.current = null;
					setPage(1);
					setReload((value) => value + 1);
				}
			} catch {
				// A failed status probe must not replace the loaded table or hide a data-query error.
			} finally {
				if (!cancelled) timer = window.setTimeout(() => void poll(), 5000);
			}
		}
		timer = window.setTimeout(() => void poll(), 5000);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [state.board?.asOf, state.board?.dataRevision, appliedFilters.chains]);

	async function onRefresh(): Promise<void> {
		setRefreshing(true);
		try {
			const result = await requestRefresh();
			if (!result.ok) {
				setRefreshing(false);
				setState((current) => ({
					status: "error",
					message: result.error,
					board: current.board ?? null,
				}));
				return;
			}
		} catch (error) {
			setRefreshing(false);
			setState((current) => ({
				status: "error",
				message: error instanceof Error ? error.message : "刷新失败。",
				board: current.board ?? null,
			}));
		}
	}

	function onApply(): void {
		const metricConditions = draftConditions(filterSettings);
		setFilterSettings(filterDraft({ ...filterSettings, metricConditions }));
		setPage(1);
		setAppliedFilters((current) => ({
			...current,
			minTvlUsd: filterSettings.minTvlUsd,
			minWindowVolumeUsd: filterSettings.minWindowVolumeUsd,
			minLpFees1hUsd: filterSettings.minLpFees1hUsd,
			hideLpRestrictions: filterSettings.hideLpRestrictions,
			metricConditions,
		}));
		closeSettings();
	}
	function closeSettings(): void {
		setSettingsOpen(false);
		settingsButton.current?.focus();
	}
	function onChainChange(nextChains: string[]): void {
		setChains(nextChains);
		setPage(1);
		setAppliedFilters((current) => ({ ...current, chains: nextChains }));
	}
	function commitSearch(value: string): void {
		if (searchTimer.current) clearTimeout(searchTimer.current);
		searchTimer.current = null;
		setPage(1);
		setAppliedFilters((current) => ({ ...current, search: value.trim() }));
	}
	function changeSearch(value: string): void {
		setSearch(value);
		if (searchTimer.current) clearTimeout(searchTimer.current);
		if (searchComposing.current) return;
		if (!value.trim()) commitSearch("");
		else searchTimer.current = setTimeout(() => commitSearch(value), 250);
	}
	function clearSearch(): void {
		setSearch("");
		commitSearch("");
		searchInput.current?.focus();
	}
	function changeFee(value: string): void {
		setFeeInput(value);
		try {
			const pips = feePercentToPips(value);
			setFeeError("");
			setPage(1);
			setAppliedFilters((current) => ({ ...current, feeTierPips: pips }));
		} catch (error) {
			setFeeError(error instanceof Error ? error.message : "费率格式无效");
		}
	}
	useEffect(
		() => () => {
			if (searchTimer.current) clearTimeout(searchTimer.current);
		},
		[],
	);

	const onSort = useCallback(
		(field: SortField): void => {
			setPage(1);
			if (field === sortField) {
				setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
				return;
			}
			setSortField(field);
			setSortDirection("desc");
		},
		[sortField],
	);

	const onSelectPool = useCallback((row: BoardRow) => {
		const key = poolIdentity(row);
		setSelected((current) =>
			current.includes(key)
				? current.filter((item) => item !== key)
				: current.length < 5
					? [...current, key]
					: current,
		);
	}, []);
	const onPoolDetail = useCallback((row: BoardRow) => {
		scrollRef.current = { x: window.scrollX, y: window.scrollY };
		const key = poolIdentity(row);
		const url = new URL(location.href);
		url.searchParams.set("pool", key);
		history.pushState(null, "", url);
		setDetail(key);
		setOrderOpen(true);
		requestAnimationFrame(() =>
			document.querySelector(".order-column")?.scrollIntoView({ block: "nearest" }),
		);
	}, []);
	const onTableSort = useCallback(
		(field: SortField, window?: WindowId) => {
			if (window) {
				setPage(1);
				if (window !== windowId) setWindowId(window);
				else setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
			} else onSort(field);
		},
		[windowId, onSort],
	);

	const board = state.board;
	const loading = state.status === "loading";
	const loadedChains =
		board?.appliedFilters.chains ??
		(board?.appliedFilters.chain ? [board.appliedFilters.chain] : []);
	const switchingChain =
		state.status !== "error" &&
		board !== null &&
		JSON.stringify(loadedChains) !== JSON.stringify(appliedFilters.chains);
	const showPublicRpcWarning = board ? isPublicTemporary(board) : false;
	const catalog = board?.catalog;

	useEffect(() => {
		const params = new URLSearchParams();
		for (const chain of appliedFilters.chains) params.append("chains", chain);
		for (const protocol of appliedFilters.protocols) params.append("protocols", protocol);
		params.set("minTvlUsd", appliedFilters.minTvlUsd);
		params.set("minWindowVolumeUsd", appliedFilters.minWindowVolumeUsd);
		params.set("minLpFees1hUsd", appliedFilters.minLpFees1hUsd);
		if (appliedFilters.metricConditions.length)
			params.set("metricConditions", JSON.stringify(appliedFilters.metricConditions));
		if (appliedFilters.hideLpRestrictions) params.set("hideLpRestrictions", "true");
		if (appliedFilters.feeTierPips) params.set("feeTierPips", appliedFilters.feeTierPips);
		if (appliedFilters.search) params.set("search", appliedFilters.search);
		params.set("window", windowId);
		params.set("sortField", sortField);
		params.set("sortDirection", sortDirection);
		params.set("page", String(page));
		params.set("pageSize", String(pageSize));
		if (detail) params.set("pool", detail);
		history.replaceState(null, "", `${location.pathname}?${params}`);
	}, [appliedFilters, windowId, sortField, sortDirection, page, pageSize, detail]);

	useEffect(() => {
		const restore = () => {
			const next = readLocation();
			setAppliedFilters(next.filters);
			setChains(next.filters.chains);
			setProtocols(next.filters.protocols);
			setSearch(next.filters.search);
			setFeeInput(feePipsToInput(next.filters.feeTierPips));
			setFeeError("");
			if (searchTimer.current) clearTimeout(searchTimer.current);
			setFilterSettings(filterDraft(next.filters));
			setWindowId(next.windowId);
			setSortField(next.sortField);
			setSortDirection(next.sortDirection);
			setPage(next.page);
			setPageSize(next.pageSize);
			setDetail(next.detail);
			if (next.detail) setOrderOpen(true);
		};
		window.addEventListener("popstate", restore);
		return () => window.removeEventListener("popstate", restore);
	}, []);

	useEffect(() => {
		const snapshot = state.board?.pagination?.snapshotId;
		const keys = detail ? [detail] : selected;
		setComparison(null);
		setComparisonError("");
		if (!snapshot || !keys.length || state.status === "loading") return;
		const controller = new AbortController();
		const recoveryKey = JSON.stringify([
			keys,
			boardQuery(appliedFilters, windowId, sortField, sortDirection),
		]);
		void fetchBoard({
			...boardQuery(appliedFilters, windowId, sortField, sortDirection),
			includeWindows: "all",
			snapshotId: snapshot,
			poolKeys: keys,
			signal: controller.signal,
		})
			.then((result) => {
				if (controller.signal.aborted) return;
				if (!result.ok) throw new Error(result.error);
				detailRecoveryRef.current = null;
				setComparison(result);
			})
			.catch((error) => {
				if (controller.signal.aborted) return;
				if (
					error instanceof Error &&
					/快照.*失效/.test(error.message) &&
					detailRecoveryRef.current !== recoveryKey
				) {
					detailRecoveryRef.current = recoveryKey;
					retryBoardLoad();
					return;
				}
				setComparisonError(error instanceof Error ? error.message : "对照读取失败");
			});
		return () => controller.abort();
	}, [
		state.board?.pagination?.snapshotId,
		state.status,
		selected,
		detail,
		appliedFilters,
		windowId,
		sortField,
		sortDirection,
		boardQuery,
		retryBoardLoad,
	]);

	const filtersDirty =
		JSON.stringify(filterSettings) !== JSON.stringify(filterDraft(appliedFilters));
	const coverageNote = windowCoverageNote(board, board?.sort.window ?? windowId);
	const refreshInFlight = refreshing;
	const currentRefresh = healthRefresh ?? board?.refresh;
	function changePage(next: number) {
		setPage(next);
		document.querySelector(".board-body")?.scrollIntoView({ block: "start" });
	}
	const pagination = board ? (
		<BoardPagination
			admissionSummary={`准入 TVL ≥ $${appliedFilters.minTvlUsd} · 1H 成交 ≥ $${appliedFilters.minWindowVolumeUsd}${appliedFilters.chains.length === 1 && appliedFilters.chains[0] === "solana" ? " · 官方候选" : ` · EVM 1H LP费 ≥ $${appliedFilters.minLpFees1hUsd}`}`}
			board={board}
			disabled={loading}
			onPage={changePage}
			onPageSize={(size) => {
				setPageSize(size);
				setPage(1);
			}}
		/>
	) : null;

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand-block">
					<p className="brand">
						<span className="brand-mark" aria-hidden="true">
							A↗
						</span>
						LP ATLAS
					</p>
					<span className="nav-active">多链扫描</span>
					<button type="button" disabled title="尚未开发">
						我的仓位 · 待开发
					</button>
				</div>
				<button type="button" className="btn" disabled>
					连接钱包 · 待开发
				</button>
			</header>

			{loading || refreshInFlight ? (
				<div className="progress-rail" aria-hidden="true">
					<span />
				</div>
			) : (
				<div className="progress-rail progress-rail-idle" aria-hidden="true" />
			)}

			<main>
				<div className={`workspace-desk ${orderOpen ? "" : "order-collapsed"}`}>
					<section className="scanner">
						<div className="scanner-heading query-topline">
							<div className="section-label">
								<h1>流动性市场</h1>
								<span className="count-pill">
									{board?.pagination?.total ?? board?.rows.length ?? "—"} 个达标池
								</span>
							</div>
							<fieldset className="chain-bar" aria-label="链筛选">
								<button
									type="button"
									className={`chain-chip ${chains.length ? "" : "selected"}`}
									aria-pressed={!chains.length}
									onClick={() => onChainChange([])}
								>
									全部网络
								</button>
								{catalog?.chains.map((item) => (
									<button
										key={item.id}
										type="button"
										aria-pressed={chains.includes(item.id)}
										className={`chain-chip ${chains.includes(item.id) ? "selected" : ""}`}
										onClick={() => onChainChange([item.id])}
									>
										{item.label}
										{board?.enabledVenues.some((venue) => venue.chain === item.id) ? (
											""
										) : (
											<span>未接通</span>
										)}
									</button>
								))}
							</fieldset>
							<div className="scanner-actions">
								{!orderOpen ? (
									<button type="button" className="btn" onClick={() => setOrderOpen(true)}>
										展开开仓区
									</button>
								) : null}
								<button
									type="button"
									className="btn"
									onClick={() => void onRefresh()}
									disabled={refreshInFlight}
								>
									{refreshInFlight ? "正在刷新…" : "↻ 刷新"}
								</button>
							</div>
						</div>
						<div className="query-toolbar">
							<div className="query-search">
								<span aria-hidden="true">⌕</span>
								<input
									ref={searchInput}
									aria-label="搜索交易对或代币"
									placeholder="代币、交易对或合约"
									autoComplete="off"
									spellCheck={false}
									value={search}
									onChange={(e) => changeSearch(e.target.value)}
									onCompositionStart={() => {
										searchComposing.current = true;
										if (searchTimer.current) clearTimeout(searchTimer.current);
									}}
									onCompositionEnd={(e) => {
										searchComposing.current = false;
										changeSearch(e.currentTarget.value);
									}}
									onKeyDown={(e) => {
										if (e.nativeEvent.isComposing) return;
										if (e.key === "Enter") {
											e.preventDefault();
											commitSearch(search);
										}
										if (e.key === "Escape") {
											e.preventDefault();
											clearSearch();
										}
									}}
								/>
								{search ? (
									<button type="button" aria-label="清空搜索" onClick={clearSearch}>
										×
									</button>
								) : null}
							</div>
							<details className="filter-options">
								<summary>
									协议：
									{protocols.length ? protocols.map(protocolLabel).join(" / ") : "全部已启用"}
								</summary>
								<div className="protocol-menu">
									{catalog?.protocols.map((item) => (
										<label key={item.id}>
											<input
												type="checkbox"
												checked={protocols.includes(item.id)}
												onChange={(event) => {
													const next = event.target.checked
														? [...protocols, item.id].sort()
														: protocols.filter((id) => id !== item.id);
													setProtocols(next);
													setPage(1);
													setAppliedFilters((current) => ({ ...current, protocols: next }));
												}}
											/>
											{item.label}
										</label>
									))}
								</div>
							</details>
							<label className="query-fee">
								池子费率
								<input
									aria-label="池子费率百分比"
									inputMode="decimal"
									autoComplete="off"
									value={feeInput}
									onChange={(e) => changeFee(e.target.value)}
									placeholder={Number(appliedFilters.feeTierPips) === 8388608 ? "动态" : "全部"}
									aria-invalid={Boolean(feeError)}
								/>
								<span>%</span>
							</label>
							<section className="sort-toolbar" aria-label="排序设置">
								<label>
									排序指标{" "}
									<select
										value={sortField}
										onChange={(event) => {
											setPage(1);
											setSortField(event.target.value as SortField);
										}}
									>
										{WINDOW_METRICS.map((metric) => (
											<option key={metric.sort} value={metric.sort}>
												{metric.label}
											</option>
										))}
										<option value="tvl">TVL</option>
										<option value="poolAge">池龄</option>
									</select>
								</label>
								<label>
									排序窗口{" "}
									<select
										disabled={sortField === "tvl" || sortField === "poolAge"}
										value={windowId}
										onChange={(event) => {
											setPage(1);
											setWindowId(event.target.value as WindowId);
										}}
									>
										{BOARD_WINDOWS.map((window) => (
											<option key={window.id} value={window.id}>
												{window.label}
											</option>
										))}
									</select>
								</label>
								<label>
									方向{" "}
									<select
										value={sortDirection}
										onChange={(event) => {
											setPage(1);
											setSortDirection(event.target.value as SortDirection);
										}}
									>
										<option value="desc">降序 ↓</option>
										<option value="asc">升序 ↑</option>
									</select>
								</label>
							</section>
							<button
								type="button"
								ref={settingsButton}
								className="btn query-funnel"
								aria-haspopup="dialog"
								aria-expanded={settingsOpen}
								onClick={() => setSettingsOpen(true)}
							>
								▽ 筛选条件{" "}
								<b>
									{appliedFilters.metricConditions.length +
										Number(appliedFilters.hideLpRestrictions)}
								</b>
								{filtersDirty ? (
									<span className="query-draft-dot" role="img" aria-label="有未应用的修改">
										•
									</span>
								) : null}
							</button>
						</div>
						{appliedFilters.metricConditions.length ? (
							<div className="query-chips">
								{appliedFilters.metricConditions.map((c) => {
									const metric = QUERY_METRICS.find((m) => m.field === c.field)!;
									return (
										<span key={c.field}>
											{c.window ? BOARD_WINDOWS.find((w) => w.id === c.window)?.label : ""}{" "}
											{metric.label} {c.operator} {conditionToDisplay(c)}
											{metric.unit}
											<button
												type="button"
												aria-label={`移除${metric.label}条件`}
												onClick={() => {
													const next = {
														...appliedFilters,
														metricConditions: appliedFilters.metricConditions.filter(
															(item) => item.field !== c.field,
														),
													};
													setAppliedFilters(next);
													setPage(1);
													if (!filtersDirty) setFilterSettings(filterDraft(next));
												}}
											>
												×
											</button>
										</span>
									);
								})}
							</div>
						) : null}
						<QueryFilterDialog
							open={settingsOpen}
							draft={filterSettings}
							dirty={filtersDirty}
							onChange={setFilterSettings}
							onClose={closeSettings}
							onApply={onApply}
						/>
						<div
							className={`board-body ${switchingChain ? "board-body-switching" : ""}`}
							aria-busy={loading}
							inert={switchingChain}
						>
							{state.status === "loading" && !board ? (
								<>
									<div className="loading-skeleton" aria-hidden="true" />
								</>
							) : null}

							{state.status === "error" && !board ? (
								<div className="state-panel state-error" role="alert">
									<p className="state-title">加载失败</p>
									<p className="state-message">{userError(state.message)}</p>
									<p className="state-note">没有上次成功结果可以展示。</p>
								</div>
							) : null}
							{board && board.rows.length === 0 && state.status !== "loading" ? (
								<div className="state-panel">
									<p className="state-title">没有可展示的池</p>
									<p className="state-message">
										{!board.enabledVenues.some(
											(venue) =>
												(!appliedFilters.chains.length ||
													appliedFilters.chains.includes(venue.chain)) &&
												(!appliedFilters.protocols.length ||
													appliedFilters.protocols.includes(venue.protocol)),
										)
											? "所选链 / 协议尚未接通采集，可在下方接入状态中查看。"
											: (boardNotices(board)[0] ??
												"当前筛选下没有可展示的池。若尚未刷新，请先点击「刷新」。若已刷新，可能是1H 成交量、LP 手续费或 TVL 未达到门槛，或 1H 数据尚有缺口。")}
									</p>
									{discoveredTotal(board) > 0 ? (
										<p className="state-note">
											已发现 {discoveredLabel(board)}；过滤前有窗口的行 {board.rowCountBeforeFilter}{" "}
											条。
										</p>
									) : null}
								</div>
							) : null}
							{pagination}
							{board && board.rows.length > 0 ? (
								<SixWindowTable
									board={board}
									selected={selected}
									onSelect={onSelectPool}
									onDetail={onPoolDetail}
									onSort={onTableSort}
								/>
							) : null}
							{pagination}
						</div>
						{selected.length && !detail ? (
							<section className="comparison-panel" aria-label="候选池对照">
								<h2>{`候选池对照 ${selected.length}/5`}</h2>
								<button type="button" onClick={() => setSelected([])}>
									清空对照
								</button>
								{comparisonError ? (
									<p role="alert">
										{userError(comparisonError)}{" "}
										<button type="button" onClick={retryBoardLoad}>
											重试加载
										</button>
									</p>
								) : null}
								{!comparison && !comparisonError ? <p>正在读取当前快照…</p> : null}
								{comparison
									? selected.map((key) => {
											const row = comparison.rows.find((item) => poolIdentity(item) === key);
											return row ? (
												<PoolMetrics key={key} row={row} board={comparison} />
											) : (
												<p key={key}>该池不在当前结果内或不可读取：{key}</p>
											);
										})
									: null}
							</section>
						) : null}
						{state.status === "error" || currentRefresh?.status === "error" ? (
							<div className="rpc-banner rpc-banner-error" role="alert">
								<span className="rpc-banner-label">
									{state.status === "error" ? "查询失败" : "刷新失败"}
								</span>
								<p>
									{userError(
										state.status === "error"
											? state.message
											: (currentRefresh?.error ?? "刷新失败"),
									)}
									{board?.asOf
										? ` 当前保留表格的数据截止 ${formatTime(board.asOf)}，未替换为本次新结果。`
										: " 没有可展示的上次成功结果。"}
								</p>
							</div>
						) : null}

						{state.status === "error" ? (
							<div className="query-retry">
								<span>可重新载入当前条件。</span>
								<button type="button" className="btn btn-secondary" onClick={retryBoardLoad}>
									重试加载
								</button>
							</div>
						) : null}

						{feeError ? (
							<p className="query-error" role="alert">
								{feeError}；列表保留上次有效费率条件。
							</p>
						) : null}
						<StatusStrip board={board} loading={loading} refreshing={refreshInFlight} />

						{showPublicRpcWarning && board ? (
							<div className="rpc-banner" role="status">
								<span className="rpc-banner-label">公共 RPC</span>
								<p>部分网络使用临时公共数据源，历史数据可能受限，详见下方数据说明。</p>
							</div>
						) : null}

						{refreshInFlight ? (
							<div className="rpc-banner" role="status">
								<span className="rpc-banner-label">刷新中</span>
								<p>
									{`正在由服务端扫描${currentRefresh?.startedAt ? `（开始于 ${formatTime(currentRefresh.startedAt)}）` : ""}。上方保留已载入结果，数据截止 ${board?.asOf ? formatTime(board.asOf) : "无"}。`}
								</p>
							</div>
						) : null}
						<p className="method-note">{venueContext(board)}</p>
						<details className="method-note">
							<summary>窗口与数据口径</summary>
							{coverageNote ? <p>{coverageNote}</p> : null}
							{board ? boardNotices(board).map((notice) => <p key={notice}>{notice}</p>) : null}
						</details>
						{board ? (
							<details className="venue-status">
								<summary>链 / 协议接入状态与来源</summary>
								{board.catalog.venues.map((venue) => {
									const source = board.chainRpcSources.find((item) => item.chain === venue.chain);
									const cutoff =
										source?.refresh === undefined ? board.asOf : source.refresh.lastSuccessAt;
									return (
										<p key={`${venue.chain}-${venue.protocol}`}>
											{venue.label} · {venue.status === "enabled" ? "已接通" : "未接通"}
											{venue.status === "enabled"
												? ` · ${source?.rpcSource.kind === RPC_SOURCE_PUBLIC_TEMPORARY ? "临时公共数据源" : "已配置数据源"} · 截止 ${formatTime(cutoff)}`
												: ""}
										</p>
									);
								})}
							</details>
						) : null}
					</section>
					{orderOpen ? (
						<EntryPlaceholder
							onRetry={retryBoardLoad}
							row={
								detail
									? (comparison?.rows.find((row) => poolIdentity(row) === detail) ?? null)
									: null
							}
							board={comparison}
							loading={Boolean(detail && !comparison && !comparisonError)}
							error={
								detail
									? comparisonError ||
										(comparison && !comparison.rows.some((row) => poolIdentity(row) === detail)
											? "该池不在当前筛选结果内，或不可读取。"
											: "")
									: ""
							}
							hasSelection={Boolean(detail)}
							onBack={() => {
								setDetail(null);
								requestAnimationFrame(() =>
									window.scrollTo(scrollRef.current.x, scrollRef.current.y),
								);
							}}
							onClose={() => setOrderOpen(false)}
						/>
					) : null}
				</div>
				<footer className="workspace-footer">
					LP ATLAS / 多链流动性数据工作台 · Asia/Shanghai
				</footer>
			</main>
		</div>
	);
}
