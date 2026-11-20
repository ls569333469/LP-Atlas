/** One look-ahead result, with observed rejection and explicit draining on exit. */
export function createHourPrefetch<T>() {
	let pending: { start: number; result: Promise<{ value: T } | { error: unknown }> } | undefined;
	return {
		start(start: number, load: () => Promise<T>) {
			if (pending) throw new Error("Only one next hour may be prefetched");
			pending = {
				start,
				result: load().then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				),
			};
		},
		take(start: number) {
			if (!pending || pending.start !== start) return undefined;
			const result = pending.result;
			pending = undefined;
			return result;
		},
		async close() {
			const result = pending?.result;
			pending = undefined;
			await result;
		},
	};
}
