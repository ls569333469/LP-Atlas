import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshableVenueBindings, venueAdapterBinding } from "../src/adapters/registry.ts";
import { composeFromHours } from "../src/metrics/compose-windows.ts";
import { chainRef, storedChain } from "../src/shared/chain-ref.ts";
import { poolIdentity, solanaPoolStorageKey } from "../src/shared/pool-identity.ts";
import { solanaPublicKey, solanaSignature } from "../src/shared/solana-identifiers.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	countPoolsByVenue,
	deferUsdRepair,
	finishRefreshRun,
	getToken,
	insertRefreshRun,
	latestPublicationRevision,
	latestSuccessfulRefresh,
	listPoolAdditions,
	listPools,
	listScannedHours,
	listTokensForPools,
	listWindowsInRange,
	upsertPool,
	upsertScannedHour,
	upsertToken,
	upsertWindow,
} from "../src/store/repositories.ts";
import type { StoredOfficialWindow, StoredSolanaPool } from "../src/store/types.ts";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

const dirs: string[] = [];
afterEach(async () => {
	await removeTempDirectories(dirs);
});
const dir = () => {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "lp-solana-"));
	dirs.push(value);
	return value;
};
const poolId = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const token0 = "So11111111111111111111111111111111111111112";
const token1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const observation = {
	source: "offline_fixture",
	schemaVersion: "test-1",
	observedAt: "2026-11-20T12:00:00Z",
	dataCutoff: null,
	finality: "unverified",
	feeAttribution: "unverified",
} as const;
const pool = (protocol = "meteora_dlmm"): StoredSolanaPool => ({
	chain: "solana",
	chainId: null,
	evmChainId: null,
	protocol,
	poolId: solanaPoolStorageKey(protocol, poolId),
	nativePoolId: poolId,
	token0,
	token1,
	feePips: null,
	tickSpacing: null,
	hooks: null,
	poolAddress: poolId,
	createdBlock: null,
	createdAtUnix: null,
});
const window = (): StoredOfficialWindow => ({
	poolId: pool().poolId,
	representation: "official_usd",
	sourceObservation: observation,
	windowStart: 3600,
	windowEnd: 7200,
	complete: false,
	volume0: null,
	volume1: null,
	lpFees0: null,
	lpFees1: null,
	swapCount: null,
	volumeUsd: "123.450000000001",
	lpFeesUsd: null,
	tvlUsd: null,
	sqrtPriceStart: null,
	sqrtPriceEnd: null,
	source: "official_index",
	asOf: observation.observedAt,
	gapReason: "source coverage and LP fees unverified",
});

