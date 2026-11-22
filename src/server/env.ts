import path from "node:path";
import { type ElysiumRpc, resolveRpcConfig } from "../adapters/rpc.ts";
import { robinhoodMainnet } from "../shared/chain.ts";
import type { AutoScanConfig } from "./auto-scan.ts";

export type OptionalRpcUrls = {
	primary?: string;
	backup?: string;
};

export type ServerEnv = {
	host: string;
	port: number;
	databasePath: string;
	rpc: ElysiumRpc;
	robinhoodRpc: ElysiumRpc;
	solanaDlmmEnabled: boolean;
	autoScan: AutoScanConfig;
	theGraphApiKey?: string;
	pancakeV3BscSubgraphId?: string;
	uniswapV3EthereumSubgraphId?: string;
	uniswapV4EthereumSubgraphId?: string;
	uniswapV3BaseSubgraphId?: string;
	uniswapV4BaseSubgraphId?: string;
	chainRpc: {
		bsc: OptionalRpcUrls;
		ethereum: OptionalRpcUrls;
		base: OptionalRpcUrls;
		robinhood: OptionalRpcUrls;
	};
};

function optionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function optionalRpc(primary: string | undefined, backup: string | undefined): OptionalRpcUrls {
	return {
		primary: optionalText(primary),
		backup: optionalText(backup),
	};
}

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
	const host = env.HOST?.trim() || "127.0.0.1";
	const port = Number(env.PORT ?? "3001");
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error("PORT 必须是正整数");
	}
	const databasePath = path.resolve(
		env.DATABASE_PATH?.trim() || path.join(process.cwd(), "data", "lp-atlas.db"),
	);
	const autoScanEnabled = env.AUTO_SCAN_ENABLED?.trim() || "true";
	if (autoScanEnabled !== "true" && autoScanEnabled !== "false") {
		throw new Error("AUTO_SCAN_ENABLED 必须为 true 或 false");
	}
	const solanaDlmmEnabled = env.SOLANA_DLMM_ENABLED?.trim() || "false";
	if (solanaDlmmEnabled !== "true" && solanaDlmmEnabled !== "false")
		throw new Error("SOLANA_DLMM_ENABLED 必须为 true 或 false");
	return {
		solanaDlmmEnabled: solanaDlmmEnabled === "true",
		host,
		port,
		databasePath,
		autoScan: {
			enabled: autoScanEnabled === "true",
			maxDatabaseBytes: positiveMebibytes(env.SCAN_MAX_DATABASE_MB, 2048, "SCAN_MAX_DATABASE_MB"),
			minFreeDiskBytes: positiveMebibytes(env.SCAN_MIN_FREE_DISK_MB, 512, "SCAN_MIN_FREE_DISK_MB"),
		},
		rpc: resolveRpcConfig({
			primaryUrl: env.ELYSIUM_RPC_URL,
			backupUrl: env.ELYSIUM_RPC_URL_BACKUP,
		}),
		robinhoodRpc: resolveRpcConfig(
			{ primaryUrl: env.ROBINHOOD_RPC_URL, backupUrl: env.ROBINHOOD_RPC_URL_BACKUP },
			robinhoodMainnet,
		),
		theGraphApiKey: optionalText(env.THE_GRAPH_API_KEY),
		pancakeV3BscSubgraphId: optionalText(env.PANCAKE_V3_BSC_SUBGRAPH_ID),
		uniswapV3EthereumSubgraphId: optionalText(env.UNISWAP_V3_ETHEREUM_SUBGRAPH_ID),
		uniswapV4EthereumSubgraphId: optionalText(env.UNISWAP_V4_ETHEREUM_SUBGRAPH_ID),
		uniswapV3BaseSubgraphId: optionalText(env.UNISWAP_V3_BASE_SUBGRAPH_ID),
		uniswapV4BaseSubgraphId: optionalText(env.UNISWAP_V4_BASE_SUBGRAPH_ID),
		chainRpc: {
			bsc: optionalRpc(env.BSC_RPC_URL, env.BSC_RPC_URL_BACKUP),
			ethereum: optionalRpc(env.ETHEREUM_RPC_URL, env.ETHEREUM_RPC_URL_BACKUP),
			base: optionalRpc(env.BASE_RPC_URL, env.BASE_RPC_URL_BACKUP),
			robinhood: optionalRpc(env.ROBINHOOD_RPC_URL, env.ROBINHOOD_RPC_URL_BACKUP),
		},
	};
}

function positiveMebibytes(value: string | undefined, fallback: number, name: string): number {
	const megabytes = Number(value?.trim() || fallback);
	const bytes = megabytes * 1024 * 1024;
	if (!Number.isSafeInteger(megabytes) || megabytes <= 0 || !Number.isSafeInteger(bytes)) {
		throw new Error(`${name} 必须为正整数 MiB`);
	}
	return bytes;
}
