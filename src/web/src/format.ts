const usdFormats = {
	large: new Intl.NumberFormat("zh-CN", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}),
	small: new Intl.NumberFormat("zh-CN", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}),
};
const percentFormats = new Map<number, Intl.NumberFormat>();

export function formatUsd(value: string | null): string {
	if (value === null) {
		return "—";
	}
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return "—";
	}
	return usdFormats[number >= 1000 ? "large" : "small"].format(number);
}

export function formatPercent(value: string | null, fractionDigits = 2): string {
	if (value === null) {
		return "—";
	}
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return "—";
	}
	let formatter = percentFormats.get(fractionDigits);
	if (!formatter) {
		formatter = new Intl.NumberFormat("zh-CN", {
			minimumFractionDigits: fractionDigits,
			maximumFractionDigits: fractionDigits,
		});
		percentFormats.set(fractionDigits, formatter);
	}
	return `${formatter.format(number * 100)}%`;
}

export function formatFeeUsd(value: string | null): string {
	return value !== null && Number(value) > 0 && Number(value) < 0.01
		? "< US$0.01"
		: formatUsd(value);
}

export function formatFeeApr(value: string | null): string {
	return value !== null && Number(value) > 0 && Number(value) < 0.0001
		? "< 0.01%"
		: formatPercent(value);
}

/** Signed percent with a typographic minus, so color is not the only up/down cue. */
export function formatSignedPercent(value: string | null, fractionDigits = 2): string {
	if (value === null) {
		return "—";
	}
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return "—";
	}
	const abs = formatPercent(String(Math.abs(number)), fractionDigits);
	if (number > 0) {
		return `+${abs}`;
	}
	if (number < 0) {
		return `−${abs}`;
	}
	return abs;
}

export function changeTone(value: string | null): "up" | "down" | "flat" {
	if (value === null) {
		return "flat";
	}
	const number = Number(value);
	if (!Number.isFinite(number) || number === 0) {
		return "flat";
	}
	return number > 0 ? "up" : "down";
}

export function formatRatio(value: string | null): string {
	if (value === null) {
		return "—";
	}
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return "—";
	}
	return number.toFixed(4);
}

export function formatAge(value: string | null): string {
	if (value === null) {
		return "—";
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return "—";
	}
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	if (days > 0) {
		return `${days}天${hours}小时`;
	}
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}小时${minutes}分钟`;
	}
	return `${minutes}分钟`;
}

export function formatTime(value: string | null): string {
	if (!value) {
		return "—";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(date);
}

export function formatDayTime(value: string | null): string {
	if (!value) {
		return "—";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

export function formatClock(value: string | null): string {
	if (!value) {
		return "—";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}
