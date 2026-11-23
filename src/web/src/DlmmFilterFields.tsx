import {
	DLMM_FILTERS,
	DLMM_INTEGER_RANGES,
	DLMM_OFFICIAL_WINDOWS,
	type DlmmFilters,
	type DlmmRangeKey,
} from "@lp-atlas/shared";
import { useId } from "react";

type ChoiceKey = Exclude<keyof DlmmFilters, `${DlmmRangeKey}Min` | `${DlmmRangeKey}Max`>;
const YES_NO = [
	["true", "是"],
	["false", "否"],
] as const;

function Hint({ label, help }: { label: string; help: string }) {
	const id = useId();
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: Field help must be reachable by keyboard.
		<span className="dlmm-filter-hint" tabIndex={0} aria-describedby={id}>
			{label}
			<span id={id} role="tooltip">
				{help}
			</span>
		</span>
	);
}

export function DlmmFilterFields(props: {
	value: DlmmFilters;
	onChange(value: DlmmFilters): void;
}) {
	const update = (field: keyof DlmmFilters, value: string) => {
		const next = { ...props.value };
		if (value) next[field] = value;
		else delete next[field];
		props.onChange(next);
	};
	const hint = (field: keyof typeof DLMM_FILTERS) => {
		const [label, help] = DLMM_FILTERS[field];
		return <Hint label={label} help={help} />;
	};
	const range = (field: DlmmRangeKey) => {
		const [label, , unit] = DLMM_FILTERS[field];
		return (
			<fieldset className="dlmm-filter-range">
				<legend>{hint(field)}</legend>
				<div>
					{(["Min", "Max"] as const).map((bound, i) => {
						const key = `${field}${bound}` as const;
						const limit = i === 0 ? "最低" : "最高";
						return (
							<span className="query-number" key={bound}>
								<input
									type="text"
									inputMode={DLMM_INTEGER_RANGES.includes(field) ? "numeric" : "decimal"}
									aria-label={`${label}${limit}`}
									placeholder={limit}
									value={props.value[key] ?? ""}
									onChange={(event) => update(key, event.target.value)}
								/>
								<span>{unit}</span>
							</span>
						);
					})}
				</div>
			</fieldset>
		);
	};
	const options = (
		field: ChoiceKey,
		entries: readonly (readonly [string, string])[],
		fallback = "",
	) => (
		<label>
			{hint(field)}
			<select
				aria-label={DLMM_FILTERS[field][0]}
				value={props.value[field] ?? fallback}
				onChange={(event) => update(field, event.target.value)}
			>
				{fallback === "" ? <option value="">不限</option> : null}
				{entries.map(([value, label]) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
			</select>
		</label>
	);
	const text = (field: ChoiceKey) => (
		<label>
			{hint(field)}
			<input
				type="text"
				aria-label={DLMM_FILTERS[field][0]}
				placeholder="不限"
				value={props.value[field] ?? ""}
				onChange={(event) => update(field, event.target.value)}
			/>
		</label>
	);
	return (
		<div className="query-dialog-body">
			<p className="query-input-note">仅筛选 Solana DLMM 池，全部网络和 Solana 共用这些条件。</p>
			<div className="query-gates dlmm-filter-grid">
				{range("baseFee")}
				{range("binStep")}
				<fieldset className="dlmm-filter-range">
					<legend>{hint("mode")}</legend>
					<div>
						{(
							[
								["0", "随输入币"],
								["1", "仅 Y 币"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								className="btn"
								aria-pressed={props.value.mode === value}
								onClick={() => update("mode", props.value.mode === value ? "" : value)}
							>
								{label}
							</button>
						))}
					</div>
				</fieldset>
				{options("farm", [
					["true", "有"],
					["false", "无"],
				])}
			</div>
			<details className="dlmm-filter-more">
				<summary>代币资料</summary>
				<div className="query-gates dlmm-filter-grid">
					{options(
						"side",
						[
							["either", "任一侧"],
							["x", "X 币"],
							["y", "Y 币"],
							["both", "两侧"],
						],
						"either",
					)}
					{range("marketCap")}
					{range("holders")}
					{range("tokenPrice")}
					{range("supply")}
					{range("decimals")}
					{options("verified", YES_NO)}
					{options("freezeDisabled", YES_NO)}
				</div>
			</details>
			<details className="dlmm-filter-more">
				<summary>池资料与风险</summary>
				<div className="query-gates dlmm-filter-grid">
					{text("launchpad")}
					{options("blacklisted", YES_NO)}
					{text("pairType")}
					{range("protocolFee")}
					{range("poolPrice")}
					{range("amountX")}
					{range("amountY")}
					{text("reserveX")}
					{text("reserveY")}
					{text("rewardMint")}
					<label>
						<Hint label="池标签" help="当前已核样本的标签均为空。" />
						<input disabled placeholder="暂不可筛" />
					</label>
					<label>
						<Hint label="农场 APR/APY" help="农场收益的单位待核。" />
						<input disabled placeholder="暂不可筛" />
					</label>
				</div>
			</details>
			<details className="dlmm-filter-more">
				<summary>官方统计</summary>
				<div className="query-gates dlmm-filter-grid">
					{options(
						"officialWindow",
						DLMM_OFFICIAL_WINDOWS.map((window) => [window, window.toUpperCase()]),
						"1h",
					)}
					{range("protocolFees")}
					{range("feeTvlRatio")}
					{range("lifetimeVolume")}
					{range("lifetimeFees")}
				</div>
			</details>
		</div>
	);
}
