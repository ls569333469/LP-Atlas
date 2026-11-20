import type { Address, Hex, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { ZERO_ADDRESS } from "../shared/constants.ts";
import { reservesLensAbi, stateViewAbi, v4PoolManagerAbi } from "./abi.ts";
import { classifyRpcError, errorText } from "./errors.ts";
import { splitV4SwapFee, unpackV4ProtocolFee } from "./fees.ts";
import { hookHasReturnDelta } from "./hooks.ts";
import { getLogsPaginated } from "./logs.ts";
import { createPoolPriceReader } from "./pool-price-reader.ts";
import { isRetryableRpcError, withRetry } from "./retry.ts";
import { forEachRpcBatch, withRpcCategory } from "./rpc-budget.ts";
import type { DecodedSwap, DiscoveredPool, V4PoolState } from "./types.ts";

/** Shared Uniswap event/state reads; the venue supplies only verified deployment addresses. */
export function createUniswapV4Reader(config: {
	poolManager: Address;
	stateView: Address;
	reservesLens?: Address;
	multicallAddress: Address;
	storagePrefix?: string;
	swapChunkSize?: bigint;
	swapConcurrency?: number;
	stateConcurrency?: number;
	reserveConcurrency?: number;
}) {
	const poolManager = config.poolManager;
	const storageId = (id: string) => `${config.storagePrefix ?? ""}${id.toLowerCase()}`;
	const rawId = (id: string) => id.slice(id.lastIndexOf(":") + 1) as Hex;
	const stateView = config.stateView;
	const reservesLens = config.reservesLens;
	const initializeEvent = v4PoolManagerAbi[0];
	const swapEvent = v4PoolManagerAbi[1];

	function decodeV4InitializeLog(log: {
		topics: `0x${string}`[];
		data: `0x${string}`;
		blockNumber?: bigint | `0x${string}` | null;
	}): DiscoveredPool {
		const decoded = decodeEventLog({
			abi: v4PoolManagerAbi,
			data: log.data,
			topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
		});
		if (decoded.eventName !== "Initialize") {
			throw new Error("expected Initialize");
		}
		const createdBlock =
			typeof log.blockNumber === "bigint" ? log.blockNumber : BigInt(log.blockNumber ?? 0);
		return {
			poolId: storageId(decoded.args.id),
			protocol: "uniswap_v4",
			token0: decoded.args.currency0,
			token1: decoded.args.currency1,
			feePips: Number(decoded.args.fee),
			tickSpacing: Number(decoded.args.tickSpacing),
			hooks: decoded.args.hooks,
			poolAddress: null,
			createdBlock,
		};
	}

	function decodeV4SwapLog(
		log: {
			topics: `0x${string}`[];
			data: `0x${string}`;
			blockNumber?: bigint | `0x${string}` | null;
			logIndex?: number | bigint | `0x${string}` | null;
			blockTimestamp?: `0x${string}` | bigint | null;
		},
		protocolFeeForDirection: (zeroForOne: boolean) => number,
	): DecodedSwap {
		const decoded = decodeEventLog({
			abi: v4PoolManagerAbi,
			data: log.data,
			topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
		});
		if (decoded.eventName !== "Swap") {
			throw new Error("expected Swap");
		}
		const amount0 = BigInt(decoded.args.amount0);
		const amount1 = BigInt(decoded.args.amount1);
		const inputIsToken0 = amount0 < 0n;
		const protocolFeePips = protocolFeeForDirection(inputIsToken0);
		const split = splitV4SwapFee({
			amount0,
			amount1,
			swapFeePips: Number(decoded.args.fee),
			protocolFeePips,
		});
		if (!split) {
			throw new Error("swap had no input amount");
		}
		return {
			poolId: storageId(decoded.args.id),
			protocol: "uniswap_v4",
			blockNumber:
				typeof log.blockNumber === "bigint" ? log.blockNumber : BigInt(log.blockNumber ?? 0),
			logIndex: typeof log.logIndex === "number" ? log.logIndex : Number(log.logIndex ?? 0),
			timestamp: log.blockTimestamp === undefined ? null : Number(log.blockTimestamp),
			amount0,
			amount1,
			sqrtPriceX96: decoded.args.sqrtPriceX96,
			feePips: Number(decoded.args.fee),
			lpFee: split.lpFee,
			protocolFee: split.protocolFee,
			inputIsToken0: split.inputIsToken0,
		};
	}

	async function discoverV4Pools(
		client: PublicClient,
		fromBlock: bigint,
		toBlock: bigint,
		deadlineAtMs?: number,
	): Promise<DiscoveredPool[]> {
		const logs = await getLogsPaginated({
			client,
			address: poolManager,
			event: initializeEvent,
			fromBlock,
			toBlock,
			chunkSize: 150_000n,
			deadlineAtMs,
		});
		return logs.map((log) => decodeV4InitializeLog(log));
	}

	async function loadV4Swaps(
		client: PublicClient,
		fromBlock: bigint,
		toBlock: bigint,
		protocolFeeByPool: Map<string, number>,
		deadlineAtMs?: number,
	): Promise<DecodedSwap[]> {
		const logs = await getLogsPaginated({
			client,
			address: poolManager,
			event: swapEvent,
			fromBlock,
			toBlock,
			chunkSize: config.swapChunkSize ?? 8_000n,
			concurrency: config.swapConcurrency,
			deadlineAtMs,
		});
		const swaps: DecodedSwap[] = [];
		for (const log of logs) {
			try {
				swaps.push(
					decodeV4SwapLog(log, (zeroForOne) => {
						const packed = protocolFeeByPool.get(decodeV4SwapPoolId(log)) ?? 0;
						return unpackV4ProtocolFee(packed, zeroForOne);
					}),
				);
			} catch {
				// Skip a malformed log rather than failing the whole refresh; the gap is counted later if a window is empty.
			}
		}
		return swaps;
	}

	function decodeV4SwapPoolId(log: { topics: `0x${string}`[] }): string {
		const topic = log.topics[1];
		return storageId(topic ?? "0x");
	}

	async function readV4Slot0s(
		client: PublicClient,
		poolIds: string[],
		blockNumber?: bigint,
	): Promise<
		Map<
			string,
			{ sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; liquidity: bigint }
		>
	> {
		const out = new Map<
			string,
			{ sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; liquidity: bigint }
		>();
		const batchSize = 80;
		await forEachRpcBatch(poolIds, batchSize, config.stateConcurrency ?? 1, async (batch) => {
			const contracts = batch.flatMap((poolId) => [
				{
					address: stateView,
					abi: stateViewAbi,
					functionName: "getSlot0" as const,
					args: [rawId(poolId)],
				},
				{
					address: stateView,
					abi: stateViewAbi,
					functionName: "getLiquidity" as const,
					args: [rawId(poolId)],
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
					const poolId = batch[index];
					if (!poolId) {
						continue;
					}
					const slot0 = results[index * 2];
					const liquidity = results[index * 2 + 1];
					if (
						!slot0 ||
						!liquidity ||
						slot0.status !== "success" ||
						liquidity.status !== "success"
					) {
						continue;
					}
					const slot = readV4Slot0(slot0.result);
					const liquidityValue = typeof liquidity.result === "bigint" ? liquidity.result : null;
					if (!slot || liquidityValue === null) {
						continue;
					}
					out.set(poolId, {
						sqrtPriceX96: slot.sqrtPriceX96,
						tick: slot.tick,
						protocolFee: slot.protocolFee,
						lpFee: slot.lpFee,
						liquidity: liquidityValue,
					});
				}
			} catch (error) {
				throw classifyRpcError(error);
			}
		});
		return new Map(
			poolIds.flatMap((id) => {
				const state = out.get(id);
				return state ? [[id, state] as const] : [];
			}),
		);
	}

	function reserveFailureText(error: unknown): string {
		const message = errorText(error);
		const detail = message.split("Details: ")[1]?.split("\n")[0];
		return detail ? `${message.split("\n")[0]} ${detail}` : (message.split("\n")[0] ?? message);
	}

	async function readV4Reserves(
		client: PublicClient,
		pools: Array<{
			poolId: string;
			token0: Address;
			token1: Address;
			feePips: number;
			tickSpacing: number;
			hooks: Address | null;
		}>,
		concurrency = config.reserveConcurrency ?? 4,
		blockNumber?: bigint,
	): Promise<
		Map<
			string,
			{ amount0: bigint; amount1: bigint; hasCustomAccounting: boolean; gap: string | null }
		>
	> {
		const out = new Map<
			string,
			{ amount0: bigint; amount1: bigint; hasCustomAccounting: boolean; gap: string | null }
		>();
		if (!reservesLens) {
			for (const pool of pools)
				out.set(pool.poolId, {
					amount0: 0n,
					amount1: 0n,
					hasCustomAccounting: false,
					gap: "本场所尚未确认官方储备读取合约，TVL 留空",
				});
			return out;
		}
		const batches = Array.from({ length: Math.ceil(pools.length / 10) }, (_, index) =>
			pools.slice(index * 10, index * 10 + 10),
		);
		let cursor = 0;
		const splitBatch = (batch: typeof pools): void => {
			const middle = Math.ceil(batch.length / 2);
			batches.push(batch.slice(0, middle), batch.slice(middle));
		};
		async function worker(): Promise<void> {
			while (cursor < batches.length) {
				const batch = batches[cursor++];
				if (!batch) continue;
				try {
					const contracts = batch.map((pool) => ({
						address: reservesLens as Address,
						abi: reservesLensAbi,
						functionName: "getPoolTVL" as const,
						args: [
							poolManager,
							{
								currency0: pool.token0,
								currency1: pool.token1,
								fee: pool.feePips,
								tickSpacing: pool.tickSpacing,
								hooks: pool.hooks ?? (ZERO_ADDRESS as Address),
							},
						] as const,
					}));
					const results = await withRetry(
						() =>
							withRpcCategory("reserve", () =>
								client.multicall({
									contracts,
									batchSize: 16384,
									allowFailure: true,
									blockNumber,
									multicallAddress: config.multicallAddress,
								}),
							),
						{
							shouldRetry: (error) =>
								!errorText(error).toLowerCase().includes("out of gas") &&
								isRetryableRpcError(error),
						},
					);
					// Multicall returns transport failures as values, so the outer retry cannot see them.
					const failed = results.flatMap((result, index) =>
						result.status === "failure" ? [index] : [],
					);
					// A transport-level call gas cap fails the entire Multicall, not each pool.
					if (
						batch.length > 1 &&
						results.length === batch.length &&
						results.every(
							(result) =>
								result.status === "failure" &&
								errorText(result.error).toLowerCase().includes("out of gas"),
						)
					) {
						splitBatch(batch);
						continue;
					}
					if (failed.length > 0) {
						await new Promise((resolve) => setTimeout(resolve, 400));
						const retried = await withRetry(() =>
							withRpcCategory("reserve", () =>
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
					for (const [index, pool] of batch.entries()) {
						const response = results[index];
						if (response?.status !== "success") {
							out.set(pool.poolId, {
								amount0: 0n,
								amount1: 0n,
								hasCustomAccounting: false,
								gap: `官方 ReservesLens 未能读出 TVL：${response?.status === "failure" ? reserveFailureText(response.error) : "缺少返回值"}`,
							});
							continue;
						}
						const result = response.result;
						out.set(pool.poolId, {
							amount0: result.coreAmount0,
							amount1: result.coreAmount1,
							hasCustomAccounting: result.hasCustomAccounting,
							gap: result.hasCustomAccounting
								? "该池 hook 可能有自定义记账，ReservesLens 的 core 金额可能不是全部可兑换深度"
								: hookHasReturnDelta(pool.hooks)
									? "该池 hook 可抽取额外费用，Swap 事件未必包含全部 hook 费"
									: null,
						});
					}
				} catch (error) {
					if (batch.length > 1 && errorText(error).toLowerCase().includes("out of gas")) {
						splitBatch(batch);
						continue;
					}
					for (const pool of batch)
						out.set(pool.poolId, {
							amount0: 0n,
							amount1: 0n,
							hasCustomAccounting: false,
							gap: `官方 ReservesLens 未能读出 TVL：${reserveFailureText(error)}`,
						});
				}
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(concurrency, Math.max(pools.length, 1)) }, () => worker()),
		);
		return out;
	}

	function toV4PoolState(
		poolId: string,
		slot:
			| {
					sqrtPriceX96: bigint;
					tick: number;
					protocolFee: number;
					lpFee: number;
					liquidity: bigint;
			  }
			| undefined,
		reserves:
			| { amount0: bigint; amount1: bigint; hasCustomAccounting: boolean; gap: string | null }
			| undefined,
	): V4PoolState | undefined {
		if (!slot) {
			return undefined;
		}
		const failedTvl = !reservesLens || (reserves?.gap?.startsWith("官方 ReservesLens") ?? false);
		return {
			poolId,
			sqrtPriceX96: slot.sqrtPriceX96,
			tick: slot.tick,
			liquidity: slot.liquidity,
			protocolFee: slot.protocolFee,
			lpFee: slot.lpFee,
			amount0: failedTvl ? null : (reserves?.amount0 ?? null),
			amount1: failedTvl ? null : (reserves?.amount1 ?? null),
			tvlGap: reserves?.gap ?? (reserves ? null : "尚未读取官方 ReservesLens 的 TVL"),
			hasCustomAccounting: reserves?.hasCustomAccounting ?? false,
		};
	}

	function readV4Slot0(
		result: unknown,
	): { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number } | null {
		if (!Array.isArray(result) || result.length < 4) {
			return null;
		}
		const sqrtPriceX96 = result[0];
		const tick = result[1];
		const protocolFee = result[2];
		const lpFee = result[3];
		if (
			typeof sqrtPriceX96 !== "bigint" ||
			typeof tick !== "number" ||
			typeof protocolFee !== "number" ||
			typeof lpFee !== "number"
		) {
			return null;
		}
		return { sqrtPriceX96, tick, protocolFee, lpFee };
	}

	function createPriceReader() {
		return createPoolPriceReader({
			multicallAddress: config.multicallAddress,
			batchSize: 80,
			stateConcurrency: config.stateConcurrency,
			slotCall: (id) => ({
				address: stateView,
				abi: stateViewAbi,
				functionName: "getSlot0",
				args: [rawId(id)],
			}),
			liquidityCall: (id) => ({
				address: stateView,
				abi: stateViewAbi,
				functionName: "getLiquidity",
				args: [rawId(id)],
			}),
		});
	}

	return {
		createPriceReader,
		decodeV4InitializeLog,
		decodeV4SwapLog,
		discoverV4Pools,
		loadV4Swaps,
		readV4Slot0s,
		readV4Reserves,
		toV4PoolState,
	};
}
