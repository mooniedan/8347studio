<script lang="ts">
  /**
   * Phase 8 follow-up — user-guide renderer.
   *
   * Fetches /docs/user-guide.md, renders it with `marked`, and lays
   * out a sticky TOC sidebar built from the h2/h3 headings. Mounts
   * in two places: full-page when the app is opened at `?docs=1`
   * (used as the non-PIP fallback), and inside a Document PIP
   * window via `lib/pip.ts`'s createDocsPipController.
   */
  import { onMount } from 'svelte';
  import { marked } from 'marked';

  let { sourceUrl = '/docs/user-guide.md' }: { sourceUrl?: string } = $props();

  let html = $state('');
  let toc = $state<{ id: string; text: string; level: number }[]>([]);
  let loading = $state(true);
  let loadError = $state<string | undefined>(undefined);

  onMount(async () => {
    try {
      const resp = await fetch(sourceUrl);
      if (!resp.ok) throw new Error(`fetch ${sourceUrl}: ${resp.status}`);
      const md = await resp.text();
      // Configure marked with stable heading ids so the TOC can
      // anchor to them. Renderer overrides slug each heading from
      // its text.
      const slug = (text: string) =>
        text
          .toLowerCase()
          .replace(/<[^>]+>/g, '')
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-');
      const renderer = new marked.Renderer();
      const builtToc: typeof toc = [];
      renderer.heading = ({ text, depth, tokens }) => {
        const plain = tokens
          .map((t) => ('text' in t ? (t as { text: string }).text : ''))
          .join('');
        const id = slug(plain || text);
        if (depth === 2 || depth === 3) {
          builtToc.push({ id, text: plain || text, level: depth });
        }
        return `<h${depth} id="${id}">${plain || text}</h${depth}>\n`;
      };
      html = await marked.parse(md, { renderer });
      toc = builtToc;
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  });
</script>

<div class="docs" data-testid="docs-panel">
  <aside class="toc" aria-label="Table of contents">
    <div class="toc-head">8347 Studio</div>
    {#if toc.length > 0}
      <nav>
        <ul>
          {#each toc as entry (entry.id)}
            <li class="lvl-{entry.level}">
              <a href="#{entry.id}" data-testid="toc-{entry.id}">{entry.text}</a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
  </aside>
  <main class="body">
    {#if loading}
      <p class="status" data-testid="docs-loading">Loading…</p>
    {:else if loadError}
      <p class="status error" data-testid="docs-error">
        Couldn't load the user guide: {loadError}
      </p>
    {:else}
      <article class="prose" data-testid="docs-content">{@html html}</article>
    {/if}
  </main>
</div>

<style>
  .docs {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: var(--sp-4);
    width: 100%;
    height: 100%;
    background: var(--bg-1);
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: var(--text-12);
  }
  .toc {
    background: var(--bg-2);
    border-right: 1px solid var(--line-1);
    padding: var(--sp-4) var(--sp-3);
    overflow-y: auto;
    position: sticky;
    top: 0;
    height: 100vh;
  }
  .toc-head {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--sp-4);
  }
  .toc nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .toc li.lvl-3 { padding-left: var(--sp-3); }
  .toc a {
    color: var(--fg-2);
    text-decoration: none;
    font-size: var(--text-11);
    line-height: 1.5;
    display: block;
    padding: 2px 4px;
    border-radius: var(--r-sm);
  }
  .toc a:hover { color: var(--fg-0); background: var(--bg-3); }

  .body {
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6);
    max-height: 100vh;
  }
  .status { color: var(--fg-2); font-size: var(--text-12); }
  .status.error { color: var(--accent-hi); }

  /* prose — markdown-rendered article styles */
  .prose {
    max-width: 720px;
    line-height: 1.6;
    color: var(--fg-1);
  }
  .prose :global(h1) {
    font-family: var(--font-mono);
    font-size: 22px;
    color: var(--fg-0);
    margin: 0 0 var(--sp-3);
    letter-spacing: -0.01em;
  }
  .prose :global(h2) {
    font-family: var(--font-mono);
    font-size: var(--text-16);
    color: var(--fg-0);
    margin: var(--sp-6) 0 var(--sp-3);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--line-1);
    scroll-margin-top: var(--sp-4);
  }
  .prose :global(h3) {
    font-family: var(--font-mono);
    font-size: var(--text-14);
    color: var(--fg-0);
    margin: var(--sp-5) 0 var(--sp-3);
    scroll-margin-top: var(--sp-4);
  }
  .prose :global(h4) {
    font-family: var(--font-mono);
    font-size: var(--text-12);
    color: var(--fg-0);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: var(--sp-4) 0 var(--sp-2);
  }
  .prose :global(p) { margin: 0 0 var(--sp-3); }
  .prose :global(a) { color: var(--accent-hi); }
  .prose :global(a:hover) { color: var(--fg-0); }
  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 var(--sp-3);
    padding-left: var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .prose :global(li) { line-height: 1.5; }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    background: var(--bg-0);
    color: var(--fg-0);
    padding: 1px 5px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-1);
  }
  .prose :global(pre) {
    background: var(--bg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-11);
    line-height: 1.5;
  }
  .prose :global(blockquote) {
    margin: var(--sp-3) 0;
    padding: var(--sp-2) var(--sp-4);
    border-left: 3px solid var(--accent);
    background: var(--bg-2);
    color: var(--fg-1);
  }
  .prose :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: var(--sp-3) 0;
    font-size: var(--text-11);
  }
  .prose :global(th),
  .prose :global(td) {
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line-1);
    text-align: left;
    vertical-align: top;
  }
  .prose :global(th) {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--line-2);
  }
  .prose :global(hr) {
    border: 0;
    border-top: 1px solid var(--line-1);
    margin: var(--sp-5) 0;
  }
  .prose :global(strong) { color: var(--fg-0); }
</style>
