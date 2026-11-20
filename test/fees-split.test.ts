import { describe, expect, it } from "vitest";
import {
	splitV3SwapFee,
	splitV4SwapFee,
	unpackV3FeeProtocol,
	unpackV4ProtocolFee,
} from "../src/adapters/fees.ts";

describe("splitV3SwapFee", () => {
	it("takes LP fees as a cut of the input, minus protocol share", () => {
		const split = splitV3SwapFee({
			amount0: 1_000_000n,
			amount1: -990_000n,
			feePips: 3000,
			feeProtocol0: 6,
			feeProtocol1: 0,
		});
		expect(split?.inputIsToken0).toBe(true);
		expect(split?.totalFee).toBe(3000n);
		expect(split?.protocolFee).toBe(500n);
		expect(split?.lpFee).toBe(2500n);
	});

	it("keeps the full fee for LPs when protocol fee is zero", () => {
		const protocol = unpackV3FeeProtocol(0);
		const split = splitV3SwapFee({
			amount0: -1n,
			amount1: 1_000_000n,
			feePips: 500,
			...protocol,
		});
		expect(split?.lpFee).toBe(500n);
		expect(split?.protocolFee).toBe(0n);
	});
});

describe("splitV4SwapFee", () => {
	it("subtracts protocol pips taken from the input first", () => {
		const packed = (100 << 12) | 0;
		expect(unpackV4ProtocolFee(packed, false)).toBe(100);
		const split = splitV4SwapFee({
			amount0: 990_000n,
			amount1: -1_000_000n,
			swapFeePips: 3000,
			protocolFeePips: 100,
		});
		expect(split?.totalFee).toBe(3000n);
		expect(split?.protocolFee).toBe(100n);
		expect(split?.lpFee).toBe(2900n);
		expect(split?.inputIsToken0).toBe(false);
	});

	it("uses negative token0 input without mixing token units", () => {
		const split = splitV4SwapFee({
			amount0: -1_000_000n,
			amount1: 200_000_000n,
			swapFeePips: 500,
			protocolFeePips: 100,
		});
		expect(split).toEqual({
			amountIn: 1_000_000n,
			inputIsToken0: true,
			totalFee: 500n,
			protocolFee: 100n,
			lpFee: 400n,
		});
	});

	it("distinguishes a zero event fee from a missing input", () => {
		expect(
			splitV4SwapFee({ amount0: -1_000_000n, amount1: 2n, swapFeePips: 0, protocolFeePips: 0 })
				?.lpFee,
		).toBe(0n);
		expect(
			splitV4SwapFee({ amount0: 0n, amount1: 0n, swapFeePips: 0, protocolFeePips: 0 }),
		).toBeNull();
	});
});
