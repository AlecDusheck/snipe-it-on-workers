<script lang="ts">
	import { getDatabase, saveRow } from '$lib/database.remote';
	import FormStatus from '$lib/FormStatus.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const database = $derived(await getDatabase({ slug: data.slug, table: data.table, offset: data.offset }));
	const selected = $derived(database.rows[data.row]);
	const pageUrl = (offset: number, row = -1) => `?${new URLSearchParams({ table: database.table ?? '', offset: String(offset), row: String(row) })}`;
</script>

<svelte:head><title>{data.slug} database · Snipe-IT Workspaces</title></svelte:head>
<a href="/">← All workspaces</a>
<h1>{data.slug} database</h1>
<div class="actions"><a href={database.url} target="_blank" rel="noreferrer">Open Snipe-IT ↗</a><a href={pageUrl(data.offset)} data-sveltekit-reload>Reload rows</a></div>
<form method="GET" class="table-picker">
	<label>Table<select name="table" value={database.table ?? ''}>{#each database.tables as table}<option value={table}>{table}</option>{/each}</select></label>
	<button type="submit">View table</button>
</form>
<p>{database.table ?? 'No tables'} · {database.rows.length ? `Rows ${database.offset + 1}–${database.offset + database.rows.length}` : 'No rows'}</p>
<div class="scroll">
	<table><thead><tr><th scope="col">Edit</th>{#each database.columns as column}<th scope="col">{column.name}<small>{column.type}{column.primaryKey ? ' · key' : ''}</small></th>{/each}</tr></thead>
		<tbody>{#each database.rows as row, index}<tr><td>{#if row.editable}<a href={pageUrl(data.offset, index)}>Edit row</a>{:else}<small>Read-only</small>{/if}</td>{#each database.columns as column}<td><span class="cell" title={row.values[column.name] ?? 'NULL'}>{row.values[column.name] === null ? 'NULL' : row.values[column.name]}</span></td>{/each}</tr>{/each}</tbody>
	</table>
</div>
<nav class="actions" aria-label="Database pages">{#if data.offset > 0}<a href={pageUrl(Math.max(0, data.offset - 50))}>← Previous 50</a>{/if}{#if database.hasMore}<a href={pageUrl(data.offset + 50)}>Next 50 →</a>{/if}</nav>

{#if selected?.editable && database.table}
	<section>
		<h2>Edit row</h2>
		<p>Use a JSON object with every column. Values are strings or <code>null</code>; keep numbers in quotes. Saving changes the database directly, bypassing Snipe-IT’s form validation and activity log.</p>
		{#key `${data.slug}:${database.table}:${data.offset}:${data.row}`}
		<form {...saveRow}>
			<input {...saveRow.fields.slug.as('hidden', data.slug)} />
			<input {...saveRow.fields.table.as('hidden', database.table)} />
			<input {...saveRow.fields.offset.as('hidden', String(data.offset))} />
			<input {...saveRow.fields._original.as('hidden', JSON.stringify(selected.values))} />
			<label>Column values<textarea {...saveRow.fields._values.as('text')} value={saveRow.fields._values.value() ?? JSON.stringify(selected.values, null, 2)} rows="20" spellcheck={false} required></textarea></label>
			<button disabled={!!saveRow.pending} type="submit">{saveRow.pending ? 'Saving…' : 'Save row'}</button>
			<FormStatus issues={saveRow.fields.allIssues()} message={saveRow.result?.message} />
		</form>
		{/key}
	</section>
{/if}

<style>
	.table-picker { grid-template-columns: minmax(180px, 360px) auto; align-items: end; width: fit-content; }
	th small { display: block; white-space: nowrap; padding-top: 6px; }
	.cell { display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	section { max-width: 860px; margin-top: 36px; }
	textarea { font: 13px/1.6 ui-monospace, monospace; }
</style>
