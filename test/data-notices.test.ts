import { expect, it } from "vitest";
import type { BoardSuccessResponse, MetricValue } from "../src/shared/types.ts";
import {
	boardNotices,
	metricTooltip,
	refreshForSelection,
	revisionForSelection,
	userError,
} from "../src/web/src/data-notices.ts";

it("changes a single-chain publication only when that chain publishes", () => {
	const before = "elysium:1.1|robinhood:2.1|solana:3.1";
	const other = "elysium:4.1|robinhood:2.1|solana:3.1";
	const own = "elysium:4.1|robinhood:2.1|solana:5.1";
	expect(revisionForSelection(before, ["solana"])).toBe("3.1");
	expect(revisionForSelection(other, ["solana"])).toBe("3.1");
	expect(revisionForSelection(own, ["solana"])).toBe("5.1");
	expect(revisionForSelection("5.1", ["solana"])).toBe("5.1");
	expect(revisionForSelection(other, [])).toBe(other);
	expect(revisionForSelection(before, [])).not.toBe(other);
});

it("keeps formatted values, cutoff and incomplete status without rendering engineering reasons", () => {
	const metric: MetricValue = {
		value: "790.31781165623119258",
		source: "self_built",
		asOf: "2026-11-15T09:25:36Z",
		complete: false,
		feeStatus: "estimated",
		reason: "历史协议费参数及跨 tick 逐步取整尚未精确重放对账。",
	};
	const text = metricTooltip(metric, "79,031.78%", true);
	expect(text).toContain("79,031.78%");
	expect(text).toContain("17:25:36");
	expect(text).toContain("当前小时尚未结束");
	expect(text).not.toMatch(/self_built|790\.317|tick|对账/);
	expect(
		metricTooltip({ ...metric, value: null, feeStatus: "protocol_state_missing" }, "—", false),
	).toContain("手续费数据暂不可用");
	expect(metricTooltip({ ...metric, value: null, reason: "previous_zero" }, "新", false)).toContain(
		"上一窗口手续费为 0",
	);
});

it("summarizes repeated diagnostics while retaining failures, missing dollars and source limitations", () => {
	const board = {
		catalog: { chains: [{ id: "robinhood", label: "Robinhood Chain" }] },
		gaps: ["robinhood: V3 failed: URL: https://rpc.example/private Request body: {}"],
		warnings: [
			"robinhood: Hook 储备范围说明：272 个池；以下为读取范围限制，不代表小时漏扫。",
			...Array.from(
				{ length: 272 },
				(_, i) =>
					`robinhood: 0x${i}: 该池 hook 可能有自定义记账，ReservesLens 的 core 金额可能不是全部可兑换深度`,
			),
			"robinhood: 小时 1794726000 金额可用性：有成交 1132 池，美元成交量缺 40 池，美元手续费缺 14 池；小时覆盖标记不代表金额全部可用。",
			"robinhood: 当前使用官方公共 RPC，仅供临时联调。",
		],
	} as unknown as BoardSuccessResponse;
	const notices = boardNotices(board);
	expect(notices).toHaveLength(4);
	expect(notices.join(" ")).toContain("272 个池");
	expect(notices.join(" ")).toContain("40 个缺美元成交量、14 个缺美元手续费");
	expect(notices.join(" ")).toContain("1 项数据读取异常");
	expect(notices.join(" ")).toContain("临时公共数据源");
	expect(notices.join(" ")).not.toMatch(/0x|ReservesLens|https:|Request body|覆盖标记/);
});

it("does not expose RPC error payloads in user alerts", () => {
	expect(userError("429 Request body: secret")).toBe("数据源暂时繁忙，请稍后重试。");
	expect(userError("查询快照已失效，请重试加载")).toBe("数据版本已失效，请重试加载。");
	expect(userError("TypeError stack trace at internal.ts")).toBe("数据读取失败，请稍后重试。");
});

it("uses the selected chain's refresh and cutoff while another chain is busy", () => {
	const idle = {
		status: "ok",
		lastSuccessAt: "2026-11-16T09:00:00Z",
	} as BoardSuccessResponse["refresh"];
	const busy = {
		...idle,
		status: "running",
		lastSuccessAt: "2026-11-16T08:55:00Z",
	} as BoardSuccessResponse["refresh"];
	const data = {
		refresh: busy,
		chainRpcSources: [
			{ chain: "elysium", refresh: idle },
			{ chain: "robinhood", refresh: busy },
		],
	} as BoardSuccessResponse;
	expect(refreshForSelection(data, ["elysium"])).toBe(idle);
	expect(refreshForSelection(data, ["robinhood"])).toBe(busy);
	expect(refreshForSelection(data, [])).toBe(busy);
});
