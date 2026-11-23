import {
	BIN_STEP_UNIT,
	BOARD_WINDOWS,
	type BoardMetricCondition,
	type BoardValuationFilters,
	conditionToDisplay,
	conditionToValue,
	type DlmmFilters,
	feeMetricLabel,
	parseValuationFilters,
	PRICE_SPACING_LABEL,
	type VALUATION_FILTER_KEYS,
	QUERY_METRICS,
	type SortField,
	type WindowId,
} from "@lp-atlas/shared";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { DlmmFilterFields } from "./DlmmFilterFields.tsx";

type DraftCondition = {
	field: SortField;
	window: WindowId;
	operator: BoardMetricCondition["operator"];
	value: string;
};
export type QueryFilterDraft = {
	valuationDraft: Record<(typeof VALUATION_FILTER_KEYS)[number], string>;
	dlmmFilters: DlmmFilters;
	hideLpRestrictions: boolean;
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	minLpFees1hUsd: string;
	conditions: DraftCondition[];
};
const emptyValuationDraft: QueryFilterDraft["valuationDraft"] = {
	minFdvUsd: "",
	maxFdvUsd: "",
	fdvSide: "either",
	minTickSpacing: "",
	maxTickSpacing: "",
	minSpacingBps: "",
	maxSpacingBps: "",
};
export function filterDraft(input: {
	valuation?: BoardValuationFilters;
	dlmmFilters?: DlmmFilters;
	hideLpRestrictions?: boolean;
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	minLpFees1hUsd: string;
	metricConditions: BoardMetricCondition[];
}): QueryFilterDraft {
	return {
		valuationDraft: {
			minFdvUsd: input.valuation?.minFdvUsd ?? "",
			maxFdvUsd: input.valuation?.maxFdvUsd ?? "",
			fdvSide: input.valuation?.fdvSide ?? "either",
			minTickSpacing: String(input.valuation?.minTickSpacing ?? ""),
			maxTickSpacing: String(input.valuation?.maxTickSpacing ?? ""),
			minSpacingBps: String(input.valuation?.minSpacingBps ?? ""),
			maxSpacingBps: String(input.valuation?.maxSpacingBps ?? ""),
		},
		dlmmFilters: input.dlmmFilters ?? {},
		hideLpRestrictions: input.hideLpRestrictions ?? false,
		minTvlUsd: input.minTvlUsd,
		minWindowVolumeUsd: input.minWindowVolumeUsd,
		minLpFees1hUsd: input.minLpFees1hUsd,
		conditions: QUERY_METRICS.map((metric) => {
			const condition = input.metricConditions.find((c) => c.field === metric.field);
			return {
				field: metric.field,
				window: condition?.window ?? "1h",
				operator: condition?.operator ?? ">",
				value: condition ? conditionToDisplay(condition) : "",
			};
		}),
	};
}
export function draftConditions(draft: QueryFilterDraft): BoardMetricCondition[] {
	return draft.conditions
		.filter((c) => c.value.trim() !== "")
		.map((c) => ({
			field: c.field,
			window: QUERY_METRICS.find((m) => m.field === c.field)!.windowed ? c.window : null,
			operator: c.operator,
			value: conditionToValue(c.field, c.value),
		}));
}

function RangeBound({
	label,
	metric,
	unit,
	step,
	value,
	onChange,
}: {
	label: string;
	metric: string;
	unit: string;
	step: string;
	value: string;
	onChange(value: string): void;
}) {
	return (
		<label>
			{label}
			<span className="query-number">
				<input
					aria-label={`${label}${metric}`}
					type="number"
					min="0"
					step={step}
					placeholder="不限"
					value={value}
					onChange={(event) => onChange(event.target.value)}
				/>
				<span>{unit}</span>
			</span>
		</label>
	);
}

function withoutLegacySpacing(filters: DlmmFilters): DlmmFilters {
	const next = { ...filters };
	delete next.binStepMin;
	delete next.binStepMax;
	return next;
}

