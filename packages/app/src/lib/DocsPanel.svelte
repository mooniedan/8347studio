<script lang="ts">
  /**
   * Phase 8 follow-up — user-guide renderer (multi-page).
   *
   * Loads `index.json` from the `docs/` directory, renders a left
   * navigation list of pages, and fetches the selected page's
   * markdown on demand. All page-to-page navigation is in-component
   * state — no URL navigation, so the PIP window never closes when
   * a link is clicked.
   *
   * In-page links use the convention `#page:<slug>` to switch pages
   * (intercepted via the article click handler); plain `#anchor`
   * links scrollIntoView within the article instead of mutating the
   * window URL.
   */
  import { onMount, tick } from 'svelte';
  import { marked } from 'marked';

  type Page = { slug: string; title: string };
  type Index = { title: string; subtitle?: string; pages: Page[] };

  let { indexUrl = '/docs/index.json' }: { indexUrl?: string } = $props();

  let index = $state<Index | null>(null);
  let currentSlug = $state<string>('');
  let html = $state('');
  let loadingIndex = $state(true);
  let loadingPage = $state(false);
  let loadError = $state<string | undefined>(undefined);
  let article: HTMLElement | null = $state(null);

  onMount(async () => {
    try {
      const resp = await fetch(indexUrl);
      if (!resp.ok) throw new Error(`fetch ${indexUrl}: ${resp.status}`);
      const data = (await resp.json()) as Index;
      index = data;
      const initial = data.pages[0]?.slug;
      if (initial) await loadPage(initial);
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loadingIndex = false;
    }
  });

  async function loadPage(slug: string) {
    if (!index) return;
    const page = index.pages.find((p) => p.slug === slug);
    if (!page) return;
    currentSlug = slug;
    loadingPage = true;
    loadError = undefined;
    try {
      const baseUrl = new URL(indexUrl, window.location.href);
      const url = new URL(`${slug}.md`, baseUrl);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch ${url.pathname}: ${resp.status}`);
      const md = await resp.text();
      html = await marked.parse(md);
    } catch (err) {
      loadError = (err as Error).message;
      html = '';
    } finally {
      loadingPage = false;
    }
    await tick();
    article?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }

  function handleArticleClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    // Intercept #page:<slug> for cross-page navigation.
    if (href.startsWith('#page:')) {
      event.preventDefault();
      const slug = href.slice('#page:'.length);
      void loadPage(slug);
      return;
    }
    // Intercept plain #anchor — scroll within article, don't
    // mutate window URL (which closes Document PIP windows).
    if (href.startsWith('#')) {
      event.preventDefault();
      const id = href.slice(1);
      const el = article?.querySelector(`#${CSS.escape(id)}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // External links open in a new tab so they don't navigate the
    // (possibly PIP) docs window.
    if (/^https?:/.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function onNavClick(event: MouseEvent, slug: string) {
    event.preventDefault();
    void loadPage(slug);
  }
</script>

<div class="docs" data-testid="docs-panel">
  <aside class="nav" aria-label="User guide navigation">
    <div class="nav-head">
      <div class="nav-title">{index?.title ?? '8347 Studio'}</div>
      {#if index?.subtitle}
        <div class="nav-sub">{index.subtitle}</div>
      {/if}
    </div>
    {#if loadingIndex}
      <p class="status" data-testid="docs-index-loading">Loading…</p>
    {:else if loadError && !index}
      <p class="status error" data-testid="docs-index-error">
        Couldn't load the index: {loadError}
      </p>
    {:else if index}
      <nav>
        <ul>
          {#each index.pages as page (page.slug)}
            <li>
              <a
                href="#page:{page.slug}"
                class:active={currentSlug === page.slug}
                aria-current={currentSlug === page.slug ? 'page' : undefined}
                data-testid="docs-nav-{page.slug}"
                onclick={(e) => onNavClick(e, page.slug)}
              >{page.title}</a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
  </aside>

  <main class="body">
    {#if loadingIndex}
      <p class="status" data-testid="docs-loading">Loading user guide…</p>
    {:else if loadError && !html}
      <p class="status error" data-testid="docs-error">
        Couldn't load the guide: {loadError}
      </p>
    {:else}
      <article
        class="prose"
        data-testid="docs-content"
        data-page={currentSlug}
        bind:this={article}
        onclick={handleArticleClick}
      >{@html html}</article>
      {#if loadingPage}
        <p class="status floating" data-testid="docs-page-loading">Loading…</p>
      {/if}
    {/if}
  </main>
</div>

<style>
  .docs {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 0;
    width: 100%;
    height: 100%;
    background: var(--bg-1);
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: var(--text-12);
  }
  .nav {
    background: var(--bg-2);
    border-right: 1px solid var(--line-1);
    padding: var(--sp-4) var(--sp-3);
    overflow-y: auto;
    height: 100vh;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .nav-head {
    border-bottom: 1px solid var(--line-1);
    padding-bottom: var(--sp-3);
  }
  .nav-title {
    font-family: var(--font-mono);
    font-size: var(--text-12);
    color: var(--fg-0);
    letter-spacing: 0.04em;
  }
  .nav-sub {
    font-size: var(--text-10);
    color: var(--fg-2);
    margin-top: 2px;
    font-style: italic;
  }
  .nav nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav a {
    color: var(--fg-2);
    text-decoration: none;
    font-size: var(--text-11);
    line-height: 1.5;
    display: block;
    padding: 4px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .nav a:hover { color: var(--fg-0); background: var(--bg-3); }
  .nav a.active {
    color: var(--fg-0);
    background: var(--bg-3);
    border-left: 2px solid var(--accent);
    padding-left: 6px;
  }

  .body {
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6);
    max-height: 100vh;
    position: relative;
  }
  .status { color: var(--fg-2); font-size: var(--text-12); }
  .status.error { color: var(--accent-hi); }
  .status.floating {
    position: absolute;
    top: var(--sp-3);
    right: var(--sp-4);
    background: var(--bg-2);
    padding: 2px 8px;
    border-radius: var(--r-sm);
    font-size: var(--text-10);
  }

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
  .prose :global(a) { color: var(--accent-hi); cursor: pointer; }
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
