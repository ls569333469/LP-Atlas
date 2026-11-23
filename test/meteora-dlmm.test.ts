import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { queryOfficialJson } from "../src/adapters/official-index.ts";
import {
	MeteoraRequestBudget,
	meteoraCandidateWindows,
	parseMeteoraCurrentAccounts,
	parseMeteoraHistory,
	readMeteoraHistory,
	readMeteoraPool,
	readMeteoraPoolPage,
	venueAdapter,
} from "../src/adapters/venues/solana/meteora-dlmm.ts";
import { composeFromHours } from "../src/metrics/compose-windows.ts";
import { matchesDlmmFilters } from "../src/metrics/dlmm-filters.ts";
import { commitHourCheckpoint } from "../src/normalize/refresh-pipeline.ts";
import { solanaPublicKey } from "../src/shared/solana-identifiers.ts";
import { sourceObservation } from "../src/shared/source-contracts.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	listScannedHours,
	listWindowsInRange,
	upsertPool,
	upsertScannedHour,
	upsertWindow,
} from "../src/store/repositories.ts";
import type { StoredSolanaScannedHour } from "../src/store/types.ts";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

const fixtureDir = fileURLToPath(new URL("./fixtures/meteora/", import.meta.url));
const fixture = (name: string) =>
	JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));
const poolId = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const start = 1795143600;
const end = start + 3600;
const observedAt = "2026-11-21T12:00:00.000Z";
const exact = () => fixture("history-0-exact");
const batch = () => parseMeteoraHistory(exact(), poolId, start, end, observedAt);
const response = (value: unknown) => new Response(JSON.stringify(value));
const fetchJson = (value: unknown) =>
	vi.fn<typeof fetch>().mockImplementation(async () => response(value));
const dirs: string[] = [];
afterEach(async () => {
	await removeTempDirectories(dirs);
});

it("applies DLMM conditions to one token at a time and preserves zero, false and missing values", async () => {
	const pool = await readMeteoraPool(poolId, { fetchImpl: fetchJson(fixture("pool-0")) });
	pool.tokenX.marketCapUsd = "500";
	pool.tokenX.holders = 0;
	pool.tokenY.marketCapUsd = null;
	pool.tokenY.holders = 1000;
	pool.hasFarm = false;
	pool.launchpad = null;
	expect(matchesDlmmFilters(pool, { side: "both" })).toBe(true);
	expect(matchesDlmmFilters(pool, { marketCapMin: "500", holdersMin: "1000" })).toBe(false);
	expect(
		matchesDlmmFilters(pool, { side: "x", marketCapMax: "500", holdersMax: "0", farm: "false" }),
	).toBe(true);
	expect(matchesDlmmFilters(pool, { side: "both", marketCapMin: "0" })).toBe(false);
	expect(matchesDlmmFilters(pool, { launchpad: "Meteora" })).toBe(false);
	expect(matchesDlmmFilters(pool, { rewardMint: "11111111111111111111111111111111" })).toBe(false);
	pool.reportedStatistics.protocolFees = { "1h": "0", "4h": "10" };
	expect(matchesDlmmFilters(pool, { protocolFeesMax: "0" })).toBe(true);
	expect(matchesDlmmFilters(pool, { protocolFeesMax: "0", officialWindow: "4h" })).toBe(false);
	expect(matchesDlmmFilters(pool, { protocolFeesMin: "0", officialWindow: "12h" })).toBe(false);
});

it("matches independently executed official SDK address vectors, including a real off-curve PDA", () => {
	const evidence = fixture("sdk-address-vectors");
	expect(evidence.sdk).toBe("@solana/web3.js@1.98.4");
	for (const vector of evidence.vectors) {
		if (vector.valid) expect(solanaPublicKey(vector.address)).toBe(vector.address);
		else expect(() => solanaPublicKey(vector.address)).toThrow();
	}
	expect(evidence.vectors.some((v: { offCurve?: boolean }) => v.offCurve)).toBe(true);
	for (const character of ["0", "O", "I", "l"])
		expect(() => solanaPublicKey(character + poolId.slice(1))).toThrow();
});

