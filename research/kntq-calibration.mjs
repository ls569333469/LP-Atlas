import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Decimal from "decimal.js";
import { createPublicClient, custom, parseAbiItem } from "viem";
import { v4PoolManagerAbi } from "../src/adapters/abi.ts";
import { findBlockAtOrAfter } from "../src/adapters/blocks.ts";
import { getLogsPaginated } from "../src/adapters/logs.ts";
import {
	decodeV4SwapLog,
	readV4Reserves,
	readV4Slot0s,
	unpackV4ProtocolFee,
} from "../src/adapters/venues/elysium/uniswap-v4.ts";
import { annualizeFeesApr, capitalEfficiency } from "../src/metrics/fees-apr.ts";
import { buildUsdPrices, sumUsd, valueRawUsd } from "../src/normalize/prices.ts";
import { accumulateSwapWindows } from "../src/normalize/windows-from-swaps.ts";
import { ELYSIUM_USDC_ADDRESS, UNISWAP_V4_ELYSIUM, ZERO_ADDRESS } from "../src/shared/constants.ts";

// Offline research only. No signer, engine, wallet vault or production writer.
const dir = "outputs/signal-research/wallet-calibration";
const tool = "D:/Axiangmu/流动性LP";
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (name, data) =>
	fs.writeFileSync(
		`${dir}/${name}`,
		JSON.stringify(data, (_, v) => (typeof v === "bigint" ? String(v) : v), 2),
	);
const owner = "0x45347cbf19dcf04d4b4f6c48fbce92c07bb00ff3";
const poolId = "0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac";
const start = 1794270894 - 43200;
const H = 3600;
fs.mkdirSync(dir, { recursive: true });

const cachePath = `${dir}/rpc-evidence.json`;
const cache = fs.existsSync(cachePath) ? load(cachePath) : {};
let queue = Promise.resolve();
const failures = [];
const client = createPublicClient({
	transport: custom(
		{
			request: (request) => {
				const key = JSON.stringify(request);
				if (cache[key] !== undefined) return Promise.resolve(cache[key]);
				const task = queue.then(async () => {
					let error;
					for (const url of ["https://rpc.agoradex.app", "https://rpc.elysium.kinetiq.xyz"]) {
						try {
							const r = await fetch(url, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }),
								signal: AbortSignal.timeout(15000),
							});
							if (!r.ok) throw Error(`HTTP ${r.status}`);
							const j = await r.json();
							if (j.error) throw Error(JSON.stringify(j.error));
							cache[key] = j.result;
							write("rpc-evidence.json", cache);
							return j.result;
						} catch (e) {
							error = e;
							failures.push({ method: request.method, url, error: String(e).slice(0, 350) });
						}
					}
					throw error;
				});
				queue = task.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 350)));
				return task;
			},
		},
		{ retryCount: 0 },
	),
});

if (process.argv.includes("--collect")) {
	const exit = load(`${tool}/docs/KNTQ_EXIT_NATIVE.latest.json`);
	const receipts = [];
	for (const row of exit.receipts) {
		const receipt = await client.getTransactionReceipt({ hash: row.hash });
		const tx = await client.getTransaction({ hash: row.hash });
		const block = await client.getBlock({ blockNumber: receipt.blockNumber });
		assert.equal(tx.from.toLowerCase(), owner);
		assert.equal(receipt.status, "success");
		assert.equal(String(receipt.blockNumber), row.block);
		assert.equal(block.hash, receipt.blockHash);
		receipts.push({
			...row,
			actualTime: Number(block.timestamp),
			blockHash: block.hash,
			transactionIndex: receipt.transactionIndex,
			nonce: tx.nonce,
			gasWei: receipt.gasUsed * receipt.effectiveGasPrice,
		});
	}
	const removal = receipts.find((r) => r.action.startsWith("remove"));
	const conversion = receipts.find((r) => r.action.startsWith("swap"));
	assert.ok(removal && conversion);
	// Trace is an evidence capability probe, not a reason to retry indefinitely.
	const sample = load(`${dir}/wallet-audit.json`).rows.find((r) => r.changes.length);
	let trace;
	try {
		const result = await client.request({
			method: "debug_traceTransaction",
			params: [sample.hash, { tracer: "callTracer" }],
		});
		trace = { status: "available", hash: sample.hash, result };
	} catch (e) {
		trace = { status: "unavailable", hash: sample.hash, error: String(e).slice(0, 600) };
	}
	write("exit-boundary.json", {
		owner,
		removal,
		conversion,
		receipts,
		trace,
		failures,
		note: "LP fee exposure ends at removal; subsequent swap ends conversion exposure. File verifiedAt is neither.",
	});
	console.log(
		"Exit boundary:",
		new Date(removal.actualTime * 1000).toISOString(),
		"trace:",
		trace.status,
	);
}

if (process.argv.includes("--flows")) {
	const a = load(`${dir}/wallet-audit.json`);
	const [first, last] = a.snapshots;
	const event = parseAbiItem(
		"event Transfer(address indexed from,address indexed to,uint256 value)",
	);
	const token = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
	const unique = new Map();
	for (const direction of ["from", "to"]) {
		const filtered = {
			...client,
			getLogs: (params) => client.getLogs({ ...params, args: { [direction]: owner } }),
		};
		const logs = await getLogsPaginated({
			client: filtered,
			address: token,
			event,
			fromBlock: BigInt(first.block) + 1n,
			toBlock: BigInt(last.block),
			chunkSize: 8000n,
		});
		for (const log of logs)
			unique.set(`${log.blockHash}:${log.transactionHash}:${log.logIndex}`, log);
	}
	const logs = [...unique.values()];
	const delta = logs.reduce(
		(sum, log) =>
			sum +
			(log.args.to.toLowerCase() === owner ? log.args.value : 0n) -
			(log.args.from.toLowerCase() === owner ? log.args.value : 0n),
		0n,
	);
	const expected = BigInt(last.kntq) - BigInt(first.kntq);
	assert.equal(delta, expected, "All wallet KNTQ transfer logs match historical balance delta");
	const ownHashes = new Set(a.rows.map((r) => r.hash));
	const externalTransactions = logs.filter((l) => !ownHashes.has(l.transactionHash));
	write("token-flows.json", {
		owner,
		token,
		fromBlock: first.block,
		toBlock: last.block,
		delta,
		expected,
		matches: delta === expected,
		logs,
		externalTransactions,
		note: "Covers KNTQ transfers from all senders, not only wallet-initiated transactions. Native HYPE internal flow still requires trace.",
	});
	console.log(
		"KNTQ balance/Transfer reconciliation:",
		logs.length,
		"logs; external-transaction transfers:",
		externalTransactions.length,
	);
}

