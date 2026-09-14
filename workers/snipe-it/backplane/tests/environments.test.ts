import { test } from "node:test";
import assert from "node:assert/strict";
import { unstable_readConfig } from "wrangler";
import type { Unstable_Config } from "wrangler";

for (const environment of ["development", "production"]) {
	test(`Wrangler resolves isolated resources and the matching RPC target for ${environment}`, () => {
		const read = (config: string): Unstable_Config => unstable_readConfig({ config, env: environment });
		const backplane = read("workers/snipe-it/backplane/wrangler.jsonc");
		const panel = read("workers/snipe-it/control-panel/wrangler.jsonc");
		const suffix = `-${environment}`;
		assert.equal(backplane.name, `snipe-it-backplane${suffix}`);
		assert.equal(panel.name, `snipe-it-control-panel${suffix}`);
		assert.deepEqual(panel.services, [
			{ binding: "BACKPLANE", service: backplane.name, entrypoint: "BackplaneControl" },
		]);
		assert.deepEqual(backplane.kv_namespaces, [{ binding: "DIRECTORY", id: `snipe-it-directory${suffix}` }]);
		assert.deepEqual(backplane.d1_databases, []);
		assert.deepEqual(backplane.r2_buckets, []);
		assert.deepEqual(backplane.worker_loaders, [{ binding: "LOADER" }]);
		assert.deepEqual(backplane.durable_objects.bindings, [{ name: "TENANTS", class_name: "Tenant" }]);
		assert.deepEqual(backplane.migrations, [{ tag: "v1", new_sqlite_classes: ["Tenant"] }]);
		assert.equal(backplane.assets?.binding, "ASSETS");
		for (const key of ["SNIPEIT_ENV", "TENANT_DEFAULTS", "RUNTIME_LIMITS"])
			assert.equal(typeof backplane.vars[key], "object");
		assert.equal(Object.hasOwn(backplane.vars, "PLATFORM_ORIGIN"), false);
	});
}

test("standalone deploys without selecting an environment or provisioning hosted resources", () => {
	const standalone = unstable_readConfig({ config: "wrangler.jsonc", env: "" });
	assert.equal(standalone.name, "snipe-it");
	assert.deepEqual(standalone.r2_buckets, []);
	assert.deepEqual(standalone.d1_databases, []);
	assert.deepEqual(standalone.kv_namespaces, []);
	assert.deepEqual(standalone.services ?? [], []);
	assert.deepEqual(standalone.worker_loaders, []);
	assert.deepEqual(standalone.durable_objects.bindings, [{ name: "SNIPEIT", class_name: "SnipeIT" }]);
	assert.deepEqual(standalone.migrations, [{ tag: "v1", new_sqlite_classes: ["SnipeIT"] }]);
	assert.equal(standalone.assets?.binding, "ASSETS");
	assert.equal(standalone.vars["DEFAULT_RELEASE"], "snipeit-8.7.2");
	assert.equal(standalone.vars["APP_URL"], "");
});

for (const worker of ["backplane", "control-panel"]) {
	test(`${worker} has no default environment resources or vars`, () => {
		const config = unstable_readConfig({ config: `workers/snipe-it/${worker}/wrangler.jsonc`, env: "" });
		assert.deepEqual(config.vars, {});
		assert.deepEqual(config.durable_objects.bindings, []);
		assert.deepEqual(config.r2_buckets, []);
		assert.deepEqual(config.d1_databases, []);
		assert.deepEqual(config.kv_namespaces, []);
		assert.deepEqual(config.services ?? [], []);
		assert.deepEqual(config.worker_loaders, []);
	});
}
