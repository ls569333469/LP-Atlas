import { describe, expect, it } from "vitest";
import { VENUE_CATALOG, venueKey } from "../src/shared/catalog.ts";
import {
	PANCAKE_V3_BSC_SUBGRAPH_ID,
	UNOFFICIAL_UNISWAP_EXPLORER_SUBGRAPH_IDS,
} from "../src/shared/deployments.ts";
import {
	BOARD_WINDOW_COMPOSITION_RULES,
	venueSourcePolicies,
	venueSourcePolicy,
} from "../src/shared/venue-sources.ts";

describe("venue source policy", () => {
	it("covers every catalog venue and keeps new venues from being enabled by policy alone", () => {
		const policies = venueSourcePolicies();
		const policyKeys = new Set(policies.map((policy) => venueKey(policy.chain, policy.protocol)));
		for (const venue of VENUE_CATALOG) {
			expect(policyKeys.has(venueKey(venue.chain, venue.protocol))).toBe(true);
		}
		expect(policies).toHaveLength(VENUE_CATALOG.length);
	});

	it("labels official, self-built, and not-started paths without inventing Uniswap official IDs", () => {
		expect(venueSourcePolicy("elysium", "uniswap_v3")?.ingest).toBe("self_built");
		expect(venueSourcePolicy("bsc", "pancake_v3")).toMatchObject({
			ingest: "official_index",
			indexKind: "pancake_subgraph",
			officialWindows: ["1h", "1d"],
			officialSubgraphId: PANCAKE_V3_BSC_SUBGRAPH_ID,
		});
		expect(venueSourcePolicy("bsc", "uniswap_v3")?.ingest).toBe("self_built");
		expect(venueSourcePolicy("bsc", "uniswap_v3")?.officialSubgraphId).toBeNull();
		expect(venueSourcePolicy("ethereum", "uniswap_v3")).toMatchObject({
			ingest: "official_index",
			indexKind: "uniswap_official_subgraph",
			officialSubgraphId: null,
		});
		expect(venueSourcePolicy("ethereum", "uniswap_v4")?.officialSubgraphId).toBeNull();
		expect(venueSourcePolicy("base", "uniswap_v3")?.officialSubgraphId).toBeNull();
		expect(venueSourcePolicy("robinhood", "uniswap_v3")?.ingest).toBe("self_built");
		expect(venueSourcePolicy("robinhood", "uniswap_v4")?.ingest).toBe("self_built");
		expect(venueSourcePolicy("robinhood", "uniswap_v4")?.contracts.stateView).toBeTruthy();
		expect(venueSourcePolicy("bsc", "pancake_infinity")?.ingest).toBe("not_started");
		expect(venueSourcePolicy("solana", "meteora_damm_v2")?.ingest).toBe("not_started");
		expect(Object.values(UNOFFICIAL_UNISWAP_EXPLORER_SUBGRAPH_IDS)).not.toContain(
			venueSourcePolicy("ethereum", "uniswap_v3")?.officialSubgraphId,
		);
	});

	it("documents composition that cannot impersonate a missing hour", () => {
		expect(BOARD_WINDOW_COMPOSITION_RULES).toEqual([
			{ windowId: "1h", hourCount: 1, utcDayCount: null },
			{ windowId: "2h", hourCount: 2, utcDayCount: null },
			{ windowId: "4h", hourCount: 4, utcDayCount: null },
			{ windowId: "6h", hourCount: 6, utcDayCount: null },
			{ windowId: "24h", hourCount: 24, utcDayCount: 1 },
			{ windowId: "3d", hourCount: 72, utcDayCount: 3 },
		]);
		const twoHour = BOARD_WINDOW_COMPOSITION_RULES.find((rule) => rule.windowId === "2h");
		expect(twoHour?.utcDayCount).toBeNull();
	});
});
