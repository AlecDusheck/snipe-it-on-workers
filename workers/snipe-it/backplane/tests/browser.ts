import { request } from "node:http";

export class Browser {
	readonly cookies = new Map<string, string>();
	constructor(
		readonly host: string,
		readonly port = 8793,
	) {}
	async visit(
		path: string,
		options: {
			method?: string;
			form?: Record<string, string>;
			json?: unknown;
			multipart?: FormData;
			headers?: Record<string, string>;
		} = {},
	) {
		let body: string | Uint8Array = options.form
			? new URLSearchParams(options.form).toString()
			: options.json
				? JSON.stringify(options.json)
				: "";
		const headers: Record<string, string> = {
			host: `${this.host}:${this.port}`,
			cookie: Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; "),
			...options.headers,
		};
		if (options.multipart) {
			const multipart = new Request("https://example.test", { method: "POST", body: options.multipart });
			headers["content-type"] = multipart.headers.get("content-type") ?? "";
			body = new Uint8Array(await multipart.arrayBuffer());
		}
		if (options.form) headers["content-type"] = "application/x-www-form-urlencoded";
		if (options.json) headers["content-type"] = "application/json";
		if (body) headers["content-length"] = String(Buffer.byteLength(body));
		return new Promise<{
			status: number;
			body: string;
			headers: import("node:http").IncomingHttpHeaders;
			bytes: Buffer;
		}>((resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					agent: false,
					port: this.port,
					path,
					method: options.method ?? (body ? "POST" : "GET"),
					headers,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => {
						chunks.push(chunk);
					});
					res.on("error", reject);
					res.on("end", () => {
						for (const cookie of res.headers["set-cookie"] ?? []) {
							const pair = cookie.split(";", 1)[0];
							if (!pair) continue;
							const at = pair.indexOf("=");
							if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
						}
						const bytes = Buffer.concat(chunks);
						resolve({
							status: res.statusCode ?? 0,
							body: bytes.toString("utf8"),
							bytes,
							headers: res.headers,
						});
					});
				},
			);
			req.on("error", reject);
			req.setTimeout(60000, () => req.destroy(new Error("Application request timed out")));
			req.end(body);
		});
	}
}

export function csrf(html: string): string {
	const token =
		html.match(/name="_token"\s+(?:[^>]*?\s)?value="([^"]+)"/)?.[1] ??
		html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
	if (!token) throw new Error("Snipe-IT did not render a CSRF token");
	return token;
}
