import {
	findVenue,
	VENUE_CATALOG,
	VENUE_STATUS_ENABLED,
	VENUE_STATUS_LISTED,
	venueKey,
} from "../shared/catalog.ts";
import type { VenueAdapter } from "./venue-adapter.ts";
import { VENUE_ADAPTERS } from "./venues/index.ts";

const ADAPTERS_BY_KEY = new Map(
	VENUE_ADAPTERS.map((adapter) => [venueKey(adapter.chain, adapter.protocol), adapter]),
);

export function venueAdapters(): readonly VenueAdapter[] {
	return VENUE_ADAPTERS;
}

export function venueAdapterBinding(chain: string, protocol: string): VenueAdapter | undefined {
	return ADAPTERS_BY_KEY.get(venueKey(chain, protocol));
}

/** Only enabled ready adapters may refresh. Placeholders must never be included. */
export function refreshableVenueBindings(): readonly VenueAdapter[] {
	return VENUE_ADAPTERS.filter(
		(adapter) => adapter.kind === "ready" && adapter.status === VENUE_STATUS_ENABLED,
	);
}

export function assertRegistryMatchesCatalog(): void {
	if (ADAPTERS_BY_KEY.size !== VENUE_ADAPTERS.length) {
		throw new Error("适配器注册表出现重复的 chain/protocol");
	}
	for (const venue of VENUE_CATALOG) {
		const adapter = ADAPTERS_BY_KEY.get(venueKey(venue.chain, venue.protocol));
		if (!adapter) {
			throw new Error(`目录场所缺少适配器：${venue.chain}/${venue.protocol}`);
		}
		if (adapter.status !== venue.status) {
			throw new Error(`适配器状态与目录不一致：${venue.chain}/${venue.protocol}`);
		}
		if (adapter.ingest !== adapter.policy.ingest) {
			throw new Error(`适配器与政策 ingest 不一致：${venue.chain}/${venue.protocol}`);
		}
		if (venue.status === VENUE_STATUS_ENABLED && adapter.kind !== "ready") {
			throw new Error(`已启用场所必须是 ready 适配器：${venue.chain}/${venue.protocol}`);
		}
		if (venue.status === VENUE_STATUS_LISTED && adapter.kind !== "placeholder") {
			throw new Error(`未启用场所必须是占位适配器：${venue.chain}/${venue.protocol}`);
		}
	}
	for (const adapter of VENUE_ADAPTERS) {
		const venue = findVenue(adapter.chain, adapter.protocol);
		if (!venue) {
			throw new Error(`适配器不在目录中：${adapter.chain}/${adapter.protocol}`);
		}
	}
}

assertRegistryMatchesCatalog();