describe("S1 identity boundaries", () => {
	it("uses catalog identities and rejects numeric Solana sentinels/inconsistent aliases", () => {
		expect(chainRef(99901)).toEqual({ chain: "elysium", evmChainId: 99901 });
		expect(chainRef("solana")).toEqual({ chain: "solana", evmChainId: null });
		for (const id of [0, -1, 101, 999999]) expect(() => chainRef(id)).toThrow();
		expect(() => storedChain({ chain: "solana", chainId: 99901 })).toThrow();
		expect(() => storedChain({ chainId: null })).toThrow();
		expect(() => storedChain({ chainId: null, chain: "elysium", evmChainId: 99901 })).toThrow();
		expect(() => chainRef({ chain: "solana", evmChainId: 101 })).toThrow();
	});
	it("distinguishes canonical 32-byte public keys (including off-curve PDA bytes) and 64-byte signatures", () => {
		expect(solanaPublicKey(poolId)).toBe(poolId);
		expect(solanaPublicKey("1".repeat(32))).toBe("1".repeat(32));
		expect(solanaPublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toBeTruthy();
		expect(solanaSignature("1".repeat(64))).toBe("1".repeat(64));
		for (const invalid of [
			"",
			` ${poolId}`,
			`${poolId}\n`,
			"0".repeat(44),
			"1".repeat(31),
			"1".repeat(33),
			"1".repeat(64),
		]) {
			expect(() => solanaPublicKey(invalid)).toThrow();
		}
		expect(() => solanaSignature(poolId)).toThrow();
		expect(solanaPublicKey(poolId.replace("C", "c"))).not.toBe(poolId);
		expect(poolIdentity({ chain: "solana", protocol: "meteora_dlmm", poolId })).not.toBe(
			poolIdentity({ chain: "solana", protocol: "meteora_dlmm", poolId: poolId.toLowerCase() }),
		);
	});
	it("keeps all Solana venues listed/placeholder/not_started and out of refresh", () => {
		for (const protocol of ["meteora_dlmm", "raydium_clmm", "meteora_damm_v2"]) {
			const adapter = venueAdapterBinding("solana", protocol);
			expect(adapter).toMatchObject({
				kind: "placeholder",
				status: "listed_not_implemented",
				ingest: "not_started",
				capabilities: { kind: "not_started", ordinaryLpFees: "unverified", coverage: "unverified" },
			});
			expect(() => adapter?.assertCanRefresh()).toThrow();
		}
		expect(refreshableVenueBindings().some((a) => a.chain === "solana")).toBe(false);
	});
});

it("round-trips non-EVM identities and unknown amounts through the SAME repositories without zero/sentinel fabrication", async () => {
	const db = await openDatabase(path.join(dir(), "fixture.db"));
	try {
		for (const address of [token0, token1])
			await upsertToken(db, {
				chain: "solana",
				chainId: null,
				evmChainId: null,
				address,
				symbol: "fixture",
				decimals: 9,
				name: null,
			});
		await upsertPool(db, pool(), observation.observedAt);
		await upsertPool(db, pool("raydium_clmm"), observation.observedAt);
		const roundtrip = await listPools(db, "solana");
		expect(roundtrip).toHaveLength(2);
		expect(roundtrip[0]).toEqual(pool());
		expect((await getToken(db, "solana", token0))?.chainId).toBeNull();
		expect(await listTokensForPools(db, [pool().poolId])).toHaveLength(2);
		expect(await listPools(db, 99901)).toHaveLength(0);
		const run = await insertRefreshRun(db, {
			startedAt: observation.observedAt,
			status: "running",
			rpcSourceKind: "fixture",
			rpcSourceLabel: "offline",
			scopeChain: "solana",
			scopeProtocol: "meteora_dlmm",
		});
		await finishRefreshRun(db, run, {
			status: "partial",
			finishedAt: observation.observedAt,
			windowsBuilt: 1,
		});
		await db.execute({
			sql: "INSERT INTO chain_publications(chain,revision,run_id,block_number,block_time,published_at,source_observation) VALUES ('solana',1,?,NULL,NULL,?,?)",
			args: [run, observation.observedAt, JSON.stringify(observation)],
		});
		expect(await latestSuccessfulRefresh(db, "solana")).toMatchObject({
			scopeChain: "solana",
			blockNumber: null,
			blockTime: null,
		});
		expect(await latestPublicationRevision(db, ["solana"])).toBe(`${run}.1`);

		expect(await countPoolsByVenue(db)).toEqual(
			expect.arrayContaining([
				{ chain: "solana", evmChainId: null, protocol: "meteora_dlmm", count: 1 },
			]),
		);
		const added = await listPoolAdditions(db, "solana", 0);
		expect((await listPoolAdditions(db, "solana", added.lastRowId)).pools).toHaveLength(0);
		await upsertWindow(db, window());
		await upsertWindow(db, { ...window(), volumeUsd: "1" });
		await upsertWindow(db, window()); // cumulative replacement, never 1 + repeated totals
		await expect(
			upsertWindow(db, {
				...window(),
				sourceObservation: { ...observation, source: "another_source" },
			}),
		).rejects.toThrow("explicit policy");
		const [stored] = await listWindowsInRange(db, 0, 10000, "solana");
		expect(stored).toMatchObject(window());
		expect(stored?.volume0).toBeNull();
		expect(stored?.swapCount).toBeNull();
		await upsertScannedHour(db, {
			chain: "solana",
			chainId: null,
			evmChainId: null,
			protocol: "meteora_dlmm",
			coverageScope: pool().poolId,
			windowStart: 3600,
			windowEnd: 7200,
			complete: false,
			fromBlock: null,
			toBlock: null,
			asOf: observation.observedAt,
			gapReason: "unverified",
			sourceObservation: observation,
		});
		expect(
			await listScannedHours(db, { chainId: "solana", startUnix: 0, endUnixExclusive: 10000 }),
		).toMatchObject([
			{ chainId: null, coverageScope: pool().poolId, fromBlock: null, toBlock: null },
		]);
		expect(
			await listScannedHours(db, { chainId: 99901, startUnix: 0, endUnixExclusive: 10000 }),
		).toEqual([]);
		await expect(upsertWindow(db, { ...window(), complete: true })).rejects.toThrow("coverage");
		await expect(upsertWindow(db, { ...window(), lpFeesUsd: "0" })).rejects.toThrow(
			"fee attribution",
		);
		await expect(
			upsertPool(db, { ...pool(), poolId: poolId }, observation.observedAt),
		).rejects.toThrow("physical key");
		await expect(
			upsertPool(db, { ...pool(), token0: "0".repeat(44) }, observation.observedAt),
		).rejects.toThrow();
		await expect(
			deferUsdRepair(db, {
				poolId: pool().poolId,
				windowStart: 3600,
				toBlock: "0",
				windowAsOf: observation.observedAt,
				window: window(),
				catalogRowId: 2,
				reason: "no_historical_path",
				evidence: "test",
			}),
		).rejects.toThrow("revaluation");
	} finally {
		db.close();
	}
});

it("does not manufacture raw amounts, missing hours, TVL or LP fees when composing official USD hours", () => {
	const hours = [window(), { ...window(), windowStart: 7200, windowEnd: 10800 }];
	const result = composeFromHours(
		hours,
		{ startUnix: 3600, endUnix: 10800, complete: false },
		new Set([3600, 7200]),
	);
	expect(result).toMatchObject({
		representation: "official_usd",
		volume0: null,
		swapCount: null,
		volumeUsd: "246.900000000002",
		lpFeesUsd: null,
		tvlUsd: null,
		sqrtPriceStart: null,
	});
	expect(
		composeFromHours(
			[window()],
			{ startUnix: 3600, endUnix: 10800, complete: false },
			new Set([3600, 7200]),
		),
	).toBeNull();
});