it("reads official current metadata separately from historical values without enabling the venue", async () => {
	const fetchImpl = fetchJson(fixture("pool-0"));
	const pool = await readMeteoraPool(poolId, { fetchImpl });
	expect(pool).toMatchObject({
		address: poolId,
		tokenX: { address: "So11111111111111111111111111111111111111112", decimals: 9 },
		tokenY: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
		binStep: 4,
		collectFeeMode: 0,
		accountVerification: "unverified",
	});
	expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
		`https://dlmm.datapi.meteora.ag/pools/${poolId}`,
	);
	expect(venueAdapter.kind).toBe("placeholder");
	expect(() => venueAdapter.assertCanRefresh()).toThrow("尚未启用");
});

it("keeps real current reserve integers and Token-2022 extensions separate from historical metrics", async () => {
	const evidence = fixture("public-current-reserves");
	const pool0 = await readMeteoraPool(poolId, { fetchImpl: fetchJson(fixture("pool-0")) });
	const pool1Id = "7qZPiJ2Lvwh9DV9gUBH2EwConBE3RUrAvGRjpN8vTjtT";
	const pool1 = await readMeteoraPool(pool1Id, { fetchImpl: fetchJson(fixture("pool-1")) });
	const standard = parseMeteoraCurrentAccounts(evidence.response, evidence.addresses, pool0);
	expect(standard).toMatchObject({
		slot: 472203524,
		poolId,
		tokenX: { compatibility: "standard_spl_current_only", decimals: 9 },
		tokenY: { compatibility: "standard_spl_current_only", decimals: 6 },
	});
	const reserveIndex = evidence.addresses.indexOf(pool0.reserveX);
	expect(standard.tokenX.amount).toBe(
		evidence.response.result.value[reserveIndex].data.parsed.info.tokenAmount.amount,
	);
	const extended = parseMeteoraCurrentAccounts(evidence.response, evidence.addresses, pool1);
	expect(extended.tokenX.compatibility).toBe("token2022_unverified");
	expect(extended.tokenX.extensions).toContainEqual({
		extension: "transferHook",
		state: expect.objectContaining({ programId: null }),
	});
	expect(extended).not.toHaveProperty("tvlUsd");
	expect(extended).not.toHaveProperty("lpFeesUsd");
	const reserve = evidence.response.result.value[reserveIndex].data.parsed.info;
	reserve.tokenAmount.amount = "9007199254740993";
	// lamports and floating UI balances are not the WSOL token amount.
	reserve.tokenAmount.uiAmount = 1;
	evidence.response.result.value[reserveIndex].lamports = 1;
	expect(
		parseMeteoraCurrentAccounts(evidence.response, evidence.addresses, pool0).tokenX.amount,
	).toBe("9007199254740993");
});

it.each(["missing", "owner", "mint", "authority", "decimals", "negative", "overflow"])(
	"rejects current account evidence with %s mismatch instead of guessing amounts",
	async (fault) => {
		const evidence = fixture("public-current-reserves");
		const pool = await readMeteoraPool(poolId, { fetchImpl: fetchJson(fixture("pool-0")) });
		const index = evidence.addresses.indexOf(pool.reserveX);
		const account = evidence.response.result.value[index];
		if (fault === "missing") evidence.response.result.value[index] = null;
		if (fault === "owner") account.owner = poolId;
		if (fault === "mint") account.data.parsed.info.mint = pool.tokenY.address;
		if (fault === "authority") account.data.parsed.info.owner = pool.tokenY.address;
		if (fault === "decimals") account.data.parsed.info.tokenAmount.decimals = 6;
		if (fault === "negative") account.data.parsed.info.tokenAmount.amount = "-1";
		if (fault === "overflow") account.data.parsed.info.tokenAmount.amount = "18446744073709551616";
		expect(() =>
			parseMeteoraCurrentAccounts(evidence.response, evidence.addresses, pool),
		).toThrow();
	},
);

it("refuses incomplete or duplicate account batches and RPC failures", async () => {
	const evidence = fixture("public-current-reserves");
	const pool = await readMeteoraPool(poolId, { fetchImpl: fetchJson(fixture("pool-0")) });
	expect(() =>
		parseMeteoraCurrentAccounts({ error: { code: -32000 } }, evidence.addresses, pool),
	).toThrow("RPC failed");
	expect(() => parseMeteoraCurrentAccounts(evidence.response, [poolId, poolId], pool)).toThrow(
		"Duplicate",
	);
	evidence.response.result.value.pop();
	expect(() => parseMeteoraCurrentAccounts(evidence.response, evidence.addresses, pool)).toThrow(
		"count mismatch",
	);
});

