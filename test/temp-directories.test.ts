import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

afterEach(() => vi.restoreAllMocks());

it("removes real temporary directories and clears successful tracking", () => {
	const directories = [fs.mkdtempSync(path.join(os.tmpdir(), "lp-cleanup-"))];
	const directory = directories[0];
	if (!directory) throw new Error("missing fixture");
	try {
		fs.writeFileSync(path.join(directory, "fixture.txt"), "offline");
		removeTempDirectories(directories);
		expect(directories).toEqual([]);
		expect(fs.existsSync(directory)).toBe(false);
	} finally {
		removeTempDirectories(directories);
	}
});

it("delegates bounded retries to Node for recursive removal", () => {
	const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
	const directories = ["first", "second"];
	removeTempDirectories(directories);
	expect(remove.mock.calls).toEqual([
		["first", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
		["second", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
	]);
	expect(directories).toEqual([]);
});

it("reports exhausted EPERM/EBUSY without skipping other directories or losing failed paths", () => {
	const locked = Object.assign(new Error("locked"), { code: "EPERM" });
	const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
	const remove = vi.spyOn(fs, "rmSync").mockImplementation((directory) => {
		if (directory === "first") throw locked;
		if (directory === "last") throw busy;
	});
	const directories = ["first", "middle", "last"];
	let failure: unknown;
	try {
		removeTempDirectories(directories);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(AggregateError);
	if (!(failure instanceof AggregateError)) throw new Error("expected final cleanup failure");
	expect(failure.errors.map((error: Error) => error.cause)).toEqual([locked, busy]);
	expect(failure.errors.map((error: Error) => error.message)).toEqual([
		"Failed to remove temporary directory: first",
		"Failed to remove temporary directory: last",
	]);
	expect(remove.mock.calls.map(([directory]) => directory)).toEqual(["first", "middle", "last"]);
	expect(remove).toHaveBeenCalledTimes(3); // No unbounded helper-level retry loop.
	expect(directories).toEqual(["first", "last"]);
	remove.mockImplementation(() => {});
	removeTempDirectories(directories);
	expect(directories).toEqual([]);
});
