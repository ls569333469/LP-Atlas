import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHypeLike, isOfficialUsdStable } from "../src/normalize/prices.ts";
import type { StoredPool, StoredToken, StoredWindow } from "../src/store/types.ts";
import { type Dataset, qualifies } from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "outputs/signal-research/v2026-11-13-mainnet");
const EVENT_POOLS = [
	"0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac",
	"0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472",
];

const hourKey = (h: StoredWindow) => `${h.poolId}:${h.windowStart}`;
const tokenKey = (t: { chainId: number; address: string }) =>
	`${t.chainId}:${t.address.toLowerCase()}`;
const isBridgePool = (p: StoredPool) =>
	(isHypeLike(p.token0) && isOfficialUsdStable(p.token1)) ||
	(isHypeLike(p.token1) && isOfficialUsdStable(p.token0));

const gapPath = path.join(outDir, "dataset-with-gap.json");
const frozenPath = path.join(outDir, "dataset.json");
const outPath = path.join(outDir, "dataset-computable.json");
const gap = JSON.parse(await fs.readFile(gapPath, "utf8")) as Dataset;
const frozen = JSON.parse(await fs.readFile(frozenPath, "utf8")) as Dataset;
if (gap.schema !== 1 || frozen.schema !== 1) throw new Error("不支持的数据格式");

const poolById = new Map<string, StoredPool>();
for (const p of [
	...gap.pools,
	...frozen.pools,
	...(gap.bridges?.pools ?? []),
	...(frozen.bridges?.pools ?? []),
]) {
	if (!poolById.has(p.poolId)) poolById.set(p.poolId, p);
}

const candidateIds = new Set<string>([
	...gap.hours.filter((h) => h.complete && qualifies(h)).map((h) => h.poolId),
	...frozen.pools.map((p) => p.poolId),
	...EVENT_POOLS,
]);
const missingCandidates = [...candidateIds].filter((id) => !poolById.has(id));
if (missingCandidates.length) {
	throw new Error(`候选池缺少元数据: ${missingCandidates.slice(0, 5).join(", ")}`);
}

const bridgePools = [...poolById.values()]
	.filter(isBridgePool)
	.sort((a, b) => a.poolId.localeCompare(b.poolId));
const bridgeSet = new Set(bridgePools.map((p) => p.poolId));
const keepIds = new Set([...candidateIds, ...bridgeSet]);

const hourMap = new Map<string, StoredWindow>();
for (const h of [
	...gap.hours,
	...frozen.hours,
	...(gap.bridges?.hours ?? []),
	...(frozen.bridges?.hours ?? []),
]) {
	if (!keepIds.has(h.poolId)) continue;
	const k = hourKey(h);
	if (!hourMap.has(k)) hourMap.set(k, h);
}
const hours = [...hourMap.values()].sort(
	(a, b) => a.windowStart - b.windowStart || a.poolId.localeCompare(b.poolId),
);

const tokenMap = new Map<string, StoredToken>();
for (const t of [...gap.tokens, ...frozen.tokens]) tokenMap.set(tokenKey(t), t);
const wantedTokens = new Set<string>();
const candidatePools = [...candidateIds]
	.map((id) => poolById.get(id)!)
	.sort((a, b) => a.poolId.localeCompare(b.poolId));
for (const p of [...candidatePools, ...bridgePools]) {
	wantedTokens.add(`${p.chainId}:${p.token0.toLowerCase()}`);
	wantedTokens.add(`${p.chainId}:${p.token1.toLowerCase()}`);
}
const tokens = [...wantedTokens].map((k) => tokenMap.get(k)).filter((t): t is StoredToken => !!t);

const computable: Dataset = {
	...gap,
	exportedAt: new Date().toISOString(),
	pools: candidatePools,
	tokens,
	hours,
	coverage: gap.coverage,
	bridges: {
		pools: bridgePools,
		hours: hours.filter((h) => bridgeSet.has(h.poolId)),
	},
};
await fs.writeFile(outPath, JSON.stringify(computable));
const manifest = {
	sourceGap: gapPath,
	sourceFrozen: frozenPath,
	output: outPath,
	note: "从 dataset-with-gap.json 收束为曾经达标池 + HYPE/稳定币桥池的全部小时档，不覆盖原 dataset.json 与 dataset-with-gap.json。",
	input: {
		pools: gap.pools.length,
		hours: gap.hours.length,
		tokens: gap.tokens.length,
		start: gap.start,
		end: gap.end,
	},
	outputCounts: {
		candidatePools: candidatePools.length,
		hours: hours.length,
		tokens: tokens.length,
		bridgePools: bridgePools.length,
		bridgeHours: computable.bridges.hours.length,
		qualifyingHours: hours.filter((h) => h.complete && qualifies(h)).length,
	},
	eventPoolsIncluded: EVENT_POOLS,
	productionUntouched: true,
};
await fs.writeFile(
	path.join(outDir, "dataset-computable-manifest.json"),
	JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest, null, 2));
