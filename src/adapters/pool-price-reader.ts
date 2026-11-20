import type { Address, ContractFunctionParameters, PublicClient } from "viem";
import { classifyRpcError } from "./errors.ts";
import { withRetry } from "./retry.ts";
import { forEachRpcBatch, withRpcCategory } from "./rpc-budget.ts";

export type PoolPrice = { sqrtPriceX96: bigint };
export type PoolQuote = PoolPrice & { liquidity: bigint };

/** One refresh owns this cache; historical states are never shared across blocks. */
export function createPoolPriceReader(config: {
	multicallAddress: Address;
	batchSize: number;
	stateConcurrency?: number;
	slotCall: (id: string) => ContractFunctionParameters;
	liquidityCall: (id: string) => ContractFunctionParameters;
}) {
	const blocks = new Map<bigint, Map<string, PoolPrice & { liquidity?: bigint }>>();
	function cache(block: bigint) {
		const values = blocks.get(block) ?? new Map<string, PoolPrice & { liquidity?: bigint }>();
		blocks.delete(block);
		blocks.set(block, values);
		const oldest = blocks.keys().next().value;
		if (blocks.size > 3 && oldest !== undefined) blocks.delete(oldest);
		return values;
	}
	function seed(block: bigint, states: ReadonlyMap<string, PoolPrice & { liquidity?: bigint }>) {
		const values = cache(block);
		for (const [id, state] of states)
			values.set(id.toLowerCase(), {
				sqrtPriceX96: state.sqrtPriceX96,
				...(state.liquidity === undefined ? {} : { liquidity: state.liquidity }),
			});
	}
	async function read(client: PublicClient, ids: string[], block: bigint, quote: boolean) {
		const values = cache(block);
		const needed = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) =>
			quote ? values.get(id)?.liquidity === undefined : !values.has(id),
		);
		await forEachRpcBatch(needed, config.batchSize, config.stateConcurrency ?? 1, async (batch) => {
			const requests = batch.flatMap((id) => [
				...(!values.has(id) ? [{ id, field: "price" as const, call: config.slotCall(id) }] : []),
				...(quote && values.get(id)?.liquidity === undefined
					? [{ id, field: "liquidity" as const, call: config.liquidityCall(id) }]
					: []),
			]);
			try {
				const results = await withRetry(() =>
					withRpcCategory("state", () =>
						client.multicall({
							contracts: requests.map((item) => item.call),
							batchSize: 16384,
							allowFailure: true,
							blockNumber: block,
							multicallAddress: config.multicallAddress,
						}),
					),
				);
				const failed = results.flatMap((result, index) =>
					result.status === "failure" ? [index] : [],
				);
				if (failed.length > 0) {
					const retried = await withRetry(() =>
						withRpcCategory("state", () =>
							client.multicall({
								contracts: requests
									.filter((_request, index) => failed.includes(index))
									.map((request) => request.call),
								batchSize: 16384,
								allowFailure: true,
								blockNumber: block,
								multicallAddress: config.multicallAddress,
							}),
						),
					).catch(() => []);
					for (const [position, index] of failed.entries()) {
						const result = retried[position];
						if (result) results[index] = result;
					}
				}
				const liquidity = new Map<string, bigint>();
				for (const [index, request] of requests.entries()) {
					const result = results[index];
					if (result?.status !== "success") continue;
					if (request.field === "liquidity" && typeof result.result === "bigint") {
						liquidity.set(request.id, result.result);
					} else if (
						request.field === "price" &&
						Array.isArray(result.result) &&
						typeof result.result[0] === "bigint"
					) {
						values.set(request.id, { ...values.get(request.id), sqrtPriceX96: result.result[0] });
					}
				}
				for (const [id, amount] of liquidity) {
					const state = values.get(id);
					if (state) values.set(id, { ...state, liquidity: amount });
				}
			} catch (error) {
				throw classifyRpcError(error);
			}
		});
		return values;
	}
	return {
		seed,
		async readBoundaries(
			client: PublicClient,
			ids: string[],
			block: bigint,
		): Promise<Map<string, PoolPrice>> {
			const values = await read(client, ids, block, false);
			return new Map(
				ids.flatMap((id) => {
					const state = values.get(id.toLowerCase());
					return state ? [[id.toLowerCase(), { sqrtPriceX96: state.sqrtPriceX96 }] as const] : [];
				}),
			);
		},
		async readQuotes(
			client: PublicClient,
			ids: string[],
			block: bigint,
		): Promise<Map<string, PoolQuote>> {
			const values = await read(client, ids, block, true);
			return new Map(
				ids.flatMap((id) => {
					const state = values.get(id.toLowerCase());
					return state?.liquidity !== undefined
						? [
								[
									id.toLowerCase(),
									{ sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity },
								] as const,
							]
						: [];
				}),
			);
		},
	};
}
