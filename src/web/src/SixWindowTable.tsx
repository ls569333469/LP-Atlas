import {
	BOARD_WINDOW_METRICS,
	BOARD_WINDOWS,
	type BoardRow,
	type BoardSuccessResponse,
	type BoardWindowMetrics,
	poolIdentity,
	protocolLabel,
	RPC_SOURCE_PUBLIC_TEMPORARY,
	type SortField,
	type WindowId,
} from "@lp-atlas/shared";
import { memo, type ReactElement } from "react";
import { MetricCell } from "./BoardTable.tsx";
import {
	formatAge,
	formatFeeApr,
	formatFeeUsd,
	formatRatio,
	formatSignedPercent,
	formatTime,
	formatUsd,
} from "./format.ts";
import { PoolRiskNotices } from "./PoolRiskNotices.tsx";

export const WINDOW_METRICS: ReadonlyArray<{
	key: keyof BoardWindowMetrics;
	sort: SortField;
	label: string;
	format(value: string | null): string;
	signed?: boolean;
}> = BOARD_WINDOW_METRICS.map((metric) => ({
	...metric,
	format: {
		feesApr: formatFeeApr,
		volumeUsd: formatUsd,
		feesUsd: formatFeeUsd,
		changeVsPrevWindow: formatSignedPercent,
		priceChange: formatSignedPercent,
		capitalEfficiency: formatRatio,
	}[metric.key],
}));