if (process.argv.includes("--wallet-boundaries")) {
	const { readV4 } = await import("file:///D:/Axiangmu/流动性LP/backend/v4.ts");
	const audit = load(`${dir}/usd-audit.json`);
	const targets = [
		{ hour: 1794268800, nft: "4716", fee: 10000, spacing: 200 },
		{ hour: 1794272400, nft: "4915", fee: 10000, spacing: 200 },
		{ hour: 1794276000, nft: "5791", fee: 8000, spacing: 120 },
	];
	const snapshots = [];
	const paired = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
	for (const target of targets) {
		const h = audit.hours.find((h) => h.windowStart === target.hour);
		assert.ok(h);
		const number = BigInt(h.atBlock),
			block = await client.getBlock({ blockNumber: number });
		const policy = {
			protocol: "v4",
			key: {
				currency0: ZERO_ADDRESS,
				currency1: paired,
				fee: target.fee,
				tickSpacing: target.spacing,
				hooks: ZERO_ADDRESS,
			},
		};
		const state = await readV4(client, policy, owner, target.nft, {
			number,
			timestamp: block.timestamp,
		});
		const p = state.position;
		const totalH = state.native + state.h + p.h + p.feeH,
			totalK = state.k + p.k + p.feeK;
		const value = new Decimal(totalH.toString())
			.div("1e18")
			.mul(h.prices[ZERO_ADDRESS])
			.plus(new Decimal(totalK.toString()).div("1e18").mul(h.prices[paired]));
		snapshots.push({
			signalBoundary: target.hour + H,
			actualBlockTime: Number(block.timestamp),
			blockNumber: String(number),
			blockHash: block.hash,
			nft: target.nft,
			fee: target.fee,
			native: state.native,
			whype: state.h,
			walletKntq: state.k,
			position: p,
			totalH,
			totalK,
			tick: state.tick,
			active: state.tick >= p.lower && state.tick < p.upper,
			prices: h.prices,
			markUsd: value.toString(),
			note: "Actual wallet HYPE/WHYPE/KNTQ plus selected owned NFT and unclaimed fees, valued with same-block direct bridges. Not a counterfactual strategy PnL, executable quote, or executed exit. Other asset classes not included.",
		});
		write("wallet-boundaries.json", { snapshots });
		console.log("Actual wallet mark", target.hour + H, target.nft, value.toFixed(2));
	}
}

if (process.argv.includes("--backfill")) {
	const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
	const anchor = db
		.prepare("SELECT from_block FROM scanned_hours WHERE protocol=? AND window_start=?")
		.get("uniswap_v4", 1794232800);
	db.close();
	assert.ok(anchor);
	const head = await client.getBlock({ blockNumber: BigInt(anchor.from_block) });
	const tip = { blockNumber: head.number, timestamp: Number(head.timestamp) };
	const boundaries = [
		await findBlockAtOrAfter(client, 1794225600, tip),
		await findBlockAtOrAfter(client, 1794229200, tip),
		BigInt(anchor.from_block),
	];
	const pool = {
		poolId,
		token0: ZERO_ADDRESS,
		token1: "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0",
		feePips: 10000,
		tickSpacing: 200,
		hooks: ZERO_ADDRESS,
	};
	const results = [];
	// Reuse the existing pagination and decoder with a pool-ID RPC filter.
	const filtered = {
		...client,
		getLogs: (params) => client.getLogs({ ...params, args: { id: poolId } }),
	};
	for (let i = 0; i < 2; i++) {
		const fromBlock = boundaries[i],
			toBlock = boundaries[i + 1] - 1n;
		const window = {
			startUnix: 1794225600 + i * H,
			endUnix: 1794229200 + i * H,
			complete: true,
			fromBlock,
			toBlock,
		};
		const slot = (await readV4Slot0s(client, [poolId], toBlock)).get(poolId);
		assert.ok(slot, "Historical protocol state is required");
		const reserves = (await readV4Reserves(client, [pool], 1, toBlock)).get(poolId);
		const logs = await getLogsPaginated({
			client: filtered,
			address: UNISWAP_V4_ELYSIUM.poolManager,
			event: v4PoolManagerAbi[1],
			fromBlock,
			toBlock,
			chunkSize: 8000n,
		});
		const seen = new Set();
		const decoded = logs
			.map((l) => {
				const key = `${l.blockHash}:${l.transactionHash}:${l.logIndex}`;
				assert.ok(!seen.has(key), "Duplicate log");
				seen.add(key);
				assert.equal(l.topics[1].toLowerCase(), poolId);
				return decodeV4SwapLog(l, (direction) => unpackV4ProtocolFee(slot.protocolFee, direction));
			})
			.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
		const acc = accumulateSwapWindows(decoded, [window]).get(`${poolId}:${window.startUnix}`);
		assert.ok(acc);
		const kPrice = new Decimal(2).pow(192).div(new Decimal(slot.sqrtPriceX96.toString()).pow(2));
		const inHype = (h, k) =>
			new Decimal(h.toString()).plus(new Decimal(k.toString()).mul(kPrice)).div("1e18");
		const tvl = reserves && !reserves.gap ? inHype(reserves.amount0, reserves.amount1) : null;
		const volume = inHype(acc.volume0, acc.volume1).div(2),
			fees = inHype(acc.lpFees0, acc.lpFees1);
		results.push({
			window,
			slot,
			reserves,
			acc,
			rawLogs: logs,
			volumeHype: volume.toString(),
			lpFeesHype: fees.toString(),
			tvlHype: tvl?.toString() ?? null,
			efficiency: tvl?.gt(0) ? capitalEfficiency(volume, tvl)?.toString() : null,
			feeIntensity: tvl?.gt(0) ? fees.div(tvl).toString() : null,
			usdEligibility: "unknown_no_same_block_official_USD_bridge",
			quality:
				"event_fee_estimate_using_hour_end_protocol_state; historical_changes_and_tick_rounding_unreconciled",
		});
		write("earliest-hours.json", { results, failures });
		console.log(
			"Backfilled raw hour",
			window.startUnix,
			"swaps",
			decoded.length,
			"TVL gap",
			reserves?.gap ?? null,
		);
	}
}

