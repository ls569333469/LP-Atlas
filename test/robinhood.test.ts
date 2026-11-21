import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { resolveRpcConfig } from "../src/adapters/rpc.ts";
import { knownToken } from "../src/adapters/tokens.ts";
import * as v3 from "../src/adapters/venues/robinhood/uniswap-v3.ts";
import * as v4 from "../src/adapters/venues/robinhood/uniswap-v4.ts";
import { selectRefreshHours } from "../src/normalize/refresh-hours.ts";
import { buildApp } from "../src/server/app.ts";
import { robinhoodMainnet } from "../src/shared/chain.ts";
import { ZERO_ADDRESS } from "../src/shared/constants.ts";
import { UNISWAP_V4_ROBINHOOD } from "../src/shared/deployments.ts";
import type { BoardSuccessResponse } from "../src/shared/types.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	finishRefreshRun,
	insertRefreshRun,
	upsertScannedHour,
	upsertWindow,
} from "../src/store/repositories.ts";

it("namespaces Robinhood logs, sends raw IDs to official StateView and reads reserves from the same chain and leaves failed TVL null", async () => {
	const fixture = (name: string) =>
		JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
	const created = v3.decodeV3PoolCreatedLog(fixture("v3-pool-created"));
	const initialized = v4.decodeV4InitializeLog(fixture("v4-initialize"));
	expect(created.poolId).toBe(`4663:uniswap_v3:${created.poolAddress!.toLowerCase()}`);
	const raw = initialized.poolId.split(":")[2]!;
	const multicall = vi.fn().mockResolvedValue([
		{ status: "success", result: [2n ** 96n, 0, 0, 10000] },
		{ status: "success", result: 99n },
	]);
	const states = await v4.readV4Slot0s(
		{ multicall } as unknown as PublicClient,
		[initialized.poolId],
		123n,
	);
	expect(multicall.mock.calls[0]![0].contracts[0]).toMatchObject({
		address: UNISWAP_V4_ROBINHOOD.stateView,
		args: [raw],
	});
	const readReserves = vi.fn().mockResolvedValue([
		{
			status: "success",
			result: { coreAmount0: 12n, coreAmount1: 34n, hasCustomAccounting: false },
		},
	]);
	const reserves = await v4.readV4Reserves(
		{ multicall: readReserves } as unknown as PublicClient,
		[initialized],
		1,
		123n,
	);
	expect(readReserves.mock.calls[0]![0]).toMatchObject({
		blockNumber: 123n,
		contracts: [
			{
				address: UNISWAP_V4_ROBINHOOD.reservesLens,
				args: [
					UNISWAP_V4_ROBINHOOD.poolManager,
					{
						currency0: initialized.token0,
						currency1: initialized.token1,
						fee: initialized.feePips,
						tickSpacing: initialized.tickSpacing,
						hooks: initialized.hooks,
					},
				],
			},
		],
	});
	expect(
		v4.toV4PoolState(
			initialized.poolId,
			states.get(initialized.poolId),
			reserves.get(initialized.poolId),
		),
	).toMatchObject({ amount0: 12n, amount1: 34n });
	expect(
		v4.toV4PoolState(initialized.poolId, states.get(initialized.poolId), {
			amount0: 0n,
			amount1: 0n,
			hasCustomAccounting: false,
			gap: "官方 ReservesLens read failed",
		}),
	).toMatchObject({ amount0: null, amount1: null });

	expect(knownToken(ZERO_ADDRESS, 4663)?.symbol).toBe("ETH");
	expect(resolveRpcConfig({}, robinhoodMainnet).source.kind).toBe("public_temporary");
	expect(
		resolveRpcConfig({ primaryUrl: "https://example.com" }, robinhoodMainnet).client.transport
			.timeout,
	).toBe(360_000);
	expect(resolveRpcConfig({ primaryUrl: "https://example.com" }).client.transport.timeout).toBe(
		20_000,
	);
	expect(
		resolveRpcConfig({ primaryUrl: "https://robinhood.rpc.pinax.network" }, robinhoodMainnet).source
			.kind,
	).toBe("public_temporary");
	const selected = selectRefreshHours({
		asOfUnix: 1794643200,
		scannedStarts: new Set(),
		maxHours: 200,
		visibleOnly: true,
	});
	expect(selected).toHaveLength(72);
	expect(Math.min(...selected)).toBe(1794643200 + 3600 - 72 * 3600);
});

