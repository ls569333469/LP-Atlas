export type QuoteAsset = "ETH" | "HYPE";

export type UsdQuote = {
	assetId: QuoteAsset;
	priceUsd: string;
	sourceId: "redstone_push";
	feedId: string;
	publishedAt: number;
	fetchedAt: string;
	sourceChainId: number;
	sourceBlockNumber: string;
	sourceBlockTimestamp: number;
	targetAt: number;
	sourceVersion: number;
};

export type UsdQuoteSource = {
	getQuote(assetId: QuoteAsset, targetAt: number): Promise<UsdQuote>;
};

export const USD_VALUATION_VERSION = 2;
