import { test } from "node:test";
import assert from "node:assert/strict";
import {
	environmentOverrides,
	deploymentEnvironment,
	runtimeEnvironment,
	environmentIdentity,
} from "../src/environment";

const input = {
	origin: "https://acme.example",
	command: { kind: "migrate" },
	database: new ArrayBuffer(0),
	ephemeral: new ArrayBuffer(0),
	secrets: { appKey: "test-key", files: {} },
} satisfies import("../src/types").RuntimeInput;

test("arbitrary Laravel environment settings preserve exact string values", () => {
	const env = {
		MAIL_HOST: "smtp.example",
		MAIL_PASSWORD: "quotes'\" dollars$ and\nnewlines",
		APP_TIMEZONE: "America/Chicago",
		EMPTY: "",
	};
	assert.deepEqual(environmentOverrides(env), env);
	assert.deepEqual(deploymentEnvironment(env), env);
});
test("deployment defaults are empty and invalid configuration fails clearly", () => {
	assert.deepEqual(deploymentEnvironment(undefined), {});
	for (const value of ["{}", [], null, { APP_KEY: "wrong" }])
		assert.throws(() => deploymentEnvironment(value), { status: 503 });
});
for (const value of [
	null,
	[],
	{ bad: "key" },
	{ MAIL_PORT: 25 },
	{ MAIL_HOST: "nul\0" },
	{ LONG: "x".repeat(33 * 1024) },
])
	test(`invalid env rejected: ${JSON.stringify(value).slice(0, 70)}`, () =>
		assert.throws(() => environmentOverrides(value), { status: 400 }));
for (const key of ["APP_KEY", "APP_URL", "DB_CONNECTION", "DB_DATABASE", "CACHE_DRIVER", "SESSION_DRIVER"])
	test(`managed ${key} cannot bypass persistence`, () =>
		assert.throws(() => environmentOverrides({ [key]: "wrong" }), { status: 400 }));
test("effective runtime settings include overrides and managed tenant identity", () => {
	const env = runtimeEnvironment({
		...input,
		environment: { APP_TIMEZONE: "Europe/London", APP_DEBUG: "true", SESSION_LIFETIME: "60" },
	});
	assert.equal(env.APP_TIMEZONE, "Europe/London");
	assert.equal(env.SESSION_LIFETIME, "60");
	assert.equal(env.APP_KEY, "test-key");
	assert.equal(env.DB_CONNECTION, "sqlite");
	assert.equal(env.APP_DEBUG, "true");
});
test("equivalent environment maps use the same dynamic Worker identity", () =>
	assert.equal(environmentIdentity({ A: "1", B: "2" }), environmentIdentity({ B: "2", A: "1" })));
