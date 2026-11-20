import type { BoardSuccessResponse } from "@lp-atlas/shared";
import { type FormEvent, type ReactElement, useState } from "react";

export function BoardPagination(props: {
	board: BoardSuccessResponse;
	admissionSummary?: string;
	disabled: boolean;
	onPage(page: number): void;
	onPageSize(size: number): void;
}): ReactElement | null {
	const [jump, setJump] = useState("");
	const [error, setError] = useState("");
	const paging = props.board.pagination;
	if (!paging) return null;
	const pages = [...new Set([1, paging.page - 1, paging.page, paging.page + 1, paging.totalPages])]
		.filter((page) => page >= 1 && page <= paging.totalPages)
		.sort((a, b) => a - b);
	function onJump(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const page = Number(jump);
		if (!/^[1-9]\d*$/.test(jump) || page > (paging?.totalPages ?? 0)) {
			setError("请输入有效范围内的整数页码");
			return;
		}
		setError("");
		props.onPage(page);
	}
	return (
		<nav className="board-pagination" aria-label="池列表分页">
			<span className="page-summary">
				{props.admissionSummary ? (
					<span className="query-summary">{props.admissionSummary}</span>
				) : null}
				<span>
					符合条件 {paging.total} 个池 · 当前 {paging.from}–{paging.to} · 第{" "}
					{paging.totalPages ? paging.page : 0}/{paging.totalPages} 页
				</span>
			</span>
			<label>
				每页{" "}
				<select
					aria-label="每页数量"
					value={paging.pageSize}
					disabled={props.disabled}
					onChange={(event) => props.onPageSize(Number(event.target.value))}
				>
					{[50, 100, 200].map((size) => (
						<option key={size} value={size}>
							{size}
						</option>
					))}
				</select>
			</label>
			<button
				type="button"
				className="btn btn-secondary"
				disabled={props.disabled || paging.page <= 1}
				onClick={() => props.onPage(paging.page - 1)}
			>
				上一页
			</button>
			{pages.map((page, index) => (
				<span key={page}>
					{index > 0 && page - (pages[index - 1] ?? 0) > 1 ? (
						<span className="page-ellipsis">…</span>
					) : null}
					<button
						type="button"
						className="btn btn-secondary"
						aria-current={page === paging.page ? "page" : undefined}
						disabled={props.disabled || page === paging.page}
						onClick={() => props.onPage(page)}
					>
						{page}
					</button>
				</span>
			))}
			<button
				type="button"
				className="btn btn-secondary"
				disabled={props.disabled || paging.page >= paging.totalPages}
				onClick={() => props.onPage(paging.page + 1)}
			>
				下一页
			</button>
			<form onSubmit={onJump}>
				<label>
					跳至{" "}
					<input
						aria-label="跳转页码"
						inputMode="numeric"
						value={jump}
						onChange={(event) => setJump(event.target.value)}
						disabled={props.disabled || !paging.total}
					/>
				</label>
				<button
					className="btn btn-secondary"
					type="submit"
					disabled={props.disabled || !paging.total}
				>
					跳转
				</button>
				{error ? <span role="alert">{error}</span> : null}
			</form>
		</nav>
	);
}