if (process.argv.includes("--price-earliest")) {
	const early = load(`${dir}/earliest-hours.json`);
	const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
	const bridges = db
		.prepare(
			"SELECT * FROM pools WHERE protocol=? AND lower(token0)=? AND lower(token1)=? AND created_block<?",
		)
		.all(
			"uniswap_v4",
			ZERO_ADDRESS,
			ELYSIUM_USDC_ADDRESS.toLowerCase(),
			Number(early.results[0].window.fromBlock),
		);
	const stable = db
		.prepare("SELECT decimals FROM tokens WHERE chain_id=99901 AND lower(address)=?")
		.get(ELYSIUM_USDC_ADDRESS.toLowerCase());
	db.close();
	assert.ok(stable);
	const paired = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
	const decimals = new Map([
		[ZERO_ADDRESS, 18],
		[paired, 18],
		[ELYSIUM_USDC_ADDRESS.toLowerCase(), stable.decimals],
	]);
	const normalized = [];
	for (const r of early.results) {
		const at = BigInt(r.window.toBlock);
		const states = await readV4Slot0s(
			client,
			bridges.map((b) => b.pool_id),
			at,
		);
		const priced = bridges.flatMap((b) => {
			const s = states.get(b.pool_id);
			return s && s.liquidity > 0n ? [{ token0: b.token0, token1: b.token1, ...s }] : [];
		});
		priced.push({
			token0: ZERO_ADDRESS,
			token1: paired,
			sqrtPriceX96: BigInt(r.slot.sqrtPriceX96),
			liquidity: BigInt(r.slot.liquidity),
		});
		const prices = buildUsdPrices(priced, decimals);
		assert.ok(prices.has(ZERO_ADDRESS) && prices.has(paired), "Same-block USD bridge unavailable");
		const boundary = (await readV4Slot0s(client, [poolId], BigInt(r.window.fromBlock) - 1n)).get(
			poolId,
		);
		assert.ok(boundary);
		const value = (a, b) =>
			sumUsd(
				valueRawUsd(BigInt(a), ZERO_ADDRESS, prices, decimals),
				valueRawUsd(BigInt(b), paired, prices, decimals),
			);
		const volume = value(r.acc.volume0, r.acc.volume1).div(2);
		const fees = value(r.acc.lpFees0, r.acc.lpFees1);
		const tvl =
			r.reserves && !r.reserves.gap ? value(r.reserves.amount0, r.reserves.amount1) : null;
		normalized.push({
			pool_id: poolId,
			window_start: r.window.startUnix,
			window_end: r.window.endUnix,
			complete: 1,
			volume0: r.acc.volume0,
			volume1: r.acc.volume1,
			lp_fees0: r.acc.lpFees0,
			lp_fees1: r.acc.lpFees1,
			swap_count: r.acc.swapCount,
			volume_usd: volume.toString(),
			lp_fees_usd: fees.toString(),
			tvl_usd: tvl?.toString() ?? null,
			sqrt_price_start: String(boundary.sqrtPriceX96),
			sqrt_price_end: r.slot.sqrtPriceX96,
			source: "research_single_pool_reconstruction",
			as_of: new Date().toISOString(),
			gap_reason: r.reserves?.gap ?? null,
			fee_status: "estimated",
			priceEvidence: {
				atBlock: String(at),
				prices: Object.fromEntries([...prices].map(([k, v]) => [k, v.toString()])),
				bridgeStates: Object.fromEntries(states),
				note: "Existing buildUsdPrices using the target pool and all pre-existing direct native/official-USDC V4 bridges; source selection may differ from original full-venue refresh.",
			},
		});
		console.log(
			"Priced early hour",
			r.window.startUnix,
			"volume",
			volume.toFixed(2),
			"TVL",
			tvl?.toFixed(2),
		);
	}
	write("earliest-normalized.json", { normalized, failures });
}

if (process.argv.includes("--check-tvl")) {
	const source = load(`${dir}/hour-input.json`).hours;
	const target = source
		.filter((r) => r.tvl_usd !== null)
		.sort((a, b) => new Decimal(b.tvl_usd).cmp(a.tvl_usd))[0];
	const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
	const bound = db
		.prepare("SELECT * FROM scanned_hours WHERE protocol=? AND window_start=?")
		.get("uniswap_v4", target.window_start);
	const bridges = db
		.prepare(
			"SELECT * FROM pools WHERE protocol=? AND lower(token0)=? AND lower(token1)=? AND created_block<?",
		)
		.all(
			"uniswap_v4",
			ZERO_ADDRESS,
			ELYSIUM_USDC_ADDRESS.toLowerCase(),
			Number(bound.state_block_number ?? bound.to_block),
		);
	db.close();
	const blockNumber = BigInt(bound.state_block_number ?? bound.to_block);
	const states = await readV4Slot0s(
		client,
		[poolId, ...bridges.map((b) => b.pool_id)],
		blockNumber,
	);
	const slot = states.get(poolId);
	assert.ok(slot);
	const paired = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
	const reserves = (
		await readV4Reserves(
			client,
			[
				{
					poolId,
					token0: ZERO_ADDRESS,
					token1: paired,
					feePips: 10000,
					tickSpacing: 200,
					hooks: ZERO_ADDRESS,
				},
			],
			1,
			blockNumber,
		)
	).get(poolId);
	assert.ok(reserves && !reserves.gap);
	const priced = bridges.flatMap((b) => {
		const s = states.get(b.pool_id);
		return s && s.liquidity > 0n ? [{ token0: b.token0, token1: b.token1, ...s }] : [];
	});
	priced.push({ token0: ZERO_ADDRESS, token1: paired, ...slot });
	const decimals = new Map([
		[ZERO_ADDRESS, 18],
		[paired, 18],
		[ELYSIUM_USDC_ADDRESS.toLowerCase(), 6],
	]);
	const prices = buildUsdPrices(priced, decimals);
	const value = (a, b) =>
		sumUsd(
			valueRawUsd(BigInt(a), ZERO_ADDRESS, prices, decimals),
			valueRawUsd(BigInt(b), paired, prices, decimals),
		);
	const revalued = value(reserves.amount0, reserves.amount1);
	assert.ok(revalued);
	const relativeDifference = revalued.div(target.tvl_usd).minus(1);
	write("tvl-check.json", {
		target,
		blockNumber,
		slot,
		reserves,
		bridgeStates: Object.fromEntries(states),
		prices: Object.fromEntries([...prices].map(([k, v]) => [k, v.toString()])),
		revaluedTvlUsd: revalued.toString(),
		relativeDifference: relativeDifference.toString(),
		explanation:
			"Same-block raw reserves and direct native/official-USDC bridges; source-price path may differ from the complete venue refresh. A discrepancy is not automatically a reserve error.",
	});
	console.log(
		"Largest TVL cross-check:",
		target.tvl_usd,
		"direct-bridge valuation",
		revalued.toFixed(2),
		"difference",
		relativeDifference.toFixed(6),
	);
}

