/** Bounded HTTP reads for source investigation, separate from the scanning RPC retry policy. */
export async function readSourceUrl(
	url: string,
	options: {
		fetch?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
	} = {},
): Promise<{
	status: "ok" | "not_found" | "access_blocked" | "rate_limited" | "http_error" | "network_error";
	httpStatus: number | null;
	body: string;
	attempts: number;
	retryAfterMs?: number;
}> {
	const request = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	for (let attempt = 1; attempt <= 3; attempt++) {
		let response: Response;
		let body: string;
		try {
			response = await request(url, { signal: AbortSignal.timeout(15_000) });
			body = await response.text();
		} catch (error) {
			if (attempt < 3) {
				await sleep(1000 * 2 ** (attempt - 1));
				continue;
			}
			const cause = error instanceof Error ? error.cause : undefined;
			return {
				status: "network_error",
				httpStatus: null,
				body: `${error instanceof Error ? error.message : String(error)}; ${String(cause ?? "")}`,
				attempts: attempt,
			};
		}
		const base = { httpStatus: response.status, body, attempts: attempt };
		if (body.includes("Vercel Security Checkpoint")) return { ...base, status: "access_blocked" };
		if (response.ok) return { ...base, status: "ok" };
		if (response.status === 404) return { ...base, status: "not_found" };
		if (response.status === 401 || response.status === 403) {
			return { ...base, status: "access_blocked" };
		}
		if (response.status === 429 || response.status >= 500) {
			const header = response.headers.get("retry-after")?.trim();
			const parsed = header
				? /^\d+$/.test(header)
					? Number(header) * 1000
					: Date.parse(header) - now()
				: Number.NaN;
			const delay = Number.isFinite(parsed) ? Math.max(0, parsed) : 1000 * 2 ** (attempt - 1);
			// A long server cooldown is returned to the caller, never shortened to retry sooner.
			if (attempt < 3 && delay <= 10_000) {
				await sleep(delay);
				continue;
			}
			return {
				...base,
				status: response.status === 429 ? "rate_limited" : "http_error",
				retryAfterMs: delay,
			};
		}
		return { ...base, status: "http_error" };
	}
	throw new Error("unreachable");
}
