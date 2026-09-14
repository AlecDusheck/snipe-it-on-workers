import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantPolicy, effectivePolicy, jobsPausedReason } from "../src/policy";

for (const value of [
	null,
	[],
	{ maxBackups: 0 },
	{ maxStorageMiB: -1 },
	{ maxDatabaseMiB: 1.1 },
	{ suspended: "true" },
	{ pauseJobsAfterInactiveDays: 0 },
	{ backupRetentionDays: 0 },
	{ unknown: 1 },
])
	test(`invalid tenant policy ${JSON.stringify(value)}`, () =>
		assert.throws(() => tenantPolicy(value), { status: 400 }));
test("deployment policy defaults merge with tenant overrides without dropping other limits", () => {
	const policy = effectivePolicy({ maxStorageMiB: 500, maxDatabaseMiB: 14 }, { suspended: true });
	assert.equal(policy.maxStorageMiB, 500);
	assert.equal(policy.maxDatabaseMiB, 14);
	assert.equal(policy.suspended, true);
	assert.equal(policy.scheduledJobsEnabled, true);
});
test("invalid deployment defaults fail closed", () => {
	for (const value of ["{}", [], null, { maxBackups: -1 }])
		assert.throws(() => effectivePolicy(value), { status: 503 });
});
test("inactivity pauses at the exact boundary and traffic resumes eligible scheduled jobs", () => {
	const policy = tenantPolicy({ pauseJobsAfterInactiveDays: 7 });
	const week = 7 * 86400000;
	assert.equal(jobsPausedReason(policy, 0, week - 1), null);
	assert.equal(jobsPausedReason(policy, 0, week), "inactive");
	assert.equal(jobsPausedReason(policy, week, week + 1), null);
});
test("manual pauses and suspension remain in force even after new traffic", () => {
	assert.equal(jobsPausedReason(tenantPolicy({ suspended: true }), 100, 100), "suspended");
	assert.equal(jobsPausedReason(tenantPolicy({ scheduledJobsEnabled: false }), 100, 100), "manual");
	assert.equal(jobsPausedReason(tenantPolicy({}), 0, 1000000000000), null);
});
