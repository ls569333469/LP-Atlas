import Decimal from "decimal.js";
import { createPublicClient, http, type PublicClient, parseAbi } from "viem";
import type { UsdQuote, UsdQuoteSource } from "../shared/usd-quotes.ts";

// Official hyperevmMultiFeed manifest; source chain 999 is not business chain 99901.
export const REDSTONE_FEEDS = {
	ETH: "0x4BAD96DD1C7D541270a0C92e1D4e5f12EEEA7a57",
	HYPE: "0xa8a94Da411425634e3Ed6C331a32ab4fd774aa43",
} as const;
const ABI = parseAbi([
	"function decimals() view returns (uint8)",
	"function description() view returns (string)",
	"function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const HEARTBEAT = 6 * 3600;

export async function findQuoteBlock(
	client: Pick<PublicClient, "getBlock">,
	targetAt: number,
): Promise<{ number: bigint; timestamp: bigint }> {
	const read = async (number?: bigint) => {
		const block = await client.getBlock(
			number === undefined ? { blockTag: "latest" } : { blockNumber: number },
		);
		if (block.number === null || (number !== undefined && block.number !== number))
			throw new Error("报价源返回了错误区块");
		return { number: block.number, timestamp: block.timestamp };
	};
	const head = await read();
	if (head.timestamp <= BigInt(targetAt)) return { number: head.number, timestamp: head.timestamp };
	let low = await read(head.number > 1024n ? head.number - 1024n : 0n);
	while (low.timestamp > BigInt(targetAt) && low.number > 0n) {
		const elapsed = head.timestamp - low.timestamp;
		const distance =
			elapsed > 0n
				? ((low.timestamp - BigInt(targetAt)) * (head.number - low.number)) / elapsed + 1024n
				: (head.number - low.number) * 2n;
		const number = low.number > distance ? low.number - distance : 0n;
		low = await read(number);
		if (low.number !== number) throw new Error("报价源返回了错误区块");
	}
	let high = head;
	if (low.timestamp > BigInt(targetAt)) throw new Error("报价源没有目标之前的区块");
	while (high.number - low.number > 1n) {
		const span = high.number - low.number;
		const elapsed = high.timestamp - low.timestamp;
		let number =
			elapsed > 0n
				? low.number + (span * (BigInt(targetAt) - low.timestamp)) / elapsed
				: (low.number + high.number) / 2n;
		if (number <= low.number) number = low.number + 1n;
		if (number >= high.number) number = high.number - 1n;
		const block = await read(number);
		if (block.number !== number) throw new Error("报价源返回了错误区块");
		if (block.timestamp <= BigInt(targetAt)) {
			low = block;
			// Verify the floor explicitly; timestamps can repeat across adjacent blocks.
			const next = await read(number + 1n);
			if (next.number !== number + 1n) throw new Error("报价源返回了错误区块");
			if (next.timestamp > BigInt(targetAt)) return { number, timestamp: block.timestamp };
			low = next;
		} else high = block;
	}
	return { number: low.number, timestamp: low.timestamp };
}

export function createRedstoneQuotes(
	options: { urls?: string[]; clientFor?: (url: string, signal: AbortSignal) => PublicClient } = {},
): UsdQuoteSource {
	const urls = options.urls ?? [
		"https://hyperliquid-rpc.publicnode.com",
		"https://hyperliquid.drpc.org",
	];
	const cache = new Map<string, UsdQuote>();
	const pending = new Map<string, Promise<UsdQuote>>();
	const blocks = new Map<string, Promise<{ number: bigint; timestamp: bigint }>>();
	return {
		getQuote(assetId, targetAt) {
			const key = `${assetId}:${targetAt}`;
			const saved = cache.get(key);
			if (saved && saved.publishedAt <= targetAt) return Promise.resolve(saved);
			const running = pending.get(key);
			if (running) return running;
			const operation = (async () => {
				const started = Date.now();
				let requestCount = 0;
				for (const url of urls) {
					// Whole asset attempt is bounded, including source-chain block lookup.
					const signal = AbortSignal.timeout(10_000);
					const client =
						options.clientFor?.(url, signal) ??
						createPublicClient({
							transport: http(url, {
								timeout: 4000,
								retryCount: 0,
								fetchFn: (input, init) => {
									requestCount += 1;
									return fetch(input, {
										...init,
										signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
									});
								},
							}),
						});
					try {
						if ((await client.getChainId()) !== 999) throw new Error("报价源链不匹配");
						const blockKey = `${url}:${targetAt}`;
						let blockRead = blocks.get(blockKey);
						if (!blockRead) {
							blockRead = findQuoteBlock(client, targetAt);
							blocks.set(blockKey, blockRead);
							void blockRead.catch(() => blocks.delete(blockKey));
							if (blocks.size > 512) {
								const oldest = blocks.keys().next().value;
								if (oldest !== undefined) blocks.delete(oldest);
							}
						}
						const block = await blockRead;
						const address = REDSTONE_FEEDS[assetId];
						const [decimals, description, round] = await Promise.all([
							client.readContract({
								address,
								abi: ABI,
								functionName: "decimals",
								blockNumber: block.number,
							}),
							client.readContract({
								address,
								abi: ABI,
								functionName: "description",
								blockNumber: block.number,
							}),
							client.readContract({
								address,
								abi: ABI,
								functionName: "latestRoundData",
								blockNumber: block.number,
							}),
						]);
						const publishedAt = Number(round[3]);
						if (
							decimals !== 8 ||
							description !== `RedStone Price Feed for ${assetId}` ||
							round[1] <= 0n ||
							publishedAt <= 0 ||
							publishedAt > Number(block.timestamp) ||
							publishedAt > targetAt ||
							targetAt - publishedAt > HEARTBEAT
						) {
							throw new Error("预言机资产、精度或发布时间不符合合同");
						}
						const quote: UsdQuote = {
							assetId,
							priceUsd: new Decimal(round[1].toString()).div(10 ** decimals).toString(),
							sourceId: "redstone_push",
							feedId: address,
							publishedAt,
							fetchedAt: new Date().toISOString(),
							sourceChainId: 999,
							sourceBlockNumber: block.number.toString(),
							sourceBlockTimestamp: Number(block.timestamp),
							targetAt,
							sourceVersion: 1,
						};
						cache.set(key, quote);
						for (const [id, value] of cache)
							if (value.targetAt < Date.now() / 1000 - 4 * 86400) cache.delete(id);
						console.info(
							JSON.stringify({
								event: "usd_quote",
								assetId,
								targetAt,
								publishedAt,
								durationMs: Date.now() - started,
								requestCount,
								status: "ok",
							}),
						);
						return quote;
					} catch {
						// Retry only the same feed through another public transport, never another price vendor.
					}
				}
				console.info(
					JSON.stringify({
						event: "usd_quote",
						assetId,
						targetAt,
						durationMs: Date.now() - started,
						requestCount,
						status: "error",
					}),
				);
				throw new Error(`RedStone ${assetId} 目标 ${targetAt} 报价不可用`);
			})().finally(() => pending.delete(key));
			pending.set(key, operation);
			return operation;
		},
	};
}
