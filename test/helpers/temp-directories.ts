import fs from "node:fs";
import { setImmediate } from "node:timers/promises";

/** Closed libsql clients can leave unreachable native statements until GC finalizes them. */
export async function removeTempDirectories(
	directories: string[],
	options: { collect: (() => void) | undefined } = { collect: globalThis.gc },
): Promise<void> {
	if (!directories.length) return;
	const collect = options.collect;
	if (typeof collect !== "function") {
		throw new Error("Temporary database cleanup requires Vitest forks with --expose-gc");
	}
	// Exactly two collection/finalizer turns, not an unbounded retry or a substitute for close().
	for (let turn = 0; turn < 2; turn++) {
		collect();
		await setImmediate();
	}
	const errors: Error[] = [];
	// Consume this batch once: a failed hook must not contaminate later unrelated tests.
	for (const directory of directories.splice(0)) {
		try {
			fs.rmSync(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch (cause) {
			errors.push(new Error(`Failed to remove temporary directory: ${directory}`, { cause }));
		}
	}
	if (errors.length) throw new AggregateError(errors, "Temporary directory cleanup failed");
}
