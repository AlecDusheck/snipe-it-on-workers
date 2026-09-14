import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/versions";

for (const [left, right, expected] of [
	["v8.7.2", "8.7.2", 0],
	["v9.0.0", "v8.7.2", 1],
	["v8.10.0", "v8.9.0", 1],
	["v8.7.1", "v8.7.2", -1],
])
	test(`${left} compared with ${right}`, () => {
		if (typeof left !== "string" || typeof right !== "string") throw new Error("Invalid test case");
		assert.equal(compareVersions(left, right), expected);
	});
for (const version of ["v9", "9.0.0-rc1", "9.0.0+custom", "9.0.0.1", "999999999999999999.0.0"])
	test(`ambiguous version ${version} is rejected`, () =>
		assert.throws(() => compareVersions(version, "8.7.2")));
