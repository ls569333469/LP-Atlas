import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refreshableVenueBindings, venueAdapters } from "../src/adapters/registry.ts";
import { venueAdapterFileName } from "../src/adapters/venue-adapter.ts";
import { VENUE_CATALOG, VENUE_STATUS_LISTED } from "../src/shared/catalog.ts";

const venuesRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/adapters/venues",
);

describe("venue adapter placeholders", () => {
	it("has a module file for every catalog venue", () => {
		for (const venue of VENUE_CATALOG) {
			const file = path.join(venuesRoot, venue.chain, venueAdapterFileName(venue.protocol));
			expect(existsSync(file), file).toBe(true);
		}
	});

	it("covers BSC, Ethereum, and Base as placeholders", () => {
		const wanted = [
			"bsc:pancake_v3",
			"bsc:uniswap_v3",
			"bsc:uniswap_v4",
			"bsc:pancake_infinity",
			"ethereum:uniswap_v3",
			"ethereum:uniswap_v4",
			"base:uniswap_v3",
			"base:uniswap_v4",
			"base:pancake_infinity",
		];
		const placeholders = new Set(
			venueAdapters()
				.filter((adapter) => adapter.kind === "placeholder")
				.map((adapter) => `${adapter.chain}:${adapter.protocol}`),
		);
		for (const key of wanted) {
			expect(placeholders.has(key), key).toBe(true);
		}
	});

	it("throws on assertCanRefresh for every placeholder", () => {
		const placeholders = venueAdapters().filter((adapter) => adapter.kind === "placeholder");
		expect(placeholders).toHaveLength(
			VENUE_CATALOG.filter((venue) => venue.status === VENUE_STATUS_LISTED).length,
		);
		for (const adapter of placeholders) {
			expect(adapter.status).toBe(VENUE_STATUS_LISTED);
			expect(() => adapter.assertCanRefresh()).toThrow(/尚未启用|不得拉取生产数据/);
		}
	});

	it("keeps the refreshable set to Elysium and Robinhood Uniswap V3 and V4", () => {
		expect(
			refreshableVenueBindings()
				.map((adapter) => `${adapter.chain}:${adapter.protocol}`)
				.sort(),
		).toEqual([
			"elysium:uniswap_v3",
			"elysium:uniswap_v4",
			"robinhood:uniswap_v3",
			"robinhood:uniswap_v4",
		]);
		expect(
			refreshableVenueBindings().every(
				(adapter) => adapter.kind === "ready" && adapter.status === "enabled",
			),
		).toBe(true);
	});
});
