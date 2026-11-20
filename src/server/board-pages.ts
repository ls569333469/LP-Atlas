import { randomUUID } from "node:crypto";
import { poolIdentity } from "../shared/pool-identity.ts";
import type {
	BoardResponse,
	BoardRow,
	BoardSuccessResponse,
	MetricValue,
} from "../shared/types.ts";

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 10;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export class BoardPageError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
	}
}

export type BoardPageQuery = {
	page?: string;
	pageSize?: string;
	snapshotId?: string;
	poolKeys?: string[];
};

type Snapshot = {
	id: string;
	key: string;
	revision: string;
	expiresAt: number;
	bytes: number;
	board: BoardSuccessResponse;
	packed?: { rows: string[]; keys: string[]; metadata: Omit<MetricValue, "value">[] };
};

const METRIC_KEYS = new Set([
	"tvlUsd",
	"volumeUsd",
	"feesUsd",
	"feesApr",
	"changeVsPrevWindow",
	"priceChange",
	"capitalEfficiency",
	"poolAgeSeconds",
]);

/** Freeze repeated metric metadata once; only materialize requested page values. */
function packRows(rows: BoardRow[]) {
	const metadata: Omit<MetricValue, "value">[] = [];
	const indexes = new Map<string, number>();
	const packed = rows.map((row) =>
		JSON.stringify(row, (key, value: unknown) => {
			if (!METRIC_KEYS.has(key) || !value || typeof value !== "object" || !("value" in value))
				return value;
			const metric = value as MetricValue;
			const { value: amount, ...meta } = metric;
			const signature = JSON.stringify(meta);
			let index = indexes.get(signature);
			if (index === undefined) {
				index = metadata.length;
				indexes.set(signature, index);
				metadata.push(meta);
			}
			return [amount, index];
		}),
	);
	return { rows: packed, keys: rows.map(poolIdentity), metadata };
}

function snapshotRows(snapshot: Snapshot, start: number, end: number): BoardRow[] {
	if (!snapshot.packed) return snapshot.board.rows.slice(start, end);
	const { metadata } = snapshot.packed;
	return snapshot.packed.rows.slice(start, end).map(
		(row) =>
			JSON.parse(row, (key, value: unknown) => {
				if (METRIC_KEYS.has(key) && Array.isArray(value))
					return { ...metadata[value[1] as number], value: value[0] };
				return value;
			}) as BoardRow,
	);
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new BoardPageError(400, "页码和每页数量必须为正整数");
	}
	return Number(value);
}

/** Freeze query results for bounded, repeatable paging without copying the database. */
export function createBoardPager() {
	const snapshots = new Map<string, Snapshot>();
	const pending = new Map<string, Promise<BoardResponse>>();
	let totalBytes = 0;

	function remove(id: string) {
		const snapshot = snapshots.get(id);
		if (snapshot) {
			totalBytes -= snapshot.bytes;
			snapshots.delete(id);
		}
	}

	return async (input: {
		query: BoardPageQuery;
		key: string;
		revision: string;
		read(): Promise<BoardResponse>;
	}): Promise<BoardResponse> => {
		const page = positiveInteger(input.query.page, 1);
		const pageSize = positiveInteger(input.query.pageSize, 50);
		if (![50, 100, 200].includes(pageSize)) {
			throw new BoardPageError(400, "每页数量只能为 50、100 或 200");
		}
		for (const [id, snapshot] of snapshots) {
			if (snapshot.expiresAt <= Date.now()) {
				remove(id);
			}
		}
		let snapshot = input.query.snapshotId ? snapshots.get(input.query.snapshotId) : undefined;
		if (input.query.snapshotId && (!snapshot || snapshot.key !== input.key)) {
			throw new BoardPageError(409, "查询快照已失效或条件已变化，请重试加载，页面将返回首页");
		}
		if (!snapshot) {
			snapshot = [...snapshots.values()].find(
				(item) => item.key === input.key && item.revision === input.revision,
			);
		}
		if (!snapshot) {
			const cacheKey = JSON.stringify([input.key, input.revision]);
			let reading = pending.get(cacheKey);
			if (!reading) {
				reading = input.read().finally(() => pending.delete(cacheKey));
				pending.set(cacheKey, reading);
			}
			const result = await reading;
			if (!result.ok) {
				return result;
			}
			// Concurrent identical reads may have published this snapshot while awaiting.
			snapshot = [...snapshots.values()].find(
				(item) =>
					item.key === input.key && item.revision === (result.dataRevision ?? input.revision),
			);
			if (!snapshot) {
				const packed = result.includeWindows === "all" ? packRows(result.rows) : undefined;
				const frozen = packed ? { ...result, rows: [] } : result;
				const bytes =
					Buffer.byteLength(JSON.stringify(frozen)) +
					(packed
						? packed.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0) +
							Buffer.byteLength(JSON.stringify(packed.keys)) +
							Buffer.byteLength(JSON.stringify(packed.metadata))
						: 0);
				if (bytes > MAX_SNAPSHOT_BYTES) {
					throw new BoardPageError(503, "查询结果超过快照容量，请缩小筛选范围");
				}
				while (snapshots.size >= MAX_SNAPSHOTS || totalBytes + bytes > MAX_SNAPSHOT_BYTES) {
					const oldest = snapshots.keys().next().value;
					if (oldest === undefined) {
						break;
					}
					remove(oldest);
				}
				snapshot = {
					id: randomUUID(),
					key: input.key,
					revision: result.dataRevision ?? input.revision,
					expiresAt: Date.now() + SNAPSHOT_TTL_MS,
					bytes,
					board: structuredClone(frozen),
					packed,
				};
				snapshots.set(snapshot.id, snapshot);
				totalBytes += bytes;
			}
		}
		if (input.query.poolKeys) {
			if (
				!input.query.snapshotId ||
				input.query.poolKeys.length > 5 ||
				!input.query.poolKeys.length
			) {
				throw new BoardPageError(400, "候选查询需提供快照及 1–5 个池标识");
			}
			const keys = new Set(input.query.poolKeys);
			return {
				...snapshot.board,
				rows: snapshot.packed
					? snapshot.packed.keys.flatMap((key, index) =>
							keys.has(key) ? snapshotRows(snapshot, index, index + 1) : [],
						)
					: snapshot.board.rows.filter((row) => keys.has(poolIdentity(row))),
			};
		}
		const total = snapshot.packed?.rows.length ?? snapshot.board.rows.length;
		const totalPages = Math.ceil(total / pageSize);
		if (page > Math.max(1, totalPages)) {
			throw new BoardPageError(400, "页码超出当前结果范围");
		}
		const offset = (page - 1) * pageSize;
		return {
			...snapshot.board,
			rows: snapshotRows(snapshot, offset, offset + pageSize),
			pagination: {
				page,
				pageSize,
				total,
				totalPages,
				from: total === 0 ? 0 : offset + 1,
				to: Math.min(offset + pageSize, total),
				snapshotId: snapshot.id,
			},
		};
	};
}
