import type { BoardRow } from "@lp-atlas/shared";
import type { ReactElement } from "react";

export function PoolRiskNotices({ row }: { row: BoardRow }): ReactElement | null {
	if (!row.riskNotices?.length) return null;
	const participation = row.riskNotices.some(
		(notice) => notice.kind === "entry" || notice.kind === "exit",
	);
	const notices = row.riskNotices.filter(
		(notice) => notice.kind !== "entry" && notice.kind !== "exit",
	);
	return (
		<div className="pool-risk-notices">
			{participation ? <span className="pool-risk">LP参与限制</span> : null}
			{notices.map((notice) => (
				<span className="pool-risk" key={notice.kind}>
					{notice.label}
				</span>
			))}
		</div>
	);
}
