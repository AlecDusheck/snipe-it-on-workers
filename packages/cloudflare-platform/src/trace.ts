/** Per-request phase timings, reported in logs and optionally in `x-platform-trace`. */
export class RequestTrace {
	readonly spans: Record<string, number> = {};
	readonly #started = performance.now();
	async span<T>(name: string, work: () => Promise<T>): Promise<T> {
		const started = performance.now();
		try {
			return await work();
		} finally {
			this.spans[name] = Math.round(performance.now() - started);
		}
	}
	report(): Record<string, number> {
		return { totalMs: Math.round(performance.now() - this.#started), ...this.spans };
	}
}
