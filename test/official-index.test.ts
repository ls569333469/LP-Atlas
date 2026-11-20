import { describe, expect, it, vi } from "vitest";
import {
	composeOfficialBoardWindow,
	DAY_SECONDS,
	graphGatewayUrl,
	isExactUtcDayRange,
	OfficialIndexError,
	type OfficialIndexPoolDay,
	type OfficialIndexPoolHour,
	queryOfficialIndex,
} from "../src/adapters/official-index.ts";

const POOL = "0xpool";
const AS_OF = "2026-11-12T12:00:00.000Z";

function hour(start: number, volumeUSD: string, feesUSD: string): OfficialIndexPoolHour {
	return {
		poolId: POOL,
		periodStartUnix: start,
		volumeUSD,
		feesUSD,
		tvlUSD: "1000",
		txCount: 2,
		sqrtPrice: "123",
	};
}

function day(start: number, volumeUSD: string, feesUSD: string): OfficialIndexPoolDay {
	return {
		poolId: POOL,
		date: start,
		volumeUSD,
		feesUSD,
		tvlUSD: "2000",
		txCount: 10,
		sqrtPrice: "456",
	};
}

function hoursCovering(start: number, count: number): OfficialIndexPoolHour[] {
	return Array.from({ length: count }, (_, index) => hour(start + index * 3600, "1", "0.1"));
}

describe("official index client", () => {
	it("builds the official Graph gateway URL", () => {
		expect(graphGatewayUrl("abc")).toBe("https://gateway.thegraph.com/api/subgraphs/id/abc");
	});

	it("refuses to query without an API key and does not hit any gateway", async () => {
		const fetchImpl = vi.fn();
		await expect(
			queryOfficialIndex({
				apiKey: "  ",
				subgraphId: "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ",
				query: "{ pools { id } }",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({
			code: "missing_api_key",
		} satisfies Partial<OfficialIndexError>);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses to query without a subgraph id", async () => {
		const fetchImpl = vi.fn();
		await expect(
			queryOfficialIndex({
				apiKey: "test-key",
				subgraphId: "",
				query: "{ pools { id } }",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(OfficialIndexError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("posts to the official gateway with a bearer token when configured", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ data: { ok: true } }),
		});
		const data = await queryOfficialIndex<{ ok: boolean }>({
			apiKey: "test-key",
			subgraphId: "subgraph-id",
			query: "{ _meta { block { number } } }",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(data).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gateway.thegraph.com/api/subgraphs/id/subgraph-id");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
	});
});

describe("official window composition", () => {
	it("maps a native official 1h bucket", () => {
		const start = 1_762_905_600;
		const mapped = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "1h",
			range: { startUnix: start, endUnix: start + 3600, complete: true },
			hours: [hour(start, "10", "0.3")],
			asOf: AS_OF,
		});
		expect(mapped).toMatchObject({
			poolId: POOL,
			windowStart: start,
			windowEnd: start + 3600,
			volumeUsd: "10",
			lpFeesUsd: "0.3",
			source: "official_index",
			volume0: "0",
			lpFees0: "0",
		});
	});

	it("composes 2h from two official hours and leaves a gap empty", () => {
		const start = 1_762_905_600;
		const complete = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "2h",
			range: { startUnix: start, endUnix: start + 7200, complete: true },
			hours: [hour(start, "10", "0.3"), hour(start + 3600, "5", "0.2")],
			asOf: AS_OF,
		});
		expect(complete?.volumeUsd).toBe("15");
		expect(complete?.lpFeesUsd).toBe("0.5");
		expect(complete?.swapCount).toBe(4);

		const missing = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "2h",
			range: { startUnix: start, endUnix: start + 7200, complete: true },
			hours: [hour(start, "10", "0.3")],
			days: [day(start, "999", "99")],
			asOf: AS_OF,
		});
		expect(missing).toBeNull();
	});

	it("does not use a 1d bucket to fill a rolling 24h that is not UTC-day aligned", () => {
		const start = 1_762_909_200;
		expect(isExactUtcDayRange(start, start + DAY_SECONDS)).toBe(false);
		const mapped = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "24h",
			range: { startUnix: start, endUnix: start + DAY_SECONDS, complete: true },
			hours: hoursCovering(start, 23),
			days: [day(utcAlign(start), "100", "4")],
			asOf: AS_OF,
		});
		expect(mapped).toBeNull();
	});

	it("uses official 1d only when the 24h window is an exact UTC day and hours are incomplete", () => {
		const start = 1_762_905_600;
		expect(isExactUtcDayRange(start, start + DAY_SECONDS)).toBe(true);
		const fromDay = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "24h",
			range: { startUnix: start, endUnix: start + DAY_SECONDS, complete: true },
			hours: hoursCovering(start, 20),
			days: [day(start, "40", "1.5")],
			asOf: AS_OF,
		});
		expect(fromDay).toMatchObject({
			volumeUsd: "40",
			lpFeesUsd: "1.5",
			windowStart: start,
			windowEnd: start + DAY_SECONDS,
			source: "official_index",
		});

		const fromHours = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "24h",
			range: { startUnix: start, endUnix: start + DAY_SECONDS, complete: true },
			hours: hoursCovering(start, 24),
			days: [day(start, "999", "99")],
			asOf: AS_OF,
		});
		expect(fromHours?.volumeUsd).toBe("24");
		expect(fromHours?.lpFeesUsd).toBe("2.4");
	});

	it("composes 3d from three official UTC days and refuses a two-day set", () => {
		const start = 1_762_300_800;
		const days = Array.from({ length: 3 }, (_, index) =>
			day(start + index * DAY_SECONDS, "3", "0.2"),
		);
		const mapped = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "3d",
			range: { startUnix: start, endUnix: start + 3 * DAY_SECONDS, complete: true },
			hours: [],
			days,
			asOf: AS_OF,
		});
		expect(mapped?.volumeUsd).toBe("9");
		expect(mapped?.lpFeesUsd).toBe("0.6");

		const incomplete = composeOfficialBoardWindow({
			poolId: POOL,
			windowId: "3d",
			range: { startUnix: start, endUnix: start + 3 * DAY_SECONDS, complete: true },
			hours: [],
			days: days.slice(0, 2),
			asOf: AS_OF,
		});
		expect(incomplete).toBeNull();
	});
});

function utcAlign(unix: number): number {
	return Math.floor(unix / DAY_SECONDS) * DAY_SECONDS;
}
