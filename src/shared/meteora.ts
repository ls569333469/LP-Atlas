/** Parsed official DLMM fields, shared by persistence, API and detail views. */
export type MeteoraTokenDetails = {
	address: string;
	symbol: string;
	decimals: number;
	name: string | null;
	priceUsd: string | null;
	marketCapUsd: string | null;
	totalSupply: string | null;
	holders: number | null;
	isVerified: boolean | null;
	freezeAuthorityDisabled: boolean | null;
};

export type MeteoraPoolMetadata = {
	address: string;
	name: string | null;
	tokenX: MeteoraTokenDetails;
	tokenY: MeteoraTokenDetails;
	reserveX: string | null;
	reserveY: string | null;
	tokenXAmount: string | null;
	tokenYAmount: string | null;
	binStep: number | null;
	collectFeeMode: number | null;
	pairType: number | null;
	baseFeePercent: string | null;
	maxFeePercent: string | null;
	protocolFeePercent: string | null;
	dynamicFeePercent: string | null;
	currentTvlUsd: string;
	currentPrice: string | null;
	createdAtUnix: number | null;
	hasFarm: boolean | null;
	farmApr: string | null;
	farmApy: string | null;
	rewardMintX: string | null;
	rewardMintY: string | null;
	isBlacklisted: boolean | null;
	launchpad: string | null;
	tags: string[];
	/** Source statistics retain their native timeframe and never become local LP fees. */
	reportedStatistics: {
		volume: Record<string, string>;
		fees: Record<string, string>;
		protocolFees: Record<string, string>;
		feeTvlRatio: Record<string, string>;
		cumulative: Record<string, string>;
		apr: string | null;
		apy: string | null;
	};
	accountVerification: "unverified";
};
