import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import { errorText } from "../adapters/errors.ts";
import type { AutoScanState, RefreshStatus } from "../shared/types.ts";

export const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export type AutoScanConfig = {
	enabled: boolean;
	maxDatabaseBytes: number;
	minFreeDiskBytes: number;
};

async function fileBytes(file: string): Promise<number> {
	try {
		return (await stat(file)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return 0;
		}
		throw error;
	}
}

export async function scanStorageBlockReason(
	databasePath: string,
	config: AutoScanConfig,
): Promise<string | null> {
	const sizes = await Promise.all(
		[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(fileBytes),
	);
	const databaseBytes = sizes.reduce((sum, size) => sum + size, 0);
	if (databaseBytes >= config.maxDatabaseBytes) {
		return `数据库及旁文件 ${databaseBytes} 字节已达到扫描准入上限 ${config.maxDatabaseBytes} 字节`;
	}
	const disk = await statfs(path.dirname(databasePath));
	const availableBytes = disk.bavail * disk.bsize;
	if (availableBytes < config.minFreeDiskBytes) {
		return `磁盘可用 ${availableBytes} 字节，低于扫描预留 ${config.minFreeDiskBytes} 字节`;
	}
	return null;
}

export function createAutoScanner(input: {
	enabled: boolean;
	allowConcurrentTicks?: boolean;
	isRefreshing(): boolean;
	checkStorage(): Promise<string | null>;
	refresh(): Promise<RefreshStatus>;
	log(state: AutoScanState): void;
}) {
	const state: AutoScanState = {
		enabled: input.enabled,
		intervalMs: AUTO_SCAN_INTERVAL_MS,
		nextRunAt: null,
		lastAttemptAt: null,
		lastFinishedAt: null,
		status: "idle",
		message: null,
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	const inFlight = new Set<Promise<void>>();
	let stopped = false;

	function tick(): void {
		if (stopped || (!input.allowConcurrentTicks && inFlight.size > 0)) {
			return;
		}
		state.lastAttemptAt = new Date().toISOString();
		state.lastFinishedAt = null;
		state.message = null;
		const pending = Promise.resolve().then(async () => {
			try {
				// Check again after storage I/O: a manual refresh can start while it is pending.
				const blocked = input.isRefreshing()
					? "已有刷新进行中，本次定时扫描跳过"
					: await input.checkStorage();
				if (stopped) {
					return;
				}
				if (blocked || input.isRefreshing()) {
					state.status = "skipped";
					state.message = blocked ?? "已有刷新进行中，本次定时扫描跳过";
					return;
				}
				state.status = "running";
				input.log({ ...state });
				state.status = await input.refresh();
			} catch (error) {
				state.status = "error";
				state.message = errorText(error);
			} finally {
				state.lastFinishedAt = new Date().toISOString();
				inFlight.delete(pending);
				if (inFlight.size > 0) {
					state.status = "running";
					state.lastFinishedAt = null;
				}
				input.log({ ...state });
			}
		});
		inFlight.add(pending);
	}

	return {
		getState: (): AutoScanState => ({ ...state }),
		start() {
			if (!input.enabled || stopped || timer) {
				return;
			}
			state.nextRunAt = new Date(Date.now() + AUTO_SCAN_INTERVAL_MS).toISOString();
			timer = setInterval(() => {
				state.nextRunAt = new Date(Date.now() + AUTO_SCAN_INTERVAL_MS).toISOString();
				tick();
			}, AUTO_SCAN_INTERVAL_MS);
			timer.unref();
			tick();
		},
		async stop() {
			stopped = true;
			state.enabled = false;
			state.nextRunAt = null;
			clearInterval(timer);
			await Promise.allSettled([...inFlight]);
		},
	};
}
