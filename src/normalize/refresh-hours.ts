import type { PublicClient } from "viem";
import type { ChainHead } from "../adapters/blocks.ts";
import { findBlockAtOrAfter } from "../adapters/blocks.ts";
import { hoursToFetch } from "../metrics/compose-windows.ts";
import { alignHourStart, hourStartsInWindow } from "../metrics/windows.ts";
import {
	BOARD_WINDOWS,
	CONFIGURED_REFRESH_MAX_HOURS,
	DETERMINED_LOOKBACK_SECONDS,
	HOUR_SECONDS,
	PUBLIC_REFRESH_MAX_HOURS,
	RPC_SOURCE_PUBLIC_TEMPORARY,
} from "../shared/constants.ts";
import type { RpcSourceKind } from "../shared/types.ts";
import type { BlockBoundedWindow } from "./windows-from-swaps.ts";

export function refreshLimits(kind: RpcSourceKind): { maxHours: number } {
	if (kind === RPC_SOURCE_PUBLIC_TEMPORARY) {
		return { maxHours: PUBLIC_REFRESH_MAX_HOURS };
	}
	return { maxHours: CONFIGURED_REFRESH_MAX_HOURS };
}

export function lookbackHourStarts(asOfUnix: number): {
	starts: number[];
	currentStart: number;
	lookbackStart: number;
} {
	const currentStart = alignHourStart(asOfUnix);
	const currentEnd = currentStart + HOUR_SECONDS;
	const lookbackStart = currentEnd - DETERMINED_LOOKBACK_SECONDS;
	return {
		starts: hourStartsInWindow(lookbackStart, currentEnd),
		currentStart,
		lookbackStart,
	};
}

export function selectRefreshHours(input: {
	asOfUnix: number;
	scannedStarts: ReadonlySet<number>;
	coveredStarts?: ReadonlySet<number>;
	maxHours: number;
	visibleOnly?: boolean;
	unfinishedStarts?: ReadonlySet<number>;
}): number[] {
	const { starts, currentStart } = lookbackHourStarts(input.asOfUnix);
	const selected = hoursToFetch({
		neededStarts: starts,
		scannedStarts: input.scannedStarts,
		rescanStart: currentStart,
		maxHours: starts.length,
	});
	// Retention is not the backfill priority: finish the visible longest window first.
	const lastClosed = currentStart - HOUR_SECONDS;
	const visibleStart =
		currentStart + HOUR_SECONDS - Math.max(...BOARD_WINDOWS.map((window) => window.seconds));
	const history = selected.filter((start) => start !== lastClosed && start !== currentStart);
	return [
		...selected.filter((start) => start === lastClosed && input.unfinishedStarts?.has(start)),
		...selected.filter((start) => start === currentStart),
		...selected.filter((start) => start === lastClosed && !input.unfinishedStarts?.has(start)),
		...history.filter((start) => start >= visibleStart && !input.coveredStarts?.has(start)),
		...history.filter((start) => start >= visibleStart && input.coveredStarts?.has(start)),
		...history.filter(
			(start) => !input.visibleOnly && start < visibleStart && !input.coveredStarts?.has(start),
		),
		...history.filter(
			(start) => !input.visibleOnly && start < visibleStart && input.coveredStarts?.has(start),
		),
	].slice(0, input.maxHours);
}

export async function resolveOneHour(input: {
	client: PublicClient;
	head: ChainHead;
	startUnix: number;
	fromBlock?: bigint;
	knownBounds?: { fromBlock: string; toBlock: string; complete: boolean };
	previousBounds?: { toBlock: string; complete: boolean };
	nextBounds?: { fromBlock: string };
}): Promise<BlockBoundedWindow | null> {
	const endUnix = input.startUnix + HOUR_SECONDS;
	const fromBlock = input.fromBlock && input.fromBlock > 0n ? input.fromBlock : 1n;
	const startBlock = input.knownBounds
		? BigInt(input.knownBounds.fromBlock)
		: input.previousBounds?.complete
			? BigInt(input.previousBounds.toBlock) + 1n
			: await findBlockAtOrAfter(input.client, input.startUnix, input.head, fromBlock);
	const endBlock = input.knownBounds?.complete
		? BigInt(input.knownBounds.toBlock)
		: endUnix <= input.head.timestamp
			? input.nextBounds
				? BigInt(input.nextBounds.fromBlock) - 1n
				: (await findBlockAtOrAfter(input.client, endUnix, input.head, startBlock)) - 1n
			: input.head.blockNumber;
	if (endBlock < startBlock) {
		return null;
	}
	return {
		startUnix: input.startUnix,
		endUnix,
		complete: input.head.timestamp >= endUnix,
		fromBlock: startBlock,
		toBlock: endBlock,
	};
}