export function QueryFilterDialog(props: {
	open: boolean;
	reportedFees?: boolean;
	showDlmm?: boolean;
	draft: QueryFilterDraft;
	dirty: boolean;
	onChange(draft: QueryFilterDraft): void;
	onClose(): void;
	onApply(): void;
}): ReactElement {
	const dialog = useRef<HTMLDialogElement>(null);
	const [error, setError] = useState("");
	const [tab, setTab] = useState<"general" | "dlmm">("general");
	const showDlmmFields = props.showDlmm && tab === "dlmm";
	const legacySpacing =
		props.draft.valuationDraft.minTickSpacing ||
		props.draft.valuationDraft.maxTickSpacing ||
		props.draft.dlmmFilters.binStepMin ||
		props.draft.dlmmFilters.binStepMax;
	const updateValuation = (key: keyof QueryFilterDraft["valuationDraft"], value: string) =>
		props.onChange({
			...props.draft,
			valuationDraft: { ...props.draft.valuationDraft, [key]: value },
		});
	const updateSpacing = (key: "minSpacingBps" | "maxSpacingBps", value: string) => {
		props.onChange({
			...props.draft,
			dlmmFilters: withoutLegacySpacing(props.draft.dlmmFilters),
			valuationDraft: {
				...props.draft.valuationDraft,
				minTickSpacing: "",
				maxTickSpacing: "",
				[key]: value,
			},
		});
	};
	useEffect(() => {
		if (props.open) dialog.current?.showModal();
		else {
			dialog.current?.close();
			setTab("general");
			setError("");
		}
	}, [props.open]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog handles Escape through onCancel; onClick only dismisses the backdrop.
		<dialog
			ref={dialog}
			className="query-dialog"
			aria-labelledby="query-dialog-title"
			onCancel={(e) => {
				e.preventDefault();
				props.onClose();
			}}
			onClick={(e) => {
				if (e.target === dialog.current) {
					const box = dialog.current.getBoundingClientRect();
					if (
						e.clientX < box.left ||
						e.clientX > box.right ||
						e.clientY < box.top ||
						e.clientY > box.bottom
					)
						props.onClose();
				}
			}}
		>
			<div className="query-dialog-head">
				<div>
					<h2 id="query-dialog-title">筛选条件</h2>
					<p>基础准入 · 指标条件留空不限</p>
				</div>
				<button type="button" aria-label="关闭筛选条件" onClick={props.onClose}>
					×
				</button>
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					try {
						draftConditions(props.draft);
						parseValuationFilters(props.draft.valuationDraft);
						setError("");
						props.onApply();
					} catch (error) {
						setError(error instanceof Error && error.message ? error.message : "请填写有效数值");
					}
				}}
			>
				{props.showDlmm ? (
					<fieldset className="dlmm-filter-tabs" aria-label="筛选类型">
						<button type="button" aria-pressed={!showDlmmFields} onClick={() => setTab("general")}>
							通用筛选
						</button>
						<button type="button" aria-pressed={showDlmmFields} onClick={() => setTab("dlmm")}>
							DLMM 专属
						</button>
					</fieldset>
				) : null}
				{showDlmmFields ? (
					<DlmmFilterFields
						value={props.draft.dlmmFilters}
						onChange={(dlmmFilters) => props.onChange({ ...props.draft, dlmmFilters })}
					/>
				) : null}
				<div className="query-dialog-body" hidden={showDlmmFields}>
					<section>
						<h3>参与限制</h3>
						<label className="query-risk-filter">
							<input
								type="checkbox"
								checked={props.draft.hideLpRestrictions}
								onChange={(e) =>
									props.onChange({ ...props.draft, hideLpRestrictions: e.target.checked })
								}
							/>
							隐藏标记“LP参与限制”的池子
						</label>
					</section>
					<section>
						<h3>
							基础准入 <small>EVM三项；Solana官方候选仅TVL与成交量</small>
						</h3>
						<div className="query-gates">
							{(
								[
									["minTvlUsd", "最低 TVL"],
									["minWindowVolumeUsd", "最低 1H 成交量"],
									["minLpFees1hUsd", "最低 1H LP 手续费"],
								] as const
							)
								.filter(([key]) => !props.reportedFees || key !== "minLpFees1hUsd")
								.map(([key, label]) => (
									<label key={key}>
										{label}
										<span className="query-number">
											<input
												aria-label={label}
												type="number"
												min="0"
												step="any"
												required
												value={props.draft[key]}
												onChange={(e) => props.onChange({ ...props.draft, [key]: e.target.value })}
											/>
											<span>美元</span>
										</span>
									</label>
								))}
						</div>
					</section>
					<section aria-labelledby="query-metric-title">
						<h3>
							<span id="query-metric-title">指标条件</span> <small>已填项同时满足</small>
						</h3>
						<div className="query-condition-head">
							<span>指标</span>
							<span>窗口</span>
							<span>比较方式</span>
							<span>阈值</span>
							<span />
						</div>
						{props.draft.conditions.map((condition, index) => {
							const definition = QUERY_METRICS.find((m) => m.field === condition.field)!;
							const metric = {
								...definition,
								label: feeMetricLabel(
									definition.field,
									definition.label,
									props.reportedFees ?? false,
								),
							};
							const update = (patch: Partial<DraftCondition>) =>
								props.onChange({
									...props.draft,
									conditions: props.draft.conditions.map((item, i) =>
										i === index ? { ...item, ...patch } : item,
									),
								});
							return (
								<div className="query-condition" key={condition.field}>
									<span className={condition.value.trim() ? "condition-enabled" : ""}>
										{metric.label}
									</span>
									<select
										aria-label={`${metric.label}条件窗口`}
										disabled={!metric.windowed}
										value={metric.windowed ? condition.window : "none"}
										onChange={(e) => update({ window: e.target.value as WindowId })}
									>
										{metric.windowed ? (
											BOARD_WINDOWS.map((w) => (
												<option key={w.id} value={w.id}>
													{w.label}
												</option>
											))
										) : (
											<option value="none">不分窗口</option>
										)}
									</select>
									<select
										aria-label={`${metric.label}比较方式`}
										value={condition.operator}
										onChange={(e) =>
											update({ operator: e.target.value as DraftCondition["operator"] })
										}
									>
										{([">", ">=", "<", "<=", "="] as const).map((op, i) => (
											<option key={op} value={op}>
												{["大于 >", "大于等于 ≥", "小于 <", "小于等于 ≤", "等于 ="][i]}
											</option>
										))}
									</select>
									<span className="query-number">
										<input
											aria-label={`${metric.label}条件数值`}
											type="number"
											step="any"
											placeholder="不限"
											value={condition.value}
											onChange={(e) => update({ value: e.target.value })}
										/>
										<span>{metric.unit}</span>
									</span>
									<button
										type="button"
										aria-label={`清空${metric.label}条件`}
										onClick={() => update({ value: "" })}
									>
										×
									</button>
								</div>
							);
						})}
						<fieldset className="query-metric-range">
							<legend title="相邻可用价格档位的比例间距，100 基点等于 1%">
								{PRICE_SPACING_LABEL}
							</legend>
							<div className="query-gates">
								{(
									[
										["minSpacingBps", "最低"],
										["maxSpacingBps", "最高"],
									] as const
								).map(([key, label]) => (
									<RangeBound
										key={key}
										label={label}
										metric={PRICE_SPACING_LABEL}
										unit={BIN_STEP_UNIT}
										step="0.0001"
										value={props.draft.valuationDraft[key]}
										onChange={(value) => updateSpacing(key, value)}
									/>
								))}
							</div>
							{legacySpacing ? (
								<button
									type="button"
									className="query-link"
									onClick={() =>
										updateSpacing("minSpacingBps", props.draft.valuationDraft.minSpacingBps)
									}
								>
									清除旧链接的档位条件
								</button>
							) : null}
						</fieldset>
						<fieldset className="query-metric-range">
							<legend>
								FDV <small>完全稀释估值</small>
							</legend>
							<div className="query-gates">
								{(
									[
										["minFdvUsd", "最低"],
										["maxFdvUsd", "最高"],
									] as const
								).map(([key, label]) => (
									<RangeBound
										key={key}
										label={label}
										metric=" FDV"
										unit="美元"
										step="any"
										value={props.draft.valuationDraft[key]}
										onChange={(value) => updateValuation(key, value)}
									/>
								))}
								<label>
									匹配代币
									<select
										value={props.draft.valuationDraft.fdvSide}
										onChange={(event) => updateValuation("fdvSide", event.target.value)}
									>
										<option value="either">任一侧</option>
										<option value="token0">第一侧（Token 0／X）</option>
										<option value="token1">第二侧（Token 1／Y）</option>
										<option value="both">两侧</option>
									</select>
								</label>
							</div>
						</fieldset>
						<p className="query-input-note">留空不追加该条件，基础准入仍生效；0为有效数值。</p>
						<button
							type="button"
							className="query-link"
							onClick={() =>
								props.onChange({
									...props.draft,
									conditions: props.draft.conditions.map((c) => ({ ...c, value: "" })),
									valuationDraft: emptyValuationDraft,
									dlmmFilters: withoutLegacySpacing(props.draft.dlmmFilters),
								})
							}
						>
							清空指标条件
						</button>
					</section>
				</div>
				<div className="query-dialog-actions">
					<button
						type="button"
						className="query-link"
						onClick={() =>
							props.onChange({
								...props.draft,
								valuationDraft: emptyValuationDraft,
								dlmmFilters: props.showDlmm ? {} : withoutLegacySpacing(props.draft.dlmmFilters),
								hideLpRestrictions: false,
								minTvlUsd: "1000",
								minWindowVolumeUsd: "100",
								minLpFees1hUsd: "10",
								conditions: props.draft.conditions.map((c) => ({
									...c,
									value: "",
									window: "1h",
									operator: ">",
								})),
							})
						}
					>
						恢复默认
					</button>
					<span>{props.dirty ? "有未应用的修改" : "设置已应用"}</span>
					<button className="btn btn-primary" type="submit">
						应用设置
					</button>
				</div>
				{error ? (
					<p role="alert" className="query-error">
						{error}
					</p>
				) : null}
			</form>
		</dialog>
	);
}
