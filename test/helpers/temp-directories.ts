import fs from "node:fs";

/** Node owns the bounded retries; never turn exhausted cleanup into a passing test. */
export function removeTempDirectories(directories: string[]): void {
	const failed: string[] = [];
	const errors: Error[] = [];
	for (const directory of directories) {
		try {
			fs.rmSync(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch (cause) {
			failed.push(directory);
			errors.push(new Error(`Failed to remove temporary directory: ${directory}`, { cause }));
		}
	}
	// Retain failed paths for another cleanup attempt, but still fail this hook.
	directories.splice(0, directories.length, ...failed);
	if (errors.length) throw new AggregateError(errors, "Temporary directory cleanup failed");
}
