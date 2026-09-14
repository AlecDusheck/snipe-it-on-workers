import { form, query } from "$app/server";
import * as v from "valibot";
import { backplane, unwrap, unwrapForm, workspaceUrl } from "$lib/server/backplane";
import {
	originSchema,
	slugSchema,
	tenantInputSchema,
} from "@simplyalec/laravel-cf-workers-cloudflare-platform/validation";
import { policyObjectSchema } from "@simplyalec/laravel-cf-workers-cloudflare-platform/policy";

export const getWorkspace = query(slugSchema, async (slug) => unwrap(await backplane().getTenant(slug)));

export const listWorkspaces = query(v.nullable(v.pipe(v.string(), v.maxLength(4096))), async (cursor) =>
	unwrap(await backplane().listTenants(cursor)),
);

export const createWorkspace = form(
	v.object({
		name: v.message(tenantInputSchema.entries.name, "Enter a workspace name of 1–100 characters."),
		slug: v.message(
			slugSchema,
			"Use 3–40 lowercase letters, numbers or hyphens. Reserved addresses are unavailable.",
		),
		requestKey: v.pipe(v.string(), v.uuid()),
	}),
	async ({ name, slug, requestKey }) => {
		const created = unwrapForm(
			await backplane().createTenant({ name, slug }, requestKey, workspaceUrl(slug)),
		);
		await listWorkspaces(null).refresh();
		return { url: `${created.url}/setup` };
	},
);

export const savePolicy = form(
	v.object({
		slug: slugSchema,
		...policyObjectSchema.entries,
		// Unchecked native checkboxes are absent; the provisioning default is true.
		scheduledJobsEnabled: v.optional(v.boolean(), false),
		pauseJobsAfterInactiveDays: v.pipe(
			v.string(),
			v.transform((value) => (value.trim() === "" ? null : Number(value))),
			v.unwrap(policyObjectSchema.entries.pauseJobsAfterInactiveDays),
		),
	}),
	async ({ slug, ...policy }) => {
		unwrapForm(await backplane().setTenantPolicy(slug, policy));
		await getWorkspace(slug).refresh();
		return { message: "Workspace limits and job settings saved." };
	},
);

export const changeUrl = form(v.object({ slug: slugSchema, url: originSchema }), async ({ slug, url }) => {
	unwrapForm(await backplane().setTenantUrl(slug, url));
	await Promise.all([getWorkspace(slug).refresh(), listWorkspaces(null).refresh()]);
	return { message: "Workspace URL updated." };
});