it("requests exactly one explicit discovery page and returns its next page without crawling", async () => {
	const fetchImpl = fetchJson(fixture("discovery"));
	const page = await readMeteoraPoolPage(1, 2, { fetchImpl });
	expect(page).toMatchObject({ page: 1, nextPage: 2, total: 137528 });
	expect(page.pools).toHaveLength(2);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
		"https://dlmm.datapi.meteora.ag/pools?page=1&page_size=2",
	);
});

it("rejects invalid inputs before HTTP and mismatched returned identities", async () => {
	const fetchImpl = fetchJson(fixture("pool-1"));
	await expect(readMeteoraPool("0".repeat(44), { fetchImpl })).rejects.toThrow();
	await expect(readMeteoraPoolPage(1, 1001, { fetchImpl })).rejects.toThrow();
	await expect(readMeteoraHistory(poolId, start, end - 1, { fetchImpl })).rejects.toThrow();
	expect(fetchImpl).not.toHaveBeenCalled();
	await expect(readMeteoraPool(poolId, { fetchImpl })).rejects.toThrow("identity mismatch");
});

it("refuses pagination totals that would silently terminate discovery early", async () => {
	const value = fixture("discovery");
	value.pages = 0;
	await expect(readMeteoraPoolPage(1, 2, { fetchImpl: fetchJson(value) })).rejects.toThrow(
		"totals mismatch",
	);
});

it("requests the exact end boundary, drops the terminal bucket and never invents source finality", async () => {
	const fetchImpl = fetchJson(exact());
	const result = await readMeteoraHistory(poolId, start, end, { fetchImpl });
	const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
	expect(url.searchParams.get("end_time")).toBe(String(end));
	expect(result.hours).toEqual([
		{
			startUnix: start,
			volumeUsd: "1064262.3261313129",
			reportedFeesUsd: "444.9549993301968",
			reportedProtocolFeesUsd: "49.30480302410541",
		},
	]);
	expect(result.observation).toMatchObject({
		dataCutoff: null,
		finality: "unverified",
		feeAttribution: "unverified",
	});
	expect(result.missingHours).toEqual([]);
});

it.each([0, 1])(
	"replays four-day official sample %i without treating its 96 labels as complete coverage",
	(index) => {
		const raw = fixture(`history-${index}-96h`);
		const id = index === 0 ? poolId : "7qZPiJ2Lvwh9DV9gUBH2EwConBE3RUrAvGRjpN8vTjtT";
		const result = parseMeteoraHistory(raw, id, 1794805200, 1795150800, observedAt);
		expect(raw.data).toHaveLength(97);
		expect(result.hours).toHaveLength(96);
		expect(result.missingHours).toEqual([]);
		expect(meteoraCandidateWindows(result).every((w) => !w.complete && w.lpFeesUsd === null)).toBe(
			true,
		);
	},
);

it("reproduces the unsafe minus-one-second boundary and refuses its truncated envelope", () => {
	const raw = fixture("history-0-minus1");
	expect(raw.data[0].volume).toBe(4777.67320142552);
	expect(exact().data[0].volume).toBe(1064262.3261313129);
	const padded = fixture("history-0-padded").data.find(
		(r: { timestamp: number }) => r.timestamp === start,
	);
	expect(padded.volume).toBeCloseTo(exact().data[0].volume, 6);
	expect(() => parseMeteoraHistory(raw, poolId, start, end, observedAt)).toThrow("range mismatch");
});

it("sorts out-of-order buckets and deduplicates equal rows without filling an unobserved hour", () => {
	const raw = fixture("history-0-padded");
	raw.data = [raw.data[3], raw.data[1], raw.data[1], raw.data[0]];
	const result = parseMeteoraHistory(raw, poolId, start - 3600, start + 7200, observedAt);
	expect(result.hours.map((r) => r.startUnix)).toEqual([start - 3600, start]);
	expect(result.missingHours).toEqual([end]);
});

it.each(["duplicate", "negative", "bucket", "timeframe", "string-number"])(
	"rejects malformed history: %s",
	(kind) => {
		const raw = exact();
		if (kind === "duplicate") raw.data.push({ ...raw.data[0], volume: 1 });
		if (kind === "negative") raw.data[0].fees = -1;
		if (kind === "bucket") raw.data[0].timestamp_str = "2026-11-20T03:01:00Z";
		if (kind === "timeframe") raw.timeframe = "24h";
		if (kind === "string-number") raw.data[0].volume = "100";
		expect(() => parseMeteoraHistory(raw, poolId, start, end, observedAt)).toThrow();
	},
);

