import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTO_SCAN_INTERVAL_MS,
	createAutoScanner,
	scanStorageBlockReason,
} from "../src/server/auto-scan.ts";
import { loadServerEnv } from "../src/server/env.ts";
import type { RefreshStatus } from "../src/shared/types.ts";

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

function scannerInput() {
	return {
		enabled: true,
		isRefreshing: vi.fn(() => false),
		checkStorage: vi.fn(async (): Promise<string | null> => null),
		refresh: vi.fn(async (): Promise<RefreshStatus> => "partial"),
		log: vi.fn(),
	};
}

describe("automatic scan scheduling", () => {
	it("scans at startup and every 5 minutes, does not duplicate start, and stops cleanly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
		const input = scannerInput();
		const scanner = createAutoScanner(input);
		scanner.start();
		scanner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(input.refresh).toHaveBeenCalledTimes(1);
		expect(scanner.getState()).toMatchObject({
			status: "partial",
			nextRunAt: "2026-11-12T06:05:00.000Z",
		});
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS - 1);
		expect(input.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(input.refresh).toHaveBeenCalledTimes(2);
		await scanner.stop();
		await vi.advanceTimersByTimeAsync(2 * AUTO_SCAN_INTERVAL_MS);
		expect(input.refresh).toHaveBeenCalledTimes(2);
		expect(scanner.getState()).toMatchObject({ enabled: false, nextRunAt: null });
	});

	it("skips a busy refresh without queuing, then runs the next cycle", async () => {
		vi.useFakeTimers();
		const input = scannerInput();
		input.isRefreshing.mockReturnValue(true);
		const scanner = createAutoScanner(input);
		scanner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(input.refresh).not.toHaveBeenCalled();
		expect(scanner.getState().status).toBe("skipped");
		input.isRefreshing.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(input.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS - 1000);
		expect(input.refresh).toHaveBeenCalledTimes(1);
		await scanner.stop();
	});

	it("checks for a manual refresh that starts during storage I/O", async () => {
		vi.useFakeTimers();
		const input = scannerInput();
		input.checkStorage.mockImplementation(async () => {
			input.isRefreshing.mockReturnValue(true);
			return null;
		});
		const scanner = createAutoScanner(input);
		scanner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(input.refresh).not.toHaveBeenCalled();
		expect(scanner.getState().status).toBe("skipped");
		await scanner.stop();
	});

	it("records storage blocking and a rejected scan, and recovers on a later cycle", async () => {
		vi.useFakeTimers();
		const input = scannerInput();
		input.checkStorage.mockResolvedValueOnce("数据库达到容量限制");
		input.refresh.mockRejectedValueOnce(new Error("RPC unavailable"));
		const scanner = createAutoScanner(input);
		scanner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(scanner.getState()).toMatchObject({ status: "skipped", message: "数据库达到容量限制" });
		expect(input.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
		expect(scanner.getState()).toMatchObject({ status: "error", message: "RPC unavailable" });
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
		expect(input.refresh).toHaveBeenCalledTimes(2);
		expect(scanner.getState()).toMatchObject({ status: "partial", message: null });
		await scanner.stop();
	});

	it("does not overlap a slow scan and drains it before shutdown", async () => {
		vi.useFakeTimers();
		const input = scannerInput();
		let finish: (status: RefreshStatus) => void = () => {};
		input.refresh.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const scanner = createAutoScanner(input);
		scanner.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2 * AUTO_SCAN_INTERVAL_MS);
		expect(input.refresh).toHaveBeenCalledTimes(1);
		let closed = false;
		const closing = scanner.stop().then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(closed).toBe(false);
		finish("ok");
		await closing;
		expect(closed).toBe(true);
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
		expect(input.refresh).toHaveBeenCalledTimes(1);
	});

	it("does not schedule when disabled", async () => {
		vi.useFakeTimers();
		const input = { ...scannerInput(), enabled: false };
		const scanner = createAutoScanner(input);
		scanner.start();
		await vi.advanceTimersByTimeAsync(2 * AUTO_SCAN_INTERVAL_MS);
		expect(input.refresh).not.toHaveBeenCalled();
		expect(scanner.getState().nextRunAt).toBeNull();
		await scanner.stop();
	});
});

describe("scan storage and configuration", () => {
	it("counts SQLite side files and checks available disk without deleting anything", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-storage-"));
		try {
			const dbPath = path.join(dir, "test.db");
			await writeFile(dbPath, "123456");
			const config = { enabled: true, maxDatabaseBytes: 10, minFreeDiskBytes: 1 };
			expect(await scanStorageBlockReason(dbPath, config)).toBeNull();
			await writeFile(`${dbPath}-wal`, "789");
			await writeFile(`${dbPath}-shm`, "0");
			expect(await scanStorageBlockReason(dbPath, config)).toContain("已达到扫描准入上限");
			expect(
				await scanStorageBlockReason(dbPath, {
					...config,
					maxDatabaseBytes: 100,
					minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
				}),
			).toContain("低于扫描预留");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("enables 5-minute scans by default, supports disabling, and rejects invalid limits", () => {
		expect(loadServerEnv({}).autoScan).toEqual({
			enabled: true,
			maxDatabaseBytes: 2048 * 1024 * 1024,
			minFreeDiskBytes: 512 * 1024 * 1024,
		});
		expect(loadServerEnv({ AUTO_SCAN_ENABLED: "false" }).autoScan.enabled).toBe(false);
		for (const invalid of ["0", "-1", "1.5", "bad", "Infinity"]) {
			expect(() => loadServerEnv({ SCAN_MAX_DATABASE_MB: invalid })).toThrow(
				"SCAN_MAX_DATABASE_MB",
			);
			expect(() => loadServerEnv({ SCAN_MIN_FREE_DISK_MB: invalid })).toThrow(
				"SCAN_MIN_FREE_DISK_MB",
			);
		}
		expect(() => loadServerEnv({ AUTO_SCAN_ENABLED: "yes" })).toThrow("AUTO_SCAN_ENABLED");
	});
});
