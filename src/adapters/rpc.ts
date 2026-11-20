import {
	type Chain,
	createPublicClient,
	fallback,
	http,
	type PublicClient,
	type Transport,
} from "viem";
import { elysiumMainnet } from "../shared/chain.ts";
import {
	PUBLIC_RPC_WARNING,
	RPC_SOURCE_CONFIGURED,
	RPC_SOURCE_PUBLIC_TEMPORARY,
} from "../shared/constants.ts";
import type { RpcSourceInfo } from "../shared/types.ts";
import { RpcFailureError, redactRpcUrl } from "./errors.ts";
import { createRpcFetch } from "./http-fetch.ts";
import { robinhoodRpcTransport } from "./rpc-budget.ts";

export type RpcConfig = {
	primaryUrl?: string;
	backupUrl?: string;
};

export type ElysiumRpc = {
	client: PublicClient;
	source: RpcSourceInfo;
	urls: string[];
	close?: () => void;
};

function httpTransport(
	url: string,
	timeout = 20_000,
	fetchFn?: ReturnType<typeof createRpcFetch>["fetch"],
): Transport {
	return http(url, {
		timeout,
		fetchFn,
		fetchOptions: { headers: { "user-agent": "lp-atlas/0.1" } },
		retryCount: 0,
		retryDelay: 500,
	});
}

export function resolveRpcConfig(config: RpcConfig, chain: Chain = elysiumMainnet): ElysiumRpc {
	const publicUrl = chain.rpcUrls.default.http[0] as string;
	const envPrefix = chain.id === 4663 ? "ROBINHOOD" : "ELYSIUM";
	const primary = config.primaryUrl?.trim();
	const backup = config.backupUrl?.trim();
	if (primary) {
		const urls = backup && backup !== primary ? [primary, backup] : [primary];
		// Robinhood log responses can finish querying quickly but take longer to download.
		const timeout = chain.id === 4663 ? 360_000 : 20_000;
		const connectionPool = chain.id === 4663 ? createRpcFetch() : undefined;
		const configuredTransport = (url: string) =>
			chain.id === 4663
				? robinhoodRpcTransport(url, httpTransport(url, timeout, connectionPool?.fetch))
				: httpTransport(url, timeout);
		const transport =
			urls.length === 1
				? configuredTransport(urls[0] as string)
				: fallback(urls.map(configuredTransport));
		return {
			client: createPublicClient({
				chain,
				transport,
			}),
			source: {
				kind: urls.every(
					(url) =>
						url === publicUrl ||
						(chain.id === 4663 && url === "https://robinhood.rpc.pinax.network"),
				)
					? RPC_SOURCE_PUBLIC_TEMPORARY
					: RPC_SOURCE_CONFIGURED,
				label: urls.map(redactRpcUrl).join(" / "),
			},
			urls,
			close: connectionPool?.close,
		};
	}
	if (backup) {
		throw new RpcFailureError(
			"rpc_misconfigured",
			`设置了 ${envPrefix}_RPC_URL_BACKUP 但没有设置 ${envPrefix}_RPC_URL。请先配置主节点。`,
		);
	}
	return {
		client: createPublicClient({
			chain,
			transport: httpTransport(publicUrl),
		}),
		source: {
			kind: RPC_SOURCE_PUBLIC_TEMPORARY,
			label: `官方公共 RPC（临时，非生产）：${publicUrl}`,
		},
		urls: [publicUrl],
	};
}

export function publicRpcWarning(source: RpcSourceInfo): string | undefined {
	return source.kind === RPC_SOURCE_PUBLIC_TEMPORARY ? PUBLIC_RPC_WARNING : undefined;
}
