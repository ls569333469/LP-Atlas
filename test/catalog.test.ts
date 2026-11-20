import { describe, expect, it } from "vitest";
import { parseBoardSort, parseWindowId } from "../src/metrics/filter-sort.ts";
import {
	enabledVenues,
	findChain,
	isEnabledVenue,
	PROTOCOL_CATALOG,
	productCatalog,
	resolveRefreshScope,
	VENUE_CATALOG,
} from "../src/shared/catalog.ts";
import { BOARD_WINDOWS, CHAIN_ID_ROBINHOOD } from "../src/shared/constants.ts";

describe("product catalog", () => {
	it("lists formal chains and protocols without hardcoding only two protocol ids as the catalog", () => {
		const catalog = productCatalog();
		expect(catalog.chains.map((chain) => chain.id)).toEqual([
			"elysium",
			"bsc",
			"ethereum",
			"base",
			"robinhood",
			"solana",
		]);
		expect(catalog.chains.some((chain) => chain.id === "arbitrum")).toBe(false);
		expect(catalog.protocols.map((protocol) => protocol.id)).toEqual(
			PROTOCOL_CATALOG.map((protocol) => protocol.id),
		);
		expect(PROTOCOL_CATALOG.length).toBeGreaterThan(2);
		expect(catalog.venues).toHaveLength(VENUE_CATALOG.length);
		expect(
			enabledVenues().every((venue) => venue.chain === "elysium" || venue.chain === "robinhood"),
		).toBe(true);
		expect(
			enabledVenues()
				.filter((venue) => venue.chain === "elysium")
				.map((venue) => venue.protocol)
				.sort(),
		).toEqual(["uniswap_v3", "uniswap_v4"]);
		expect(isEnabledVenue("bsc", "pancake_v3")).toBe(false);
		expect(findChain("99901")?.id).toBe("elysium");
	});

	it("lists Robinhood Chain as a formal chain with enabled Uniswap V3 and V4 venues", () => {
		const robinhood = findChain("robinhood");
		expect(robinhood).toEqual({
			id: "robinhood",
			evmChainId: CHAIN_ID_ROBINHOOD,
			label: "Robinhood Chain",
			nativeSymbol: "ETH",
		});
		expect(findChain("robin")?.id).toBe("robinhood");
		expect(findChain("Robinhood Chain")?.id).toBe("robinhood");
		expect(findChain("4663")?.id).toBe("robinhood");
		const venues = VENUE_CATALOG.filter((venue) => venue.chain === "robinhood");
		expect(venues.map((venue) => venue.protocol).sort()).toEqual(["uniswap_v3", "uniswap_v4"]);
		expect(venues.every((venue) => venue.status === "enabled")).toBe(true);
		expect(isEnabledVenue("robinhood", "uniswap_v3")).toBe(true);
		expect(isEnabledVenue("robinhood", "uniswap_v4")).toBe(true);
	});

	it("rejects refresh of listed but not implemented venues", () => {
		expect(resolveRefreshScope({ chain: "bsc", protocol: "pancake_v3" })).toEqual({
			error: "BNB Smart Chain PancakeSwap V3 已列入目录但尚未接入，不能刷新。",
		});
		expect(resolveRefreshScope({ chain: "robinhood" })).toEqual({
			chain: "robinhood",
			protocol: null,
		});
		expect(resolveRefreshScope({ chain: "robin", protocol: "uniswap_v3" })).toEqual({
			chain: "robinhood",
			protocol: "uniswap_v3",
		});
		expect(resolveRefreshScope({ chain: "ethereum", protocol: "uniswap_v3" })).toEqual({
			error: "Ethereum Uniswap V3 已列入目录但尚未接入，不能刷新。",
		});
		expect(resolveRefreshScope({ chain: "base", protocol: "uniswap_v4" })).toEqual({
			error: "Base Uniswap V4 已列入目录但尚未接入，不能刷新。",
		});
		expect(resolveRefreshScope({})).toEqual({ chain: null, protocol: null });
		expect(resolveRefreshScope({ chain: "elysium", protocol: "uniswap_v3" })).toEqual({
			chain: "elysium",
			protocol: "uniswap_v3",
		});
	});
});

describe("window query reservation", () => {
	it("accepts the determined windows including 4h and defaults to 1h", () => {
		expect(BOARD_WINDOWS.map((window) => window.id)).toEqual(["1h", "2h", "4h", "6h", "24h", "3d"]);
		expect(parseWindowId("3d")).toBe("3d");
		expect(parseWindowId("30d")).toBe("1h");
		expect(parseBoardSort({ window: "24h", field: "tvl" })).toEqual({
			field: "tvl",
			window: "24h",
			direction: "desc",
		});
	});
});
