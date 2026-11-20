import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveRpcConfig } from "../src/adapters/rpc.ts";
import { runRefreshPipeline } from "../src/normalize/refresh-pipeline.ts";
import { buildApp } from "../src/server/app.ts";
import { AUTO_SCAN_INTERVAL_MS } from "../src/server/auto-scan.ts";
import type { HealthResponse } from "../src/shared/types.ts";
import { openDatabase } from "../src/store/db.ts";
import { finishRefreshRun, insertRefreshRun } from "../src/store/repositories.ts";

// Replace only the RPC pipeline boundary; exercise real HTTP routes, locks, timers and storage.
vi.mock("../src/normalize/refresh-pipeline.ts", () => ({ runRefreshPipeline: vi.fn() }));

it("shares one refresh between manual and scheduled calls, skips busy cycles and drains on close", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-auto-api-"));
	const databasePath = path.join(dir, "test.db");
	const db = await openDatabase(databasePath);
	const rpc = resolveRpcConfig({});
	let release: () => void = () => {};
	const gates: Array<() => void> = [];
	vi.mocked(runRefreshPipeline).mockImplementation(async ({ scope }) => {
		const asOf = new Date().toISOString();
		const id = await insertRefreshRun(db, {
			startedAt: asOf,
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: scope?.chain ?? null,
			scopeProtocol: scope?.protocol ?? null,
		});
		await new Promise<void>((resolve) => {
			release = resolve;
			gates.push(resolve);
		});
		await finishRefreshRun(db, id, {
			finishedAt: asOf,
			status: "partial",
			blockTime: asOf,
			windowsBuilt: 1,
			durationMs: 1,
		});
		return {
			ok: true,
			asOf,
			blockNumber: "1",
			windowsBuilt: 1,
			discoveredPoolCount: [],
			gaps: ["fixture partial"],
			warnings: [],
			durationMs: 1,
		};
	});
	const app = buildApp({
		db,
		rpc,
		autoScan: { enabled: true, databasePath, maxDatabaseBytes: 1024 * 1024, minFreeDiskBytes: 1 },
	});
	const health = async () => (await app.inject("/api/v1/health")).json<HealthResponse>();
	try {
		for (const version of [1, 2]) {
			const obsolete = await app.inject(`/api/v${version}/board?window=7d`);
			expect(obsolete.statusCode).toBe(400);
			expect(obsolete.json().error).toContain("3d");
		}
		const manual = await app.inject({ method: "POST", url: "/api/v1/refresh", payload: {} });
		expect(manual.statusCode).toBe(202);
		expect(manual.json().alreadyRunning).toBe(false);
		await vi.waitFor(() => expect(gates).toHaveLength(1));
		await app.listen({ host: "127.0.0.1", port: 0 });
		await vi.waitFor(async () => expect((await health()).autoScan?.status).toBe("skipped"));
		expect(runRefreshPipeline).toHaveBeenCalledTimes(1);
		release();
		await vi.waitFor(async () => expect((await health()).refresh.status).toBe("partial"));
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
		await vi.waitFor(() => expect(gates).toHaveLength(2));
		expect((await health()).autoScan).toMatchObject({ status: "running", intervalMs: 300_000 });
		const duplicate = await app.inject({ method: "POST", url: "/api/v1/refresh", payload: {} });
		expect(duplicate.statusCode).toBe(202);
		expect(duplicate.json().alreadyRunning).toBe(true);
		const overlap = await app.inject({
			method: "POST",
			url: "/api/v1/refresh",
			payload: { chain: "elysium", protocol: "uniswap_v3" },
		});
		expect(overlap.statusCode).toBe(409);
		const disabled = await app.inject({
			method: "POST",
			url: "/api/v1/refresh",
			payload: { chain: "bsc", protocol: "uniswap_v3" },
		});
		expect(disabled.statusCode).toBe(400);
		expect(runRefreshPipeline).toHaveBeenCalledTimes(2);
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
		expect(closed).toBe(false);
		expect(runRefreshPipeline).toHaveBeenCalledTimes(2);
		release();
		await closing;
		expect(closed).toBe(true);
	} finally {
		release();
		await app.close();
		db.close();
		vi.useRealTimers();
		vi.resetAllMocks();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				// libsql on Windows may retain the file until the test worker exits.
				if (error.code !== "EBUSY") {
					throw error;
				}
			},
		);
	}
});

import { robinhoodMainnet } from "../src/shared/chain.ts";

