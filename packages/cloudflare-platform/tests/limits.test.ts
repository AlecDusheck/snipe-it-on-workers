import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeLimits } from "../src/limits";

test("runtime limits have explicit defaults and accept partial overrides", () => {
	assert.deepEqual(runtimeLimits(undefined), {
		httpCpuMs: 60000,
		backgroundCpuMs: 60000,
		subRequests: 10000,
	});
	assert.deepEqual(runtimeLimits({ httpCpuMs: 5000, backgroundCpuMs: 60000 }), {
		httpCpuMs: 5000,
		backgroundCpuMs: 60000,
		subRequests: 10000,
	});
});
for (const value of [
	"invalid",
	"{}",
	[],
	null,
	{ memory: 256 },
	{ httpCpuMs: 0 },
	{ httpCpuMs: 300001 },
	{ backgroundCpuMs: "30000" },
	{ subRequests: 1.5 },
	{ subRequests: 10000001 },
])
	test(`invalid runtime limits fail before execution: ${value}`, () =>
		assert.throws(() => runtimeLimits(value), { status: 503 }));
