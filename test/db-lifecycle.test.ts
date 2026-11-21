import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase } from "../src/store/db.ts";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

vi.mock("@libsql/client", () => ({ createClient: vi.fn() }));
const directories: string[] = [];
function filename() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-open-fault-"));
	directories.push(directory);
	return path.join(directory, "fixture.db");
}
function client() {
	const db = { execute: vi.fn(), close: vi.fn() };
	// Only the initialization surface is mocked; migrations have separate real-DB coverage.
	vi.mocked(createClient).mockReturnValue(db as unknown as Client);
	return db;
}
afterEach(() => {
	vi.resetAllMocks();
	removeTempDirectories(directories);
});

it("closes synchronously when WAL initialization fails and preserves the original rejection", async () => {
	const db = client();
	const failure = new Error("injected WAL failure");
	db.execute.mockRejectedValueOnce(failure);
	await expect(openDatabase(filename())).rejects.toBe(failure);
	expect(db.execute).toHaveBeenCalledExactlyOnceWith("PRAGMA journal_mode = WAL");
	expect(db.close).toHaveBeenCalledTimes(1);
});

it("still closes when migration initialization fails after WAL succeeds", async () => {
	const db = client();
	const failure = new Error("injected migration failure");
	db.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
	await expect(openDatabase(filename())).rejects.toBe(failure);
	expect(db.execute).toHaveBeenCalledTimes(2);
	expect(db.close).toHaveBeenCalledTimes(1);
});

it("retains both initialization and synchronous close failures instead of masking the original", async () => {
	const db = client();
	const failure = new Error("injected WAL failure");
	const closeFailure = new Error("injected close failure");
	db.execute.mockRejectedValueOnce(failure);
	db.close.mockImplementationOnce(() => {
		throw closeFailure;
	});
	await expect(openDatabase(filename())).rejects.toMatchObject({
		name: "AggregateError",
		cause: failure,
		errors: [failure, closeFailure],
	});
	expect(db.close).toHaveBeenCalledTimes(1);
});

it("transfers a successfully initialized client to its caller without closing it early", async () => {
	const db = client();
	const migrations = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../src/store/migrations",
	);
	db.execute
		.mockResolvedValue({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({
			rows: fs
				.readdirSync(migrations)
				.filter((name) => name.endsWith(".sql"))
				.map((name) => ({ name })),
		});
	try {
		expect(await openDatabase(filename())).toBe(db);
		expect(db.close).not.toHaveBeenCalled();
	} finally {
		db.close();
	}
});
