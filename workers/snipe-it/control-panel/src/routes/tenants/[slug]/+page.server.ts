import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { slugValid } from "@simplyalec/laravel-cf-workers-cloudflare-platform/validation";

export const load: PageServerLoad = ({ params }) => {
	if (!slugValid(params.slug)) error(404, "Workspace not found.");
	return { slug: params.slug };
};