if (process.argv.includes("--audit-usd")) {
	const primary = load(`${dir}/hour-input.json`).hours;
	const other = load(`${dir}/timeline.json`).hourly.filter((r) => r.pool_id !== poolId);
	const early = load(`${dir}/earliest-normalized.json`).normalized;
	const ending = load(`${dir}/exit-boundary.json`).removal.actualTime;
	const inputs = [...primary, ...other, ...early].filter((r) => r.window_start < ending);
	const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
	const bridges = db
		.prepare("SELECT * FROM pools WHERE protocol=? AND lower(token0)=? AND lower(token1)=?")
		.all("uniswap_v4", ZERO_ADDRESS, ELYSIUM_USDC_ADDRESS.toLowerCase());
	const pools = new Map(
		db
			.prepare("SELECT * FROM pools WHERE token1=? AND token0=?")
			.all("0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0", ZERO_ADDRESS)
			.map((p) => [p.pool_id, p]),
	);
	const bounds = new Map(
		db
			.prepare(
				"SELECT window_start,state_block_number,to_block FROM scanned_hours WHERE protocol=?",
			)
			.all("uniswap_v4")
			.map((r) => [r.window_start, r]),
	);
	db.close();
	const result = fs.existsSync(`${dir}/usd-audit.json`)
		? load(`${dir}/usd-audit.json`)
		: { hours: [], failures: [] };
	const checked = new Set(
		result.hours.filter((h) => h.status === "observed").map((h) => h.windowStart),
	);
	const paired = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
	const decimals = new Map([
		[ZERO_ADDRESS, 18],
		[paired, 18],
		[ELYSIUM_USDC_ADDRESS.toLowerCase(), 6],
	]);
	for (const time of [...new Set(inputs.map((r) => r.window_start))].sort((a, b) => a - b)) {
		if (checked.has(time)) continue;
		const records = inputs.filter((r) => r.window_start === time);
		const bound = bounds.get(time);
		const blockNumber = BigInt(
			bound?.state_block_number ?? bound?.to_block ?? records[0].priceEvidence.atBlock,
		);
		try {
			const links = bridges.filter((b) => BigInt(b.created_block) <= blockNumber);
			const ids = records.map((r) => r.pool_id);
			const states = await readV4Slot0s(
				client,
				[...ids, ...links.map((b) => b.pool_id)],
				blockNumber,
			);
			const toRead = ids.map((id) => {
				const p = pools.get(id);
				assert.ok(p);
				return {
					poolId: id,
					token0: p.token0,
					token1: p.token1,
					feePips: p.fee_pips,
					tickSpacing: p.tick_spacing,
					hooks: p.hooks,
				};
			});
			const reserveMap = await readV4Reserves(client, toRead, 1, blockNumber);
			const priced = [...links, ...ids.map((id) => pools.get(id))].flatMap((p) => {
				const s = states.get(p.pool_id);
				return s && s.liquidity > 0n ? [{ token0: p.token0, token1: p.token1, ...s }] : [];
			});
			const prices = buildUsdPrices(priced, decimals);
			assert.ok(prices.has(ZERO_ADDRESS) && prices.has(paired));
			const value = (a, b) =>
				sumUsd(
					valueRawUsd(BigInt(a), ZERO_ADDRESS, prices, decimals),
					valueRawUsd(BigInt(b), paired, prices, decimals),
				);
			const normalized = records.map((r) => {
				const s = states.get(r.pool_id),
					reserves = reserveMap.get(r.pool_id);
				assert.ok(s && reserves && !reserves.gap, "Missing historical pool state or reserves");
				const volume = value(r.volume0, r.volume1).div(2),
					fees = value(r.lp_fees0, r.lp_fees1),
					tvl = value(reserves.amount0, reserves.amount1);
				assert.ok(tvl.gt(0));
				return {
					...r,
					originalVolumeUsd: r.volume_usd,
					originalFeesUsd: r.lp_fees_usd,
					originalTvlUsd: r.tvl_usd,
					volume_usd: volume.toString(),
					lp_fees_usd: fees.toString(),
					tvl_usd: tvl.toString(),
					source: "research_direct_bridge_revaluation",
					originalSource: r.source,
					tvlRelativeDifference: new Decimal(tvl).div(r.tvl_usd).minus(1).toString(),
					slotMatchesSource: String(s.sqrtPriceX96) === r.sqrt_price_end,
					reserves,
				};
			});
			result.hours = result.hours.filter((h) => h.windowStart !== time);
			result.hours.push({
				windowStart: time,
				atBlock: String(blockNumber),
				status: "observed",
				prices: Object.fromEntries([...prices].map(([k, v]) => [k, v.toString()])),
				states: Object.fromEntries(states),
				normalized,
			});
		} catch (e) {
			result.hours.push({
				windowStart: time,
				atBlock: String(blockNumber),
				status: "missing",
				error: String(e).slice(0, 500),
			});
		}
		result.failures = failures;
		write("usd-audit.json", result);
		if (result.hours.length % 12 === 0)
			console.log(
				"USD state checks",
				result.hours.filter((h) => h.status === "observed").length,
				"/",
				new Set(inputs.map((r) => r.window_start)).size,
			);
	}
}

