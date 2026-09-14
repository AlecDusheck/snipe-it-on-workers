import * as v from "valibot";
import { slugValid, originSchema } from "./validation";
import { HttpError, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import type { TenantDescriptor, TenantPage } from "./types";

const descriptorSchema = v.object({
	slug: v.pipe(v.string(), v.check(slugValid)),
	name: v.string(),
	createdAt: v.string(),
	url: originSchema,
});
const descriptor = (value: unknown): TenantDescriptor =>
	parse(descriptorSchema, value, 503, "Workspace directory is invalid.");
const TENANT = "tenant:";
const ORIGIN = "origin:";
const PAGE = 50;

// KV has no transactions: each slug's Durable Object serializes its writes; hostname ownership is checked, not locked.
// `origin:` keys are reserved before PHP initialization; `tenant:` keys publish after it.
export class TenantDirectory {
	constructor(private readonly store: KVNamespace) {}
	/** Routing only; the tenant recheck of its canonical URL rejects pending or stale mappings. */
	resolve(origin: string): Promise<string | null> {
		return this.store.get(ORIGIN + origin);
	}
	async get(slug: string): Promise<TenantDescriptor> {
		const tenant = await this.find(slug);
		if (!tenant) throw new HttpError(404, "Workspace not found.");
		return tenant;
	}
	async reserve(slug: string, origin: string): Promise<void> {
		const [holder, tenant] = await Promise.all([this.store.get(ORIGIN + origin), this.find(slug)]);
		if ((holder && holder !== slug) || (tenant && tenant.url !== origin))
			throw new HttpError(409, "Workspace name or URL is already reserved.");
		if (holder !== slug) await this.store.put(ORIGIN + origin, slug);
	}
	async setUrl(slug: string, url: string): Promise<void> {
		const tenant = await this.get(slug);
		if (tenant.url === url) return;
		const holder = await this.store.get(ORIGIN + url);
		if (holder && holder !== slug) throw new HttpError(409, "This URL belongs to another workspace.");
		await this.store.put(ORIGIN + url, slug);
		await this.publish({ ...tenant, url });
		await this.store.delete(ORIGIN + tenant.url);
	}
	async register(tenant: TenantDescriptor): Promise<void> {
		await this.reserve(tenant.slug, tenant.url);
		if (!(await this.find(tenant.slug))) await this.publish(tenant);
	}
	/** Pages read descriptors from key metadata (under KV's 1024-byte limit at the validation bounds). */
	async list(cursor: string | null = null): Promise<TenantPage> {
		if (cursor !== null && typeof cursor !== "string") throw new HttpError(400, "Invalid workspace page.");
		const page = await this.store
			.list({ prefix: TENANT, limit: PAGE, ...(cursor && { cursor }) })
			.catch((error: unknown) => {
				if (cursor) throw new HttpError(400, "Invalid workspace page.");
				throw error;
			});
		return {
			tenants: page.keys.map((key) => descriptor(key.metadata)),
			cursor: page.list_complete ? null : page.cursor,
		};
	}
	private async find(slug: string): Promise<TenantDescriptor | null> {
		const value = await this.store.get(TENANT + slug, "json");
		return value === null ? null : descriptor(value);
	}
	private publish(tenant: TenantDescriptor): Promise<void> {
		return this.store.put(TENANT + tenant.slug, JSON.stringify(tenant), { metadata: tenant });
	}
}
