import {
	BOARD_WINDOWS,
	type BoardMetricCondition,
	conditionToDisplay,
	conditionToValue,
	QUERY_METRICS,
	type SortField,
	type WindowId,
} from "@lp-atlas/shared";
import { type ReactElement, useEffect, useRef, useState } from "react";

type DraftCondition = {
	field: SortField;
	window: WindowId;
	operator: BoardMetricCondition["operator"];
	value: string;
};
export type QueryFilterDraft = {
	hideLpRestrictions: boolean;
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	minLpFees1hUsd: string;
	conditions: DraftCondition[];
};
export function filterDraft(input: {
	hideLpRestrictions?: boolean;
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	minLpFees1hUsd: string;
	metricConditions: BoardMetricCondition[];
}): QueryFilterDraft {
	return {
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

export function QueryFilterDialog(props: {
	open: boolean;
	draft: QueryFilterDraft;
	dirty: boolean;
	onChange(draft: QueryFilterDraft): void;
	onClose(): void;
	onApply(): void;
}): ReactElement {
	const dialog = useRef<HTMLDialogElement>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		if (props.open) dialog.current?.showModal();
		else dialog.current?.close();
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
					<p>三项准入 · 八项指标 · 留空不限</p>
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
						setError("");
						props.onApply();
					} catch {
						setError("请填写有效数值");
					}
				}}
			>
				<div className="query-dialog-body">
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
							基础准入 <small>同时满足三项</small>
						</h3>
						<div className="query-gates">
							{(
								[
									["minTvlUsd", "最低 TVL"],
									["minWindowVolumeUsd", "最低 1H 成交量"],
									["minLpFees1hUsd", "最低 1H LP 手续费"],
								] as const
							).map(([key, label]) => (
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
					<section>
						<h3>
							指标条件 <small>已填项同时满足</small>
						</h3>
						<div className="query-condition-head">
							<span>指标</span>
							<span>窗口</span>
							<span>比较方式</span>
							<span>阈值</span>
							<span />
						</div>
						{props.draft.conditions.map((condition, index) => {
							const metric = QUERY_METRICS.find((m) => m.field === condition.field)!;
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
						<p className="query-input-note">留空不追加该条件，基础准入仍生效；0为有效数值。</p>
						<button
							type="button"
							className="query-link"
							onClick={() =>
								props.onChange({
									...props.draft,
									conditions: props.draft.conditions.map((c) => ({ ...c, value: "" })),
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
