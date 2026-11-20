import assert from "node:assert/strict";
import fs from "node:fs";
import { positionFeeDelta } from "./position-fees.ts";

const dir = "outputs/signal-research/wallet-calibration";
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const wallet = load(`${dir}/wallet-audit.json`);
const cache = load("D:/Axiangmu/流动性LP/outputs/maintenance/six-hour-rpc-cache.json");
const tuple = (id, block) => {
	const data = cache[`position:${id}:${block}`];
	assert(data, `Missing raw position ${id}:${block}`);
	return data.map((x) => BigInt(x.bigint));
};
const rows = [];
for (const tx of [...wallet.rows].sort((a, b) => a.nonce - b.nonce)) {
	let amount0 = 0n,
		amount1 = 0n;
	const checkpoints = [];
	for (const change of tx.changes) {
		const before = tuple(change.nft, BigInt(tx.block) - 1n),
			after = tuple(change.nft, tx.block);
		const fee0 = positionFeeDelta(before[0], before[1], after[1]);
		const fee1 = positionFeeDelta(before[0], before[2], after[2]);
		assert.equal(fee0, BigInt(change.feesH));
		assert.equal(fee1, BigInt(change.feesK));
		assert.equal(after[0] - before[0], BigInt(change.liquidityDelta));
		amount0 += fee0;
		amount1 += fee1;
		checkpoints.push({
			nft: change.nft,
			lower: change.lower,
			upper: change.upper,
			liquidityBefore: before[0],
			liquidityAfter: after[0],
			growthBefore: before.slice(1),
			growthAfter: after.slice(1),
			fee0,
			fee1,
		});
	}
	assert.equal(amount0, BigInt(tx.feesH));
	assert.equal(amount1, BigInt(tx.feesK));
	rows.push({
		hash: tx.hash,
		block: tx.block,
		nonce: tx.nonce,
		gas: BigInt(tx.gas),
		fee0: amount0,
		fee1: amount1,
		checkpoints,
	});
}
assert.equal(
	new Set(rows.map((r) => r.block)).size,
	rows.length,
	"No duplicate wallet blocks in sample",
);
const [first, last] = wallet.snapshots;
const settled0 = rows.reduce((s, r) => s + r.fee0, 0n),
	settled1 = rows.reduce((s, r) => s + r.fee1, 0n);
const earned0 = settled0 + BigInt(last.feeH) - BigInt(first.feeH);
const earned1 = settled1 + BigInt(last.feeK) - BigInt(first.feeK);
assert.equal(earned0, BigInt(wallet.summary.earnedH));
assert.equal(earned1, BigInt(wallet.summary.earnedK));
const result = {
	basis: "actual_NFT_liquidity_and_feeGrowth_checkpoints",
	capture: null,
	start: first.time,
	end: last.time,
	settled0,
	settled1,
	openingUnclaimed0: first.feeH,
	openingUnclaimed1: first.feeK,
	closingUnclaimed0: last.feeH,
	closingUnclaimed1: last.feeK,
	earned0,
	earned1,
	gas: rows.reduce((s, r) => s + r.gas, 0n),
	rows,
	personalNetPnl: null,
	note: "Actual fee entitlements reconstructed from existing chain-checked position checkpoints, not TVL shares. Full wallet net PnL and native transfers are a separate reconciliation.",
};
fs.writeFileSync(
	`${dir}/position-fee-replay.json`,
	JSON.stringify(result, (_, v) => (typeof v === "bigint" ? String(v) : v), 2),
);
console.log(
	JSON.stringify({
		transactions: rows.length,
		checkpoints: rows.flatMap((r) => r.checkpoints).length,
		earned0: String(earned0),
		earned1: String(earned1),
		capture: null,
	}),
);
