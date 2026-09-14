import type {
	Release,
	RuntimeInput,
	RuntimeOutput,
	RuntimeSecrets,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { JobsPausedReason, TenantPolicy } from "./policy";

export interface TenantInput {
	slug: string;
	name: string;
}

export interface TenantSecrets extends RuntimeSecrets {
	creationKey: string;
	environment?: Record<string, string>;
}

export interface ReleaseSummary {
	name: string;
	version: string;
	phpVersion: string | null;
}
export interface TenantDetails {
	slug: string;
	url: string;
	release: ReleaseSummary;
	revision: number;
	databaseBytes: number;
	createdAt: string;
	policy: TenantPolicy;
	lastActivityAt: string;
	jobsPausedReason: JobsPausedReason;
}

export interface Snapshot extends SnapshotWrite {
	etag: string;
}

export interface TenantDescriptor {
	url: string;
	slug: string;
	name: string;
	createdAt: string;
}
export interface TenantPage {
	tenants: TenantDescriptor[];
	cursor: string | null;
}

export interface SnapshotWrite {
	bytes: ArrayBuffer;
	release: string;
	revision: number;
	createdAt: string;
}

export interface TenantDependencies {
	createSecrets?: ((creationKey: string) => Promise<TenantSecrets>) | undefined;
	policy(): Promise<TenantPolicy>;
	/** Deployment-level application environment: Worker vars and secrets. */
	environment(): Record<string, string>;
	read(): Promise<Snapshot | null>;
	readEphemeral(): Promise<ArrayBuffer>;
	commit(value: SnapshotWrite | null, previous: Snapshot | null, ephemeral: ArrayBuffer): Promise<void>;
	getSecrets(): Promise<TenantSecrets | undefined>;
	putSecrets(value: TenantSecrets): Promise<void>;
	release(name: string): Promise<Release>;
	run(release: Release, input: RuntimeInput): Promise<RuntimeOutput>;
}

export interface CreatedTenant {
	slug: string;
	url: string;
	release: string;
}
export type OperationResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
