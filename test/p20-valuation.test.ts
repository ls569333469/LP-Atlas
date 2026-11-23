import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { rowPassesValuationFilters } from "../src/metrics/filter-sort.ts";
import { parseBoardMetricFilters } from "../src/server/board-query.ts";
import { priceSpacingBps } from "../src/shared/format.ts";
import type { BoardFilters, BoardRow } from "../src/shared/types.ts";
import { migrate } from "../src/store/db.ts";
import { readEvmFdvPublication, saveEvmFdvPublication } from "../src/store/token-fdv.ts";

it("freezes supply as of publication, keeps chain identities separate, and rejects stale observations", async () => {
	const db = createClient({ url: ":memory:" });
	try {
		await migrate(db);
		await db.execute(`INSERT INTO evm_token_supply VALUES
			('robinhood', 'same-address', '123456789', '2026-11-23T08:00:00.000Z', '2026-11-24T07:00:00.000Z'),
			('elysium', 'same-address', '999', '2026-11-23T08:00:00.000Z', '2026-11-24T07:00:00.000Z'),
			('robinhood', 'future-address', '11', '2026-11-23T10:00:00.000Z', '2026-11-24T07:00:00.000Z'),
			('robinhood', 'stale-address', '11', '2026-11-22T08:00:00.000Z', '2026-11-24T07:00:00.000Z')`);
		const asOf = "2026-11-23T09:00:00.000Z";
		const candidates = ["same-address", "future-address", "stale-address"].map((address) => ({
			address, decimals: 6, priceUsd: "2.5", priceObservedAt: asOf, source: "pool_derived" as const,
		}));
		await saveEvmFdvPublication(db, "robinhood", asOf, candidates);
		const before = await readEvmFdvPublication(db, "robinhood", asOf);
		expect(Object.keys(before)).toEqual(["same-address"]);
		expect(before["same-address"]).toMatchObject({ fdvUsd: "308.6419725", priceObservedAt: asOf });
		await db.execute("UPDATE evm_token_supply SET raw_supply = '321' WHERE chain = 'robinhood'");
		await saveEvmFdvPublication(db, "robinhood", "2026-11-23T07:00:00.000Z", []);
		expect(await readEvmFdvPublication(db, "robinhood", asOf)).toEqual(before);
		expect(await readEvmFdvPublication(db, "elysium", asOf)).toEqual({});
	} finally {
		db.close();
	}
});

it("uses the displayed basis-point value in a shared range across protocols", () => {
	const evm = { protocol: "uniswap_v4", tickSpacing: 60 } as BoardRow;
	const dlmm = { protocol: "meteora_dlmm", officialPool: { metadata: { binStep: 100 } } } as BoardRow;
	expect(priceSpacingBps(evm)).toBe(60.1773);
	expect(priceSpacingBps(dlmm)).toBe(100);
	const filters = parseBoardMetricFilters({ minSpacingBps: "60.1773", maxSpacingBps: "100" }) as BoardFilters;
	expect(rowPassesValuationFilters(evm, filters)).toBe(true);
	expect(rowPassesValuationFilters(dlmm, filters)).toBe(true);
	expect(rowPassesValuationFilters({ ...evm, tickSpacing: 59 }, filters)).toBe(false);
	expect(rowPassesValuationFilters({ ...dlmm, officialPool: undefined }, filters)).toBe(false);
	expect(() => parseBoardMetricFilters({ minSpacingBps: "101", maxSpacingBps: "100" })).toThrow();
});

it("validates P20 filters with inclusive bounds on the same side and scoped Uniswap spacing", () => {
	const value = (fdvUsd: string) => ({ fdvUsd, priceObservedAt: "", supplyObservedAt: "", source: "meteora" as const });
	const base = { protocol: "uniswap_v4", tickSpacing: 60, token0Fdv: value("10"), token1Fdv: value("40") } as BoardRow;
	const filters = (input: Record<string, string>) => parseBoardMetricFilters(input) as BoardFilters;
	expect(rowPassesValuationFilters(base, filters({ minFdvUsd: "20", maxFdvUsd: "30" }))).toBe(false);
	expect(rowPassesValuationFilters(base, filters({ maxFdvUsd: "10", fdvSide: "token0" }))).toBe(true);
	expect(rowPassesValuationFilters(base, filters({ maxFdvUsd: "10", fdvSide: "both" }))).toBe(false);
	expect(rowPassesValuationFilters(base, filters({ minTickSpacing: "60", maxTickSpacing: "60" }))).toBe(true);
	expect(rowPassesValuationFilters(base, filters({ maxTickSpacing: "59" }))).toBe(false);
	expect(rowPassesValuationFilters({ ...base, protocol: "meteora_dlmm" }, filters({ maxTickSpacing: "59" }))).toBe(true);
	expect(rowPassesValuationFilters({ ...base, token0Fdv: null }, filters({ minFdvUsd: "0", fdvSide: "token0" }))).toBe(false);
	expect(() => parseBoardMetricFilters({ minFdvUsd: "50", maxFdvUsd: "20" })).toThrow();
	expect(() => parseBoardMetricFilters({ minTickSpacing: "1.1" })).toThrow();
});
