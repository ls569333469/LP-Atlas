import {
	BOARD_COLUMNS,
	BOARD_SORT_FIELDS,
	type BoardRow,
	type BoardSuccessResponse,
	type MetricValue,
	type ProtocolId,
	protocolLabel,
	type SortDirection,
	type SortField,
} from "@lp-atlas/shared";
import { memo, type ReactElement, type ReactNode } from "react";
import { boardNotices, metricTooltip } from "./data-notices.ts";
import {
	changeTone,
	formatAge,
	formatFeeApr,
	formatFeeUsd,
	formatRatio,
	formatSignedPercent,
	formatUsd,
} from "./format.ts";

const RIGHT_ALIGNED = new Set([
	"tvl",
	"volume",
	"fees",
	"feesApr",
	"changeVsPrevWindow",
	"priceChange",
	"capitalEfficiency",
	"poolAge",
]);

function isSortField(id: string): id is SortField {
	return (BOARD_SORT_FIELDS as readonly string[]).includes(id);
}

export function splitGaps(gaps: readonly string[]): { coverage: string[]; hookCount: number } {
	const coverage: string[] = [];
	let hookCount = 0;
	for (const gap of gaps) {
		if (gap.includes("hook") || gap.includes("Hook") || gap.includes("自定义记账")) {
			hookCount += 1;
		} else {
			coverage.push(gap);
		}
	}
	return { coverage, hookCount };
}

function columnClass(columnId: string): string {
	const parts = ["cell"];
	if (RIGHT_ALIGNED.has(columnId)) {
		parts.push("cell-num");
	}
	if (columnId === "feesApr") {
		parts.push("cell-emphasis");
	}
	if (columnId === "pair") {
		parts.push("cell-pair");
	}
	return parts.join(" ");
}

function shortHookLabel(hookType: string): string {
	const match = hookType.match(/0x[a-fA-F0-9]+/);
	if (match) {
		const address = match[0];
		const short = address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
		return `Hook ${short}`;
	}
	return hookType.length > 18 ? `${hookType.slice(0, 16)}…` : hookType;
}

export function MetricCell(props: {
	metric: MetricValue;
	format: (value: string | null) => string;
	signed?: boolean;
	hourIncomplete: boolean;
	emptyText?: string;
}): ReactElement {
	const display =
		props.metric.value === null && props.metric.complete && props.emptyText
			? props.emptyText
			: props.format(props.metric.value);
	const tone =
		props.signed && display !== props.emptyText ? changeTone(props.metric.value) : "flat";
	const classes = ["metric"];
	if (tone === "up") {
		classes.push("metric-up");
	} else if (tone === "down") {
		classes.push("metric-down");
	}
	const incompleteReason = props.hourIncomplete ? "当前小时未完成" : "该指标窗口未完成";
	return (
		<span
			className={classes.join(" ")}
			title={metricTooltip(props.metric, display, props.hourIncomplete)}
		>
			<span className="metric-value">{display}</span>
			{!props.metric.complete ? (
				props.hourIncomplete ? (
					<span className="incomplete-mark" title={incompleteReason}>
						<span className="visually-hidden">{incompleteReason}</span>*
					</span>
				) : (
					<span className="badge">未完成</span>
				)
			) : null}
		</span>
	);
}

function protocolShortLabel(protocol: ProtocolId): string {
	const full = protocolLabel(protocol);
	if (protocol.endsWith("_v3") || full.endsWith("V3")) {
		return "V3";
	}
	if (protocol.endsWith("_v4") || full.endsWith("V4")) {
		return "V4";
	}
	return full;
}

function ProtocolCell(props: { protocol: ProtocolId; hookType: string | null }): ReactElement {
	const short = protocolShortLabel(props.protocol);
	const full = protocolLabel(props.protocol);
	const pillClass = props.protocol.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	return (
		<div className="protocol-cell">
			<span
				className={`protocol-pill protocol-${pillClass} protocol-${short.toLowerCase()}`}
				title={full}
			>
				{short}
			</span>
			{props.hookType ? (
				<span className="hook" title={props.hookType}>
					{shortHookLabel(props.hookType)}
				</span>
			) : null}
		</div>
	);
}

