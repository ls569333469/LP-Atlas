import Decimal from "decimal.js";
import { ELYSIUM_USDC_ADDRESS, ELYSIUM_WHYPE_ADDRESS, ZERO_ADDRESS } from "../shared/constants.ts";

const Q96 = new Decimal(2).pow(96);

export function rawPriceToken1PerToken0(sqrtPriceX96: bigint): Decimal {
	return new Decimal(sqrtPriceX96.toString()).div(Q96).pow(2);
}

export function usdPerRawUnit(usdPerHuman: Decimal, decimals: number): Decimal {
	return usdPerHuman.div(new Decimal(10).pow(decimals));
}

export function humanAmount(raw: bigint, decimals: number): Decimal {
	return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals));
}

export function isOfficialUsdStable(address: string): boolean {
	return address.toLowerCase() === ELYSIUM_USDC_ADDRESS.toLowerCase();
}

export function isHypeLike(address: string): boolean {
	const lower = address.toLowerCase();
	return lower === ZERO_ADDRESS.toLowerCase() || lower === ELYSIUM_WHYPE_ADDRESS.toLowerCase();
}

export type PricedPool = {
	poolId?: string;
	token0: string;
	token1: string;
	sqrtPriceX96: bigint;
	liquidity: bigint;
};

export type UsdPricePolicy = {
	stable: readonly string[];
	wrappedNative?: string;
	requireLiquidity?: boolean;
	rootPrices?: ReadonlyMap<string, Decimal>;
	lockedTokens?: ReadonlySet<string>;
	quote?: import("../shared/usd-quotes.ts").UsdQuote;
	valuationVersion?: number;
};
export const ELYSIUM_PRICE_POLICY: UsdPricePolicy = {
	stable: [ELYSIUM_USDC_ADDRESS],
	wrappedNative: ELYSIUM_WHYPE_ADDRESS,
};

/**
 * Builds USD prices from the venue policy's stable anchors, using pool mid prices.
 * Native and official wrapped-native prices are shared according to that same policy.
 */
export function buildUsdPrices(
	pools: readonly PricedPool[],
	decimals: Map<string, number>,
	existing?: ReadonlyMap<string, Decimal>,
	policy: UsdPricePolicy = ELYSIUM_PRICE_POLICY,
): Map<string, Decimal> {
	const prices = new Map<string, Decimal>(existing);
	for (const token of policy.lockedTokens ?? []) prices.delete(token);
	for (const [token, price] of policy.rootPrices ?? []) prices.set(token, price);
	for (const address of policy.stable) prices.set(address.toLowerCase(), new Decimal(1));

	const ranked = [...pools].sort((a, b) => {
		if (a.liquidity === b.liquidity) {
			return 0;
		}
		return a.liquidity > b.liquidity ? -1 : 1;
	});

	let changed = true;
	let guard = 0;
	while (changed && guard < 32) {
		changed = false;
		guard += 1;
		shareNativePrice(prices, policy.wrappedNative);
		for (const pool of ranked) {
			if (pool.sqrtPriceX96 === 0n || (policy.requireLiquidity && pool.liquidity <= 0n)) {
				continue;
			}
			const token0 = pool.token0.toLowerCase();
			const token1 = pool.token1.toLowerCase();
			const dec0 = decimals.get(token0);
			const dec1 = decimals.get(token1);
			if (dec0 === undefined || dec1 === undefined) {
				continue;
			}
			const raw = rawPriceToken1PerToken0(pool.sqrtPriceX96);
			if (raw.lte(0) || !raw.isFinite()) {
				continue;
			}
			const price0 = prices.get(token0);
			const price1 = prices.get(token1);
			if (price0 && !price1 && !policy.lockedTokens?.has(token1)) {
				// token1 human USD = token0 human USD / (raw * 10^(dec0-dec1))
				const token1PerToken0Human = raw.mul(new Decimal(10).pow(dec0 - dec1));
				if (token1PerToken0Human.gt(0)) {
					prices.set(token1, price0.div(token1PerToken0Human));
					changed = true;
				}
			} else if (price1 && !price0 && !policy.lockedTokens?.has(token0)) {
				const token1PerToken0Human = raw.mul(new Decimal(10).pow(dec0 - dec1));
				prices.set(token0, price1.mul(token1PerToken0Human));
				changed = true;
			}
		}
		shareNativePrice(prices, policy.wrappedNative);
	}
	return prices;
}

function shareNativePrice(prices: Map<string, Decimal>, wrappedAddress?: string): void {
	if (!wrappedAddress) return;
	const native = ZERO_ADDRESS.toLowerCase();
	const wrapped = wrappedAddress.toLowerCase();
	const nativePrice = prices.get(native);
	const wrappedPrice = prices.get(wrapped);
	if (nativePrice && !wrappedPrice) {
		prices.set(wrapped, nativePrice);
	} else if (wrappedPrice && !nativePrice) {
		prices.set(native, wrappedPrice);
	}
}

export function valueRawUsd(
	amount: bigint,
	token: string,
	prices: Map<string, Decimal>,
	decimals: Map<string, number>,
): Decimal | null {
	if (amount === 0n) {
		return new Decimal(0);
	}
	const price = prices.get(token.toLowerCase());
	const dec = decimals.get(token.toLowerCase());
	if (!price || dec === undefined) {
		return null;
	}
	return humanAmount(amount, dec).mul(price);
}

export function sumUsd(left: Decimal | null, right: Decimal | null): Decimal | null {
	if (left && right) {
		return left.plus(right);
	}
	return null;
}