it("does not reinterpret reported fees, current TVL, raw amounts or prices as known historical metrics", () => {
	const [row] = meteoraCandidateWindows(batch());
	if (!row) throw new Error("Missing candidate fixture hour");
	expect(row).toMatchObject({
		complete: false,
		volumeUsd: "1064262.3261313129",
		lpFeesUsd: null,
		tvlUsd: null,
		volume0: null,
		volume1: null,
		lpFees0: null,
		lpFees1: null,
		swapCount: null,
		sqrtPriceStart: null,
		sqrtPriceEnd: null,
		feeStatus: "protocol_state_missing",
	});
	const metrics = composeFromHours(
		[row],
		{ startUnix: start, endUnix: end, complete: false },
		new Set([start]),
	);
	expect(metrics).not.toBeNull();
	expect(metrics?.lpFeesUsd).toBeNull();
});

it("bounds a 429 to one retry without accepting an error page as data", async () => {
	const fetchImpl = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response("rate limited", { status: 429 }));
	await expect(readMeteoraPool(poolId, { fetchImpl })).rejects.toMatchObject({
		code: "index_rate_limited",
	});
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("bounds response bytes and rejects malformed JSON", async () => {
	const url = new URL("https://dlmm.datapi.meteora.ag/pools");
	await expect(
		queryOfficialJson(url, { maxBytes: 2, fetchImpl: fetchJson({ large: true }) }),
	).rejects.toThrow("budget");
	await expect(
		queryOfficialJson(url, {
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>")),
		}),
	).rejects.toThrow("JSON");
});

it("keeps the deadline active while the response body is stalled", async () => {
	let aborted = false;
	const fetchImpl: typeof fetch = async (_url, init) =>
		new Response(
			new ReadableStream({
				start(controller) {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							controller.error(new Error("body aborted"));
						},
						{ once: true },
					);
				},
			}),
		);
	await expect(readMeteoraPool(poolId, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
		code: "index_down",
	});
	expect(aborted).toBe(true);
});

it("ends Meteora reads at 60 seconds even when fetch ignores abort", async () => {
	vi.useFakeTimers();
	try {
		let deliver!: (response: Response) => void;
		const fetchImpl = vi.fn<typeof fetch>(
			() =>
				new Promise((resolve) => {
					deliver = resolve;
				}),
		);
		const result = readMeteoraPool(poolId, { fetchImpl, budget: new MeteoraRequestBudget() });
		const rejection = expect(result).rejects.toMatchObject({ code: "index_down" });
		await vi.advanceTimersByTimeAsync(0);
		const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
		expect(signal).toBeDefined();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		deliver(Response.json({ address: poolId }));
		await vi.advanceTimersByTimeAsync(500);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		await rejection;
		expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
		deliver(Response.json({ address: poolId }));
	} finally {
		vi.useRealTimers();
	}
});

it("rejects a response observed past the deadline before the timer callback runs", async () => {
	let elapsed = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const onRequestTiming = vi.fn();
	try {
		await expect(
			queryOfficialJson(new URL("https://dlmm.datapi.meteora.ag/pools"), {
				timeoutMs: 60_000,
				fetchImpl: async () => {
					elapsed = 60_001;
					return Response.json({ pools: [] });
				},
				onRequestTiming,
			}),
		).rejects.toMatchObject({ code: "index_down" });
		expect(onRequestTiming).toHaveBeenCalledWith(
			expect.objectContaining({ timedOut: true, lateResponse: true }),
		);
	} finally {
		clock.mockRestore();
	}
});

