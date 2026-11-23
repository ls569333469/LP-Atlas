import Decimal from "decimal.js";
import type { TokenFdv } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";

type Reader = Pick<AppDatabase, "execute">;
export const SUPPLY_TTL_MS = 24 * 60 * 60 * 1000;

export type TokenPriceObservation = {
	address: string;
	decimals: number;
	priceUsd: string;
	priceObservedAt: string;
	source: Exclude<TokenFdv["source"], "meteora">;
};

export async function saveEvmFdvPublication(
	db: Reader,
	chain: string,
	asOf: string,
	candidates: TokenPriceObservation[],
) {
	const candidateJson = JSON.stringify(candidates);
	const supplies = candidates.length
		? (await db.execute({
			sql: `SELECT address, raw_supply, observed_at FROM evm_token_supply
				WHERE chain = ? AND address IN (SELECT json_extract(value, '$.address') FROM json_each(?))
				AND observed_at > ? AND observed_at <= ?`,
			args: [chain, candidateJson, new Date(Date.parse(asOf) - SUPPLY_TTL_MS).toISOString(), asOf],
		})).rows
		: [];
	const byAddress = new Map(supplies.map((supply) => [String(supply.address), supply]));
	const valuations: Record<string, TokenFdv> = {};
	for (const token of candidates) {
		const supply = byAddress.get(token.address);
		if (typeof supply?.raw_supply !== "string" || typeof supply.observed_at !== "string") continue;
		valuations[token.address] = {
			fdvUsd: new Decimal(supply.raw_supply).div(new Decimal(10).pow(token.decimals)).times(token.priceUsd).toFixed(),
			priceObservedAt: token.priceObservedAt,
			supplyObservedAt: supply.observed_at,
			source: token.source,
		};
	}
	await db.execute({
		sql: `INSERT INTO evm_fdv_publication (chain, as_of, candidates, valuations) VALUES (?, ?, ?, ?)
			ON CONFLICT (chain) DO UPDATE SET as_of = excluded.as_of, candidates = excluded.candidates,
				valuations = excluded.valuations WHERE excluded.as_of >= evm_fdv_publication.as_of`,
		args: [chain, asOf, candidateJson, JSON.stringify(valuations)],
	});
}

export async function readEvmFdvPublication(db: Reader, chain: string, asOf: string): Promise<Record<string, TokenFdv>> {
	const { rows } = await db.execute({
		sql: "SELECT valuations FROM evm_fdv_publication WHERE chain = ? AND as_of = ?",
		args: [chain, asOf],
	});
	return typeof rows[0]?.valuations === "string" ? JSON.parse(rows[0].valuations) : {};
}
