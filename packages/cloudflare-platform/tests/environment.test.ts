import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEnvironment } from "../src/environment";

test("native JSON defaults and individual Worker secrets merge without forwarding bindings", () => {
	assert.deepEqual(
		workerEnvironment({
			APPLICATION_ENV: { MAIL_HOST: "smtp.example", MAIL_USERNAME: "default" },
			MAIL_USERNAME: "override",
			MAIL_PASSWORD: "secret",
			EMPTY: "",
			ASSETS: { fetch: () => {} },
			DIRECTORY: {},
			APP_URL: "https://inventory.example",
			DEFAULT_RELEASE: "current",
			TENANT_DEFAULTS: {},
			RUNTIME_LIMITS: {},
		}),
		{ MAIL_HOST: "smtp.example", MAIL_USERNAME: "override", MAIL_PASSWORD: "secret", EMPTY: "" },
	);
});
