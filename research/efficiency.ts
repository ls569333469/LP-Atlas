import type { Features, ResearchEngine, Signal } from "./engine.ts";
import type { Playbook } from "./lifecycle.ts";

export function efficiencySignals(engine: ResearchEngine): Signal[] {
	const pools = new Map(engine.data.pools.map((p) => [p.poolId, p]));
	return engine.signals().map((s) => {
		const pool = pools.get(s.poolId);
		return {
			...s,
			features: { ...s.features, motion4: pool ? engine.motion(pool, s.start) : null },
		};
	});
}

const width = (f: Features) =>
	Math.min(0.2, Math.max(0.02, 2 * (f.motion4?.excursion ?? 0), 4 * (f.motion4?.rms ?? 0)));
const common = (s: Signal) =>
	!!s.features.motion4 && (s.features.efficiency ?? 0) >= 1 && (s.features.feeRate ?? 0) >= 0.001;
const abs = (value: number | null, max: number) => value !== null && Math.abs(value) <= max;

const pressureBooks: Playbook[] = [
	{
		id: "efficient-flat",
		name: "横盘高效收费",
		entry: "效率≥1、费强≥0.1%、连续2H、|1H涨跌|≤2%、4H端点振幅≤8%",
		test: (s: Signal) =>
			common(s) &&
			s.features.consecutive >= 2 &&
			abs(s.features.price1, 0.02) &&
			(s.features.motion4?.excursion ?? Infinity) <= 0.08,
		range: "symmetric" as const,
	},
	{
		id: "efficient-surge",
		name: "起量收费",
		entry: "效率≥1、费强≥0.1%、成交加速≥2、费用加速≥1.2、|1H涨跌|≤10%",
		test: (s: Signal) =>
			common(s) &&
			(s.features.volumeAcceleration ?? 0) >= 2 &&
			(s.features.feeAcceleration ?? 0) >= 1.2 &&
			abs(s.features.price1, 0.1),
		range: "symmetric" as const,
	},
	{
		id: "efficient-up",
		name: "温和上涨收费",
		entry: "效率≥1、费强≥0.1%、1H上涨0.5%–5%、4H上涨、费用环比≥0",
		test: (s: Signal) =>
			common(s) &&
			(s.features.price1 ?? 0) >= 0.005 &&
			(s.features.price1 ?? 1) <= 0.05 &&
			(s.features.price4 ?? 0) > 0 &&
			(s.features.growth ?? -1) >= 0,
		range: "up" as const,
	},
	{
		id: "efficient-contract",
		name: "波动收敛收费",
		entry: "效率≥1、费强≥0.1%、近2H RMS≤此前2H的70%、成交加速≥0.8、|1H涨跌|≤3%",
		test: (s: Signal) =>
			common(s) &&
			(s.features.motion4?.priorRms ?? 0) > 0 &&
			(s.features.motion4?.recentRms ?? Infinity) <= 0.7 * (s.features.motion4?.priorRms ?? 0) &&
			(s.features.volumeAcceleration ?? 0) >= 0.8 &&
			abs(s.features.price1, 0.03),
		range: "symmetric" as const,
	},
].flatMap((b, i) =>
	[1, 2, 4, 6, 12].map((holdHours) => ({
		...b,
		id: `${b.id}-${holdHours}h`,
		name: `${i + 1}. ${b.name} · 上限${holdHours}H`,
		holdHours,
		width,
		rangeText: `总宽=max(2%,2×4H端点振幅,4×4H log收益RMS)，上限20%，tick外扩；${b.range === "up" ? "下20%/上80%" : "对称"}`,
		exit: `每小时检查出区间、净损益±2%、盈利1%后回吐1%、TVL降20%、资金效率/成交/费强降半、波动扩大2倍、费用压力；最长${holdHours}H，冷却1H。`,
		source: "研究参数；资金效率+费用强度+四小时端点波动，非分钟真实波动或实盘验证",
		coverageExit: true,
		efficiencyDecay: 0.5,
		volatilityExpansion: 2,
	})),
);

export const EFFICIENCY_BOOKS: Playbook[] = [
	...pressureBooks.map((b) => ({
		...b,
		id: `${b.id}-signal`,
		name: `${b.name} · 信号退出`,
		exit: b.exit.replace("、费用压力", ""),
		coverageExit: false,
	})),
	...pressureBooks.map((b) => ({ ...b, name: `${b.name} · 压力退出` })),
];