function rowCells(
	row: BoardRow,
	hourIncomplete: boolean,
): Array<{ id: string; content: ReactNode }> {
	return [
		{ id: "pair", content: <span className="pair">{row.pairLabel}</span> },
		{ id: "feeTier", content: <span className="fee-tier">{row.feeTierLabel}</span> },
		{
			id: "protocol",
			content: <ProtocolCell protocol={row.protocol} hookType={row.hookType} />,
		},
		{
			id: "tvl",
			content: (
				<MetricCell metric={row.tvlUsd} format={formatUsd} hourIncomplete={hourIncomplete} />
			),
		},
		{
			id: "volume",
			content: (
				<MetricCell metric={row.volumeUsd} format={formatUsd} hourIncomplete={hourIncomplete} />
			),
		},
		{
			id: "fees",
			content: (
				<MetricCell metric={row.feesUsd} format={formatFeeUsd} hourIncomplete={hourIncomplete} />
			),
		},
		{
			id: "feesApr",
			content: (
				<MetricCell metric={row.feesApr} format={formatFeeApr} hourIncomplete={hourIncomplete} />
			),
		},
		{
			id: "changeVsPrevWindow",
			content: (
				<MetricCell
					metric={row.changeVsPrevWindow}
					format={formatSignedPercent}
					signed
					hourIncomplete={hourIncomplete}
					emptyText={row.changeVsPrevWindow.reason === "previous_zero" ? "新" : undefined}
				/>
			),
		},
		{
			id: "priceChange",
			content: (
				<MetricCell
					metric={row.priceChange}
					format={formatSignedPercent}
					signed
					hourIncomplete={hourIncomplete}
				/>
			),
		},
		{
			id: "capitalEfficiency",
			content: (
				<MetricCell
					metric={row.capitalEfficiency}
					format={formatRatio}
					hourIncomplete={hourIncomplete}
				/>
			),
		},
		{
			id: "poolAge",
			content: (
				<MetricCell
					metric={row.poolAgeSeconds}
					format={formatAge}
					hourIncomplete={hourIncomplete}
				/>
			),
		},
	];
}

function sortAria(active: boolean, direction: SortDirection): "ascending" | "descending" | "none" {
	if (!active) {
		return "none";
	}
	return direction === "asc" ? "ascending" : "descending";
}

export const BoardTable = memo(function BoardTable(props: {
	board: BoardSuccessResponse;
	onSort?: (field: SortField) => void;
}): ReactElement {
	const hourIncomplete = !props.board.currentHourComplete;
	const notices = boardNotices(props.board);
	const sortField = props.board.sort.field;
	const sortDirection = props.board.sort.direction;
	return (
		<div className="table-shell">
			<table className="board-table">
				<caption>
					数字属于当前选中的时间窗口，同一交易对在不同协议分行展示。fees APR 只用该窗口内实际归 LP
					的手续费年化。缺档显示为 —，不会用邻近窗口凑数。点击表头可排序。
				</caption>
				<thead>
					<tr>
						{BOARD_COLUMNS.map((column) => {
							const sortable = isSortField(column.id);
							const active = sortable && column.id === sortField;
							return (
								<th
									key={column.id}
									scope="col"
									className={columnClass(column.id)}
									aria-sort={sortable ? sortAria(active, sortDirection) : undefined}
								>
									{sortable ? (
										<button
											type="button"
											className={active ? "th-sort th-sort-active" : "th-sort"}
											onClick={() => props.onSort?.(column.id as SortField)}
										>
											<span className="th-label">{column.label}</span>
											<span className={active ? "sort-hint" : "sort-hint sort-hint-idle"}>
												{active ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}
											</span>
										</button>
									) : (
										<span className="th-label">{column.label}</span>
									)}
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{props.board.rows.map((row) => (
						<tr key={`${row.chain}-${row.protocol}-${row.poolId}`}>
							{rowCells(row, hourIncomplete).map((cell) => (
								<td key={cell.id} className={columnClass(cell.id)}>
									{cell.content}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{notices.length > 0 ? (
				<div className="gap-stack">
					<details className="gaps">
						<summary>数据说明（{notices.length}）</summary>
						<ul>
							{notices.map((notice) => (
								<li key={notice}>{notice}</li>
							))}
						</ul>
					</details>
				</div>
			) : null}
		</div>
	);
});

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"] as const;

const SKELETON_WIDTHS: Record<string, string> = {
	pair: "72%",
	feeTier: "44%",
	protocol: "36%",
	tvl: "58%",
	volume: "52%",
	fees: "48%",
	feesApr: "56%",
	changeVsPrevWindow: "50%",
	priceChange: "50%",
	capitalEfficiency: "46%",
	poolAge: "60%",
};

export function BoardTableSkeleton(): ReactElement {
	return (
		<div className="table-shell" aria-hidden="true">
			<table className="board-table">
				<thead>
					<tr>
						{BOARD_COLUMNS.map((column) => (
							<th key={column.id} scope="col" className={columnClass(column.id)}>
								<span className="th-label">{column.label}</span>
								{isSortField(column.id) ? (
									<span className="sort-hint sort-hint-idle">↕</span>
								) : null}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{SKELETON_ROWS.map((rowId) => (
						<tr key={rowId} className="skeleton-row">
							{BOARD_COLUMNS.map((column) => (
								<td key={column.id} className={columnClass(column.id)}>
									<span
										className="skeleton-bar"
										style={{ width: SKELETON_WIDTHS[column.id] ?? "50%" }}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
