import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Decimal from "decimal.js";
import {
	type AbiEvent,
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type PublicClient,
} from "viem";
import { expect, it } from "vitest";
import { resolveRpcConfig } from "../src/adapters/rpc.ts";
import { lookbackHourStarts } from "../src/normalize/refresh-hours.ts";
import { commitHourCheckpoint, runRefreshPipeline } from "../src/normalize/refresh-pipeline.ts";
import { buildApp } from "../src/server/app.ts";
import { ROBINHOOD_USDG_ADDRESS, ROBINHOOD_WETH_ADDRESS } from "../src/shared/constants.ts";
import { openDatabase, setMeta } from "../src/store/db.ts";
import {
	finishRefreshRun,
	insertRefreshRun,
	latestPublicationRevision,
	latestSuccessfulRefresh,
	upsertPool,
	upsertScannedHour,
	upsertToken,
} from "../src/store/repositories.ts";
import type { StoredScannedHour, StoredWindow } from "../src/store/types.ts";

it.each([
	"normal",
	"failed-v3",
	"zero",
	"repair",
	"interrupted",
	"incremental",
	"new-pool",
	"parallel",
	"quotes",
	"quote-failure",
] as const)("runs Robinhood hours with checkpoint and one-hour prefetch: %s", async (mode) => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-robinhood-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const current = Date.parse("2026-11-15T00:00:00Z") / 1000;
		let headTime = current + 600;
		const { starts } = lookbackHourStarts(headTime);
		const epoch = starts[0] as number;
		let head = BigInt(headTime - epoch);
		const token = `0x${"1".repeat(40)}` as const;
		const address = `0x${"2".repeat(40)}` as const;
		const raw4 = `0x${"3".repeat(64)}` as const;
		const q96 = 2n ** 96n;
		const ids = {
			uniswap_v3: `4663:uniswap_v3:${address}`,
			uniswap_v4: `4663:uniswap_v4:${raw4}`,
		};
		for (const coin of [token, ROBINHOOD_USDG_ADDRESS])
			await upsertToken(db, {
				chainId: 4663,
				address: coin.toLowerCase(),
				symbol: "TEST",
				decimals: 6,
				name: null,
			});
		for (const protocol of ["uniswap_v3", "uniswap_v4"] as const) {
			await upsertPool(
				db,
				{
					poolId: ids[protocol],
					chainId: 4663,
					protocol,
					token0: token,
					token1: ROBINHOOD_USDG_ADDRESS.toLowerCase(),
					feePips: 10000,
					tickSpacing: 200,
					hooks: null,
					poolAddress: protocol === "uniswap_v3" ? address : null,
					createdBlock: mode === "new-pool" ? current + 50 - epoch : 1,
					createdAtUnix: epoch + 1,
				},
				new Date(epoch * 1000).toISOString(),
			);
			await setMeta(
				db,
				`4663:${protocol === "uniswap_v3" ? "v3" : "v4"}_discover_block`,
				String(head),
			);
			for (const start of starts.filter((start) => start < current - 7200))
				await upsertScannedHour(db, {
					chainId: 4663,
					protocol,
					windowStart: start,
					windowEnd: start + 3600,
					complete: true,
					fromBlock: String(Math.max(start - epoch, 1)),
					toBlock: String(start + 3599 - epoch),
					stateBlockNumber: String(start + 3599 - epoch),
					priceBoundaryVersion: 1,
					usdBridgeVersion: 1,
					usdValuationVersion: 2,
					asOf: new Date(headTime * 1000).toISOString(),
					gapReason: null,
				});
		}

		if (mode === "repair")
			for (const protocol of ["uniswap_v3", "uniswap_v4"])
				await upsertScannedHour(db, {
					chainId: 4663,
					protocol,
					windowStart: current - 7200,
					windowEnd: current - 3600,
					complete: true,
					fromBlock: String(current - 7200 - epoch),
					toBlock: String(current - 3601 - epoch),
					stateBlockNumber: String(current - 3601 - epoch),
					priceBoundaryVersion: null,
					usdBridgeVersion: 1,
					asOf: new Date(headTime * 1000).toISOString(),
					gapReason: null,
				});
		const oldCutoff = current - 3600 + 300;
		const previous = await insertRefreshRun(db, {
			startedAt: new Date(oldCutoff * 1000).toISOString(),
			status: "running",
			rpcSourceKind: "configured",
			rpcSourceLabel: "fixture",
			scopeChain: "robinhood",
			scopeProtocol: null,
		});
		await finishRefreshRun(db, previous, {
			status: "ok",
			windowsBuilt: 1,
			blockTime: new Date(oldCutoff * 1000).toISOString(),
			finishedAt: new Date(oldCutoff * 1000).toISOString(),
		});
		const logs: Array<{ hour: number; protocol: string; from: bigint; to: bigint }> = [];
		let failIncrementV3 = false;
		let checkedBeforePublication = false;
		let checkpointsSeen = 0;
		const gates = new Map<string, { ready: Promise<void>; release: () => void }>();
		const gate = (key: string) => {
			let value = gates.get(key);
			if (!value) {
				let release!: () => void;
				const ready = new Promise<void>((resolve) => {
					release = resolve;
				});
				value = { ready, release };
				gates.set(key, value);
			}
			return value;
		};
		const waitForGate = async (key: string) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					gate(key).ready,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`parallel read blocked: ${key}`)), 2000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		};
		const client = {
			getChainId: async () => 4663,
			getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({
				number: blockNumber ?? head,
				timestamp: BigInt(epoch) + (blockNumber ?? head),
			}),
			readContract: async ({
				address: coin,
				blockNumber,
			}: {
				address: string;
				blockNumber?: bigint;
			}) => {
				if (
					mode === "parallel" &&
					blockNumber === head &&
					coin.toLowerCase() === ROBINHOOD_USDG_ADDRESS.toLowerCase()
				)
					gate(`anchor:${head}`).release();
				return coin.toLowerCase() === ROBINHOOD_WETH_ADDRESS.toLowerCase() ? 18 : 6;
			},
			getLogs: async (input: {
				event: AbiEvent;
				address?: Address;
				fromBlock: bigint;
				toBlock: bigint;
			}) => {
				if (input.event.name !== "Swap") return [];
				const v3 = input.address === undefined;
				if (mode === "parallel" && v3 && input.toBlock === head) {
					await waitForGate(`anchor:${head}`);
					await waitForGate(`v3:${input.toBlock}`);
				}
				const start = Math.floor((epoch + Number(input.fromBlock)) / 3600) * 3600;
				logs.push({
					hour: start,
					protocol: v3 ? "v3" : "v4",
					from: input.fromBlock,
					to: input.toBlock,
				});
				if (mode === "new-pool" && start !== current) return [];
				if (mode === "failed-v3" && v3 && start === current - 3600)
					throw new Error("connection failed");
				if (failIncrementV3 && v3) throw new Error("connection failed in incremental segment");
				const blocks = (mode === "incremental" && start === current ? [100, 700] : [100])
					.map((offset) => BigInt(start + offset - epoch))
					.filter((block) => block >= input.fromBlock && block <= input.toBlock);
				if (mode === "zero") return [];
				const values = v3
					? [1000000n, -1000000n, q96, 100n, 0]
					: [-1000000n, 1000000n, q96, 100n, 0, 10000];
				return blocks.map((blockNumber, logIndex) => ({
					address: v3 ? address : input.address,
					topics: encodeEventTopics({
						abi: [input.event],
						eventName: "Swap",
						args: v3 ? { sender: token, recipient: token } : { id: raw4, sender: token },
					}),
					data: encodeAbiParameters(
						input.event.inputs.filter((item) => !item.indexed),
						values,
					),
					blockNumber,
					logIndex,
				}));
			},
			multicall: async ({
				contracts,
				blockNumber,
			}: {
				contracts: Array<{ functionName: string }>;
				blockNumber: bigint;
			}) => {
				if (mode === "parallel") {
					if (
						blockNumber === BigInt(current - epoch - 1) &&
						contracts.some(({ functionName }) => functionName === "slot0")
					)
						await waitForGate(`anchor:${head}`);
					if (contracts.some(({ functionName }) => functionName === "getPoolTVL")) {
						gate(`v3:${blockNumber}`).release();
						gate(`reserves:${blockNumber}`).release();
					}
					if (
						blockNumber === head &&
						contracts.some(({ functionName }) => functionName === "getSlot0")
					)
						await waitForGate(`reserves:${blockNumber}`);
				}
				if (blockNumber === head && !checkedBeforePublication) {
					checkedBeforePublication = true;
					// State reads must finish before this hour is committed.
					expect(
						(
							await db.execute({
								sql: "SELECT * FROM scanned_hours WHERE chain_id=4663 AND window_start=?",
								args: [current - 3600],
							})
						).rows,
					).toHaveLength(0);
				}
				return contracts.map(({ functionName }) => ({
					status: "success",
					result:
						functionName === "slot0"
							? [q96, 0, 0, 0, 0, 0, true]
							: functionName === "getSlot0"
								? [q96, 0, 0, 10000]
								: functionName === "getPoolTVL"
									? { coreAmount0: 1000000n, coreAmount1: 1000000n, hasCustomAccounting: false }
									: functionName === "balanceOf"
										? 1000000n
										: 100n,
				}));
			},
		} as unknown as PublicClient;
		let storageChecks = 0;
		const run = runRefreshPipeline({
			db,
			quoteSource:
				mode === "quotes" || mode === "quote-failure"
					? {
							getQuote: async (assetId, targetAt) => {
								if (mode === "quote-failure") throw new Error("source unavailable");
								return {
									assetId,
									targetAt,
									priceUsd: "2000",
									sourceId: "redstone_push",
									feedId: "fixture",
									publishedAt: targetAt - 60,
									fetchedAt: new Date().toISOString(),
									sourceChainId: 999,
									sourceBlockNumber: "123",
									sourceBlockTimestamp: targetAt,
									sourceVersion: 1,
								};
							},
						}
					: undefined,
			rpc: { client, source: { kind: "configured", label: "fixture" }, urls: [] },
			scope: { chain: "robinhood", protocol: null },
			checkStorage: async () => {
				storageChecks++;
				const rows = (
					await db.execute({
						sql: "SELECT * FROM scanned_hours WHERE chain_id=4663 AND window_start=?",
						args: [current - 7200],
					})
				).rows;
				if (rows.length === 2) checkpointsSeen++;
				return mode === "interrupted" && rows.length === 2
					? "fixture stop before publication"
					: null;
			},
		});
		if (mode === "interrupted") await expect(run).rejects.toThrow("fixture stop");
		else {
			await run;
			const finished = (
				await db.execute(
					"SELECT gaps, warnings, windows_built, duration_ms FROM refresh_runs ORDER BY id DESC LIMIT 1",
				)
			).rows[0];
			expect(finished?.gaps).not.toBeNull();
			expect(finished?.warnings).not.toBeNull();
			expect(finished?.windows_built).not.toBeNull();
			expect(Number(finished?.duration_ms)).toBeGreaterThanOrEqual(0);
		}
		expect(storageChecks).toBeGreaterThan(0);
		const coverage = (
			await db.execute({
				sql: "SELECT * FROM scanned_hours WHERE chain_id=4663 AND window_start>=?",
				args: [current - 7200],
			})
		).rows;
		expect(coverage.filter((row) => Number(row.window_start) === current - 7200)).toHaveLength(2);
		const rows = (await db.execute("SELECT * FROM window_aggregates")).rows;
		if (mode === "quotes" || mode === "quote-failure") {
			for (const row of coverage) {
				expect(row.usd_valuation_version).toBe(mode === "quotes" ? 2 : null);
				if (mode === "quotes") expect(JSON.parse(String(row.usd_quote_json)).assetId).toBe("ETH");
			}
		}
		if (mode === "interrupted") {
			expect(checkpointsSeen).toBeGreaterThan(0);
			expect(coverage).toHaveLength(6);
			const beforeResume = logs.filter((log) => log.hour === current - 7200).length;
			await runRefreshPipeline({
				db,
				rpc: { client, source: { kind: "configured", label: "fixture" }, urls: [] },
				scope: { chain: "robinhood", protocol: null },
			});
			expect(
				(
					await db.execute({
						sql: "SELECT * FROM scanned_hours WHERE chain_id=4663 AND window_start>=?",
						args: [current - 7200],
					})
				).rows,
			).toHaveLength(6);
			expect(logs.filter((log) => log.hour === current - 7200)).toHaveLength(beforeResume);
		} else {
			expect(coverage).toHaveLength(mode === "failed-v3" ? 5 : 6);
			for (const row of rows) {
				if (mode === "parallel") expect(row.sqrt_price_start).toBe(String(q96));
				expect(row.volume_usd).toBe("1");
				expect(new Decimal(String(row.lp_fees_usd)).minus("0.01").abs().lt("1e-18")).toBe(true);
				expect(row.tvl_usd).toBe("2");
			}
			if (mode === "zero") {
				expect(rows).toHaveLength(0);
				expect((await latestSuccessfulRefresh(db, "robinhood"))?.blockTime).toBe(
					new Date(headTime * 1000).toISOString(),
				);
				expect(await latestPublicationRevision(db, ["robinhood"])).not.toBe(String(previous));
			} else if (mode === "new-pool") {
				expect(rows).toHaveLength(2);
				for (const row of rows) expect(row.sqrt_price_start).toBeNull();
			} else expect(rows).toHaveLength(mode === "failed-v3" ? 5 : mode === "repair" ? 4 : 6);
		}
		// Successful pages cover each hour once, including smaller production chunks.
		for (const start of [current, current - 7200])
			for (const protocol of ["v3", "v4"]) {
				const pages = logs
					.filter((log) => log.hour === start && log.protocol === protocol)
					.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
				if (mode === "repair" && start === current - 7200) {
					expect(pages).toHaveLength(0);
					continue;
				}
				expect(pages[0]?.from).toBe(BigInt(start - epoch));
				expect(pages.at(-1)?.to).toBe(start === current ? head : BigInt(start + 3599 - epoch));
				for (let index = 1; index < pages.length; index++)
					expect(pages[index]?.from).toBe((pages[index - 1]?.to as bigint) + 1n);
			}
		if (mode === "incremental") {
			const refresh = () =>
				runRefreshPipeline({
					db,
					rpc: { client, source: { kind: "configured", label: "fixture" }, urls: [] },
					scope: { chain: "robinhood", protocol: null },
				});
			const firstRevision = await latestPublicationRevision(db, ["robinhood"]);
			const committedHead = head;
			const priorRequestCount = logs.length;
			headTime = current + 900;
			head = BigInt(headTime - epoch);
			await refresh();
			const secondRevision = await latestPublicationRevision(db, ["robinhood"]);
			expect(secondRevision).not.toBe(firstRevision);
			for (const protocol of ["v3", "v4"]) {
				const ranges = logs
					.slice(priorRequestCount)
					.filter((log) => log.hour === current && log.protocol === protocol)
					.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
				expect(ranges[0]?.from).toBe(committedHead + 1n);
				expect(ranges.at(-1)?.to).toBe(head);
				for (let index = 1; index < ranges.length; index++)
					expect(ranges[index]?.from).toBe((ranges[index - 1]?.to as bigint) + 1n);
			}
			let saved = (
				await db.execute({
					sql: "SELECT * FROM window_aggregates WHERE window_start=?",
					args: [current],
				})
			).rows;
			expect(saved).toHaveLength(2);
			for (const row of saved) {
				expect(row.volume0).toBe("2000000");
				expect(Number(row.swap_count)).toBe(2);
				expect(row.volume_usd).toBe("2");
				expect(row.sqrt_price_start).toBe(q96.toString());
			}
			const requestCount = logs.length;
			await refresh();
			expect(logs).toHaveLength(requestCount);
			expect(await latestPublicationRevision(db, ["robinhood"])).toBe(secondRevision);
			headTime = current + 1200;
			head = BigInt(headTime - epoch);
			failIncrementV3 = true;
			await refresh(); // No swap at 901..1200: preserve the earlier cumulative pools.
			saved = (
				await db.execute({
					sql: "SELECT * FROM window_aggregates WHERE window_start=?",
					args: [current],
				})
			).rows;
			for (const row of saved) {
				expect(Number(row.swap_count)).toBe(2);
				expect(row.as_of).toBe(
					new Date(
						(row.pool_id === ids.uniswap_v3 ? current + 900 : headTime) * 1000,
					).toISOString(),
				);
			}
			failIncrementV3 = false;
			headTime = current + 1500;
			head = BigInt(headTime - epoch);
			const retryRequestCount = logs.length;
			await refresh();
			for (const protocol of ["v3", "v4"]) {
				const ranges = logs
					.slice(retryRequestCount)
					.filter((log) => log.hour === current && log.protocol === protocol)
					.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
				expect(ranges[0]?.from).toBe(BigInt(current + (protocol === "v3" ? 901 : 1201) - epoch));
				expect(ranges.at(-1)?.to).toBe(head);
				for (let index = 1; index < ranges.length; index++)
					expect(ranges[index]?.from).toBe((ranges[index - 1]?.to as bigint) + 1n);
			}
			headTime = current + 4200;
			head = BigInt(headTime - epoch);
			await refresh();
			saved = (
				await db.execute({
					sql: "SELECT * FROM window_aggregates WHERE window_start=?",
					args: [current],
				})
			).rows;
			for (const row of saved) {
				expect(Number(row.complete)).toBe(1);
				expect(Number(row.swap_count)).toBe(2);
			}
			await db.execute({
				sql: "DELETE FROM window_aggregates WHERE window_start=?",
				args: [current],
			});
			await db.execute({
				sql: "DELETE FROM scanned_hours WHERE chain_id=4663 AND window_start=?",
				args: [current],
			});
			await refresh();
			const rebuilt = (
				await db.execute({
					sql: "SELECT * FROM window_aggregates WHERE window_start=?",
					args: [current],
				})
			).rows;
			expect(rebuilt).toEqual(saved);
			expect((await latestSuccessfulRefresh(db, "robinhood"))?.blockTime).toBe(
				new Date(headTime * 1000).toISOString(),
			);
		}
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("rolls back a failed hour transaction, retains pending rows, then resumes without duplicate writes", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-checkpoint-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const hour: StoredScannedHour = {
			chainId: 4663,
			protocol: "uniswap_v3",
			windowStart: 100,
			windowEnd: 3700,
			complete: true,
			fromBlock: "1",
			toBlock: "3600",
			stateBlockNumber: "3600",
			priceBoundaryVersion: 1,
			asOf: "2026-11-15T00:00:00Z",
			gapReason: null,
		};
		const row: StoredWindow = {
			poolId: "fixture",
			windowStart: 100,
			windowEnd: 3700,
			complete: true,
			volume0: "1",
			volume1: "1",
			lpFees0: "1",
			lpFees1: "0",
			swapCount: 1,
			volumeUsd: "1",
			lpFeesUsd: "1",
			tvlUsd: "2",
			feeStatus: "estimated",
			sqrtPriceStart: "1",
			sqrtPriceEnd: "1",
			source: "self_built",
			asOf: hour.asOf,
			gapReason: null,
		};
		await upsertPool(
			db,
			{
				poolId: "fixture",
				chainId: 4663,
				protocol: "uniswap_v3",
				token0: `0x${"1".repeat(40)}`,
				token1: `0x${"2".repeat(40)}`,
				feePips: 10000,
				tickSpacing: 200,
				hooks: null,
				poolAddress: `0x${"3".repeat(40)}`,
				createdBlock: 1,
				createdAtUnix: 1,
			},
			hour.asOf,
		);
		const windows = [row];
		const hours = [hour];
		const runId = await insertRefreshRun(db, {
			startedAt: hour.asOf,
			status: "running",
			rpcSourceKind: "configured",
			rpcSourceLabel: "fixture",
			scopeChain: "robinhood",
			scopeProtocol: null,
		});
		const publication = {
			chain: "robinhood",
			runId,
			savedHours: [] as StoredScannedHour[],
			gaps: [],
			warnings: [],
		};
		await db.execute(
			"CREATE TRIGGER fail_hour BEFORE INSERT ON scanned_hours BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END",
		);
		await expect(commitHourCheckpoint(db, windows, hours, 100, publication)).rejects.toThrow();
		expect((await db.execute("SELECT * FROM window_aggregates")).rows).toHaveLength(0);
		expect((await db.execute("SELECT * FROM chain_publications")).rows).toHaveLength(0);
		expect(windows).toHaveLength(1);
		expect(hours).toHaveLength(1);
		await db.execute("DROP TRIGGER fail_hour");
		await db.execute(
			"CREATE TRIGGER fail_publication BEFORE INSERT ON chain_publications BEGIN SELECT RAISE(ABORT,'publication failure'); END",
		);
		await expect(commitHourCheckpoint(db, windows, hours, 100, publication)).rejects.toThrow();
		expect((await db.execute("SELECT * FROM scanned_hours")).rows).toHaveLength(0);
		expect((await db.execute("SELECT * FROM window_aggregates")).rows).toHaveLength(0);
		expect(windows).toHaveLength(1);
		await db.execute("DROP TRIGGER fail_publication");
		expect(await commitHourCheckpoint(db, windows, hours, 100, publication)).toBe(true);
		expect(windows).toHaveLength(0);
		expect(hours).toHaveLength(0);
		expect(await commitHourCheckpoint(db, windows, hours, 100)).toBe(false);
		expect((await db.execute("SELECT * FROM window_aggregates")).rows).toHaveLength(1);
		const firstRevision = await latestPublicationRevision(db, ["robinhood"]);
		expect((await latestSuccessfulRefresh(db, "robinhood"))?.status).toBe("running");
		expect((await latestSuccessfulRefresh(db, "robinhood"))?.blockTime).toBe(hour.asOf);
		const rpc = resolveRpcConfig({});
		const app = buildApp({ db, rpc, robinhoodRpc: rpc });
		try {
			const health = (await app.inject({ method: "GET", url: "/api/v1/health" })).json();
			const board = (
				await app.inject({ method: "GET", url: "/api/v2/board?chain=robinhood&includeWindows=all" })
			).json();
			expect(health.refresh.status).toBe("running");
			expect(board.refresh.status).toBe("running");
			expect(board.asOf).toBe(hour.asOf);
			expect(board.dataRevision).toBe(health.dataRevision);
		} finally {
			await app.close();
		}
		await expect(
			commitHourCheckpoint(db, [{ ...row, volume0: "2" }], [hour], 100, publication),
		).rejects.toThrow("游标已变化");
		expect(await latestPublicationRevision(db, ["robinhood"])).toBe(firstRevision);
		const nextHour = { ...hour, toBlock: "3601" };
		await commitHourCheckpoint(db, [{ ...row, volume0: "2" }], [nextHour], 100, {
			...publication,
			savedHours: [hour],
		});
		expect(await latestPublicationRevision(db, ["robinhood"])).not.toBe(firstRevision);
		await finishRefreshRun(db, runId, { status: "error", error: "later phase failed" });
		expect((await latestSuccessfulRefresh(db, "robinhood"))?.blockTime).toBe(hour.asOf);
		expect((await db.execute("SELECT volume0 FROM window_aggregates")).rows[0]?.volume0).toBe("2");
		expect(await latestPublicationRevision(db, ["elysium"])).toBe("idle");
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});
