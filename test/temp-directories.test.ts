import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("removes real temporary directories and clears successful tracking", async () => {
	const directories = [fs.mkdtempSync(path.join(os.tmpdir(), "lp-cleanup-"))];
	const directory = directories[0];
	if (!directory) throw new Error("missing fixture");
	try {
		fs.writeFileSync(path.join(directory, "fixture.txt"), "offline");
		await removeTempDirectories(directories);
		expect(directories).toEqual([]);
		expect(fs.existsSync(directory)).toBe(false);
	} finally {
		await removeTempDirectories(directories);
	}
});

it("delegates bounded retries to Node for recursive removal", async () => {
	const collect = vi.fn();
	vi.stubGlobal("gc", collect);
	const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
	const directories = ["first", "second"];
	await removeTempDirectories(directories);
	expect(collect).toHaveBeenCalledTimes(2);
	expect(remove.mock.calls).toEqual([
		["first", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
		["second", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
	]);
	expect(directories).toEqual([]);
});

it("reports exhausted EPERM/EBUSY once without skipping other directories or contaminating later hooks", async () => {
	const locked = Object.assign(new Error("locked"), { code: "EPERM" });
	const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
	const remove = vi.spyOn(fs, "rmSync").mockImplementation((directory) => {
		if (directory === "first") throw locked;
		if (directory === "last") throw busy;
	});
	const directories = ["first", "middle", "last"];
	let failure: unknown;
	try {
		await removeTempDirectories(directories);
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
	expect(directories).toEqual([]);
	await removeTempDirectories(directories);
	// The already-reported failed batch is not retried by later hooks.
	expect(remove).toHaveBeenCalledTimes(3);
});

it("fails explicitly if the committed worker GC option is missing", async () => {
	vi.stubGlobal("gc", undefined);
	const directories = ["not-created"];
	await expect(removeTempDirectories(directories)).rejects.toThrow("--expose-gc");
	expect(directories).toEqual(["not-created"]);
});

it("releases a closed file client after WAL, committed transaction and materialized results", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-cleanup-client-"));
	const directories = [directory];
	let db: Client | undefined;
	try {
		db = createClient({ url: `file:${path.join(directory, "fixture.db")}` });
		await db.execute("PRAGMA journal_mode=WAL");
		const tx = await db.transaction("write");
		try {
			await tx.execute("CREATE TABLE fixture(value)");
			await tx.commit();
		} finally {
			tx.close();
		}
		const result = await db.execute("SELECT 1 AS value");
		db.close();
		expect(db.closed).toBe(true);
		await removeTempDirectories(directories);
		expect(result.rows[0]?.value).toBe(1);
		expect(fs.existsSync(directory)).toBe(false);
	} finally {
		db?.close();
		if (fs.existsSync(directory) && !directories.includes(directory)) directories.push(directory);
		await removeTempDirectories(directories);
	}
});
