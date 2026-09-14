import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => ({
	requestKey: crypto.randomUUID(),
	cursor: url.searchParams.get("cursor"),
});
