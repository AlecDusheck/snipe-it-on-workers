import { form, query } from "$app/server";
import * as v from "valibot";
import { backplane, unwrap, unwrapForm } from "$lib/server/backplane";
import { getWorkspace } from "./workspaces.remote";
import { releaseNameSchema, slugSchema } from "@simplyalec/laravel-cf-workers-cloudflare-platform/validation";

export const getReleases = query(async () => unwrap(await backplane().getReleases()));
export const upgradeWorkspace = form(
	v.object({ slug: slugSchema, release: releaseNameSchema }),
	async (input) => {
		unwrapForm(await backplane().upgradeTenant(input.slug, input.release));
		await getWorkspace(input.slug).refresh();
		return { message: "Release updated." };
	},
);
