<script lang="ts">
	import type { RemoteFormIssue } from '@sveltejs/kit';
	let { issues, message }: { issues: RemoteFormIssue[] | undefined; message?: string | undefined } = $props();
</script>

{#if issues}<ul role="alert">{#each issues as issue (issue)}<li>{issue.message}</li>{/each}</ul>{/if}
{#if message}<p role="status">{message}</p>{/if}