if (process.argv.includes("--fill-gaps")) {
	const audit = load(`${dir}/usd-audit.json`);
	const source = load(`${dir}/timeline.json`).hourly;
	const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
	const bounds = new Map(
		db
			.prepare("SELECT * FROM scanned_hours WHERE protocol=?")
			.all("uniswap_v4")
			.map((r) => [r.window_start, r]),
	);
	const catalog = new Map(
		db
			.prepare("SELECT * FROM pools WHERE token1=? AND token0=?")
			.all("0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0", ZERO_ADDRESS)
			.map((r) => [r.pool_id, r]),
	);
	db.close();
	const evidence = fs.existsSync(`${dir}/gap-evidence.json`)
		? load(`${dir}/gap-evidence.json`)
		: [];
	const earlyBounds = new Map(
		load(`${dir}/earliest-hours.json`).results.map((r) => [
			r.window.startUnix,
			{
				complete: 1,
				from_block: r.window.fromBlock,
				to_block: r.window.toBlock,
				state_block_number: r.window.toBlock,
			},
		]),
	);
	for (const id of new Set(source.map((r) => r.pool_id))) {
		const originals = source
			.filter((r) => r.pool_id === id)
			.sort((a, b) => a.window_start - b.window_start);
		for (const time of audit.hours
			.map((h) => h.windowStart)
			.filter((t) => t <= originals.at(-1).window_start)
			.sort((a, b) => a - b)) {
			const h = audit.hours.find((h) => h.windowStart === time && h.status === "observed");
			if (!h || h.normalized.some((r) => r.pool_id === id)) continue;
			const bound = bounds.get(time) ?? earlyBounds.get(time),
				pool = catalog.get(id);
			assert.ok(bound?.complete && pool);
			const fromBlock = BigInt(bound.from_block),
				toBlock = BigInt(bound.to_block),
				at = BigInt(bound.state_block_number ?? bound.to_block);
			const slot = (await readV4Slot0s(client, [id], at)).get(id);
			const reserves = (
				await readV4Reserves(
					client,
					[
						{
							poolId: id,
							token0: pool.token0,
							token1: pool.token1,
							feePips: pool.fee_pips,
							tickSpacing: pool.tick_spacing,
							hooks: pool.hooks,
						},
					],
					1,
					at,
				)
			).get(id);
			assert.ok(slot && reserves && !reserves.gap);
			const filtered = {
				...client,
				getLogs: (params) => client.getLogs({ ...params, args: { id } }),
			};
			const logs = await getLogsPaginated({
				client: filtered,
				address: UNISWAP_V4_ELYSIUM.poolManager,
				event: v4PoolManagerAbi[1],
				fromBlock,
				toBlock,
				chunkSize: 8000n,
			});
			const window = { startUnix: time, endUnix: time + H, complete: true, fromBlock, toBlock };
			const swaps = logs
				.map((l) =>
					decodeV4SwapLog(l, (direction) => unpackV4ProtocolFee(slot.protocolFee, direction)),
				)
				.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
			const acc = accumulateSwapWindows(swaps, [window]).get(`${id}:${time}`);
			const prices = new Map(Object.entries(h.prices).map(([k, v]) => [k, new Decimal(v)]));
			const decimals = new Map([
				[ZERO_ADDRESS, 18],
				[pool.token1, 18],
				[ELYSIUM_USDC_ADDRESS.toLowerCase(), 6],
			]);
			const value = (a, b) =>
				sumUsd(
					valueRawUsd(BigInt(a), ZERO_ADDRESS, prices, decimals),
					valueRawUsd(BigInt(b), pool.token1, prices, decimals),
				);
			const boundary = (await readV4Slot0s(client, [id], fromBlock - 1n)).get(id);
			assert.ok(boundary);
			// Zero is used only after the complete filtered chain log query returned no swaps.
			const v0 = acc?.volume0 ?? 0n,
				v1 = acc?.volume1 ?? 0n,
				f0 = acc?.lpFees0 ?? 0n,
				f1 = acc?.lpFees1 ?? 0n;
			const r = {
				pool_id: id,
				window_start: time,
				window_end: time + H,
				complete: 1,
				volume0: String(v0),
				volume1: String(v1),
				lp_fees0: String(f0),
				lp_fees1: String(f1),
				volume_usd: value(v0, v1).div(2).toString(),
				lp_fees_usd: value(f0, f1).toString(),
				tvl_usd: value(reserves.amount0, reserves.amount1).toString(),
				swap_count: logs.length,
				sqrt_price_start: String(boundary.sqrtPriceX96),
				sqrt_price_end: String(slot.sqrtPriceX96),
				fee_status: "estimated",
				gap_reason: null,
				source: "research_gap_chain_query",
				originalTvlUsd: null,
				originalFeesUsd: null,
				originalVolumeUsd: null,
				originalComparisonAvailable: false,
				tvlRelativeDifference: "0",
				slotMatchesSource: null,
				reserves,
			};
			h.normalized.push(r);
			h.states[id] = slot;
			evidence.push({
				poolId: id,
				window,
				atBlock: String(at),
				logs,
				slot,
				reserves,
				recoveredSwaps: logs.length,
			});
			write("gap-evidence.json", evidence);
			write("usd-audit.json", audit);
			console.log("Gap read", time, id.slice(0, 10), "swaps", logs.length);
		}
	}
}

