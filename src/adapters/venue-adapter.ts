import {
	findVenue,
	productCatalog,
	type RuntimeVenues,
	VENUE_STATUS_ENABLED,
	type VenueStatus,
} from "../shared/catalog.ts";
import type { SourceCapabilities } from "../shared/source-contracts.ts";
import type { IngestPath, VenueSourcePolicy } from "../shared/venue-sources.ts";
import { venueSourceCapabilities, venueSourcePolicy } from "../shared/venue-sources.ts";

export type VenueAdapterKind = "ready" | "placeholder";

export type VenueAdapter = {
	chain: string;
	protocol: string;
	status: VenueStatus;
	ingest: IngestPath;
	kind: VenueAdapterKind;
	capabilities: SourceCapabilities;
	policy: VenueSourcePolicy;
	assertCanRefresh(): void;
};

/** Protocol ids use underscores; venue files use kebab-case (`uniswap_v3` -> `uniswap-v3.ts`). */
export function venueAdapterFileName(protocol: string): string {
	return `${protocol.replaceAll("_", "-")}.ts`;
}

type ResolvedVenue = {
	chain: string;
	protocol: string;
	status: VenueStatus;
	label: string;
	policy: VenueSourcePolicy;
};

function requireVenuePolicy(
	chain: string,
	protocol: string,
	missingMessage: string,
	runtime: RuntimeVenues = {},
): ResolvedVenue {
	const venue = runtime.solanaDlmm
		? productCatalog(runtime).venues.find((v) => v.chain === chain && v.protocol === protocol)
		: findVenue(chain, protocol);
	const policy = venueSourcePolicy(chain, protocol, runtime);
	if (!venue || !policy) {
		throw new Error(`${missingMessage}${chain}/${protocol}`);
	}
	return {
		chain: venue.chain,
		protocol: venue.protocol,
		status: venue.status,
		label: venue.label,
		policy,
	};
}

function blockedRefreshError(label: string): Error {
	return new Error(`${label} 尚未启用，不得拉取生产数据。`);
}

export function createReadyAdapter(
	chain: string,
	protocol: string,
	runtime: RuntimeVenues = {},
): VenueAdapter {
	const venue = requireVenuePolicy(chain, protocol, "已启用场所缺少目录或数据路径政策：", runtime);
	if (venue.status !== VENUE_STATUS_ENABLED || venue.policy.ingest === "not_started") {
		throw new Error(`未启用场所不得注册为 ready 适配器：${chain}/${protocol}`);
	}
	return {
		chain: venue.chain,
		protocol: venue.protocol,
		status: venue.status,
		ingest: venue.policy.ingest,
		kind: "ready",
		policy: venue.policy,
		capabilities: venueSourceCapabilities(chain, protocol, runtime),
		assertCanRefresh() {
			if (venue.status !== VENUE_STATUS_ENABLED || venue.policy.ingest === "not_started") {
				throw blockedRefreshError(venue.label);
			}
		},
	};
}

/** Each listed venue keeps its own file that calls this factory. Do not collapse placeholders into one module. */
export function createPlaceholderAdapter(chain: string, protocol: string): VenueAdapter {
	const venue = requireVenuePolicy(chain, protocol, "目录或数据路径政策缺少场所：");
	if (venue.status === VENUE_STATUS_ENABLED) {
		throw new Error(`已启用场所不得使用占位适配器：${chain}/${protocol}`);
	}
	return {
		chain: venue.chain,
		protocol: venue.protocol,
		status: venue.status,
		ingest: venue.policy.ingest,
		kind: "placeholder",
		policy: venue.policy,
		capabilities: venueSourceCapabilities(chain, protocol),
		assertCanRefresh() {
			throw blockedRefreshError(venue.label);
		},
	};
}
