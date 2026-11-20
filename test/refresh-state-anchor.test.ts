import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Decimal from "decimal.js";
import {
	type AbiEvent,
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type PublicClient,
} from "viem";
import { expect, it, vi } from "vitest";
import { lookbackHourStarts } from "../src/normalize/refresh-hours.ts";
import { runRefreshPipeline } from "../src/normalize/refresh-pipeline.ts";
import { ELYSIUM_USDC_ADDRESS } from "../src/shared/constants.ts";
import { openDatabase, setMeta } from "../src/store/db.ts";
import {
	listScannedHours,
	upsertPool,
	upsertScannedHour,
	upsertToken,
} from "../src/store/repositories.ts";

it.each([
	{ missingState: false, elapsedMs: 0, missingReserves: false },
	{ missingState: true, elapsedMs: 0, missingReserves: false },
	{ missingState: false, elapsedMs: 300000, missingReserves: false },
	{ missingState: false, elapsedMs: 0, missingReserves: true },
])(
	"rebuilds hours at their own blocks, missing state=$missingState, elapsed=$elapsedMs, missing reserves=$missingReserves",
	async ({ missingState, elapsedMs, missingReserves }) => {
		const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-anchor-"));
		const db = await openDatabase(path.join(dir, "test.db"));
		const realNow = Date.now.bind(Date);
		let elapsed = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
		try {
			const current = Date.parse("2026-11-12T12:00:00Z") / 1000;
			let headTime = current + 600;
			const { starts } = lookbackHourStarts(headTime);
			const epoch = starts[0] as number;
			let head = BigInt(headTime - epoch);
			const blockAt = (time: number) => String(time - epoch);
			const token = `0x${"1".repeat(40)}` as const;
			const v3 = `0x${"2".repeat(40)}` as const;
			const v4 = `0x${"3".repeat(64)}` as const;
			const usdc = ELYSIUM_USDC_ADDRESS.toLowerCase() as Address;
			const q96 = 2n ** 96n;
			let currentSqrt = q96 * 2n;
			for (const address of [token, usdc])
				await upsertToken(db, {
					chainId: 99901,
					address,
					symbol: address === token ? "TEST" : "USDC",
					decimals: 6,
					name: null,
				});
			for (const protocol of ["uniswap_v3", "uniswap_v4"] as const) {
				await upsertPool(
					db,
					{
						poolId: protocol === "uniswap_v3" ? v3 : v4,
						chainId: 99901,
						protocol,
						token0: token,
						token1: usdc,
						feePips: 10000,
						tickSpacing: 200,
						hooks: null,
						poolAddress: protocol === "uniswap_v3" ? v3 : null,
						createdBlock: 1,
						createdAtUnix: epoch + 1,
					},
					new Date(epoch * 1000).toISOString(),
				);
				for (const start of starts)
					await upsertScannedHour(db, {
						chainId: 99901,
						protocol,
						windowStart: start,
						windowEnd: start + 3600,
						complete: start < current,
						fromBlock: blockAt(Math.max(epoch + 1, start)),
						toBlock: blockAt(Math.min(headTime, start + 3599)),
						// Both old ended hours must be repaired even though they were marked complete.
						stateBlockNumber: start >= current - 7200 ? null : blockAt(start + 3599),
						priceBoundaryVersion: start >= current - 7200 ? null : 1,
						asOf: new Date(headTime * 1000).toISOString(),
						gapReason: null,
					});
			}
			await setMeta(db, "v3_discover_block", String(head));
			await setMeta(db, "v4_discover_block", String(head));
			let failReserves = missingReserves;
			let failBoundary = false;
			const multicall = vi.fn(
				async ({
					contracts,
					blockNumber,
				}: {
					contracts: Array<{ functionName: string }>;
					blockNumber?: bigint;
				}) => {
					expect(blockNumber).toBeDefined();
					elapsed = elapsedMs;
					if (missingState || (failBoundary && blockNumber === BigInt(blockAt(current - 7201)))) {
						return contracts.map(() => ({
							status: "failure",
							error: new Error("state unavailable"),
						}));
					}
					const sqrt = blockNumber === head ? currentSqrt : q96;
					return contracts.map(({ functionName }) =>
						failReserves &&
						functionName === "getPoolTVL" &&
						blockNumber === BigInt(blockAt(current - 3601))
							? { status: "failure", error: new Error("429 Rate Limit Exceeded") }
							: {
									status: "success",
									result:
										functionName === "slot0"
											? [sqrt, 0, 0, 0, 0, 0, true]
											: functionName === "getSlot0"
												? [sqrt, 0, 0, 10000]
												: functionName === "getLiquidity" || functionName === "liquidity"
													? 100n
													: functionName === "balanceOf"
														? 1000000n
														: {
																coreAmount0: 1000000n,
																coreAmount1: 1000000n,
																hasCustomAccounting: false,
															},
								},
					);
				},
			);
			const getLogs = vi.fn(
				async (input: {
					event: AbiEvent;
					address: Address | Address[];
					fromBlock: bigint;
					toBlock: bigint;
				}) => {
					if (input.event.name !== "Swap") return [];
					const isV3 = Array.isArray(input.address);
					const hourStart = Math.floor((epoch + Number(input.fromBlock)) / 3600) * 3600;
					const eventBlock = BigInt(
						hourStart + (headTime > current + 600 && hourStart === current ? 700 : 100) - epoch,
					);
					if (eventBlock < input.fromBlock || eventBlock > input.toBlock) return [];
					const sqrt = hourStart === current ? q96 * 2n : q96;
					const values = isV3
						? [1000000n, -1000000n, sqrt, 100n, 0]
						: [-1000000n, 1000000n, sqrt, 100n, 0, 10000];
					const topics = encodeEventTopics({
						abi: [input.event],
						eventName: "Swap",
						args: isV3 ? { sender: token, recipient: token } : { id: v4, sender: token },
					});
					return [
						{
							address: isV3 ? v3 : input.address,
							topics,
							data: encodeAbiParameters(
								input.event.inputs.filter((p) => !p.indexed),
								values,
							),
							blockNumber: eventBlock,
							logIndex: 0,
						},
					];
				},
			);
			const client = {
				getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => ({
					number: blockNumber ?? head,
					timestamp: BigInt(epoch) + (blockNumber ?? head),
				})),
				getLogs,
				multicall,
			} as unknown as PublicClient;
			const rpc = {
				client,
				source: { kind: "public_temporary" as const, label: "test fixture" },
				urls: [],
			};
			const execute = vi.spyOn(db, "execute");
			const batch = vi.spyOn(db, "batch");
			const result = await runRefreshPipeline({ db, rpc });
			const sqlCalls = execute.mock.calls.map(([statement]) =>
				typeof statement === "string" ? statement : (statement as { sql: string }).sql,
			);
			// Three hours reuse metadata; stored tokens are not rewritten on every hour.
			expect(sqlCalls.filter((sql) => /FROM\s+tokens\s+WHERE/.test(sql))).toHaveLength(1);
			const batchSql = batch.mock.calls.flatMap(([statements]) =>
				statements.map((statement) =>
					typeof statement === "string"
						? statement
						: Array.isArray(statement)
							? statement[0]
							: statement.sql,
				),
			);
			expect(
				[...sqlCalls, ...batchSql].filter((sql) => sql.includes("INSERT INTO tokens")),
			).toHaveLength(1);
			execute.mockRestore();
			batch.mockRestore();
			expect(result.windowsBuilt).toBe(6);
			const rows = (
				await db.execute("select * from window_aggregates order by window_start,pool_id")
			).rows;
			expect(rows).toHaveLength(6);
			for (const row of rows) {
				expect(row.fee_status).toBe(missingState ? "protocol_state_missing" : "estimated");
				expect(row.swap_count).toBe(1);
				expect(row.sqrt_price_start).toBe(missingState ? null : q96.toString());
				expect(row.sqrt_price_end).toBe(
					(Number(row.window_start) === current ? q96 * 2n : q96).toString(),
				);
				expect(row.volume_usd).toBe(Number(row.window_start) === current ? "2.5" : "1");
				expect(
					new Decimal(String(row.lp_fees_usd))
						.minus(Number(row.window_start) === current ? "0.04" : "0.01")
						.abs()
						.lt("1e-18"),
				).toBe(true);
				expect(row.tvl_usd).toBe(
					missingState ||
						(missingReserves && row.pool_id === v4 && Number(row.window_start) === current - 7200)
						? null
						: Number(row.window_start) === current
							? "5"
							: "2",
				);
			}
			const coverage = await listScannedHours(db, {
				startUnix: current - 7200,
				endUnixExclusive: headTime + 1,
			});
			expect(coverage).toHaveLength(6);
			for (const hour of coverage) expect(hour.stateBlockNumber).toBe(hour.toBlock);
			expect(new Set(multicall.mock.calls.map(([call]) => String(call.blockNumber)))).toEqual(
				new Set([
					blockAt(current - 1),
					String(head),
					blockAt(current - 3601),
					blockAt(current - 7201),
				]),
			);
			if (missingState) return;
			// A TVL failure with priced swaps must be repaired even when fees and coverage are valid.
			failReserves = false;
			getLogs.mockClear();
			const second = await runRefreshPipeline({ db, rpc });
			expect(second.windowsBuilt).toBe(missingReserves ? 1 : 0);
			expect(getLogs.mock.calls.filter(([call]) => call.event.name === "Swap")).toHaveLength(0);
			if (missingReserves) {
				expect(
					getLogs.mock.calls.every(([call]) => call.fromBlock >= BigInt(blockAt(current))),
				).toBe(true);
				const repairedRows = (
					await db.execute("select * from window_aggregates order by window_start,pool_id")
				).rows;
				for (const old of rows.filter((row) => Number(row.window_start) < current)) {
					const saved = repairedRows.find(
						(row) => row.pool_id === old.pool_id && row.window_start === old.window_start,
					);
					expect(saved).toEqual(
						old.pool_id === v4 && Number(old.window_start) === current - 7200
							? { ...old, tvl_usd: "2", gap_reason: null }
							: old,
					);
				}
				expect(
					(
						await db.execute({
							sql: "select tvl_usd from window_aggregates where pool_id=? and window_start=?",
							args: [v4, current - 7200],
						})
					).rows[0]?.tvl_usd,
				).toBe("2");
				return;
			}
			expect(
				(await db.execute("select * from window_aggregates order by window_start,pool_id")).rows,
			).toEqual(rows);
			// Rebuild old price boundaries without re-fetching swaps or touching valid amounts.
			await db.execute({
				sql: "update scanned_hours set price_boundary_version=null where window_start=?",
				args: [current - 7200],
			});
			await db.execute({
				sql: "update window_aggregates set sqrt_price_start='123' where window_start=?",
				args: [current - 7200],
			});
			getLogs.mockClear();
			multicall.mockClear();
			await runRefreshPipeline({ db, rpc });
			expect(getLogs.mock.calls.every(([call]) => call.fromBlock >= BigInt(blockAt(current)))).toBe(
				true,
			);
			expect(
				(await db.execute("select * from window_aggregates order by window_start,pool_id")).rows,
			).toEqual(rows);
			expect(
				multicall.mock.calls.filter(
					([call]) => call.blockNumber === BigInt(blockAt(current - 7201)),
				),
			).toHaveLength(2);
			if (elapsedMs === 0) {
				await db.execute({
					sql: "update scanned_hours set price_boundary_version=null where window_start=?",
					args: [current - 7200],
				});
				failBoundary = true;
				getLogs.mockClear();
				await runRefreshPipeline({ db, rpc });
				expect(
					getLogs.mock.calls.every(([call]) => call.fromBlock >= BigInt(blockAt(current))),
				).toBe(true);
				const failed = (
					await db.execute({
						sql: "select * from window_aggregates where window_start=?",
						args: [current - 7200],
					})
				).rows;
				for (const row of failed) {
					const old = rows.find(
						(part) => part.pool_id === row.pool_id && part.window_start === row.window_start,
					);
					expect(row).toEqual({ ...old, sqrt_price_start: null });
				}
				expect(
					(
						await listScannedHours(db, {
							startUnix: current - 7200,
							endUnixExclusive: current - 3600,
						})
					).every((hour) => hour.priceBoundaryVersion === 2),
				).toBe(true);
				failBoundary = false;
				await runRefreshPipeline({ db, rpc });
				expect(
					(await db.execute("select * from window_aggregates order by window_start,pool_id")).rows,
				).toEqual(rows);
			}
			if (elapsedMs === 0) {
				getLogs.mockClear();
				headTime = current + 900;
				head = BigInt(headTime - epoch);
				currentSqrt = q96;
				await runRefreshPipeline({ db, rpc });
				const swaps = getLogs.mock.calls.filter(([call]) => call.event.name === "Swap");
				expect(swaps).toHaveLength(2);
				for (const [call] of swaps)
					expect(call.fromBlock).toBe(BigInt(blockAt(current + 600)) + 1n);
				let accumulated = (
					await db.execute({
						sql: "SELECT * FROM window_aggregates WHERE window_start=?",
						args: [current],
					})
				).rows;
				for (const row of accumulated) {
					expect(Number(row.swap_count)).toBe(2);
					expect(row.volume_usd).toBe("2");
					expect(new Decimal(String(row.lp_fees_usd)).minus("0.02").abs().lt("1e-18")).toBe(true);
					expect(row.sqrt_price_start).toBe(q96.toString());
				}
				headTime = current + 1200;
				head = BigInt(headTime - epoch);
				currentSqrt = q96 / 2n;
				await runRefreshPipeline({ db, rpc });
				accumulated = (
					await db.execute({
						sql: "SELECT * FROM window_aggregates WHERE window_start=?",
						args: [current],
					})
				).rows;
				for (const row of accumulated) {
					expect(Number(row.swap_count)).toBe(2);
					expect(row.volume_usd).toBe("1.25");
					expect(row.sqrt_price_end).toBe(currentSqrt.toString());
					expect(row.as_of).toBe(new Date(headTime * 1000).toISOString());
				}
			}
		} finally {
			clock.mockRestore();
			db.close();
			await rm(dir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			});
		}
	},
);
