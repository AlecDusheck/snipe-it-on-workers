import assert from "node:assert/strict";
import { Browser, csrf } from "./browser";

export const admin = { username: "admin@example.test", password: "test-only-long-password" };
export const adminForm = (token: string, name = "WASM Inventory") => ({
	_token: token,
	site_name: name,
	first_name: "Test",
	last_name: "Admin",
	username: admin.username,
	email: admin.username,
	password: admin.password,
	password_confirmation: admin.password,
	locale: "en-US",
	default_currency: "USD",
});
export async function completeSetup(browser: Browser, name = "WASM Inventory"): Promise<void> {
	const page = await browser.visit("/setup");
	assert.equal(page.status, 200, page.body.slice(0, 1000));
	const migrated = await browser.visit("/setup/migrate", { form: { _token: csrf(page.body) } });
	assert.equal(migrated.status, 200, migrated.body.slice(0, 1000));
	const form = await browser.visit("/setup/user");
	assert.equal(form.status, 200, form.body.slice(0, 1000));
	const created = await browser.visit("/setup/user", { form: adminForm(csrf(form.body), name) });
	assert.equal(created.status, 302, created.body);
	assert.ok(created.headers.location?.endsWith("/setup/done"), created.headers.location);
	const dashboard = await browser.visit("/");
	assert.equal(dashboard.status, 200, dashboard.body.slice(0, 1000));
}
