import Decimal from "decimal.js";
import type { DlmmFilters, DlmmRangeKey } from "../shared/dlmm-filters.ts";
import type { MeteoraPoolMetadata, MeteoraTokenDetails } from "../shared/meteora.ts";

const EMPTY_REWARD_MINT = "11111111111111111111111111111111";

export function matchesDlmmFilters(pool: MeteoraPoolMetadata, filters: DlmmFilters): boolean {
	const range = (field: DlmmRangeKey, value: string | number | null | undefined): boolean => {
		const min = filters[`${field}Min`];
		const max = filters[`${field}Max`];
		if (min === undefined && max === undefined) return true;
		if (value == null) return false;
		const number = new Decimal(value);
		return (min === undefined || number.gte(min)) && (max === undefined || number.lte(max));
	};
	const exact = (field: keyof DlmmFilters, value: string | number | boolean | null): boolean =>
		filters[field] === undefined || (value !== null && filters[field] === String(value));
	const stats = pool.reportedStatistics;
	const window = filters.officialWindow ?? "1h";
	if (
		!range("baseFee", pool.baseFeePercent) ||
		!range("binStep", pool.binStep) ||
		!exact("mode", pool.collectFeeMode) ||
		!exact("farm", pool.hasFarm) ||
		!exact("launchpad", pool.launchpad) ||
		!exact("blacklisted", pool.isBlacklisted) ||
		!exact("pairType", pool.pairType) ||
		!range("protocolFee", pool.protocolFeePercent) ||
		!range("poolPrice", pool.currentPrice) ||
		!range("amountX", pool.tokenXAmount) ||
		!range("amountY", pool.tokenYAmount) ||
		!exact("reserveX", pool.reserveX) ||
		!exact("reserveY", pool.reserveY) ||
		(filters.rewardMint !== undefined &&
			(filters.rewardMint === EMPTY_REWARD_MINT ||
				(pool.rewardMintX !== filters.rewardMint && pool.rewardMintY !== filters.rewardMint))) ||
		!range("protocolFees", stats.protocolFees[window]) ||
		!range("feeTvlRatio", stats.feeTvlRatio[window]) ||
		!range("lifetimeVolume", stats.cumulative.volume) ||
		!range("lifetimeFees", stats.cumulative.fees)
	)
		return false;

	const matchesToken = (token: MeteoraTokenDetails): boolean =>
		range("marketCap", token.marketCapUsd) &&
		range("holders", token.holders) &&
		range("tokenPrice", token.priceUsd) &&
		range("supply", token.totalSupply) &&
		range("decimals", token.decimals) &&
		exact("verified", token.isVerified) &&
		exact("freezeDisabled", token.freezeAuthorityDisabled);
	switch (filters.side) {
		case "x":
			return matchesToken(pool.tokenX);
		case "y":
			return matchesToken(pool.tokenY);
		case "both":
			return matchesToken(pool.tokenX) && matchesToken(pool.tokenY);
		default:
			return matchesToken(pool.tokenX) || matchesToken(pool.tokenY);
	}
}
