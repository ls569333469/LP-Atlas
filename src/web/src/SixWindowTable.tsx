import {
	BOARD_WINDOW_METRICS,
	BOARD_WINDOWS,
	DYNAMIC_FEE_LABEL,
	type BoardRow,
	type BoardSuccessResponse,
	type BoardWindowMetrics,
	ELYSIUM_WHYPE_ADDRESS,
	feeMetricLabel,
	poolIdentity,
	PRICE_SPACING_LABEL,
	priceSpacingBps,
	protocolLabel,
	ROBINHOOD_WETH_ADDRESS,
	RPC_SOURCE_PUBLIC_TEMPORARY,
	type SortField,
	ZERO_ADDRESS,
	type WindowId,
} from "@lp-atlas/shared";
import { memo, type ReactElement, useState } from "react";
import { MetricCell } from "./BoardTable.tsx";
import {
	formatAge,
	formatFeeApr,
	formatFeeUsd,
	formatPoolFee,
	formatPriceSpacing,
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

function priceSpacing(row: BoardRow): string {
	return formatPriceSpacing(priceSpacingBps(row));
}

function CopyAddress({ address, label, compact = false }: { address: string; label: string; compact?: boolean }) {
	const [status, setStatus] = useState("");
	return (
		<button type="button" className="address-copy" aria-label={`复制${label}`} title={status || `复制${label}`}
			onClick={() => void navigator.clipboard.writeText(address).then(
				() => setStatus("已复制"),
				() => setStatus("复制失败"),
			)}>
			{compact ? (
				<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
					<rect x="5" y="5" width="9" height="9" rx="1.5" />
					<path d="M11 3H3v8" />
				</svg>
			) : status || "复制"}
		</button>
	);
}

function officialPoolUrl(row: BoardRow): string | null {
	if (row.chain === "solana" && row.protocol === "meteora_dlmm" &&
		/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.poolId)) {
		return `https://app.meteora.ag/dlmm/${row.poolId}`;
	}
	if (row.chain !== "robinhood" && row.chain !== "elysium") return null;
	const validId =
		(row.protocol === "uniswap_v3" && /^0x[0-9a-f]{40}$/i.test(row.poolId)) ||
		(row.protocol === "uniswap_v4" && /^0x[0-9a-f]{64}$/i.test(row.poolId));
	return validId ? `https://app.uniswap.org/explore/pools/${row.chain}/${row.poolId}` : null;
}

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
					<col className="venue-col" />
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
						<th className="directory-identity">交易对</th>
						<th className="pool-venue">协议 / 费率</th>
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
										className="window-sort-button"
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
						const feeLabel = formatPoolFee(row.feeTierLabel);
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
									<div className="pool-short-id">
										<small title={row.poolId}>{row.poolId.slice(0, 10)}…{row.poolId.slice(-6)}</small>
										<CopyAddress address={row.poolId} label="池 ID" compact />
									</div>
								</td>
								<td className="pool-venue">
									<span className="venue-label" data-protocol={row.protocol}>{protocolLabel(row.protocol)}</span>
									<div><span className="fee-tag" data-dynamic={feeLabel.startsWith(DYNAMIC_FEE_LABEL)}>{feeLabel}</span></div>
									<small title={PRICE_SPACING_LABEL}>{priceSpacing(row)}</small>
									<PoolRiskNotices row={row} />
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
												{feeMetricLabel(
													metric.key,
													metric.label,
													row.feesUsd.feeBasis === "reported_fees",
												)}
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

