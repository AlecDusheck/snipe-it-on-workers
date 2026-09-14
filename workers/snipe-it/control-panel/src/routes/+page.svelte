<script lang="ts">
	import { createWorkspace, listWorkspaces } from "$lib/workspaces.remote";
	import FormStatus from "$lib/FormStatus.svelte";
	import type { PageProps } from "./$types";
	let { data }: PageProps = $props();
	const directory = $derived(await listWorkspaces(data.cursor));
</script>

<svelte:head>
	<title>Snipe-IT Workspaces</title>
	<meta name="description" content="Create a Snipe-IT workspace for your team's asset inventory." />
</svelte:head>

<h1>Workspaces</h1>
<p>Your Snipe-IT inventories.</p>
{#if directory.tenants.length}
<div class="scroll"><table><thead><tr><th>Name</th><th>Address</th><th>Created</th><th>Manage</th></tr></thead>
<tbody>{#each directory.tenants as tenant}<tr><td>{tenant.name}</td><td><a href={tenant.url} target="_blank" rel="noreferrer">{tenant.slug} ↗</a></td><td>{tenant.createdAt.slice(0, 10)}</td><td><a href={`/tenants/${tenant.slug}`}>Manage</a> · <a href={`/tenants/${tenant.slug}/database`}>Database</a></td></tr>{/each}</tbody></table></div>
{:else}<p>No workspaces yet. Create the first one below.</p>{/if}
<nav class="actions" aria-label="Workspace pages">{#if data.cursor}<a href="/">First page</a>{/if}{#if directory.cursor}<a href={`/?cursor=${encodeURIComponent(directory.cursor)}`}>Next 50 →</a>{/if}</nav>
<section>
	<h1>Create your workspace</h1>
	<p>Reserve an address, then configure the instance in Snipe-IT’s setup wizard.</p>
	<form {...createWorkspace}>
		<input {...createWorkspace.fields.requestKey.as('hidden', data.requestKey)} />
		<label>Workspace name <input {...createWorkspace.fields.name.as('text')} required maxlength="100" autocomplete="organization" placeholder="Acme IT" /></label>
		<label>Workspace address <input {...createWorkspace.fields.slug.as('text')} required minlength="3" maxlength="40" autocapitalize="none" spellcheck={false} placeholder="acme" /><small>3–40 lowercase letters, numbers or hyphens.</small></label>
		<button disabled={!!createWorkspace.pending} type="submit">{createWorkspace.pending ? 'Creating workspace…' : 'Create workspace'}</button>
		<FormStatus issues={createWorkspace.fields.allIssues()} />
		{#if createWorkspace.result}
			<p class="message" role="status">Workspace created. <a href={createWorkspace.result.url}>Open your workspace →</a></p>
		{/if}
	</form>
</section>

<style>
 section { max-width: 540px; margin-top: 52px; }
 section p { margin-bottom: 26px; }
 .message { overflow-wrap: anywhere; }
</style>
