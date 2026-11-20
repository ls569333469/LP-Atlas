import type { BoardSuccessResponse, HealthResponse, MetricValue } from "@lp-atlas/shared";
import { formatTime } from "./format.ts";

export function refreshForSelection(
	data: Pick<HealthResponse, "refresh" | "chainRpcSources">,
	chains: readonly string[],
) {
	return chains.length === 1
		? (data.chainRpcSources.find((source) => source.chain === chains[0])?.refresh ?? data.refresh)
		: data.refresh;
}

export function metricTooltip(
	metric: MetricValue,
	display: string,
	hourIncomplete: boolean,
): string {
	const parts = [display, `截止 ${formatTime(metric.asOf)}`];
	if (metric.value === null) {
		parts.push(
			metric.reason === "previous_zero"
				? "上一窗口手续费为 0"
				: metric.feeStatus && !["estimated", "verified_zero"].includes(metric.feeStatus)
					? "手续费数据暂不可用"
					: "历史数据不足或暂未取得",
		);
	}
	if (!metric.complete) parts.push(hourIncomplete ? "当前小时尚未结束" : "数据尚未完整");
	return parts.join(" · ");
}

export function userError(message: string): string {
	if (/快照.*失效/.test(message)) return "数据版本已失效，请重试加载。";
	if (/429|限流/.test(message)) return "数据源暂时繁忙，请稍后重试。";
	if (/timeout|超时/i.test(message)) return "数据读取超时，请稍后重试。";
	if (/空间|磁盘/.test(message)) return "存储空间不足，采集暂时停止。";
	return "数据读取失败，请稍后重试。";
}

export function boardNotices(board: BoardSuccessResponse): string[] {
	const notices = new Set<string>();
	for (const chain of board.catalog.chains) {
		const prefix = `${chain.id}: `;
		const gaps = board.gaps.filter((value) => value.startsWith(prefix));
		const warnings = board.warnings.filter((value) => value.startsWith(prefix));
		const values = [...gaps, ...warnings];
		if (!values.length) continue;
		const add = (text: string) => notices.add(`${chain.label}：${text}`);
		if (!values.some((value) => value.includes("Hook 储备范围说明"))) {
			const hookCount = values.filter((value) => /该池 hook 可能有自定义记账/.test(value)).length;
			if (hookCount) add(`${hookCount} 个池的流动性数据仅包含核心池储备。`);
		}
		let otherGaps = 0;
		let otherWarnings = 0;
		for (const value of values) {
			if (/该池 hook 可能有自定义记账/.test(value)) continue;
			const hooks = value.match(/Hook 储备范围说明：(\d+) 个池/);
			const amounts = value.match(
				/小时 (\d+) 金额可用性：有成交 (\d+) 池，美元成交量缺 (\d+) 池，美元手续费缺 (\d+) 池/,
			);
			const hours = value.match(/还缺 (\d+) 个自建小时档/);
			if (hooks) add(`${hooks[1]} 个池的流动性数据仅包含核心池储备。`);
			else if (amounts)
				add(
					`${formatTime(new Date(Number(amounts[1]) * 1000).toISOString())} 起的小时内，${amounts[2]} 个成交池中，${amounts[3]} 个缺美元成交量、${amounts[4]} 个缺美元手续费。`,
				);
			else if (hours) add(`当前及对比窗口缺 ${hours[1]} 小时数据，相关指标暂不可用。`);
			else if (/当前使用官方公共 RPC/.test(value))
				add("使用临时公共数据源，部分历史数据可能无法取得。");
			else if (/刷新进行中/.test(value)) add("正在采集，当前显示上次结果。");
			else if (/刷新失败|上次刷新失败/.test(value)) add("最近一次采集失败，当前保留上次结果。");
			else if (gaps.includes(value)) otherGaps++;
			else otherWarnings++;
		}
		if (otherGaps) add(`${otherGaps} 项数据读取异常，相关指标可能不完整。`);
		if (otherWarnings) add(`${otherWarnings} 项数据可用性提示，部分结果可能受限。`);
	}
	const unscoped = [...board.gaps, ...board.warnings].filter(
		(value) => !board.catalog.chains.some((chain) => value.startsWith(`${chain.id}: `)),
	);
	if (unscoped.length) notices.add(`有 ${unscoped.length} 项数据可用性提示，部分结果可能不完整。`);
	return [...notices];
}
