import { expect, it } from "vitest";
import { createHourPrefetch } from "../src/normalize/hour-prefetch.ts";

it("holds only the next hour, consumes it once, and observes failure", async () => {
	const ahead = createHourPrefetch<number>();
	ahead.start(1, async () => 7);
	expect(() => ahead.start(2, async () => 8)).toThrow();
	expect(ahead.take(2)).toBeUndefined();
	expect(await ahead.take(1)).toEqual({ value: 7 });
	expect(ahead.take(1)).toBeUndefined();
	const error = new Error("RPC failed");
	ahead.start(2, async () => {
		throw error;
	});
	expect(await ahead.take(2)).toEqual({ error });
	await ahead.close();
});

it("drains in-flight prefetch before returning on shutdown", async () => {
	const ahead = createHourPrefetch<number>();
	let release: (value: number) => void = () => {};
	ahead.start(
		1,
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	let closed = false;
	const closing = ahead.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	release(7);
	await closing;
	expect(closed).toBe(true);
	expect(ahead.take(1)).toBeUndefined();
});
