<script lang="ts">
	import { getWorkspace, savePolicy, changeUrl } from '$lib/workspaces.remote';
	import { getReleases, upgradeWorkspace } from '$lib/releases.remote';
	import FormStatus from '$lib/FormStatus.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const workspace = $derived(await getWorkspace(data.slug));
	const releases = $derived(await getReleases());
</script>

<svelte:head><title>{data.slug} · Snipe-IT Workspaces</title></svelte:head>
<a href="/">← All workspaces</a>
<h1>{data.slug}</h1>
<div class="actions"><a href={workspace.url} target="_blank" rel="noreferrer">Open Snipe-IT ↗</a><a href={`/tenants/${data.slug}/database`}>View and edit database</a></div>
<dl>
	<dt>Snipe-IT</dt><dd>{workspace.release.version}</dd>
	<dt>PHP</dt><dd>{workspace.release.phpVersion ?? 'Not recorded for this build'}</dd>
	<dt>Database</dt><dd>{(workspace.databaseBytes / 1048576).toFixed(2)} MiB · revision {workspace.revision}</dd>
	<dt>Created</dt><dd>{workspace.createdAt.slice(0, 10)}</dd>
	<dt>Status</dt><dd>{workspace.policy.suspended ? 'Suspended' : 'Running'}</dd>
	<dt>Last activity</dt><dd>{workspace.lastActivityAt}</dd>
	<dt>Scheduled jobs</dt><dd>{workspace.jobsPausedReason ? `Paused: ${workspace.jobsPausedReason}` : 'Enabled'}</dd>
</dl>
<section>
	<h2>Workspace URL</h2>
	<form {...changeUrl}>
		<input {...changeUrl.fields.slug.as('hidden', data.slug)} />
		<label>URL<input {...changeUrl.fields.url.as('url', workspace.url)} required /><small>The hostname must route to your backplane Worker in Cloudflare.</small></label>
		<button type="submit" disabled={!!changeUrl.pending}>Save URL</button>
		<FormStatus issues={changeUrl.fields.allIssues()} message={changeUrl.result?.message} />
	</form>
</section>
<section>
	<h2>Limits and operation</h2>
	<form {...savePolicy}>
		<input {...savePolicy.fields.slug.as('hidden', data.slug)} />
		<label class="toggle"><input {...savePolicy.fields.suspended.as('checkbox', workspace.policy.suspended)} /> Suspend this instance</label>
		<label class="toggle"><input {...savePolicy.fields.scheduledJobsEnabled.as('checkbox', workspace.policy.scheduledJobsEnabled)} /> Enable scheduled jobs</label>
		<label>Pause scheduled jobs after inactive days<input {...savePolicy.fields.pauseJobsAfterInactiveDays.as('text', workspace.policy.pauseJobsAfterInactiveDays?.toString() ?? '')} inputmode="numeric" placeholder="Never" /><small>Leave empty to keep running. New traffic resumes jobs paused for inactivity.</small></label>
		<label>Maximum request size (MiB)<input {...savePolicy.fields.maxRequestMiB.as('number', workspace.policy.maxRequestMiB)} min="1" max="32" required /></label>
		<label>Database allowance (MiB)<input {...savePolicy.fields.maxDatabaseMiB.as('number', workspace.policy.maxDatabaseMiB)} min="1" required /></label>
		<label>Total instance storage (MiB)<input {...savePolicy.fields.maxStorageMiB.as('number', workspace.policy.maxStorageMiB)} min="1" required /></label>
		<button type="submit" disabled={!!savePolicy.pending}>Save settings</button>
		<FormStatus issues={savePolicy.fields.allIssues()} message={savePolicy.result?.message} />
	</form>
</section>
<section>
	<h2>Update Snipe-IT</h2>
	<p>Each release includes its PHP runtime. An update runs the release’s database migrations and activates it when the save succeeds. Failed updates preserve the current state.</p>
	<form {...upgradeWorkspace}>
		<input {...upgradeWorkspace.fields.slug.as('hidden', data.slug)} />
		<label>Release<select {...upgradeWorkspace.fields.release.as('select', workspace.release.name)} required>
			{#if !releases.some((release) => release.name === workspace.release.name)}<option value={workspace.release.name}>{workspace.release.version} · current</option>{/if}
			{#each releases as release}<option value={release.name}>{release.version} · PHP {release.phpVersion ?? 'unrecorded'}{release.name === workspace.release.name ? ' · current' : ''}</option>{/each}
		</select></label>
		<button type="submit" disabled={!!upgradeWorkspace.pending}>{upgradeWorkspace.pending ? 'Updating workspace…' : 'Apply release'}</button>
		<FormStatus issues={upgradeWorkspace.fields.allIssues()} message={upgradeWorkspace.result?.message} />
	</form>
</section>

<style>
	dl { display: grid; grid-template-columns: 120px 1fr; gap: 14px; }
	dt { color: #60716b; }
	dd { margin: 0; }
	section { max-width: 560px; margin-top: 44px; }
	.toggle { display: flex; flex-direction: row; align-items: center; gap: 10px; }
	.toggle input { width: auto; }
</style>