it("keeps scheduling idle Elysium while a scheduled Robinhood scan spans multiple cycles", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-chain-lock-"));
	const databasePath = path.join(dir, "test.db");
	const db = await openDatabase(databasePath);
	const calls: string[] = [];
	let release = () => {};
	const robinhoodGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.mocked(runRefreshPipeline).mockImplementation(async ({ scope }) => {
		const chain = scope!.chain!;
		calls.push(chain);
		const asOf = new Date().toISOString();
		const id = await insertRefreshRun(db, {
			startedAt: asOf,
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: chain,
			scopeProtocol: null,
		});
		if (chain === "robinhood") await robinhoodGate;
		await finishRefreshRun(db, id, {
			finishedAt: asOf,
			status: "partial",
			blockTime: asOf,
			windowsBuilt: 1,
			durationMs: 1,
		});
		return {
			ok: true,
			asOf,
			blockNumber: "1",
			windowsBuilt: 1,
			discoveredPoolCount: [],
			gaps: [],
			warnings: [],
			durationMs: 1,
		};
	});
	const app = buildApp({
		db,
		rpc: resolveRpcConfig({}),
		robinhoodRpc: resolveRpcConfig({}, robinhoodMainnet),
		autoScan: { enabled: true, databasePath, maxDatabaseBytes: 1024 * 1024, minFreeDiskBytes: 1 },
	});
	const health = async () => (await app.inject("/api/v1/health")).json<HealthResponse>();
	try {
		await app.listen({ host: "127.0.0.1", port: 0 });
		await vi.waitFor(async () =>
			expect((await health()).chainRpcSources[0]?.refresh?.lastSuccessAt).toBeTruthy(),
		);
		for (let cycle = 1; cycle <= 2; cycle++) {
			await vi.advanceTimersByTimeAsync(AUTO_SCAN_INTERVAL_MS);
			await vi.waitFor(() =>
				expect(calls.filter((chain) => chain === "elysium")).toHaveLength(cycle + 1),
			);
			await vi.waitFor(async () =>
				expect((await health()).chainRpcSources[0]?.refresh?.status).toBe("partial"),
			);
			expect(calls.filter((chain) => chain === "robinhood")).toHaveLength(1);
		}
		const duplicate = await app.inject({
			method: "POST",
			url: "/api/v1/refresh",
			payload: { chain: "robinhood" },
		});
		expect(duplicate.statusCode).toBe(409);
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(closed).toBe(false);
		release();
		await closing;
		expect(closed).toBe(true);
	} finally {
		release();
		await app.close();
		db.close();
		vi.useRealTimers();
		vi.resetAllMocks();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("dispatches both chains in one scheduled refresh and isolates a failed Robinhood pipeline", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-chain-dispatch-"));
	const databasePath = path.join(dir, "test.db");
	const db = await openDatabase(databasePath);
	const calls: string[] = [];
	vi.mocked(runRefreshPipeline).mockImplementation(async ({ scope }) => {
		const chain = scope?.chain ?? "unknown";
		calls.push(chain);
		const asOf = new Date().toISOString();
		const id = await insertRefreshRun(db, {
			startedAt: asOf,
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: chain,
			scopeProtocol: null,
		});
		if (chain === "robinhood") {
			await finishRefreshRun(db, id, { finishedAt: asOf, status: "error", error: "fixture 429" });
			throw new Error("fixture 429");
		}
		await finishRefreshRun(db, id, {
			finishedAt: asOf,
			status: "partial",
			blockTime: asOf,
			windowsBuilt: 1,
		});
		return {
			ok: true,
			asOf,
			blockNumber: "1",
			windowsBuilt: 1,
			discoveredPoolCount: [],
			gaps: [],
			warnings: [],
			durationMs: 1,
		};
	});
	const app = buildApp({
		db,
		rpc: resolveRpcConfig({}),
		robinhoodRpc: resolveRpcConfig({}, robinhoodMainnet),
		autoScan: { enabled: true, databasePath, maxDatabaseBytes: 1024 * 1024, minFreeDiskBytes: 1 },
	});
	try {
		await app.listen({ host: "127.0.0.1", port: 0 });
		await vi.waitFor(async () => {
			const health = (await app.inject("/api/v1/health")).json<HealthResponse>();
			expect(
				health.chainRpcSources.find((source) => source.chain === "elysium")?.refresh?.lastSuccessAt,
			).toBeTruthy();
			expect(
				health.chainRpcSources.find((source) => source.chain === "robinhood")?.refresh?.status,
			).toBe("error");
			expect(health.autoScan?.lastFinishedAt).toBeTruthy();
		});
		expect(calls.sort()).toEqual(["elysium", "robinhood"]);
		const board = (await app.inject("/api/v2/board")).json();
		expect(board.ok).toBe(true);
		expect(board.chainRpcSources).toHaveLength(2);
	} finally {
		await app.close();
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				// libsql on Windows may retain the file until the test worker exits.
				if (error.code !== "EBUSY") throw error;
			},
		);
		vi.restoreAllMocks();
	}
});
