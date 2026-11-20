import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { cacheBlockStates } from "../src/adapters/block-state-cache.ts";

it("shares exact-block in-flight reads, preserves input order and isolates refreshes/blocks", async () => {
	const client = {} as PublicClient;
	const load = vi.fn(async (_client: PublicClient, ids: string[], block?: bigint) => {
		await Promise.resolve();
		return new Map(ids.map((id) => [id, block]));
	});
	const read = cacheBlockStates((id: string) => id, load);
	const [a, b] = await Promise.all([read(client, ["b", "a"], 10n), read(client, ["a", "b"], 10n)]);
	expect(load).toHaveBeenCalledTimes(1);
	expect([...a]).toEqual([
		["b", 10n],
		["a", 10n],
	]);
	expect([...b.keys()]).toEqual(["a", "b"]);
	await read(client, ["b"], 10n);
	expect(load).toHaveBeenCalledTimes(1);
	await read(client, ["a"], 11n);
	await cacheBlockStates((id: string) => id, load)(client, ["a"], 10n);
	expect(load).toHaveBeenCalledTimes(3);
});

it("does not retain missing, rejected, or failed-reserve values", async () => {
	const client = {} as PublicClient;
	const load = vi.fn(
		async (_client: PublicClient, _ids: string[], _block?: bigint) =>
			new Map([["a", { ok: true }]]),
	);
	load
		.mockResolvedValueOnce(new Map())
		.mockRejectedValueOnce(new Error("RPC failed"))
		.mockResolvedValueOnce(new Map([["a", { ok: false }]]));
	const read = cacheBlockStates(
		(id: string) => id,
		load,
		(value) => value.ok,
	);
	expect(await read(client, ["a"], 10n)).toEqual(new Map());
	await expect(read(client, ["a"], 10n)).rejects.toThrow("RPC failed");
	expect((await read(client, ["a"], 10n)).get("a")).toEqual({ ok: false });
	expect((await read(client, ["a"], 10n)).get("a")).toEqual({ ok: true });
	await read(client, ["a"], 10n);
	expect(load).toHaveBeenCalledTimes(4);
});
