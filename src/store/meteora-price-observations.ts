import Decimal from "decimal.js";
import type { MeteoraPoolMetadata } from "../shared/meteora.ts";
import { solanaPoolStorageKey } from "../shared/pool-identity.ts";
import type { AppDatabase } from "./db.ts";

export const METEORA_PRICE_MAX_AGE_MS = 5 * 60 * 1000;
const RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

type PriceSample = {
	observedAt: number;
	tokenX: string;
	tokenY: string;
	price: string | null;
};

export async function saveMeteoraPriceObservations(
	db: Pick<AppDatabase, "execute">,
	pools: MeteoraPoolMetadata[],
	asOf: string,
): Promise<void> {
	const samples = pools.flatMap((pool) =>
		pool.priceObservedAt !== undefined
			? [
					[
						solanaPoolStorageKey("meteora_dlmm", pool.address),
						pool.priceObservedAt,
						pool.tokenX.address,
						pool.tokenY.address,
						pool.currentPrice !== null && new Decimal(pool.currentPrice).gt(0)
							? pool.currentPrice
							: null,
					],
				]
			: [],
	);
	await db.execute({
		sql: `INSERT OR IGNORE INTO meteora_price_observations
			(pool_id, observed_at_ms, token_x, token_y, price_y_per_x)
			SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
				json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
			FROM json_each(?)`,
		args: [JSON.stringify(samples)],
	});
	await db.execute({
		sql: "DELETE FROM meteora_price_observations WHERE observed_at_ms < ?",
		args: [Date.parse(asOf) - RETENTION_MS],
	});
}

/** Read only the small intervals around the requested boundaries, in one statement. */
export async function readMeteoraPriceObservations(
	db: Pick<AppDatabase, "execute">,
	targets: readonly number[],
): Promise<Map<string, PriceSample[]>> {
	const result = new Map<string, PriceSample[]>();
	if (!targets.length) return result;
	const rows = await db.execute({
		sql: `SELECT DISTINCT p.pool_id, p.observed_at_ms, p.token_x, p.token_y, p.price_y_per_x
			FROM json_each(?) t CROSS JOIN meteora_price_observations p
			WHERE p.observed_at_ms BETWEEN t.value - ? AND t.value
			ORDER BY p.observed_at_ms DESC`,
		args: [JSON.stringify(targets), METEORA_PRICE_MAX_AGE_MS],
	});
	for (const row of rows.rows) {
		const key = String(row.pool_id);
		const samples = result.get(key) ?? [];
		samples.push({
			observedAt: Number(row.observed_at_ms),
			tokenX: String(row.token_x),
			tokenY: String(row.token_y),
			price: row.price_y_per_x === null ? null : String(row.price_y_per_x),
		});
		result.set(key, samples);
	}
	return result;
}

export function meteoraPriceAt(
	samples: readonly PriceSample[],
	target: number,
	pool: MeteoraPoolMetadata,
): (PriceSample & { price: string }) | undefined {
	if (pool.createdAtUnix !== null && target < pool.createdAtUnix * 1000) return;
	const sample = samples.find((entry) => entry.observedAt <= target && entry.price !== null);
	if (
		sample &&
		sample.price !== null &&
		target - sample.observedAt <= METEORA_PRICE_MAX_AGE_MS &&
		(pool.createdAtUnix === null || sample.observedAt >= pool.createdAtUnix * 1000) &&
		sample.tokenX === pool.tokenX.address &&
		sample.tokenY === pool.tokenY.address
	)
		return { ...sample, price: sample.price };
}
