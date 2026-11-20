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
	await db.execute("PRAGMA journal_mode = WAL");
	await migrate(db);
	return db;
}

async function migrate(db: AppDatabase): Promise<void> {
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
		.readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith(".sql"))
		.sort();
	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
		await db.executeMultiple(sql);
		await db.execute({
			sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
			args: [file, new Date().toISOString()],
		});
	}
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
