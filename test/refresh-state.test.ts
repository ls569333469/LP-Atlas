import { describe, expect, it } from "vitest";
import { freshnessWarnings, toBoardRefreshState } from "../src/normalize/board.ts";
import type { StoredRefreshRun } from "../src/store/types.ts";

function run(
	partial: Partial<StoredRefreshRun> & Pick<StoredRefreshRun, "id" | "status">,
): StoredRefreshRun {
	return {
		startedAt: "2026-11-12T01:00:00.000Z",
		finishedAt: "2026-11-12T01:02:00.000Z",
		rpcSourceKind: "public_temporary",
		rpcSourceLabel: "official public rpc",
		blockNumber: "100",
		blockTime: "2026-11-12T01:01:00.000Z",
		error: null,
		gaps: null,
		warnings: null,
		poolCounts: null,
		windowsBuilt: 1,
		durationMs: 1000,
		scopeChain: null,
		scopeProtocol: null,
		...partial,
	};
}

describe("toBoardRefreshState and freshnessWarnings", () => {
	it("is idle when nothing has been refreshed", () => {
		const refresh = toBoardRefreshState({});
		expect(refresh.status).toBe("idle");
		expect(freshnessWarnings(refresh)).toEqual([]);
	});

	it("labels a failed refresh with the last success time and does not call the stale table fresh", () => {
		const lastSuccess = run({ id: 1, status: "ok", blockTime: "2026-11-12T00:50:00.000Z" });
		const latest = run({
			id: 2,
			status: "error",
			error: "节点限流：429",
			blockTime: null,
			finishedAt: "2026-11-12T01:10:00.000Z",
		});
		const refresh = toBoardRefreshState({ latest, lastSuccess });
		expect(refresh.status).toBe("error");
		expect(refresh.lastSuccessAt).toBe("2026-11-12T00:50:00.000Z");
		expect(freshnessWarnings(refresh).join("")).toContain("刷新失败：节点限流：429");
		expect(freshnessWarnings(refresh).join("")).toContain("2026-11-12T00:50:00.000Z");
		expect(freshnessWarnings(refresh).join("")).toContain("失败片段未发布");
	});

	it("makes an in-progress refresh visible while pointing at the last success time", () => {
		const lastSuccess = run({ id: 1, status: "partial", blockTime: "2026-11-12T00:50:00.000Z" });
		const latest = run({
			id: 2,
			status: "running",
			finishedAt: null,
			blockTime: null,
			startedAt: "2026-11-12T01:20:00.000Z",
		});
		const refresh = toBoardRefreshState({ latest, lastSuccess });
		expect(refresh.status).toBe("running");
		const text = freshnessWarnings(refresh).join("");
		expect(text).toContain("刷新进行中");
		expect(text).toContain("2026-11-12T01:20:00.000Z");
		expect(text).toContain("数据截止：2026-11-12T00:50:00.000Z");
		expect(text).toContain("已提交结果");
	});
});
