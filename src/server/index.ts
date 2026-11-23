import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
const indexFile = path.join(webRoot, "index.html");
if (fs.existsSync(path.join(webRoot, "assets")) && fs.existsSync(indexFile)) {
	app.get("/", async (_, reply) =>
		reply.type("text/html; charset=utf-8").send(fs.createReadStream(indexFile)),
	);
	app.get<{ Params: { name: string } }>("/assets/:name", async (request, reply) => {
		const { name } = request.params;
		if (!/^[a-zA-Z0-9_-]+\.(?:js|css)$/.test(name)) return reply.callNotFound();
		const file = path.join(webRoot, "assets", name);
		if (!fs.existsSync(file)) return reply.callNotFound();
		return reply
			.type(name.endsWith(".js") ? "text/javascript" : "text/css")
			.header("cache-control", "public, max-age=31536000, immutable")
			.send(fs.createReadStream(file));
	});
}

const shutdown = async () => {
	await app.close();
	db.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: env.host, port: env.port });
app.log.info(`LP Atlas API listening on http://${env.host}:${env.port}`);