export const SixWindowTable = memo(function SixWindowTable(props: {
	board: BoardSuccessResponse;
	selected: string[];
	onSelect(row: BoardRow): void;
	onDetail(row: BoardRow): void;
	onSort(field: SortField, window?: WindowId): void;
}): ReactElement {
	const { board } = props;
	const windowSort = board.sort.field !== "tvl" && board.sort.field !== "poolAge";
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the data table.
		<section className="directory-scroll" tabIndex={0} aria-label="六窗口池目录，可横向滚动">
			<table className="directory-table">
				<colgroup>
					<col className="pair-col" />
					<col className="network-col" />
					<col className="tvl-col" />
					<col className="metric-label-col" />
					{BOARD_WINDOWS.map((w) => (
						<col key={w.id} className="window-col" />
					))}
					<col className="action-col" />
				</colgroup>
				<thead>
					<tr>
						<th className="directory-identity">交易对 / 协议</th>
						<th className="pool-network">网络</th>
						<th className="pool-facts">
							<span className="fact-head">
								{(["tvl", "poolAge"] as const).map((field) => (
									<button
										key={field}
										type="button"
										className={board.sort.field === field ? "sort-active fact-sort" : "fact-sort"}
										onClick={() => props.onSort(field)}
									>
										{field === "poolAge" && <span aria-hidden="true">/ </span>}
										{field === "tvl" ? "TVL" : "池龄"}
										{board.sort.field === field
											? board.sort.direction === "asc"
												? " ↑"
												: " ↓"
											: ""}
									</button>
								))}
							</span>
						</th>
						<th className="metric-labels">指标</th>
						{BOARD_WINDOWS.map((window) => {
							const active = windowSort && board.sort.window === window.id;
							return (
								<th
									key={window.id}
									className={active ? "sort-window-highlight" : ""}
									aria-sort={
										active
											? board.sort.direction === "asc"
												? "ascending"
												: "descending"
											: undefined
									}
								>
									<button
										type="button"
										disabled={!windowSort}
										onClick={() => props.onSort(board.sort.field, window.id)}
									>
										{window.label}
										{active ? (board.sort.direction === "asc" ? " ↑" : " ↓") : ""}
									</button>
								</th>
							);
						})}
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{board.rows.map((row) => {
						const identity = poolIdentity(row);
						const checked = props.selected.includes(identity);
						const chainName =
							board.catalog.chains.find((chain) => chain.id === row.chain)?.label ?? row.chain;
						return (
							<tr key={identity} className={checked ? "selected" : ""}>
								<td className="directory-identity">
									<div className="pool-heading">
										<input
											type="checkbox"
											aria-label={`对照 ${row.pairLabel} ${row.chain}`}
											checked={checked}
											disabled={!checked && props.selected.length >= 5}
											onChange={() => props.onSelect(row)}
										/>
										<button
											type="button"
											className="pool-link"
											title={row.pairLabel}
											onClick={() => props.onDetail(row)}
										>
											{row.pairLabel}
										</button>
									</div>
									<small>
										{protocolLabel(row.protocol)} ·{" "}
										<span className="fee-tag">{row.feeTierLabel}</span>
									</small>
									<small>
										<span title={row.hookType ?? undefined}>
											{row.hookType?.split("（")[0] ?? "零 Hook / 无 Hook"}
										</span>
									</small>
									<PoolRiskNotices row={row} />
									{row.feeEntitlementNotice ? (
										<small className="fee-entitlement">{row.feeEntitlementNotice}</small>
									) : null}
									<small title={row.poolId}>
										{row.poolId.slice(0, 10)}…{row.poolId.slice(-6)}
									</small>
								</td>
								<td className="pool-network">
									{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need the full truncated network name. */}
									<span tabIndex={0} title={chainName}>
										{chainName === "Robinhood Chain" ? "Robinhood" : chainName}
									</span>
								</td>
								<td className="pool-facts">
									<strong className={board.sort.field === "tvl" ? "sort-active" : ""}>
										{formatUsd(row.tvlUsd.value)}
									</strong>
									<small className={board.sort.field === "poolAge" ? "sort-active" : ""}>
										{formatAge(row.poolAgeSeconds.value)}
									</small>
								</td>
								<td className="metric-labels">
									<div className="metric-stack">
										{WINDOW_METRICS.map((metric) => (
											<div
												key={metric.key}
												className={board.sort.field === metric.sort ? "sort-label-highlight" : ""}
											>
												{metric.label}
											</div>
										))}
									</div>
								</td>
								{BOARD_WINDOWS.map((window) => (
									<td
										key={window.id}
										className={windowSort && board.sort.window === window.id ? "active-window" : ""}
									>
										<div className="metric-stack">
											{WINDOW_METRICS.map((metric) => {
												const value = row.windows?.[window.id]?.[metric.key];
												return (
													<div
														key={metric.key}
														className={`${value?.value === null ? "missing" : ""} ${metric.key === "feesApr" ? "apr-value" : ""}`}
													>
														{value ? (
															<MetricCell
																metric={value}
																format={metric.format}
																signed={metric.signed}
																hourIncomplete={
																	!(board.chainRpcSources.find((item) => item.chain === row.chain)
																		?.windowsMeta ?? board.windowsMeta)?.[window.id]
																		.currentHourComplete
																}
															/>
														) : (
															"—"
														)}
													</div>
												);
											})}
										</div>
									</td>
								))}
								<td className="pool-action">
									<button type="button" onClick={() => props.onDetail(row)}>
										详情 ↗
									</button>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
});

export function PoolMetrics(props: {
	row: BoardRow;
	board: BoardSuccessResponse;
	compact?: boolean;
}): ReactElement {
	const { row, board } = props;
	return (
		<article className="pool-matrix">
			<div className="eyebrow">池详情</div>
			<PoolRiskNotices row={row} />
			{row.feeEntitlementNotice ? (
				<p className="fee-entitlement">{row.feeEntitlementNotice}</p>
			) : null}
			<h3>
				{row.pairLabel} ·{" "}
				{board.catalog.chains.find((chain) => chain.id === row.chain)?.label ?? row.chain} ·{" "}
				{protocolLabel(row.protocol)}
			</h3>
			<p>
				池 ID：<code>{row.poolId}</code>{" "}
				<button type="button" onClick={() => void navigator.clipboard.writeText(row.poolId)}>
					复制
				</button>
			</p>
			<p>
				TVL {formatUsd(row.tvlUsd.value)} · 池龄 {formatAge(row.poolAgeSeconds.value)} · 费率{" "}
				{row.feeTierLabel} · {row.hookType ?? "零 Hook / 无 Hook"}
			</p>
			<p>
				代币：{row.token0.symbol} <code>{row.token0.address}</code> / {row.token1.symbol}{" "}
				<code>{row.token1.address}</code>
			</p>
			{row.officialPool ? <MeteoraDetails details={row.officialPool} /> : null}
			<details className="detail-window-values" open={!props.compact}>
				<summary>六窗口数据</summary>
				<div className="matrix-scroll">
					<table>
						<thead>
							<tr>
								<th>指标</th>
								{BOARD_WINDOWS.map((window) => (
									<th
										key={window.id}
										title={`${formatTime((board.chainRpcSources.find((item) => item.chain === row.chain)?.windowsMeta ?? board.windowsMeta)?.[window.id].windowStart ?? null)} — ${formatTime((board.chainRpcSources.find((item) => item.chain === row.chain)?.windowsMeta ?? board.windowsMeta)?.[window.id].windowEnd ?? null)}`}
									>
										{window.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{WINDOW_METRICS.map((metric) => (
								<tr key={metric.key}>
									<th>{metric.label}</th>
									{BOARD_WINDOWS.map((window) => {
										const value = row.windows?.[window.id]?.[metric.key];
										return (
											<td key={window.id}>
												{value ? (
													<MetricCell
														metric={value}
														format={metric.format}
														signed={metric.signed}
														hourIncomplete={
															!(board.chainRpcSources.find((item) => item.chain === row.chain)
																?.windowsMeta ?? board.windowsMeta)?.[window.id].currentHourComplete
														}
													/>
												) : (
													"—"
												)}
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
			<details className="detail-source">
				<summary>数据来源与窗口边界</summary>
				<p>
					来源：
					{(
						board.chainRpcSources.find((item) => item.chain === row.chain)?.rpcSource ??
						board.rpcSource
					).kind === "official_index"
						? "Meteora 官方 API"
						: (
									board.chainRpcSources.find((item) => item.chain === row.chain)?.rpcSource ??
									board.rpcSource
								).kind === RPC_SOURCE_PUBLIC_TEMPORARY
							? "临时公共数据源"
							: "已配置数据源"}{" "}
					· 截止{" "}
					{formatTime(
						board.chainRpcSources.find((item) => item.chain === row.chain)?.refresh
							?.lastSuccessAt ?? row.feesUsd.asOf,
					)}
				</p>
				{BOARD_WINDOWS.map((window) => (
					<p key={window.id}>
						<strong>{window.label}</strong> ·{" "}
						{formatTime(
							(board.chainRpcSources.find((item) => item.chain === row.chain)?.windowsMeta ??
								board.windowsMeta)?.[window.id].windowStart ?? null,
						)}{" "}
						→{" "}
						{formatTime(
							(board.chainRpcSources.find((item) => item.chain === row.chain)?.windowsMeta ??
								board.windowsMeta)?.[window.id].windowEnd ?? null,
						)}{" "}
						·{" "}
						{(board.chainRpcSources.find((item) => item.chain === row.chain)?.windowsMeta ??
							board.windowsMeta)?.[window.id].currentHourComplete
							? "已结束小时"
							: "当前小时未完成"}
					</p>
				))}
				<p>将鼠标移到指标上，可查看数值、截止时间和数据状态。</p>
			</details>
		</article>
	);
}

function MeteoraDetails({
	details,
}: {
	details: NonNullable<BoardRow["officialPool"]>;
}): ReactElement {
	const p = details.metadata;
	const percent = (value: string | null) => (value === null ? "—" : `${value}%`);
	const flag = (value: boolean | null) => (value === null ? "未提供" : value ? "是" : "否");
	return (
		<details className="detail-source">
			<summary>DLMM 资料</summary>
			<p>官方 API · 更新于 {formatTime(details.asOf)} · LP手续费与收益年化尚未核实</p>
			<p>
				池名称：{p.name ?? "—"} · Bin Step：{p.binStep ?? "—"} · 池类型：{p.pairType ?? "—"}
			</p>
			<p>
				基础费率 {percent(p.baseFeePercent)} · 动态费率字段原值 {percent(p.dynamicFeePercent)} ·
				最大费率字段原值 {percent(p.maxFeePercent)} · 协议分成比例 {percent(p.protocolFeePercent)}
			</p>
			<p>动态及最大费率字段含义待核，暂不作为实际总费率。</p>
			<p>
				收费模式：
				{p.collectFeeMode === 0
					? "InputOnly"
					: p.collectFeeMode === 1
						? "OnlyY"
						: (p.collectFeeMode ?? "—")}{" "}
				· 当前池价格 {p.currentPrice ?? "—"}
			</p>
			<p>
				当前储备：{p.tokenX.symbol} {p.tokenXAmount ?? "—"} / {p.tokenY.symbol}{" "}
				{p.tokenYAmount ?? "—"}
			</p>
			<p>
				储备账户：<code>{p.reserveX ?? "—"}</code> / <code>{p.reserveY ?? "—"}</code>
			</p>
			{[p.tokenX, p.tokenY].map((t) => (
				<div key={t.address}>
					<p>
						{t.name ?? t.symbol} · 价格 {formatUsd(t.priceUsd)} · 市值 {formatUsd(t.marketCapUsd)} ·
						持有人 {t.holders ?? "—"} · 总供应 {t.totalSupply ?? "—"}
					</p>
					<p>
						官方验证：{flag(t.isVerified)} · 冻结权限已撤销：{flag(t.freezeAuthorityDisabled)}
					</p>
				</div>
			))}
			<p>
				农场：{flag(p.hasFarm)} · 激励 APR 原值 {p.farmApr ?? "—"} · APY 原值 {p.farmApy ?? "—"}
			</p>
			<p>
				奖励代币：<code>{p.rewardMintX ?? "—"}</code> / <code>{p.rewardMintY ?? "—"}</code>
			</p>
			<p>
				标签：{p.tags.join("、") || "—"} · Launchpad：{p.launchpad ?? "—"} · 官方黑名单标记：
				{flag(p.isBlacklisted)}
			</p>
			<details>
				<summary>官方滚动统计</summary>
				<div className="matrix-scroll">
					<table>
						<thead>
							<tr>
								<th>窗口</th>
								<th>成交量</th>
								<th>报告费用</th>
								<th>协议费用</th>
								<th>费用/TVL原值</th>
							</tr>
						</thead>
						<tbody>
							{Object.keys(p.reportedStatistics.volume).map((w) => (
								<tr key={w}>
									<th>{w}</th>
									<td>{formatUsd(p.reportedStatistics.volume[w] ?? null)}</td>
									<td>{formatUsd(p.reportedStatistics.fees[w] ?? null)}</td>
									<td>{formatUsd(p.reportedStatistics.protocolFees[w] ?? null)}</td>
									<td>{p.reportedStatistics.feeTvlRatio[w] ?? "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p>
					累计成交 {formatUsd(p.reportedStatistics.cumulative.volume ?? null)} · 累计报告费用{" "}
					{formatUsd(p.reportedStatistics.cumulative.fees ?? null)}
				</p>
				<p>
					来源 APR 原值 {p.reportedStatistics.apr ?? "—"} · APY 原值{" "}
					{p.reportedStatistics.apy ?? "—"}；未作为本地LP收益年化使用。
				</p>
			</details>
		</details>
	);
}
