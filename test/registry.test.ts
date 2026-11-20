import { describe, expect, it } from "vitest";
import {
	assertRegistryMatchesCatalog,
	refreshableVenueBindings,
	venueAdapterBinding,
	venueAdapters,
} from "../src/adapters/registry.ts";
import { enabledVenues, VENUE_CATALOG, VENUE_STATUS_LISTED } from "../src/shared/catalog.ts";

describe("venue adapter registry", () => {
	it("keeps a 1:1 registry with the catalog", () => {
		expect(() => assertRegistryMatchesCatalog()).not.toThrow();
		expect(venueAdapters()).toHaveLength(VENUE_CATALOG.length);
		for (const venue of VENUE_CATALOG) {
			const adapter = venueAdapterBinding(venue.chain, venue.protocol);
			expect(adapter).toMatchObject({
				chain: venue.chain,
				protocol: venue.protocol,
				status: venue.status,
			});
		}
	});

	it("returns ready adapters for enabled Elysium and Robinhood venues", () => {
		expect(venueAdapterBinding("elysium", "uniswap_v3")).toMatchObject({
			kind: "ready",
			ingest: "self_built",
			status: "enabled",
		});
		expect(venueAdapterBinding("elysium", "uniswap_v4")).toMatchObject({
			kind: "ready",
			ingest: "self_built",
		});
		expect(() => venueAdapterBinding("elysium", "uniswap_v3")?.assertCanRefresh()).not.toThrow();
		expect(() => venueAdapterBinding("elysium", "uniswap_v4")?.assertCanRefresh()).not.toThrow();
		expect(refreshableVenueBindings()).toHaveLength(enabledVenues().length);
		expect(refreshableVenueBindings().every((item) => item.kind === "ready")).toBe(true);
	});

	it("returns placeholders for listed venues and does not treat them as refreshable", () => {
		const listed = VENUE_CATALOG.filter((venue) => venue.status === VENUE_STATUS_LISTED);
		expect(listed.length).toBeGreaterThan(0);
		for (const venue of listed) {
			expect(venueAdapterBinding(venue.chain, venue.protocol)).toMatchObject({
				kind: "placeholder",
				chain: venue.chain,
				protocol: venue.protocol,
			});
		}
		expect(venueAdapterBinding("robinhood", "uniswap_v3")?.kind).toBe("ready");
		expect(venueAdapterBinding("bsc", "pancake_v3")?.kind).toBe("placeholder");
		expect(
			refreshableVenueBindings().some(
				(item) => item.chain !== "elysium" && item.chain !== "robinhood",
			),
		).toBe(false);
	});
});
