import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { createRedstoneQuotes } from "../adapters/redstone-quotes.ts";
import { openDatabase } from "../store/db.ts";
import { interruptStaleRefreshRuns } from "../store/repositories.ts";
import { buildApp } from "./app.ts";
import { loadServerEnv } from "./env.ts";

loadDotenv({ path: path.resolve(process.cwd(), ".env") });

const env = loadServerEnv();
fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });
const db = await openDatabase(env.databasePath);
await interruptStaleRefreshRuns(
	db,
	"服务已重启，上次刷新中断。表格若仍在，是上次成功结果，不是新数据。",
);
const app = buildApp({
	db,
	quoteSource:
		process.env.USD_QUOTES_ENABLED === "false"
			? {
					getQuote: async () => {
						throw new Error("美元报价已停用");
					},
				}
			: createRedstoneQuotes(),
	rpc: env.rpc,
	robinhoodRpc: env.robinhoodRpc,
	solanaDlmm: env.solanaDlmmEnabled ? {} : undefined,
	autoScan: { ...env.autoScan, databasePath: env.databasePath },
});

const shutdown = async () => {
	await app.close();
	db.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: env.host, port: env.port });
app.log.info(`LP Atlas API listening on http://${env.host}:${env.port}`);
