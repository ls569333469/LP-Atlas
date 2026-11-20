import type { BoardRow, BoardSuccessResponse } from "@lp-atlas/shared";
import type { ReactElement } from "react";
import { userError } from "./data-notices.ts";
import { PoolMetrics } from "./SixWindowTable.tsx";

export function EntryPlaceholder(props: {
	row: BoardRow | null;
	board: BoardSuccessResponse | null;
	loading: boolean;
	error: string;
	hasSelection: boolean;
	onBack(): void;
	onClose(): void;
	onRetry(): void;
}): ReactElement {
	return (
		<aside className="order-column" aria-label="新建仓位配置占位">
			<div className="order-heading">
				<h2>新建仓位</h2>
				<span className="outline-tag">尚未开发</span>
				<button type="button" className="order-close" onClick={props.onClose}>
					收起
				</button>
			</div>
			<p className="order-note">配置预览 · 暂不可提交</p>
			{props.hasSelection ? (
				<button type="button" className="order-back" onClick={props.onBack}>
					← 返回目录
				</button>
			) : null}
			{props.error ? (
				<p className="order-note state-error" role="alert">
					{userError(props.error)}
					<button type="button" onClick={props.onRetry}>
						重试加载
					</button>
				</p>
			) : null}
			{props.loading ? <p className="order-note">正在读取所选池的当前快照…</p> : null}
			{props.row && props.board ? (
				<PoolMetrics row={props.row} board={props.board} compact />
			) : !props.loading && !props.error ? (
				<div className="order-empty">从左侧点击交易对或“详情”，选择要配置的池。</div>
			) : null}
			{props.row ? (
				<div className="order-context-placeholders">
					<details>
						<summary>价格与流动性 · 待开发</summary>
						<p>价格曲线、流动性分布及区间叠加尚未接入。</p>
					</details>
					<details>
						<summary>该池已有头寸 · 待开发</summary>
						<p>连接钱包后的区间、库存与未领手续费尚未接入。</p>
					</details>
				</div>
			) : null}
			<fieldset className="entry-placeholder" disabled>
				<section className="entry-section">
					<h3>
						<span>01</span>选择集中模板
					</h3>
					<div className="entry-template-grid">
						<button type="button" className="entry-template">
							<strong>窄区间跟随</strong>
							<small>总宽 1%–2%</small>
						</button>
						<button type="button" className="entry-template">
							<strong>短线收割后撤</strong>
							<small>出区间就撤</small>
						</button>
						<button type="button" className="entry-template">
							<strong>宽区间铺现货</strong>
							<small>宽区间 · 少调仓</small>
						</button>
						<button type="button" className="entry-template">
							<strong>两端加厚</strong>
							<small>进阶分布</small>
						</button>
					</div>
				</section>
				<section className="entry-section">
					<h3>
						<span>02</span>价格区间
					</h3>
					<select aria-label="价格区间方式">
						<option>预设 / 自定义 / 单边</option>
					</select>
					<div className="entry-range">
						<label>
							价格下沿
							<input aria-label="价格下沿" placeholder="—" />
						</label>
						<label>
							价格上沿
							<input aria-label="价格上沿" placeholder="—" />
						</label>
					</div>
				</section>
				<section className="entry-section">
					<h3>
						<span>03</span>投入资产
					</h3>
					<select aria-label="投入资产方式">
						<option>单资产 / 双资产</option>
					</select>
					<label>
						投入金额
						<span className="entry-amount">
							<input aria-label="投入金额" placeholder="待接入钱包与余额" />
							<span>USD</span>
						</span>
					</label>
				</section>
				<section className="entry-section">
					<h3>
						<span>04</span>滑点与离场
					</h3>
					<select aria-label="滑点与离场">
						<option>滑点 / 出区间退出 / 止盈止损</option>
					</select>
					<label>
						授权范围
						<select>
							<option>本次上限 + 滑点缓冲</option>
						</select>
					</label>
				</section>

				<div className="entry-quote">
					<p>
						实际价格区间 <span>—</span>
					</p>
					<p>
						流动性份额 / gas <span>—</span>
					</p>
					<p>
						窗口手续费预估 <span>—</span>
					</p>
					<p>
						兑换后数量 / 最少到账 <span>—</span>
					</p>
				</div>
				<button type="button" className="btn btn-primary">
					新建仓位 · 尚未开发
				</button>
			</fieldset>
		</aside>
	);
}
