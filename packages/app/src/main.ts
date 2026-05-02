import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import SatellitePopup from './SatellitePopup.svelte';

// Phase-6 M4: when this page was opened with `?panel=<name>`, render
// the popup-only shell instead of the full root app. The popup boots
// a fresh Y.Doc, syncs with root via BroadcastChannel, and mounts the
// requested panel only.

const params = new URLSearchParams(window.location.search);
const panel = params.get('panel');

const target = document.getElementById('app')!;
const app =
  panel == null
    ? mount(App, { target })
    : mount(SatellitePopup, { target, props: { panel } });

export default app;