it("uses the existing atomic checkpoint and tables, preserves nulls, and refuses a stale cumulative replacement", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-meteora-"));
	dirs.push(directory);
	const db = await openDatabase(path.join(directory, "fixture.db"));
	try {
		const [row] = meteoraCandidateWindows(batch());
		if (!row) throw new Error("Missing candidate fixture hour");
		await upsertPool(
			db,
			{
				poolId: row.poolId,
				nativePoolId: poolId,
				chain: "solana",
				chainId: null,
				evmChainId: null,
				protocol: "meteora_dlmm",
				token0: "So11111111111111111111111111111111111111112",
				token1: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				feePips: null,
				tickSpacing: null,
				hooks: null,
				poolAddress: poolId,
				createdBlock: null,
				createdAtUnix: null,
			},
			observedAt,
		);
		const hour: StoredSolanaScannedHour = {
			chain: "solana",
			chainId: null,
			evmChainId: null,
			protocol: "meteora_dlmm",
			coverageScope: row.poolId,
			sourceObservation: batch().observation,
			windowStart: start,
			windowEnd: end,
			complete: false,
			fromBlock: null,
			toBlock: null,
			asOf: observedAt,
			gapReason: "source unverified",
		};
		const windows = [row],
			hours = [hour];
		expect(await commitHourCheckpoint(db, windows, hours, start)).toBe(true);
		expect(windows).toEqual([]);
		expect(hours).toEqual([]);
		await commitHourCheckpoint(db, [row], [hour], start);
		const revised = {
			...row,
			volumeUsd: "200",
			sourceObservation: { ...row.sourceObservation, observedAt: "2026-11-21T12:01:00Z" },
		};
		await upsertWindow(db, revised);
		await expect(upsertWindow(db, row)).rejects.toThrow("explicit policy");
		// The older request finishes later. Its completion time must not win the race.
		const concurrent = {
			...revised,
			sourceObservation: {
				...revised.sourceObservation,
				requestStartedAt: "2026-11-21T12:00:30Z",
				observedAt: "2026-11-21T12:02:00Z",
			},
		};
		await expect(upsertWindow(db, concurrent)).rejects.toThrow("explicit policy");
		expect((await listWindowsInRange(db, start, end, "solana"))[0]).toMatchObject({
			volumeUsd: "200",
			lpFeesUsd: null,
		});
		await expect(upsertWindow(db, { ...revised, complete: true })).rejects.toThrow("coverage");
		await expect(upsertWindow(db, { ...revised, lpFeesUsd: "0" })).rejects.toThrow(
			"fee attribution",
		);
		// A coverage failure rolls the preceding window replacement back in the same transaction.
		const pending = [{ ...revised, volumeUsd: "300" }];
		const badHours = [{ ...hour, protocol: "raydium_clmm" }];
		await expect(commitHourCheckpoint(db, pending, badHours, start)).rejects.toThrow(
			"identity mismatch",
		);
		expect(pending).toHaveLength(1);
		expect((await listWindowsInRange(db, start, end, "solana"))[0]?.volumeUsd).toBe("200");
		await upsertScannedHour(db, { ...hour, sourceObservation: revised.sourceObservation });
		await expect(upsertScannedHour(db, hour)).rejects.toThrow("Stale coverage");
		expect(
			await listScannedHours(db, { chainId: 99901, startUnix: start, endUnixExclusive: end }),
		).toEqual([]);
	} finally {
		db.close();
	}
});

it("validates request timing without treating it as source cutoff", () => {
	const observation = { ...batch().observation, requestStartedAt: "2026-11-21T11:59:00Z" };
	expect(sourceObservation(observation)).toMatchObject({
		requestStartedAt: observation.requestStartedAt,
		dataCutoff: null,
	});
	expect(() =>
		sourceObservation({ ...observation, requestStartedAt: "2026-11-21T12:00:01Z" }),
	).toThrow("request start");
});

it("keeps known volume and fees when protocol fees are missing, without replacing unknown fees by zero", () => {
	const raw = exact();
	delete raw.data[0].protocol_fees;
	const known = parseMeteoraHistory(raw, poolId, start, end, observedAt).hours[0]!;
	expect(known.volumeUsd).toBe(String(raw.data[0].volume));
	expect(known.reportedFeesUsd).toBe(String(raw.data[0].fees));
	expect(known.reportedProtocolFeesUsd).toBeNull();
	delete raw.data[0].fees;
	const missing = parseMeteoraHistory(raw, poolId, start, end, observedAt).hours[0]!;
	expect(missing.volumeUsd).toBe(known.volumeUsd);
	expect(missing.reportedFeesUsd).toBeNull();
	raw.data[0].fees = 0;
	expect(parseMeteoraHistory(raw, poolId, start, end, observedAt).hours[0]!.reportedFeesUsd).toBe(
		"0",
	);
});
