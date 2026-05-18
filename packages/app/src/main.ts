import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import SatellitePopup from './SatellitePopup.svelte';
import Styleguide from './Styleguide.svelte';
import DocsPanel from './lib/DocsPanel.svelte';

// Routing: query-string driven (the app has no router).
//   ?styleguide=1  → P0 visual-system reference + base-component spec
//                    (Phase 7 M1; Playwright snapshot target)
//   ?panel=<name>  → Phase-6 popup shell synced with root over
//                    BroadcastChannel
//   ?docs=1        → user-guide full-page renderer (the non-PIP
//                    fallback for the docs button)
//   ?room=<id>     → Phase-9 M5 collab — boot an ephemeral project
//                    and attach the sync client to the named room.
//                    Optional `?syncUrl=ws://…` overrides the default
//                    server (test infrastructure passes this so it can
//                    spawn the sync-server on a random port).
//   (default)      → full root app

const params = new URLSearchParams(window.location.search);
const target = document.getElementById('app')!;

const roomId = params.get('room');

const app = params.get('styleguide') === '1'
  ? mount(Styleguide, { target })
  : params.get('docs') === '1'
    ? mount(DocsPanel, { target })
    : params.get('panel') != null
      ? mount(SatellitePopup, { target, props: { panel: params.get('panel')! } })
      : mount(App, { target, props: { roomId } });

export default app;
