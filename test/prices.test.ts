import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { sumUsd, valueRawUsd } from "../src/normalize/prices.ts";

describe("USD totals with missing prices", () => {
	it("does not treat one priced side as the complete amount", () => {
		expect(sumUsd(new Decimal(100), null)).toBeNull();
		expect(sumUsd(null, new Decimal(100))).toBeNull();
		expect(sumUsd(new Decimal(100), new Decimal(20))?.toString()).toBe("120");
	});
	it("values a real zero without a price, but keeps unpriced nonzero amounts missing", () => {
		expect(valueRawUsd(0n, "unknown", new Map(), new Map())?.toString()).toBe("0");
		expect(valueRawUsd(1n, "unknown", new Map(), new Map())).toBeNull();
		expect(sumUsd(new Decimal(0), null)).toBeNull();
	});
});
