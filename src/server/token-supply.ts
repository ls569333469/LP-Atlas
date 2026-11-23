import { type Address, parseAbi, type PublicClient } from "viem";
import { MULTICALL3_ADDRESS } from "../shared/constants.ts";
import type { AppDatabase } from "../store/db.ts";
import { SUPPLY_TTL_MS } from "../store/token-fdv.ts";

const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);
const BATCH_SIZE = 20;
const INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 90 * 1000;
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const REFRESH_AHEAD_MS = 60 * 60 * 1000;

export function startTokenSupplyTask(input: {
	db: AppDatabase;
	chains: { chain: string; client: PublicClient }[];
	isScanning(chain: string): boolean;
	onBatch(chain: string, attempted: number, saved: number): void;
	onError(chain: string, error: unknown): void;
}) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout>;
	let pending: Promise<void> | undefined;

	async function collect(chain: string, client: PublicClient) {
		const now = new Date().toISOString();
		const { rows } = await input.db.execute({
			sql: `SELECT json_extract(t.value, '$.address') AS address
				FROM evm_fdv_publication p, json_each(p.candidates) t
				LEFT JOIN evm_token_supply s ON s.chain = p.chain AND s.address = json_extract(t.value, '$.address')
				WHERE p.chain = ? AND (s.retry_at IS NULL OR s.retry_at <= ?)
				ORDER BY COALESCE(s.observed_at, ''), address LIMIT ?`,
			args: [chain, now, BATCH_SIZE],
		});
		if (stopped || input.isScanning(chain) || !rows.length) return;
		const addresses = rows.map((row) => String(row.address) as Address);
		const results = await client.multicall({
			contracts: addresses.map((address) => ({ address, abi: supplyAbi, functionName: "totalSupply" as const })),
			multicallAddress: MULTICALL3_ADDRESS as Address,
			allowFailure: true,
		}).catch((error: unknown) => {
			input.onError(chain, error);
			return [];
		});
		if (stopped) return;
		const observedAt = Date.now();
		let saved = 0;
		await input.db.batch(addresses.map((address, index) => {
			const result = results[index];
			const raw = result?.status === "success" ? result.result.toString() : null;
			if (raw !== null) saved++;
			return {
				sql: `INSERT INTO evm_token_supply (chain, address, raw_supply, observed_at, retry_at)
					VALUES (?, ?, ?, ?, ?) ON CONFLICT (chain, address) DO UPDATE SET
					raw_supply = COALESCE(excluded.raw_supply, evm_token_supply.raw_supply),
					observed_at = COALESCE(excluded.observed_at, evm_token_supply.observed_at),
					retry_at = excluded.retry_at`,
				args: [
					chain, address, raw, raw === null ? null : new Date(observedAt).toISOString(),
					new Date(observedAt + (raw === null ? FAILURE_BACKOFF_MS : SUPPLY_TTL_MS - REFRESH_AHEAD_MS)).toISOString(),
				],
			};
		}), "write");
		input.onBatch(chain, addresses.length, saved);
	}

	async function run() {
		for (const { chain, client } of input.chains) {
			if (stopped || input.isScanning(chain)) continue;
			await collect(chain, client).catch((error: unknown) => input.onError(chain, error));
		}
	}
	function tick() {
		pending = run().finally(() => {
			if (stopped) return;
			timer = setTimeout(tick, INTERVAL_MS);
			timer.unref();
		});
	}
	timer = setTimeout(tick, INITIAL_DELAY_MS);
	timer.unref();

	return async () => {
		stopped = true;
		clearTimeout(timer);
		await pending;
	};
}