if (fs.existsSync(`${dir}/exit-boundary.json`)) {
	const boundary = load(`${dir}/exit-boundary.json`);
	let hours;
	if (fs.existsSync(`${dir}/hour-input.json`)) hours = load(`${dir}/hour-input.json`).hours;
	else {
		const db = new DatabaseSync("data/lp-atlas.db", { readOnly: true });
		db.exec("BEGIN");
		hours = db
			.prepare(
				"SELECT * FROM window_aggregates WHERE pool_id=? AND window_end>? AND window_start<? ORDER BY window_start",
			)
			.all(poolId, start, boundary.removal.actualTime);
		db.exec("COMMIT");
		db.close();
		write("hour-input.json", { frozenAt: new Date().toISOString(), hours });
	}
	// The previous read-only export contains the separately held 0.8% pool.
	// Keep its frozen values and identity; never join its hours into the 1% pool.
	const timeline = load(`${dir}/timeline.json`);
	const otherPool = timeline.hourly.filter(
		(r) =>
			r.pool_id !== poolId && r.window_end > start && r.window_start < boundary.removal.actualTime,
	);
	hours = [...hours, ...otherPool];
	if (fs.existsSync(`${dir}/earliest-normalized.json`)) {
		const extra = load(`${dir}/earliest-normalized.json`).normalized;
		const merged = new Map(hours.map((r) => [`${r.pool_id}:${r.window_start}`, r]));
		for (const r of extra)
			if (!merged.has(`${r.pool_id}:${r.window_start}`))
				merged.set(`${r.pool_id}:${r.window_start}`, r);
		hours = [...merged.values()].sort((a, b) => a.window_start - b.window_start);
	}
	if (process.argv.includes("--audited")) {
		const audited = load(`${dir}/usd-audit.json`).hours;
		const checked = new Map(
			audited
				.filter((r) => r.status === "observed")
				.flatMap((r) => r.normalized)
				.map((r) => [`${r.pool_id}:${r.window_start}`, r]),
		);
		hours = hours.map(
			(r) =>
				checked.get(`${r.pool_id}:${r.window_start}`) ?? {
					...r,
					gap_reason: "research_USD_audit_missing",
				},
		);
		const present = new Set(hours.map((r) => `${r.pool_id}:${r.window_start}`));
		for (const [key, r] of checked) if (!present.has(key)) hours.push(r);
		hours.sort((a, b) => a.window_start - b.window_start);
	}
	const rows = hours.map((r) => {
		const usable =
			r.complete === 1 &&
			!r.gap_reason &&
			r.fee_status === "estimated" &&
			r.tvl_usd !== null &&
			new Decimal(r.tvl_usd).gt(0) &&
			r.volume_usd !== null &&
			r.lp_fees_usd !== null;
		const unusableReason = usable
			? null
			: r.complete !== 1
				? "incomplete_hour"
				: r.gap_reason
					? r.gap_reason
					: r.fee_status !== "estimated"
						? "fee_status_unresolved"
						: r.tvl_usd === null
							? "TVL_missing"
							: new Decimal(r.tvl_usd).lte(0)
								? "TVL_zero_or_negative"
								: r.volume_usd === null
									? "volume_missing"
									: "fees_missing";
		const e = usable ? capitalEfficiency(new Decimal(r.volume_usd), new Decimal(r.tvl_usd)) : null;
		const q = usable ? new Decimal(r.lp_fees_usd).div(r.tvl_usd) : null;
		const apr = usable
			? annualizeFeesApr({
					lpFeesUsd: new Decimal(r.lp_fees_usd),
					tvlUsd: new Decimal(r.tvl_usd),
					windowDurationSeconds: H,
				})
			: null;
		return {
			...r,
			usable,
			unusableReason,
			e: e?.toString() ?? null,
			q: q?.toString() ?? null,
			apr: apr?.toString() ?? null,
		};
	});
	const base = (r) =>
		r?.usable &&
		new Decimal(r.tvl_usd).gte(1000) &&
		new Decimal(r.volume_usd).gte(100) &&
		new Decimal(r.lp_fees_usd).gte(10);
	const high = (r) => base(r) && new Decimal(r.e).gte(1) && new Decimal(r.q).gte("0.001");
	const definitions = {
		baseline: (r) => base(r),
		sustained: (r, p) => high(r) && high(p),
		acceleration: (r, p) =>
			high(r) &&
			p?.usable &&
			new Decimal(p.volume_usd).gt(0) &&
			new Decimal(r.volume_usd).gte(new Decimal(p.volume_usd).mul(2)),
		fee_intensity: (r) => base(r) && new Decimal(r.q).gte("0.001"),
	};
	const trades = [];
	for (const selectedPool of new Set(rows.map((r) => r.pool_id))) {
		const poolRows = rows.filter((r) => r.pool_id === selectedPool);
		const byStart = new Map(poolRows.map((r) => [r.window_start, r]));
		for (const [strategy, trigger] of Object.entries(definitions))
			for (const mode of ["expiry", "fee_half", "efficiency_half", "both_half"])
				for (const horizon of [0.5, 1, 2, 4, 6, 12]) {
					if (horizon === 0.5) {
						trades.push({
							strategy,
							mode,
							horizon,
							poolId: selectedPool,
							status: "not_executed",
							reason: "No complete half-hour input; hourly fees are not split.",
						});
						continue;
					}
					let nextEligible = start;
					for (const r of poolRows) {
						const entry = r.window_end;
						if (
							entry < start ||
							entry < nextEligible ||
							entry >= boundary.removal.actualTime ||
							!trigger(r, byStart.get(r.window_start - H))
						)
							continue;
						let exit,
							reason,
							status = "observed";
						const future = [];
						for (let step = 1; step <= horizon; step++) {
							const t = entry + (step - 1) * H;
							if (t + H > boundary.removal.actualTime) {
								status = "censored";
								reason = "LP_exit_boundary";
								break;
							}
							const f = byStart.get(t);
							if (!f?.usable) {
								status = "missing";
								reason = f?.unusableReason ?? "hour_absent";
								break;
							}
							future.push(f);
							const feeHalf = new Decimal(f.q).lte(new Decimal(r.q).mul("0.5"));
							const efficiencyHalf = new Decimal(f.e).lte(new Decimal(r.e).mul("0.5"));
							const decay =
								mode === "fee_half"
									? feeHalf
									: mode === "efficiency_half"
										? efficiencyHalf
										: mode === "both_half"
											? feeHalf && efficiencyHalf
											: false;
							if (decay || step === horizon) {
								exit = f.window_end;
								reason = decay ? mode : "expiry";
								break;
							}
						}
						const last = future.at(-1);
						const feeRatio =
							status === "observed"
								? future
										.reduce((sum, f) => sum.plus(f.lp_fees_usd), new Decimal(0))
										.div(r.tvl_usd)
										.toString()
								: null;
						const priceChange =
							status === "observed" && r.sqrt_price_end && last.sqrt_price_end
								? new Decimal(r.sqrt_price_end).div(last.sqrt_price_end).pow(2).minus(1).toString()
								: null;
						trades.push({
							strategy,
							mode,
							horizon,
							poolId: selectedPool,
							signalHourStart: r.window_start,
							entry,
							exit: exit ?? null,
							status,
							reason,
							entryEfficiency: r.e,
							entryFeeIntensity: r.q,
							futureFeeOverEntryPoolTvl: feeRatio,
							kntqPriceChangeInHype: priceChange,
							entryVolumeUsd: r.volume_usd,
							entryTvlUsd: r.tvl_usd,
							observedHours: future.length,
							personalPnl: null,
							feeQuality: "estimated",
							execution: "ideal_hour_boundary_observation_not_executed_trade",
						});
						nextEligible = status === "observed" ? exit + H : boundary.removal.actualTime;
					}
				}
	}
	for (const r of trades.filter((r) => r.entry)) {
		assert.equal(r.entry, r.signalHourStart + H);
		if (r.exit) {
			assert.ok(r.exit > r.entry);
			assert.ok(r.exit <= boundary.removal.actualTime);
			assert.ok(r.exit - r.entry <= r.horizon * H);
		}
		assert.equal(r.personalPnl, null);
	}
	if (process.argv.includes("--verify")) {
		const impulse = trades.find(
			(t) =>
				t.poolId === poolId &&
				t.strategy === "acceleration" &&
				t.mode === "both_half" &&
				t.horizon === 12 &&
				t.entry === 1794272400,
		);
		assert.ok(impulse, "08:00-09:00 impulse is only available at 09:00");
		assert.equal(impulse.exit, 1794276000, "Decay first observed after 09:00-10:00 closes");
		const entryRow = rows.find(
				(r) => r.pool_id === poolId && r.window_start === impulse.signalHourStart,
			),
			after = rows.find((r) => r.pool_id === poolId && r.window_start === impulse.entry);
		assert.ok(new Decimal(after.q).lt(new Decimal(entryRow.q).div(2)));
		assert.ok(new Decimal(after.e).lt(new Decimal(entryRow.e).div(2)));
		for (const id of new Set(rows.map((r) => r.pool_id)))
			for (const strategy of Object.keys(definitions))
				for (const mode of ["expiry", "fee_half", "efficiency_half", "both_half"])
					for (const horizon of [1, 2, 4, 6, 12]) {
						const selected = trades.filter(
							(t) =>
								t.poolId === id &&
								t.strategy === strategy &&
								t.mode === mode &&
								t.horizon === horizon &&
								t.entry,
						);
						for (let i = 1; i < selected.length; i++)
							assert.ok(
								selected[i].entry >= selected[i - 1].exit + H,
								"No overlap or immediate reentry",
							);
					}
		assert.equal(
			trades.filter((t) => t.horizon === 0.5).every((t) => t.status === "not_executed"),
			true,
		);
		if (process.argv.includes("--audited")) {
			const data = load(`${dir}/usd-audit.json`);
			const extreme = data.hours
				.find((h) => h.windowStart === 1794348000)
				?.normalized.find((r) => r.pool_id === poolId);
			assert.ok(extreme, "Known bad USD hour must be represented");
			assert.ok(
				new Decimal(extreme.originalTvlUsd).div(extreme.tvl_usd).gt(90),
				"Do not accidentally reuse the inflated USD input",
			);
			assert.ok(
				rows.some((r) => r.pool_id === poolId && r.window_start === 1794225600),
				"Earliest raw hour recovered",
			);
			assert.ok(
				rows.some((r) => r.pool_id === poolId && r.window_start === 1794229200),
				"Second earliest hour recovered",
			);
			if (fs.existsSync(`${dir}/gap-evidence.json`))
				for (const g of load(`${dir}/gap-evidence.json`)) {
					if (g.logs.length === 0) {
						const recovered = rows.find(
							(r) => r.pool_id === g.poolId && r.window_start === g.window.startUnix,
						);
						assert.equal(recovered.swap_count, 0);
						assert.equal(recovered.lp_fees0, "0");
						assert.equal(recovered.lp_fees1, "0");
					}
				}
		}
		console.log(
			"Verified temporal boundaries, observed decay, non-overlap, half-hour exclusion and null personal PnL.",
		);
	}
	write(process.argv.includes("--audited") ? "signal-tests-audited.json" : "signal-tests.json", {
		dataStart: start,
		lpExitTime: boundary.removal.actualTime,
		valuationBasis: process.argv.includes("--audited")
			? "same_block_direct_official_USDC_bridge_research"
			: "original_USD_inputs_contain_known_price_anomaly_use_audited_version",
		rows,
		trades,
		note: "Pool-level signal observations only; source fees remain estimated. Reconstructed boundary availability is idealized. No personal PnL is inferred.",
	});
	if (process.argv.includes("--audited")) {
		const audit = load(`${dir}/usd-audit.json`);
		const normalized = audit.hours
			.filter((h) => h.status === "observed")
			.flatMap((h) => h.normalized);
		const changed = normalized.filter((r) => new Decimal(r.tvlRelativeDifference).abs().gt("0.01"));
		const local = (t) =>
			new Date(t * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
		const percent = (value) => new Decimal(value).mul(100).toFixed(3) + "%";
		const gaps = fs.existsSync(`${dir}/gap-evidence.json`) ? load(`${dir}/gap-evidence.json`) : [];
		let report = `# KNTQ真实数据校准与信号测试结果\n\n研究方案：docs/03-data/06-signal-research.md末节；执行清单：docs/04-standards/05-roadmap.md研究组。\n\n## 目前能确认什么\n\n补回最早两个小时，共2,586条成交事件，保留原始日志、精确区块范围及价格边界。两端资产和70笔交易的费用checkpoint已重读；爆发段23条KNTQ转账与钱包余额差完全一致，未见其他交易额外转入KNTQ。不能因此排除原生HYPE内部转入。\n\n另逐项读取0.8%池内部缺少的${gaps.length}个小时，${gaps.filter((g) => g.logs.length === 0).length}个小时完整Swap日志查询结果为零，并读取历史TVL和边界价格；这些是已取证的无Swap小时，不再按未知缺档处理，也不是用假设零填充。\n\n全周期LP暴露终点改为真实撤仓区块${boundary.removal.block}，北京时间${local(boundary.removal.actualTime)}；兑换完成于${local(boundary.conversion.actualTime)}。两者均不同于原核验文件生成时间，不能合并。\n\n## 美元输入核对\n\n逐小时检查同区块的官方状态、ReservesLens、直接原生HYPE/官方USDC桥，沿用项目buildUsdPrices、sumUsd及资金效率/APR函数。核对${audit.hours.filter((h) => h.status === "observed").length}个小时边界、${normalized.length}个池小时；未核对成功的小时${audit.hours.filter((h) => h.status !== "observed").length}个。本轮测试中，超过1%的TVL计价差异有${changed.length}个池小时，全部保留原值与研究重估值。研究重估不改生产数据库；直接桥估值与原全场所价格路径可能不同，不能自动认定储备数据错误。\n\n`;
		const extreme = normalized
			.slice()
			.sort((a, b) =>
				new Decimal(b.tvlRelativeDifference).abs().cmp(new Decimal(a.tvlRelativeDifference).abs()),
			)[0];
		if (extreme)
			report += `最大差异样本：${local(extreme.window_start)}，原TVL $${new Decimal(extreme.originalTvlUsd).toFixed(2)}，同区块直接桥重估 $${new Decimal(extreme.tvl_usd).toFixed(2)}。费用和成交量也用相同价格重估。资金效率、费用强度在统一等比例缩放时可以保持不变，不能把美元数值错误直接推成效率错误。\n\n`;
		if (fs.existsSync(`${dir}/price-path-diagnostic.json`)) {
			const diagnostic = load(`${dir}/price-path-diagnostic.json`);
			const one = diagnostic.results[0];
			report += `异常定价进一步核对：${local(diagnostic.hour)}原成交量和手续费的两条估值方程反推出HYPE价格约$${new Decimal(one.impliedOriginalHypeUsd).toFixed(2)}；同区块直接官方USDC桥约$${new Decimal(one.currentPrices[ZERO_ADDRESS]).toFixed(2)}。两池独立反推一致，反推价格乘官方储备又复现原TVL，支持问题出在USD价格输入；具体原始路径选择尚未定位。由于HYPE与KNTQ并非同比例错价，该小时资金效率和费用强度也会变，已在研究重估版重新计算，不能沿用原指标。\n\n`;
		}
		if (fs.existsSync(`${dir}/wallet-boundaries.json`)) {
			report +=
				"## 信号边界时的真实钱包资产\n\n|小时信号边界|实际读取区块时间|实际NFT|所列资产估值|LP是否在区间|\n|---|---|---|---:|---|\n";
			for (const s of load(`${dir}/wallet-boundaries.json`).snapshots)
				report += `|${local(s.signalBoundary)}|${local(s.actualBlockTime)}|${s.nft}|$${new Decimal(s.markUsd).toFixed(2)}|${s.active ? "是" : "否"}|\n`;
			report +=
				"\n包含钱包HYPE/WHYPE/KNTQ、所列实际NFT本金及未领费；使用同区块直接价格桥估值，不是退出成交到账。11点实际路径已切换0.8%池，区间、兑换与迁移都可能改变资产；不能将此表当成不同信号策略的个人净收益比较。其他资产类别不在本表中。\n\n";
		}
		report +=
			"## 关键小时的统一估值指标\n\n1%池；时间为小时起点，数值需等该小时结束才能用于信号。费用仍为事件重建估算，USD为同区块直接桥估值。\n\n|小时起点|成交量$|LP费用$|TVL$|资金效率|费用强度|费用APR|\n|---|---:|---:|---:|---:|---:|---:|\n";
		for (const t of [
			1794225600, 1794229200, 1794232800, 1794268800, 1794272400, 1794276000, 1794279600,
		]) {
			const r = rows.find((r) => r.pool_id === poolId && r.window_start === t);
			if (r?.usable)
				report += `|${local(t)}|${new Decimal(r.volume_usd).toFixed(2)}|${new Decimal(r.lp_fees_usd).toFixed(2)}|${new Decimal(r.tvl_usd).toFixed(2)}|${new Decimal(r.e).toFixed(3)}倍|${percent(r.q)}|${percent(r.apr)}|\n`;
		}
		report += "\n";
		report += `## 固定规则的首轮信号\n\n4个入场条件×4种退出规则×5个整小时上限（1/2/4/6/12H），两池各自测试，不作为同一个可执行账户。0.5H因没有半小时数据未执行。下面列1%池、12H上限、费用强度与效率均减半退出的部分观察；时间均为完整小时结束后首次可见边界，非真实已执行交易。\n\n|规则|提示入场|提示退出|原因|后续全池费用/入场TVL|\n|---|---|---|---|---:|\n`;
		for (const name of Object.keys(definitions)) {
			const label = {
				baseline: "原三门槛",
				sustained: "连续两小时高效",
				acceleration: "起量加速",
				fee_intensity: "仅费用强度",
			}[name];
			const selected = trades.filter(
				(t) =>
					t.poolId === poolId &&
					t.strategy === name &&
					t.mode === "both_half" &&
					t.horizon === 12 &&
					t.entry &&
					t.entry <= 1794283200,
			);
			for (const t of selected)
				report += `|${label}|${local(t.entry)}|${t.exit ? local(t.exit) : "—"}|${t.reason === "both_half" ? "效率与费用强度均减半" : t.reason}|${t.futureFeeOverEntryPoolTvl === null ? "—" : percent(t.futureFeeOverEntryPoolTvl)}|\n`;
		}
		report +=
			"\n“后续全池费用/入场TVL”是收费能力对照，不能当成个人窄区间收益。数据经历史重建，未保存各时点真实发布延迟；小时边界可用是理想观察假设。\n\n";
		const statuses = trades.reduce((acc, t) => {
			acc[t.status] = (acc[t.status] ?? 0) + 1;
			return acc;
		}, {});
		report += `## 结果数量与限制\n\n状态计数：${JSON.stringify(statuses)}。不同配置共享行情和入场，不是独立交易次数或独立盈利策略数量。\n\n- 关键验证：不使用未结束小时；入场依据在入场前结束；退出不超过持仓上限与实际LP撤仓边界；同池单配置不重叠；缺档、末端截断、半小时未执行分别记录；个人净收益字段保持null。\n- 所有全池费用继续为原estimated口径，未进行跨tick逐步取整和完整历史协议参数精确重放；USD对照不改变该事实。\n- 三次真实建仓的上下沿总宽约4.08%，活跃份额4.16%/5.67%/4.30%只适用于各自区块，不能固定应用到其他时段或假设仓位。\n- 仍受阻：原生HYPE内部转账独立取证。备用RPC不支持debug_traceTransaction，官方RPC返回401；具体样本交易在exit-boundary.json，不能宣称个人净利润精确结案。\n- 仍未完成：新区间/新入场的可核验个人收益模拟、全周期钱包收支与退出到账成本。因此不发布最佳盈利策略或精确收益率。\n\n复核入口：signal-tests-audited.json（输入、逐条提示与退出）、usd-audit.json（原值/重估值和状态）、earliest-hours.json（补回日志）、token-flows.json（实际转账）、wallet-audit.json（真实样本）、exit-boundary.json（真实终点及trace失败）。\n\n复跑：node --import tsx research/kntq-calibration.mjs --audited --verify。首次采集可分别使用--collect、--flows、--backfill、--price-earliest、--audit-usd；证据缓存可续接，无需重新采集已完成部分。\n`;
		fs.writeFileSync(`${dir}/test-results.md`, "\uFEFF" + report, "utf8");
	}
	console.log(
		"Signal observations:",
		trades.filter((r) => r.entry).length,
		"pool hours:",
		rows.length,
	);
}
