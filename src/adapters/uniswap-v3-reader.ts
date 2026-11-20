import type { Address, Log, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { v3FactoryAbi, v3PoolAbi } from "./abi.ts";
import { classifyRpcError } from "./errors.ts";
import { splitV3SwapFee, unpackV3FeeProtocol } from "./fees.ts";
import { getLogsInAddressBatches, getLogsPaginated } from "./logs.ts";
import { createPoolPriceReader } from "./pool-price-reader.ts";
import { withRetry } from "./retry.ts";
import { forEachRpcBatch, withRpcCategory } from "./rpc-budget.ts";
import type { DecodedSwap, DiscoveredPool, V3PoolState } from "./types.ts";

/** Shared Uniswap event/state reads; the venue supplies only verified deployment addresses. */
export function createUniswapV3Reader(config: {
	factory: Address;
	multicallAddress: Address;
	storagePrefix?: string;
	discoveryChunkSize?: bigint;
	swapChunkSize?: bigint;
	swapConcurrency?: number;
	stateConcurrency?: number;
}) {
	const factory = config.factory;
	const storageId = (id: string) => `${config.storagePrefix ?? ""}${id.toLowerCase()}`;
	const poolCreatedEvent = v3FactoryAbi[0];
	const swapEvent = v3PoolAbi[0];

	function decodeV3PoolCreatedLog(log: {
		topics: [Address | `0x${string}`, ...`0x${string}`[]] | `0x${string}`[];
		data: `0x${string}`;
		blockNumber?: bigint | `0x${string}` | null;
	}): DiscoveredPool {
		const topics = log.topics as [`0x${string}`, ...`0x${string}`[]];
		const decoded = decodeEventLog({
			abi: v3FactoryAbi,
			data: log.data,
			topics,
		});
		if (decoded.eventName !== "PoolCreated") {
			throw new Error("expected PoolCreated");
		}
		const { token0, token1, fee, tickSpacing, pool } = decoded.args;
		const createdBlock =
			typeof log.blockNumber === "bigint" ? log.blockNumber : BigInt(log.blockNumber ?? 0);
		return {
			poolId: storageId(pool),
			protocol: "uniswap_v3",
			token0,
			token1,
			feePips: Number(fee),
			tickSpacing: Number(tickSpacing),
			hooks: null,
			poolAddress: pool,
			createdBlock,
		};
	}

	function decodeV3SwapLog(
		log: {
			address: Address;
			topics: `0x${string}`[];
			data: `0x${string}`;
			blockNumber?: bigint | `0x${string}` | null;
			logIndex?: number | bigint | `0x${string}` | null;
			blockTimestamp?: `0x${string}` | bigint | null;
		},
		context: { feePips: number; feeProtocol0: number; feeProtocol1: number },
	): DecodedSwap {
		const decoded = decodeEventLog({
			abi: v3PoolAbi,
			data: log.data,
			topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
		});
		if (decoded.eventName !== "Swap") {
			throw new Error("expected Swap");
		}
		const split = splitV3SwapFee({
			amount0: decoded.args.amount0,
			amount1: decoded.args.amount1,
			feePips: context.feePips,
			feeProtocol0: context.feeProtocol0,
			feeProtocol1: context.feeProtocol1,
		});
		if (!split) {
			throw new Error("swap had no input amount");
		}
		const blockNumber =
			typeof log.blockNumber === "bigint" ? log.blockNumber : BigInt(log.blockNumber ?? 0);
		const logIndex = typeof log.logIndex === "number" ? log.logIndex : Number(log.logIndex ?? 0);
		const timestamp = log.blockTimestamp === undefined ? null : Number(log.blockTimestamp);
		return {
			poolId: storageId(log.address),
			protocol: "uniswap_v3",
			blockNumber,
			logIndex,
			timestamp,
			amount0: decoded.args.amount0,
			amount1: decoded.args.amount1,
			sqrtPriceX96: decoded.args.sqrtPriceX96,
			feePips: context.feePips,
			lpFee: split.lpFee,
			protocolFee: split.protocolFee,
			inputIsToken0: split.inputIsToken0,
		};
	}

	async function discoverV3Pools(
		client: PublicClient,
		fromBlock: bigint,
		toBlock: bigint,
		deadlineAtMs?: number,
	): Promise<DiscoveredPool[]> {
		const logs = await getLogsPaginated({
			client,
			address: factory,
			event: poolCreatedEvent,
			fromBlock,
			toBlock,
			chunkSize: config.discoveryChunkSize ?? 2_000_000n,
			deadlineAtMs,
		});
		return logs.map((log) => decodeV3PoolCreatedLog(log));
	}

	/** Logs are subsequently matched to this venue's official factory catalog before decoding. */
	async function loadV3SwapLogs(
		client: PublicClient,
		fromBlock: bigint,
		toBlock: bigint,
	): Promise<Log[]> {
		return getLogsPaginated({
			client,
			event: swapEvent,
			fromBlock,
			toBlock,
			chunkSize: config.swapChunkSize ?? 8_000n,
			concurrency: config.swapConcurrency,
		});
	}

	async function loadV3Swaps(
		client: PublicClient,
		pools: Array<{
			poolAddress: Address;
			feePips: number;
			feeProtocol0: number;
			feeProtocol1: number;
		}>,
		fromBlock: bigint,
		toBlock: bigint,
		deadlineAtMs?: number,
		prefetchedLogs?: readonly Log[],
	): Promise<DecodedSwap[]> {
		if (pools.length === 0) {
			return [];
		}
		const byAddress = new Map(pools.map((pool) => [pool.poolAddress.toLowerCase(), pool]));
		const logs =
			prefetchedLogs ??
			(await getLogsInAddressBatches({
				client,
				addresses: pools.map((pool) => pool.poolAddress),
				event: swapEvent,
				fromBlock,
				toBlock,
				chunkSize: 50_000n,
				deadlineAtMs,
			}));
		const swaps: DecodedSwap[] = [];
		for (const log of logs) {
			const pool = byAddress.get(log.address.toLowerCase());
			if (!pool) {
				continue;
			}
			try {
				swaps.push(
					decodeV3SwapLog(log, {
						feePips: pool.feePips,
						feeProtocol0: pool.feeProtocol0,
						feeProtocol1: pool.feeProtocol1,
					}),
				);
			} catch {
				// Skip a zero-amount or malformed swap rather than failing the refresh.
			}
		}
		return swaps;
	}

	async function readV3PoolStates(
		client: PublicClient,
		pools: Array<{ poolAddress: Address; token0: Address; token1: Address }>,
		blockNumber?: bigint,
	): Promise<Map<string, V3PoolState>> {
		const states = new Map<string, V3PoolState>();
		const batchSize = 40;
		await forEachRpcBatch(pools, batchSize, config.stateConcurrency ?? 1, async (batch) => {
			const contracts = batch.flatMap((pool) => [
				{ address: pool.poolAddress, abi: v3PoolAbi, functionName: "slot0" as const },
				{ address: pool.poolAddress, abi: v3PoolAbi, functionName: "liquidity" as const },
				{
					address: pool.token0,
					abi: [
						{
							type: "function",
							name: "balanceOf",
							stateMutability: "view",
							inputs: [{ name: "account", type: "address" }],
							outputs: [{ type: "uint256" }],
						},
					] as const,
					functionName: "balanceOf" as const,
					args: [pool.poolAddress] as const,
				},
				{
					address: pool.token1,
					abi: [
						{
							type: "function",
							name: "balanceOf",
							stateMutability: "view",
							inputs: [{ name: "account", type: "address" }],
							outputs: [{ type: "uint256" }],
						},
					] as const,
					functionName: "balanceOf" as const,
					args: [pool.poolAddress] as const,
				},
			]);
			try {
				const results = await withRetry(() =>
					withRpcCategory("state", () =>
						client.multicall({
							contracts,
							batchSize: 16384,
							allowFailure: true,
							blockNumber,
							multicallAddress: config.multicallAddress,
						}),
					),
				);
				// allowFailure also wraps transport failures as individual failed results.
				// Retry just those calls once instead of silently caching a missing state.
				const failed = results.flatMap((result, index) =>
					result.status === "failure" ? [index] : [],
				);
				if (failed.length > 0) {
					const retried = await withRetry(() =>
						withRpcCategory("state", () =>
							client.multicall({
								contracts: contracts.filter((_contract, index) => failed.includes(index)),
								batchSize: 16384,
								allowFailure: true,
								blockNumber,
								multicallAddress: config.multicallAddress,
							}),
						),
					).catch(() => []);
					for (const [position, index] of failed.entries()) {
						const result = retried[position];
						if (result) results[index] = result;
					}
				}
				for (let index = 0; index < batch.length; index += 1) {
					const pool = batch[index];
					if (!pool) {
						continue;
					}
					const slot0 = results[index * 4];
					const liquidity = results[index * 4 + 1];
					const balance0 = results[index * 4 + 2];
					const balance1 = results[index * 4 + 3];
					if (
						!slot0 ||
						!liquidity ||
						!balance0 ||
						!balance1 ||
						slot0.status !== "success" ||
						liquidity.status !== "success" ||
						balance0.status !== "success" ||
						balance1.status !== "success"
					) {
						continue;
					}
					const slot = readV3Slot0(slot0.result);
					const liquidityValue = readBigIntResult(liquidity.result);
					const amount0 = readBigIntResult(balance0.result);
					const amount1 = readBigIntResult(balance1.result);
					if (!slot || liquidityValue === null || amount0 === null || amount1 === null) {
						continue;
					}
					const protocol = unpackV3FeeProtocol(slot.feeProtocol);
					states.set(pool.poolAddress.toLowerCase(), {
						poolId: pool.poolAddress.toLowerCase(),
						sqrtPriceX96: slot.sqrtPriceX96,
						tick: slot.tick,
						liquidity: liquidityValue,
						feeProtocol0: protocol.feeProtocol0,
						feeProtocol1: protocol.feeProtocol1,
						amount0,
						amount1,
					});
				}
			} catch (error) {
				throw classifyRpcError(error);
			}
		});
		return new Map(
			pools.flatMap((pool) => {
				const id = pool.poolAddress.toLowerCase();
				const state = states.get(id);
				return state ? [[id, state] as const] : [];
			}),
		);
	}

	function readV3Slot0(
		result: unknown,
	): { sqrtPriceX96: bigint; tick: number; feeProtocol: number } | null {
		if (!Array.isArray(result) || result.length < 6) {
			return null;
		}
		const sqrtPriceX96 = result[0];
		const tick = result[1];
		const feeProtocol = result[5];
		if (
			typeof sqrtPriceX96 !== "bigint" ||
			typeof tick !== "number" ||
			typeof feeProtocol !== "number"
		) {
			return null;
		}
		return { sqrtPriceX96, tick, feeProtocol };
	}

	function readBigIntResult(result: unknown): bigint | null {
		return typeof result === "bigint" ? result : null;
	}

	function createPriceReader() {
		return createPoolPriceReader({
			multicallAddress: config.multicallAddress,
			batchSize: 40,
			stateConcurrency: config.stateConcurrency,
			slotCall: (id) => ({ address: id as Address, abi: v3PoolAbi, functionName: "slot0" }),
			liquidityCall: (id) => ({
				address: id as Address,
				abi: v3PoolAbi,
				functionName: "liquidity",
			}),
		});
	}

	return {
		createPriceReader,
		loadV3SwapLogs,
		decodeV3PoolCreatedLog,
		decodeV3SwapLog,
		discoverV3Pools,
		loadV3Swaps,
		readV3PoolStates,
	};
}
