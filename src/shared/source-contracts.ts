/** Source truth, not the HTTP wall clock. No source/provider is selected by this type. */
export type SourceObservation = {
	source: string;
	schemaVersion: string;
	observedAt: string;
	/** Local request start orders concurrent responses; it is not the source data cutoff. */
	requestStartedAt?: string;
	dataCutoff: string | null;
	finality: "unverified" | "finalized";
	feeAttribution: "unverified" | "ordinary_lp_verified";
	/** The reported hourly value was obtained, not proof of chain finality. */
	coverage?: "reported_hour";
};

export type SourceCapabilities =
	| { kind: "event_scan"; coverageScope: "venue"; rawAmounts: true; historicalState: "required" }
	| { kind: "official_index"; nativeWindows: readonly ("1h" | "1d")[] }
	| {
			kind: "not_started";
			candidate: "official_cumulative" | "events_and_state" | "unreviewed";
			coverage: "unverified";
			ordinaryLpFees: "unverified";
			historicalState: "unverified";
	  };

export function sourceObservation(value: unknown): SourceObservation {
	if (typeof value !== "object" || value === null) throw new Error("Missing source observation");
	const v = value as Record<string, unknown>;
	if (
		typeof v.source !== "string" ||
		!v.source ||
		typeof v.schemaVersion !== "string" ||
		!v.schemaVersion ||
		typeof v.observedAt !== "string" ||
		!Number.isFinite(Date.parse(v.observedAt)) ||
		(v.dataCutoff !== null &&
			(typeof v.dataCutoff !== "string" || !Number.isFinite(Date.parse(v.dataCutoff)))) ||
		(v.finality !== "unverified" && v.finality !== "finalized") ||
		(v.feeAttribution !== "unverified" && v.feeAttribution !== "ordinary_lp_verified") ||
		(v.coverage !== undefined && v.coverage !== "reported_hour")
	) {
		throw new Error("Invalid source observation");
	}
	if (typeof v.dataCutoff === "string" && Date.parse(v.dataCutoff) > Date.parse(v.observedAt)) {
		throw new Error("Source cutoff is later than observation");
	}
	if (
		v.requestStartedAt !== undefined &&
		(typeof v.requestStartedAt !== "string" ||
			!Number.isFinite(Date.parse(v.requestStartedAt)) ||
			Date.parse(v.requestStartedAt) > Date.parse(v.observedAt))
	) {
		throw new Error("Invalid source request start");
	}
	return {
		source: v.source,
		schemaVersion: v.schemaVersion,
		observedAt: v.observedAt,
		...(v.requestStartedAt === undefined ? {} : { requestStartedAt: v.requestStartedAt as string }),
		dataCutoff: v.dataCutoff as string | null,
		finality: v.finality,
		feeAttribution: v.feeAttribution,
		...(v.coverage === undefined ? {} : { coverage: "reported_hour" as const }),
	};
}

export function assertSourceCompletion(
	observation: SourceObservation,
	complete: boolean,
	end: number,
): void {
	if (
		complete &&
		(observation.dataCutoff === null ||
			observation.finality !== "finalized" ||
			Date.parse(observation.dataCutoff) < end * 1000)
	)
		throw new Error("Unverified source coverage cannot be complete");
}

/** Source cursors are not interchangeable and are advanced only by a committed batch. */
export type SourceCursor =
	| { kind: "evm_block"; chain: string; committedBlock: string }
	| { kind: "solana_events"; chain: "solana"; finalizedSlot: string; signature: string | null }
	| {
			kind: "official_hour_revision";
			chain: string;
			poolStorageKey: string;
			hourStart: number;
			sourceRevision: string | null;
	  };
