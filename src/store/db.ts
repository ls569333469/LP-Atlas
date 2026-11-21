import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export type AppDatabase = Client;

export async function openDatabase(databasePath: string): Promise<AppDatabase> {
	const resolved = path.resolve(databasePath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const db = createClient({ url: `file:${resolved}` });
	// A board read must keep one snapshot while the scanner publishes its next revision.
	try {
		await db.execute("PRAGMA journal_mode = WAL");
		await migrate(db);
		return db;
	} catch (error) {
		try {
			db.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Database initialization and close failed", {
				cause: error,
			});
		}
		throw error;
	}
}

export async function migrate(db: AppDatabase, directory = MIGRATIONS_DIR): Promise<void> {
	await db.execute(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			applied_at TEXT NOT NULL
		);
	`);
	const applied = new Set(
		(await db.execute("SELECT name FROM schema_migrations")).rows.map((row) => String(row.name)),
	);
	const files = fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort();
	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		const sql = migrationBody(fs.readFileSync(path.join(directory, file), "utf8"));
		// @libsql/client 0.18 Transaction pins one connection. Client.executeMultiple
		// does NOT pin it across calls; SQL BEGIN/COMMIT cannot cover registration.
		const tx = await db.transaction("write");
		try {
			// Recheck inside the writer lock in case another opener completed it.
			const existing = await tx.execute({
				sql: "SELECT name FROM schema_migrations WHERE name = ?",
				args: [file],
			});
			if (existing.rows.length === 0) {
				await tx.executeMultiple(sql);
				await tx.execute({
					sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
					args: [file, new Date().toISOString()],
				});
			}
			await tx.commit();
		} finally {
			// close() rolls back an uncommitted transaction, including DDL.
			tx.close();
		}
	}
}

/** Existing scripts have only standalone outer BEGIN/COMMIT. Never nest them.
 * Fail closed on any other standalone transaction/PRAGMA control in new scripts.
 * This is deliberately not a general SQL parser: migration DDL is repository-owned.
 */
export function migrationBody(sql: string): string {
	const lines = sql.split("\n");
	const active = lines
		.map((line, index) => ({ line: line.trim(), index }))
		.filter(({ line }) => line !== "" && !line.startsWith("--"));
	const first = active[0];
	const last = active.at(-1);
	if (first?.line === "BEGIN;" && last?.line === "COMMIT;") {
		lines[first.index] = "";
		lines[last.index] = "";
	}
	const controls = lines
		.join("\n")
		.replace(
			/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
			" ",
		);
	if (
		controls
			.split(";")
			.some((statement) =>
				/^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(
					statement,
				),
			)
	) {
		throw new Error("Migration contains unsupported transaction or connection control");
	}
	return lines.join("\n");
}

export async function getMeta(db: AppDatabase, key: string): Promise<string | undefined> {
	const result = await db.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
	const row = result.rows[0];
	return row ? String(row.value) : undefined;
}

export async function setMeta(db: AppDatabase, key: string, value: string): Promise<void> {
	await db.execute({
		sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		args: [key, value],
	});
}

export function rowNumber(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	return Number(value);
}

export function rowString(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return String(value);
}