it("isolates identical pool IDs and chain cutoffs through SQLite, all windows and paginated API after a chain failure", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-multichain-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	const rpc = resolveRpcConfig({});
	const app = buildApp({ db, rpc, robinhoodRpc: resolveRpcConfig({}, robinhoodMainnet) });
	const raw = `0x${"1".repeat(64)}`;
	try {
		for (const [chain, chainId, offset] of [
			["elysium", 99901, 0],
			["robinhood", 4663, 7200],
		] as const) {
			const start = 1794643200 + offset;
			const asOf = new Date((start + 1800) * 1000).toISOString();
			const poolId = chainId === 99901 ? raw : `4663:uniswap_v4:${raw}`;
			await db.execute({
				sql: `INSERT INTO pools(chain_key,native_pool_id,pool_id,chain_id,protocol,token0,token1,fee_pips,tick_spacing,hooks,created_block,discovered_at) VALUES (?,?,?,?,'uniswap_v4',?,?,10000,60,?,1,?)`,
				args: [chain, raw, poolId, chainId, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, asOf],
			});
			const run = await insertRefreshRun(db, {
				startedAt: asOf,
				status: "running",
				rpcSourceKind: "public_temporary",
				rpcSourceLabel: "fixture",
				scopeChain: chain,
				scopeProtocol: null,
			});
			await finishRefreshRun(db, run, {
				finishedAt: asOf,
				status: "partial",
				blockTime: asOf,
				windowsBuilt: 1,
			});
			await upsertScannedHour(db, {
				chainId,
				protocol: "uniswap_v4",
				windowStart: start,
				windowEnd: start + 3600,
				complete: false,
				fromBlock: "1",
				toBlock: "2",
				asOf,
				gapReason: null,
				stateBlockNumber: "2",
				priceBoundaryVersion: 1,
				usdBridgeVersion: 1,
			});
			await upsertWindow(db, {
				poolId,
				windowStart: start,
				windowEnd: start + 3600,
				complete: false,
				volume0: "1000",
				volume1: "1000",
				lpFees0: "20",
				lpFees1: "20",
				swapCount: 1,
				volumeUsd: "2000",
				lpFeesUsd: chainId === 99901 ? "20" : "40",
				feeStatus: "estimated",
				tvlUsd: "2000",
				sqrtPriceStart: (2n ** 96n).toString(),
				sqrtPriceEnd: (2n ** 96n).toString(),
				source: "self_built",
				asOf,
				gapReason: null,
			});
		}
		const failed = await insertRefreshRun(db, {
			startedAt: "2026-11-14T13:00:00Z",
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: "robinhood",
			scopeProtocol: null,
		});
		await finishRefreshRun(db, failed, {
			finishedAt: "2026-11-14T13:00:01Z",
			status: "error",
			error: "429 fixture",
		});
		for (const window of ["1h", "2h", "4h", "6h", "24h", "3d"]) {
			const response = await app.inject(
				`/api/v2/board?window=${window}&includeWindows=all&pageSize=50&page=1`,
			);
			expect(response.statusCode).toBe(200);
			const board = response.json<BoardSuccessResponse>();
			expect(board.rows.map((row) => row.chain).sort()).toEqual(["elysium", "robinhood"]);
			expect(board.rows.every((row) => row.poolId === raw)).toBe(true);
			const elysium = board.rows.find((row) => row.chain === "elysium")!;
			expect(elysium.windows!["1h"].feesUsd.value).toBe("20");
			expect(elysium.windows!["3d"].feesUsd.value).toBeNull();
			expect(
				board.chainRpcSources.find((source) => source.chain === "robinhood")!.refresh!.status,
			).toBe("error");
			expect(
				board.chainRpcSources.find((source) => source.chain === "elysium")!.refresh!.lastSuccessAt,
			).toBe("2026-11-14T08:30:00.000Z");
		}
		const only = (await app.inject("/api/v2/board?chain=robinhood")).json<BoardSuccessResponse>();
		expect(only.rows.map((row) => row.chain)).toEqual(["robinhood"]);
		// The earlier-started chain can publish after the higher-ID chain.
		const lateElysium = await insertRefreshRun(db, {
			startedAt: "2026-11-14T13:30:00Z",
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: "elysium",
			scopeProtocol: null,
		});
		const earlyRobinhood = await insertRefreshRun(db, {
			startedAt: "2026-11-14T13:30:01Z",
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: "robinhood",
			scopeProtocol: null,
		});
		await finishRefreshRun(db, earlyRobinhood, {
			finishedAt: "2026-11-14T13:31:00Z",
			status: "partial",
			blockTime: "2026-11-14T10:30:00Z",
			windowsBuilt: 1,
		});
		const pageUrl = "/api/v2/board?includeWindows=all&pageSize=50&page=1";
		const before = (await app.inject(pageUrl)).json<BoardSuccessResponse>();
		await db.execute({
			sql: "UPDATE window_aggregates SET lp_fees_usd='30' WHERE pool_id=?",
			args: [raw],
		});
		await finishRefreshRun(db, lateElysium, {
			finishedAt: "2026-11-14T13:32:00Z",
			status: "partial",
			blockTime: "2026-11-14T08:30:00Z",
			windowsBuilt: 1,
		});
		const after = (await app.inject(pageUrl)).json<BoardSuccessResponse>();
		expect(after.pagination!.snapshotId).not.toBe(before.pagination!.snapshotId);
		expect(after.rows.find((row) => row.chain === "elysium")!.windows!["1h"].feesUsd.value).toBe(
			"30",
		);
		const frozen = (
			await app.inject(`${pageUrl}&snapshotId=${before.pagination!.snapshotId}`)
		).json<BoardSuccessResponse>();
		expect(frozen.rows.find((row) => row.chain === "elysium")!.windows!["1h"].feesUsd.value).toBe(
			"20",
		);
		expect(after.rows.find((row) => row.chain === "robinhood")!.windows!["1h"].feesUsd.value).toBe(
			"40",
		);
		const health = (await app.inject("/api/v1/health")).json();
		expect(health.refresh.lastSuccessAt).toBe("2026-11-14T08:30:00Z");
		expect(health.dataRevision).toBe(after.dataRevision);
		expect(after.dataRevision).not.toBe(before.dataRevision);
		const sameCutoff = await insertRefreshRun(db, {
			startedAt: "2026-11-14T13:33:00Z",
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: "elysium",
			scopeProtocol: null,
		});
		await finishRefreshRun(db, sameCutoff, {
			finishedAt: "2026-11-14T13:34:00Z",
			status: "partial",
			blockTime: "2026-11-14T08:30:00Z",
			windowsBuilt: 1,
		});
		const sameTimeHealth = (await app.inject("/api/v1/health")).json();
		const sameTimeBoard = (await app.inject(pageUrl)).json<BoardSuccessResponse>();
		expect(sameTimeHealth.refresh.lastSuccessAt).toBe(health.refresh.lastSuccessAt);
		expect(sameTimeHealth.dataRevision).not.toBe(health.dataRevision);
		expect(sameTimeHealth.dataRevision).toBe(sameTimeBoard.dataRevision);
		expect(sameTimeBoard.pagination!.snapshotId).not.toBe(after.pagination!.snapshotId);
	} finally {
		await app.close();
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
			(error: NodeJS.ErrnoException) => {
				// libsql on Windows may retain the file until the test worker exits.
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("keeps Robinhood factory requests within the empirically checked starting span", async () => {
	const getLogs = vi.fn().mockResolvedValue([]);
	await v3.discoverV3Pools({ getLogs } as unknown as PublicClient, 10_000_000n, 10_300_000n);
	expect(getLogs.mock.calls.map(([call]) => [call.fromBlock, call.toBlock])).toEqual([
		[10_000_000n, 10_149_999n],
		[10_150_000n, 10_299_999n],
		[10_300_000n, 10_300_000n],
	]);
});
it("reuses event-only V3 logs and ignores addresses outside the official catalog", async () => {
	const log = JSON.parse(readFileSync(new URL("./fixtures/v3-swap.json", import.meta.url), "utf8"));
	const foreign = { ...log, address: "0x1111111111111111111111111111111111111111" };
	const getLogs = vi.fn().mockResolvedValue([log, foreign]);
	const client = { getLogs } as unknown as PublicClient;
	const logs = await v3.loadV3SwapLogs(client, 100n, 200n);
	expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 100n, toBlock: 200n });
	expect(getLogs.mock.calls[0]?.[0].address).toBeUndefined();
	const context = { poolAddress: log.address, feePips: 3000, feeProtocol0: 4, feeProtocol1: 4 };
	const swaps = await v3.loadV3Swaps(client, [context], 100n, 200n, undefined, logs);
	expect(getLogs).toHaveBeenCalledTimes(1);
	expect(swaps).toEqual([v3.decodeV3SwapLog(log, context)]);
});
