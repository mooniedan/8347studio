import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import SatellitePopup from './SatellitePopup.svelte';
import Styleguide from './Styleguide.svelte';

// Routing: query-string driven (the app has no router).
//   ?styleguide=1  → P0 visual-system reference + base-component spec
//                    (Phase 7 M1; Playwright snapshot target)
//   ?panel=<name>  → Phase-6 popup shell synced with root over
//                    BroadcastChannel
//   (default)      → full root app

const params = new URLSearchParams(window.location.search);
const target = document.getElementById('app')!;

const app =
  params.get('styleguide') === '1'
    ? mount(Styleguide, { target })
    : params.get('panel') != null
      ? mount(SatellitePopup, { target, props: { panel: params.get('panel')! } })
      : mount(App, { target });

export default app;
