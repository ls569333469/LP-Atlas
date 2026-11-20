import { AsyncLocalStorage } from "node:async_hooks";
import type { Transport } from "viem";
import { classifyRpcError } from "./errors.ts";

type Category = "state" | "reserve" | "logs" | "other";
const categoryContext = new AsyncLocalStorage<Category>();

export function withRpcCategory<T>(category: Category, operation: () => Promise<T>): Promise<T> {
	return categoryContext.run(category, operation);
}

/** Admission is atomic across both limits; a queued category never holds a total slot. */
export function createRpcBudget() {
	const limits = { total: 64, state: 32, reserve: 64, logs: 16, other: 64 };
	const active = { total: 0, state: 0, reserve: 0, logs: 0, other: 0 };
	const waiting: Array<{ category: Category; start: () => void }> = [];
	let pausedUntil = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function drain() {
		if (Date.now() < pausedUntil) {
			if (!timer)
				timer = setTimeout(() => {
					timer = undefined;
					drain();
				}, pausedUntil - Date.now());
			return;
		}
		for (let index = 0; index < waiting.length && active.total < limits.total; ) {
			const item = waiting[index];
			if (!item) break;
			if (active[item.category] >= limits[item.category]) {
				index += 1;
				continue;
			}
			waiting.splice(index, 1);
			active.total += 1;
			active[item.category] += 1;
			item.start();
		}
	}
	return {
		async run<T>(category: Category, operation: () => Promise<T>): Promise<T> {
			await new Promise<void>((start) => {
				waiting.push({ category, start });
				drain();
			});
			try {
				return await operation();
			} catch (error) {
				if (classifyRpcError(error).code === "rpc_rate_limited") {
					limits[category] = Math.max(1, Math.floor(limits[category] / 2));
					pausedUntil = Date.now() + 400;
				}
				throw error;
			} finally {
				active.total -= 1;
				active[category] -= 1;
				drain();
			}
		},
	};
}

const endpointBudgets = new Map<string, ReturnType<typeof createRpcBudget>>();

/** Wrap actual transport requests, including Multicall splits and targeted retries. */
export function limitRpcTransport(
	transport: Transport,
	budget: ReturnType<typeof createRpcBudget>,
): Transport {
	return (options) => {
		const base = transport(options);
		return {
			...base,
			request: (args, requestOptions) =>
				budget.run(
					args.method === "eth_getLogs" ? "logs" : (categoryContext.getStore() ?? "other"),
					() => base.request(args, requestOptions),
				),
		};
	};
}

export function robinhoodRpcTransport(url: string, transport: Transport): Transport {
	let budget = endpointBudgets.get(url);
	if (!budget) {
		budget = createRpcBudget();
		endpointBudgets.set(url, budget);
	}
	return limitRpcTransport(transport, budget);
}

/** Stop scheduling on failure, but drain already-started batches before returning. */
export async function forEachRpcBatch<T>(
	items: readonly T[],
	size: number,
	concurrency: number,
	operation: (batch: T[]) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	let failure: { error: unknown } | undefined;
	async function worker() {
		while (cursor < items.length && !failure) {
			const offset = cursor;
			cursor += size;
			try {
				await operation(items.slice(offset, offset + size));
			} catch (error) {
				failure ??= { error };
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, Math.ceil(items.length / size)) }, worker),
	);
	if (failure) throw failure.error;
}
