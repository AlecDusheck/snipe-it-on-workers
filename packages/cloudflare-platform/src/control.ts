import { WorkerEntrypoint } from "cloudflare:workers";
import { requestKey, requireRelease, requireSlug, tenantInput, tenantUrl } from "./validation";
import { record } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { environmentOverrides } from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";
import { operation } from "./operations";
import { TenantDirectory } from "./directory";
import { databaseAction } from "./database";
import { listReleases } from "./releases";
import type { DatabaseAction, DatabasePage } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type {
	CreatedTenant,
	OperationResult,
	ReleaseSummary,
	TenantDetails,
	TenantInput,
	TenantPage,
} from "./types";
import type { PolicyOverrides } from "./policy";
import type { TenantBase, TenantEnv } from "./tenant";

export interface ControlEnv {
	DIRECTORY: KVNamespace;
	ASSETS: Fetcher;
	TENANTS: DurableObjectNamespace<TenantBase<TenantEnv>>;
}
type Tenant = DurableObjectStub<TenantBase<TenantEnv>>;

// Inputs are rejected before a Durable Object is woken; the tenant validates again at its own boundary.
export class BackplaneControl extends WorkerEntrypoint<ControlEnv> {
	async #forward<V, T>(
		slug: unknown,
		validate: () => V,
		run: (tenant: Tenant, slug: string, value: V) => Promise<OperationResult<T>>,
	): Promise<OperationResult<T>> {
		const checked = await operation(async () => ({ slug: requireSlug(slug), value: validate() }));
		if (!checked.ok) return checked;
		return run(this.env.TENANTS.getByName(checked.value.slug), checked.value.slug, checked.value.value);
	}
	setTenantPolicy(slug: string, policy: PolicyOverrides): Promise<OperationResult<void>> {
		return this.#forward(
			slug,
			() => policy,
			(tenant, _slug, value) => tenant.setPolicy(value),
		);
	}
	getTenant(slug: string): Promise<OperationResult<TenantDetails>> {
		return this.#forward(
			slug,
			() => undefined,
			(tenant, name) => tenant.details(name),
		);
	}
	getReleases(): Promise<OperationResult<ReleaseSummary[]>> {
		return operation(() => listReleases(this.env.ASSETS));
	}
	listTenants(cursor: string | null = null): Promise<OperationResult<TenantPage>> {
		return operation(() => new TenantDirectory(this.env.DIRECTORY).list(cursor));
	}
	setTenantUrl(slug: string, url: string): Promise<OperationResult<void>> {
		return this.#forward(
			slug,
			() => tenantUrl(url),
			(tenant, name, origin) => tenant.setUrl(name, origin),
		);
	}
	database(slug: string, action: DatabaseAction): Promise<OperationResult<DatabasePage & { url: string }>> {
		return this.#forward(
			slug,
			() => databaseAction(action),
			async (tenant, name, checked) => {
				const result = await tenant.database(name, checked);
				if (!result.ok) return result;
				return operation(async () => ({
					...result.value,
					url: (await new TenantDirectory(this.env.DIRECTORY).get(name)).url,
				}));
			},
		);
	}
	createTenant(input: TenantInput, key: string, url: string): Promise<OperationResult<CreatedTenant>> {
		return this.#forward(
			record(input) ? input.slug : undefined,
			() => ({ input: tenantInput(input), key: requestKey(key), url: tenantUrl(url) }),
			(tenant, _slug, checked) => tenant.provision(checked.input, checked.key, checked.url),
		);
	}
	upgradeTenant(slug: string, release: string): Promise<OperationResult<string>> {
		return this.#forward(
			slug,
			() => requireRelease(release),
			(tenant, name, target) => tenant.upgrade(name, target),
		);
	}
	configureTenant(slug: string, environment: Record<string, string>): Promise<OperationResult<void>> {
		return this.#forward(
			slug,
			() => environmentOverrides(environment),
			(tenant, _slug, checked) => tenant.configure(checked),
		);
	}
}