function CompactPoolFacts({ row }: { row: BoardRow }) {
	const officialUrl = officialPoolUrl(row);
	const wrappedNative = row.chain === "elysium"
		? ELYSIUM_WHYPE_ADDRESS.toLowerCase()
		: row.chain === "robinhood" ? ROBINHOOD_WETH_ADDRESS.toLowerCase() : null;
	const assets = [
		{ token: row.token0, valuation: row.token0Fdv },
		{ token: row.token1, valuation: row.token1Fdv },
	].filter(({ token }) => row.chainId === null || token.address.toLowerCase() !== ZERO_ADDRESS);
	const addresses = [
		{ label: "池 ID", address: row.poolId },
		...assets.map(({ token }) => ({
			label: `${token.symbol} · ${row.chainId === null ? "Mint" : "CA"}`,
			address: token.address,
		})),
	];
	return (
		<div className="compact-pool-facts">
			<dl className="compact-pool-grid">
				{[
					["TVL", formatUsd(row.tvlUsd.value)],
					["池龄", formatAge(row.poolAgeSeconds.value)],
					["池子费率", formatPoolFee(row.feeTierLabel)],
					[PRICE_SPACING_LABEL, priceSpacing(row)],
				].map(([label, value]) => (
					<div key={label}><dt>{label}</dt><dd>{value}</dd></div>
				))}
				{assets.length ? <div className="compact-fdv">
					<dt>FDV（完全稀释估值）</dt>
					{assets.map(({ token, valuation }) => (
						<dd key={token.address}>
							<span>{token.symbol}{token.address.toLowerCase() === wrappedNative ? "（包装合约）" : ""}</span>
							<span title={valuation
								? `价格来源 ${valuation.source} · 报价 ${formatTime(valuation.priceObservedAt)} · 供应量 ${formatTime(valuation.supplyObservedAt)}`
								: "暂无有效的价格或供应量"}>
								{formatUsd(valuation?.fdvUsd ?? null)}
							</span>
						</dd>
					))}
				</div> : null}
			</dl>
			{addresses.map(({ label, address }) => (
				<div className="compact-pool-address" key={address}>
					<div><strong>{label}</strong><CopyAddress address={address} label={label} /></div>
					<code>{address}</code>
					{label === "池 ID" && officialUrl ? (
						<a className="official-pool-link" href={officialUrl} target="_blank" rel="noopener noreferrer">打开官方池</a>
					) : null}
				</div>
			))}
			{row.hookType?.startsWith("0x") ? (
				<details className="detail-source">
					<summary>查看池规则（Hook）</summary>
					<p>Hook 是池绑定的智能合约，可在进出流动性和交易等时机运行额外规则。</p>
					{row.hookAddress ? <code className="detail-hook-address">{row.hookAddress}</code> : null}
					<p>{row.hookType.includes("（") ? row.hookType.split("（")[1]?.replace("）", "") : row.hookType}</p>
				</details>
			) : null}
		</div>
	);
}

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
			<h3>
				{row.pairLabel} ·{" "}
				{board.catalog.chains.find((chain) => chain.id === row.chain)?.label ?? row.chain} ·{" "}
				{protocolLabel(row.protocol)}
			</h3>
			{props.compact ? <CompactPoolFacts row={row} /> : <>
			<p>
				池 ID：<code>{row.poolId}</code>{" "}
				<button type="button" onClick={() => void navigator.clipboard.writeText(row.poolId)}>
					复制
				</button>
			</p>
			<p>
				TVL {formatUsd(row.tvlUsd.value)} · 池龄 {formatAge(row.poolAgeSeconds.value)} · 费率{" "}
				{formatPoolFee(row.feeTierLabel)} · {PRICE_SPACING_LABEL} {priceSpacing(row)}
				{row.chainId !== null ? ` · ${row.hookType ?? "零 Hook / 无 Hook"}` : null}
			</p>
			<p>
				代币：{row.token0.symbol} <code>{row.token0.address}</code> / {row.token1.symbol}{" "}
				<code>{row.token1.address}</code>
			</p>
			</>}
			{row.officialPool ? <MeteoraDetails details={row.officialPool} /> : null}
			{props.compact ? null : <details className="detail-window-values" open>
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
									<th>
										{feeMetricLabel(
											metric.key,
											metric.label,
											row.feesUsd.feeBasis === "reported_fees",
										)}
									</th>
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
			</details>}
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
			<p>
				官方 API · 更新于 {formatTime(details.asOf)} · 费用取官方
				fees，协议费用单独保留；年化按对应小时窗口计算
			</p>
			<p>
				池名称：{p.name ?? "—"} · 池类型：{p.pairType ?? "—"}
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
				{p.currentPrice === null ? "" : ` ${p.tokenY.symbol}/${p.tokenX.symbol}`}
			</p>
			<p>
				价格涨跌按正常采集的池价估算，方向为每 1 {p.tokenX.symbol} 对应的 {p.tokenY.symbol}{" "}
				数量。两端观测不足时留空。
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
