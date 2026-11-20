import type {
	BoardFilters,
	BoardResponse,
	BoardSort,
	HealthResponse,
	RefreshRequest,
	RefreshResponse,
} from "@lp-atlas/shared";
import { DEFAULT_BOARD_FILTERS, DEFAULT_BOARD_SORT } from "@lp-atlas/shared";

async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) {
		let detail = `${response.status} ${response.statusText}`;
		try {
			const body: unknown = await response.json();
			if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
				detail = body.error;
			}
		} catch {
			// Keep the status text when the body is not JSON.
		}
		throw new Error(detail);
	}
	return (await response.json()) as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
	return readJson<HealthResponse>(await fetch("/api/v1/health"));
}

export async function fetchBoard(input?: {
	filters?: Partial<BoardFilters>;
	sort?: Partial<BoardSort>;
	page?: number;
	pageSize?: number;
	snapshotId?: string;
	includeWindows?: "all";
	poolKeys?: string[];
	signal?: AbortSignal;
}): Promise<BoardResponse> {
	const filters = input?.filters;
	const sort = input?.sort;
	const params = new URLSearchParams({
		minTvlUsd: filters?.minTvlUsd ?? DEFAULT_BOARD_FILTERS.minTvlUsd,
		minWindowVolumeUsd: filters?.minWindowVolumeUsd ?? DEFAULT_BOARD_FILTERS.minWindowVolumeUsd,
		sortField: sort?.field ?? DEFAULT_BOARD_SORT.field,
		sortDirection: sort?.direction ?? DEFAULT_BOARD_SORT.direction,
		window: sort?.window ?? DEFAULT_BOARD_SORT.window,
	});
	if (filters?.hideLpRestrictions) params.set("hideLpRestrictions", "true");
	if (filters?.minLpFees1hUsd !== undefined) params.set("minLpFees1hUsd", filters.minLpFees1hUsd);
	if (filters?.metricConditions?.length)
		params.set("metricConditions", JSON.stringify(filters.metricConditions));
	for (const chain of filters?.chains ?? []) params.append("chains", chain);
	for (const protocol of filters?.protocols ?? []) params.append("protocols", protocol);
	if (input?.includeWindows) params.set("includeWindows", input.includeWindows);
	for (const key of input?.poolKeys ?? []) params.append("poolKeys", key);
	if (filters?.chain) {
		params.set("chain", filters.chain);
	}
	if (filters?.protocol) {
		params.set("protocol", filters.protocol);
	}
	if (filters?.feeTierPips !== null && filters?.feeTierPips !== undefined) {
		params.set("feeTierPips", String(filters.feeTierPips));
	}
	if (filters?.search) {
		params.set("search", filters.search);
	}
	if (input?.page !== undefined) params.set("page", String(input.page));
	if (input?.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
	if (input?.snapshotId) params.set("snapshotId", input.snapshotId);
	return readJson<BoardResponse>(
		await fetch(`/api/v2/board?${params.toString()}`, { signal: input?.signal }),
	);
}

export async function requestRefresh(scope?: RefreshRequest): Promise<RefreshResponse> {
	const response = await fetch("/api/v1/refresh", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(scope ?? {}),
	});
	try {
		const body: unknown = await response.json();
		if (body && typeof body === "object" && "ok" in body) {
			return body as RefreshResponse;
		}
	} catch {
		// Fall through to a generic error when the body is not JSON.
	}
	if (!response.ok) {
		return {
			ok: false,
			error: `${response.status} ${response.statusText}`.trim() || "刷新失败",
		};
	}
	return { ok: false, error: "刷新响应无法解析。" };
}
