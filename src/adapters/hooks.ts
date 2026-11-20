import { ZERO_ADDRESS } from "../shared/constants.ts";

const HOOK_FLAGS: Array<{ bit: number; label: string }> = [
	{ bit: 13, label: "beforeInitialize" },
	{ bit: 12, label: "afterInitialize" },
	{ bit: 11, label: "beforeAddLiquidity" },
	{ bit: 10, label: "afterAddLiquidity" },
	{ bit: 9, label: "beforeRemoveLiquidity" },
	{ bit: 8, label: "afterRemoveLiquidity" },
	{ bit: 7, label: "beforeSwap" },
	{ bit: 6, label: "afterSwap" },
	{ bit: 5, label: "beforeDonate" },
	{ bit: 4, label: "afterDonate" },
	{ bit: 3, label: "beforeSwapReturnsDelta" },
	{ bit: 2, label: "afterSwapReturnsDelta" },
	{ bit: 1, label: "afterAddLiquidityReturnsDelta" },
	{ bit: 0, label: "afterRemoveLiquidityReturnsDelta" },
];

export function hasHook(hooks: string | null | undefined): boolean {
	return Boolean(hooks) && hooks !== ZERO_ADDRESS;
}

export function hookPermissionLabels(hooks: string): string[] {
	const bits = Number(BigInt(hooks) & 0x3fffn);
	return HOOK_FLAGS.filter((flag) => (bits & (1 << flag.bit)) !== 0).map((flag) => flag.label);
}

export function formatHookType(hooks: string | null | undefined): string | null {
	if (!hasHook(hooks)) {
		return null;
	}
	const address = hooks as string;
	const labels = hookPermissionLabels(address);
	const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
	if (labels.length === 0) {
		return short;
	}
	return `${short}（${labels.join(", ")}）`;
}

export function hookHasReturnDelta(hooks: string | null | undefined): boolean {
	if (!hasHook(hooks)) {
		return false;
	}
	const bits = Number(BigInt(hooks as string) & 0x3fffn);
	return (bits & 0b1111) !== 0;
}
