import { DurableObject } from "cloudflare:workers";
import { InstanceStorage } from "./instance-storage";
import { getRelease, releaseSummary } from "./releases";
import { TenantService } from "./tenant-service";
import { SerialQueue } from "@simplyalec/laravel-cf-workers-laravel-runtime/queue";
import { HttpError, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { parseRuntimeOutput } from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import { requestKey, requireRelease, tenantInput, tenantUrl } from "./validation";
import { errorResponse, toHttpInput, toResponse } from "./http";
import { environmentOverrides } from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";
import { workerEnvironment } from "./environment";
import { operation } from "./operations";
import { TenantDirectory } from "./directory";
import { reservedPath } from "./router";
import { PUBLIC_ROOT, publicPrefixes } from "./assets";
import { RequestTrace } from "./trace";
import { MIB, effectivePolicy, jobsPausedReason, policyOverridesSchema } from "./policy";
import type { PolicyOverrides, TenantPolicy } from "./policy";
import { TenantBlocks } from "./blocks";
import { fileResponse } from "./file-response";
import {
	databaseBytes,
	decodeFiles,
	isFileManifest,
	persistentPath,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type { RuntimeStorage } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";
import type { RuntimeMemory } from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import type {
	DatabaseAction,
	DatabasePage,
	Release,
	RuntimeInput,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type {
	CreatedTenant,
	OperationResult,
	Snapshot,
	TenantDescriptor,
	TenantDetails,
	TenantInput,
	TenantSecrets,
} from "./types";

export interface TenantEnv {
	ASSETS: Fetcher;
	DIRECTORY?: KVNamespace;
	DEFAULT_RELEASE: string;
	TENANT_DEFAULTS?: unknown;
	/** When set, every response carries its I/O trace in `x-platform-trace`. */
	PLATFORM_TRACE?: string;
}

// Deployment-mode hooks; the application profile supplies everything application-specific.
export interface TenantRuntime {
	application: ApplicationProfile;
	execute(release: Release, input: RuntimeInput, storage: RuntimeStorage): Promise<unknown>;
	resolveRelease?(name: string): Promise<Release>;
	requestOrigin?(slug: string, url: URL): Promise<string>;
	prepareInstance?(service: TenantService): Promise<void>;
	/** Memory the runtime retains in this isolate, when PHP runs in-process. */
	memory?(): RuntimeMemory | undefined;
}

const ACTIVITY_INTERVAL = 60000;
const MAX_CONCURRENT_STREAMS = 8;

// PHP executions and management writes share one queue; downloads lease committed blocks.
export class TenantBase<E extends TenantEnv> extends DurableObject<E> {
	#runtime: TenantRuntime;
	#state: InstanceStorage;
	#queue = new SerialQueue();
	#publicPrefixes: string[];
	#committed: Promise<Snapshot | null> | undefined;
	#descriptor: TenantDescriptor | undefined;
	#policyCache: TenantPolicy | undefined;
	#workerEnvironment: Record<string, string> | undefined;
	#lastActivity = 0;
	#streams = 0;
	constructor(ctx: DurableObjectState, env: E, runtime: TenantRuntime) {
		super(ctx, env);
		this.#runtime = runtime;
		this.#state = new InstanceStorage(ctx.storage);
		this.#publicPrefixes = publicPrefixes(runtime.application);
	}

	details(slug: string): Promise<OperationResult<TenantDetails>> {
		return operation(async () => {
			const snapshot = await this.#requireSnapshot();
			const [policy, activity, descriptor, release] = await Promise.all([
				this.#policy(),
				this.ctx.storage.get<number>("lastActivity"),
				this.#describe(slug),
				this.#resolveRelease(snapshot.release),
			]);
			const lastActivity = activity ?? Date.parse(snapshot.createdAt);
			return {
				slug,
				url: descriptor.url,
				release: releaseSummary(release),
				revision: snapshot.revision,
				databaseBytes: databaseBytes(snapshot.bytes),
				createdAt: snapshot.createdAt,
				policy,
				lastActivityAt: new Date(lastActivity).toISOString(),
				jobsPausedReason: jobsPausedReason(policy, lastActivity, Date.now()),
			};
		});
	}
	/** The release a tenant is running, for serving its static assets outside the queue. */
	currentRelease(origin: string): Promise<OperationResult<Release>> {
		return operation(async () => {
			if (!this.#runtime.requestOrigin && origin !== (await this.#describe()).url)
				throw new HttpError(404, "Not found.");
			if ((await this.#policy()).suspended) throw new HttpError(503, "This workspace is suspended.");
			return this.#resolveRelease((await this.#requireSnapshot()).release);
		});
	}
	setPolicy(overrides: PolicyOverrides): Promise<OperationResult<void>> {
		return this.#run(async () => {
			const checked = parse(policyOverridesSchema, overrides, 400, "Invalid workspace policy.");
			await this.#requireSnapshot();
			await this.ctx.storage.put("policy", checked);
			this.#policyCache = undefined;
		});
	}
	setUrl(slug: string, url: string): Promise<OperationResult<void>> {
		return this.#run(async () => {
			this.#descriptor = undefined;
			await this.#directory.setUrl(slug, tenantUrl(url));
		});
	}
	provision(input: TenantInput, key: string, url: string): Promise<OperationResult<CreatedTenant>> {
		return this.#run(async () => {
			const checked = tenantInput(input);
			const origin = tenantUrl(url);
			await this.#directory.reserve(checked.slug, origin);
			const release = await this.#service(origin).provision(requestKey(key), this.env.DEFAULT_RELEASE);
			const snapshot = await this.#requireSnapshot();
			const descriptor = { ...checked, url: origin, createdAt: snapshot.createdAt };
			await this.#directory.register(descriptor);
			this.#descriptor = descriptor;
			return { slug: checked.slug, url: origin, release };
		});
	}
	database(slug: string, action: DatabaseAction): Promise<OperationResult<DatabasePage>> {
		return this.#run(async () => this.#service((await this.#describe(slug)).url).database(action));
	}
	upgrade(slug: string, release: string): Promise<OperationResult<string>> {
		return this.#run(async () =>
			this.#service((await this.#describe(slug)).url).upgrade(requireRelease(release)),
		);
	}
	configure(environment: Record<string, string>): Promise<OperationResult<void>> {
		return this.#run(async () => {
			const checked = environmentOverrides(environment);
			await this.#requireSnapshot();
			const secrets = await this.ctx.storage.get<TenantSecrets>("secrets");
			if (!secrets) throw new HttpError(503, "Workspace keys are unavailable.");
			await this.ctx.storage.put("secrets", { ...secrets, environment: checked });
		});
	}

	override async fetch(request: Request): Promise<Response> {
		const trace = new RequestTrace();
		const response = await this.#http(request, trace).catch(errorResponse);
		const report = trace.report();
		console.log(
			JSON.stringify({
				trace: { path: new URL(request.url).pathname, status: response.status, ...report },
				memory: this.#runtime.memory?.(),
			}),
		);
		if (!this.env.PLATFORM_TRACE) return response;
		const traced = new Response(response.body, response);
		traced.headers.set("x-platform-trace", JSON.stringify(report));
		return traced;
	}
	async #http(request: Request, trace: RequestTrace): Promise<Response> {
		const url = new URL(request.url);
		const slug = request.headers.get("x-platform-slug");
		if (!slug) throw new HttpError(400, "Workspace is missing.");
		if (reservedPath(url.pathname)) throw new HttpError(404, "Not found.");
		const origin = await this.#requestOrigin(slug, url);
		const policy = await this.#policy();
		if (policy.suspended) throw new HttpError(503, "This workspace is suspended.");
		const read = request.method === "GET" || request.method === "HEAD";
		if (read && this.#publicPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
			return this.#publicFile(request, url.pathname);
		this.#touch();
		return this.#queue.run(() =>
			this.#withCollection(() =>
				trace.span("queueMs", async () => {
					const service = this.#service(origin);
					await this.#runtime.prepareInstance?.(service);
					const input = await toHttpInput(request, policy.maxRequestMiB * MIB);
					const output = await trace.span("phpMs", () => service.http(input));
					return toResponse(
						output,
						request.method,
						new TenantBlocks(this.#state),
						output.file ? this.#state.lease(output.file) : undefined,
					);
				}),
			),
		);
	}
	// Uploads stream from the committed manifest without entering PHP or the queue.
	async #publicFile(request: Request, pathname: string): Promise<Response> {
		let path: string;
		try {
			path = PUBLIC_ROOT + decodeURIComponent(pathname);
		} catch {
			throw new HttpError(400, "Invalid file path.");
		}
		if (!persistentPath(path, this.#runtime.application.storageDirectories))
			throw new HttpError(404, "File not found.");
		const snapshot = await this.#snapshot();
		const file =
			snapshot && isFileManifest(snapshot.bytes) ? decodeFiles(snapshot.bytes).files[path] : undefined;
		if (!file) throw new HttpError(404, "File not found.");
		if (this.#streams >= MAX_CONCURRENT_STREAMS) throw new HttpError(503, "Too many concurrent downloads.");
		const release = this.#state.lease(file);
		this.#streams++;
		await this.#wake();
		return fileResponse(file, new TenantBlocks(this.#state), request, path, () => {
			this.#streams--;
			release();
		});
	}

	async #wake(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 3600000);
	}
	override async alarm(): Promise<void> {
		await this.#queue.run(async () => {
			this.#state.collect();
			if (this.#state.needsCollection()) await this.ctx.storage.setAlarm(Date.now() + 3600000);
		});
	}

	async #withCollection<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} finally {
			if (this.#state.needsCollection()) await this.#wake();
		}
	}
	#run<T>(work: () => Promise<T>): Promise<OperationResult<T>> {
		return this.#queue.run(() => operation(() => this.#withCollection(work)));
	}
	get #directory(): TenantDirectory {
		if (!this.env.DIRECTORY) throw new HttpError(503, "Hosted directory is unavailable.");
		return new TenantDirectory(this.env.DIRECTORY);
	}

	#snapshot(): Promise<Snapshot | null> {
		this.#committed ??= Promise.resolve(this.#state.snapshot());
		return this.#committed;
	}
	async #requireSnapshot(): Promise<Snapshot> {
		const snapshot = await this.#snapshot();
		if (!snapshot) throw new HttpError(404, "Workspace not found.");
		return snapshot;
	}
	async #policy(): Promise<TenantPolicy> {
		this.#policyCache ??= effectivePolicy(
			this.env.TENANT_DEFAULTS,
			await this.ctx.storage.get<PolicyOverrides>("policy"),
		);
		return this.#policyCache;
	}
	/** Records activity at most once a minute; the write never blocks the response. */
	#touch(): void {
		const now = Date.now();
		if (now - this.#lastActivity < ACTIVITY_INTERVAL) return;
		this.#lastActivity = now;
		void this.ctx.storage.put("lastActivity", now, { allowUnconfirmed: true });
	}
	async #describe(slug?: string): Promise<TenantDescriptor> {
		if (this.#descriptor && (!slug || this.#descriptor.slug === slug)) return this.#descriptor;
		if (!slug) throw new HttpError(404, "Not found.");
		this.#descriptor = await this.#directory.get(slug);
		return this.#descriptor;
	}
	async #requestOrigin(slug: string, url: URL): Promise<string> {
		if (this.#runtime.requestOrigin) return this.#runtime.requestOrigin(slug, url);
		const origin = (await this.#describe(slug)).url;
		if (url.origin !== origin) throw new HttpError(404, "Not found.");
		return origin;
	}
	#resolveRelease(name: string): Promise<Release> {
		return this.#runtime.resolveRelease?.(name) ?? getRelease(this.env.ASSETS, name);
	}
	#service(origin: string): TenantService {
		const { application } = this.#runtime;
		return new TenantService(
			{
				createSecrets: application.createSecrets,
				policy: () => this.#policy(),
				environment: () =>
					(this.#workerEnvironment ??= workerEnvironment(this.env, application.environmentBinding)),
				read: () => this.#snapshot(),
				readEphemeral: async () => this.#state.ephemeral(),
				commit: async (value, previous, ephemeral) => {
					this.#committed = undefined;
					const snapshot = this.#state.commit(value, previous, ephemeral);
					this.#committed = Promise.resolve(snapshot);
				},
				getSecrets: () => this.ctx.storage.get<TenantSecrets>("secrets"),
				putSecrets: (value) => this.ctx.storage.put("secrets", value),
				release: (name) => this.#resolveRelease(name),
				run: async (release, input) => {
					using blocks = new TenantBlocks(this.#state);
					await this.ctx.storage.sync();
					return parseRuntimeOutput(await this.#runtime.execute(release, input, blocks));
				},
			},
			origin,
		);
	}
}
