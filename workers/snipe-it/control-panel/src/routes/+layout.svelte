<script lang="ts">
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<main>{@render children()}</main>

<style>
	:global(body) { margin: 0; color: #20302b; background: #f5f6f4; font-family: system-ui, sans-serif; }
	:global(*) { box-sizing: border-box; }
	main { max-width: 1280px; margin: 44px auto; padding: 0 24px 60px; }
	:global(h1) { font-size: 32px; letter-spacing: -1px; }
	:global(p) { line-height: 1.6; }
	:global(a) { color: #206c53; }
	:global(form) { display: grid; gap: 20px; }
	:global(label) { display: grid; gap: 8px; font-size: 14px; font-weight: 600; }
	:global(input), :global(textarea), :global(select) { width: 100%; padding: 12px; border: 1px solid #aebbb5; border-radius: 5px; font: inherit; background: white; }
	:global(:is(input, textarea, select):focus) { outline: 2px solid #207357; outline-offset: 2px; }
	:global(small) { font-weight: 400; color: #60716b; }
	:global(button) { padding: 12px 18px; border: 0; border-radius: 5px; background: #206c53; color: white; font: 600 15px system-ui; cursor: pointer; }
	:global(button:disabled) { opacity: .6; cursor: wait; }
	:global(table) { width: 100%; border-collapse: collapse; background: white; text-align: left; font-size: 14px; }
	:global(th), :global(td) { padding: 14px; border-bottom: 1px solid #dce2dd; }
	:global(th) { background: #edf1ed; }
	:global(.scroll) { overflow-x: auto; }
	:global(.actions) { display: flex; flex-wrap: wrap; gap: 20px; align-items: center; margin: 24px 0; }
	:global([role='alert']) { color: #9b3024; }
	:global([role='status']) { color: #206c53; }
</style>
