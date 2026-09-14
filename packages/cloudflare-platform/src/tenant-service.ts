import { createSecrets, digestText, sameBytes } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { environmentOverrides } from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { databaseAction, databaseResponse } from "./database";
import { compareVersions } from "./versions";
import { MIB } from "./policy";
import {
	databaseBytes,
	decodeFiles,
	isFileManifest,
	storageBytes,
	MAX_MANIFEST_BYTES,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type {
	DatabaseAction,
	DatabasePage,
	HttpInput,
	HttpOutput,
	Release,
	RuntimeCommand,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { Snapshot, TenantDependencies, TenantSecrets } from "./types";

export class TenantService {
	constructor(
		private readonly deps: TenantDependencies,
		private readonly origin: string,
	) {}

	async provision(key: string, releaseName: string): Promise<string> {
		const creationKey = await digestText(key);
		const [previous, stored] = await Promise.all([this.deps.read(), this.deps.getSecrets()]);
		if (stored && stored.creationKey !== creationKey)
			throw new HttpError(409, "This workspace address is already reserved.");
		if (previous) {
			if (!stored) throw new HttpError(503, "Workspace keys are unavailable.");
			return previous.release;
		}
		const release = await this.deps.release(releaseName);
		let secrets = stored;
		if (!secrets) {
			secrets = await (this.deps.createSecrets ?? createSecrets)(creationKey);
			await this.deps.putSecrets(secrets);
		}
		// A new instance starts from an empty database; the application's setup runs its migrations.
		await this.execute({ kind: "initialize" }, new ArrayBuffer(0), release, secrets, null);
		return release.name;
	}

	async http(request: HttpInput): Promise<HttpOutput> {
		const previous = await this.requireSnapshot();
		const [release, secrets] = await Promise.all([
			this.deps.release(previous.release),
			this.requireSecrets(),
		]);
		return this.execute({ kind: "http", request }, previous.bytes, release, secrets, previous);
	}

	async upgrade(target: string): Promise<string> {
		const previous = await this.requireSnapshot();
		const release = await this.deps.release(target);
		if (release.name === previous.release) return previous.release;
		const [current, secrets] = await Promise.all([
			this.deps.release(previous.release),
			this.requireSecrets(),
		]);
		if (compareVersions(release.version, current.version) < 0)
			throw new HttpError(409, "Downgrades are unsupported; reverse migrations are not safe.");
		await this.execute({ kind: "migrate" }, previous.bytes, release, secrets, previous);
		return release.name;
	}

	async database(action: DatabaseAction): Promise<DatabasePage> {
		const checked = databaseAction(action);
		const previous = await this.requireSnapshot();
		const [release, secrets] = await Promise.all([
			this.deps.release(previous.release),
			this.requireSecrets(),
		]);
		return databaseResponse(
			await this.execute({ kind: "database", action: checked }, previous.bytes, release, secrets, previous),
		);
	}

	private async requireSnapshot(): Promise<Snapshot> {
		const previous = await this.deps.read();
		if (!previous) throw new HttpError(404, "Workspace not found.");
		return previous;
	}

	private async requireSecrets(): Promise<TenantSecrets> {
		const secrets = await this.deps.getSecrets();
		if (!secrets) throw new HttpError(503, "Workspace keys are unavailable.");
		return secrets;
	}

	private async execute(
		command: RuntimeCommand,
		database: ArrayBuffer,
		release: Release,
		secrets: TenantSecrets,
		previous: Snapshot | null,
	): Promise<HttpOutput> {
		const [policy, ephemeral] = await Promise.all([this.deps.policy(), this.deps.readEphemeral()]);
		if (database.byteLength > MAX_MANIFEST_BYTES)
			throw new HttpError(413, "Workspace state exceeds the file index capacity.");
		const environment = environmentOverrides({ ...this.deps.environment(), ...secrets.environment });
		// In-process WASM must not mutate the committed baseline.
		const output = await this.deps.run(release, {
			command,
			requestLimitBytes: policy.maxRequestMiB * MIB,
			database: database.slice(0),
			ephemeral,
			secrets,
			environment,
			origin: this.origin,
		});
		if (output.database.byteLength > MAX_MANIFEST_BYTES)
			throw new HttpError(413, "Workspace state exceeds the file index capacity.");
		if (output.response.status >= 500)
			throw new HttpError(502, "The application could not complete this request.");

		// Editor conflicts must abort before committing runtime state.
		if (command.kind === "database") {
			databaseResponse(output.response);
			if (command.action.kind === "inspect") return output.response;
		}
		const manifest = isFileManifest(output.database) ? decodeFiles(output.database) : output.database;
		if (
			databaseBytes(manifest) > policy.maxDatabaseMiB * MIB ||
			storageBytes(manifest) > policy.maxStorageMiB * MIB
		)
			throw new HttpError(413, "Workspace storage allowance exceeded. Increase the limit or remove data.");
		const changed = !previous || previous.release !== release.name || !sameBytes(database, output.database);
		await this.deps.commit(
			changed
				? {
						bytes: output.database,
						release: release.name,
						revision: (previous?.revision ?? 0) + 1,
						createdAt: previous?.createdAt ?? new Date().toISOString(),
					}
				: null,
			previous,
			output.ephemeral,
		);

		return output.response;
	}
}
