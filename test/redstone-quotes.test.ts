import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { createRedstoneQuotes, findQuoteBlock } from "../src/adapters/redstone-quotes.ts";

function fixture(publishedAt = 600) {
	const getBlock = vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => {
		const number = blockNumber ?? 1000n;
		return { number, timestamp: number };
	});
	const readContract = vi.fn(
		async ({
			functionName,
			address,
		}: {
			functionName: string;
			address: string;
		}): Promise<string | number | bigint[]> => {
			if (functionName === "decimals") return 8;
			if (functionName === "description")
				return `RedStone Price Feed for ${address.toLowerCase().startsWith("0x4bad") ? "ETH" : "HYPE"}`;
			return [1n, 200000000000n, 1n, BigInt(publishedAt), 1n];
		},
	);
	return { getBlock, readContract, getChainId: vi.fn(async () => 999) };
}

it("selects the last source block at or before target, including repeated timestamps", async () => {
	const getBlock = vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => {
		const number = blockNumber ?? 100n;
		return { number, timestamp: number / 2n };
	});
	expect(await findQuoteBlock({ getBlock } as unknown as PublicClient, 20)).toEqual({
		number: 41n,
		timestamp: 20n,
	});
	expect(await findQuoteBlock({ getBlock } as unknown as PublicClient, 51)).toEqual({
		number: 100n,
		timestamp: 50n,
	});
});

it("shares in-flight exact targets and source blocks across assets without bucket lookahead", async () => {
	const client = fixture();
	const source = createRedstoneQuotes({
		urls: ["test"],
		clientFor: () => client as unknown as PublicClient,
	});
	const [first, duplicate, hype] = await Promise.all([
		source.getQuote("ETH", 650),
		source.getQuote("ETH", 650),
		source.getQuote("HYPE", 650),
	]);
	expect(first).toBe(duplicate);
	expect(hype.assetId).toBe("HYPE");
	expect(
		client.getBlock.mock.calls.filter(([call]) => call.blockNumber === undefined),
	).toHaveLength(1);
	expect(client.readContract).toHaveBeenCalledTimes(6);
	await expect(source.getQuote("ETH", 599)).rejects.toThrow("不可用");
});

it.each(["future", "precision", "asset", "stale"])(
	"rejects invalid %s evidence and falls back only to the same feed",
	async (mode) => {
		const bad = fixture(mode === "future" ? 800 : mode === "stale" ? 1 : 600);
		const good = fixture(600);
		const original = bad.readContract.getMockImplementation()!;
		bad.readContract.mockImplementation(async (call) => {
			if (mode === "precision" && call.functionName === "decimals") return 18;
			if (mode === "asset" && call.functionName === "description") return "another asset";
			return original(call);
		});
		const source = createRedstoneQuotes({
			urls: ["bad", "good"],
			clientFor: (url) => (url === "bad" ? bad : good) as unknown as PublicClient,
		});
		const target = mode === "stale" ? 30000 : 700;
		if (mode === "stale") await expect(source.getQuote("ETH", target)).rejects.toThrow();
		else expect((await source.getQuote("ETH", target)).publishedAt).toBe(600);
		expect(good.readContract).toHaveBeenCalled();
	},
);
