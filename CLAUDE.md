# clinux-frontend

Vue 3 + Vite + Pinia + TanStack DB frontend for ClinixFlow, packaged for native via Capacitor.
This is the **active development target** for the product. The sibling project `../../clinixflow`
(Alpine.js, same product) has been fully ported here and is now kept only as a sandbox /
behavioral reference — not a place to add new features, and not something to keep in sync with
this project going forward.

## Relationship to sibling projects

- `../clinuxflow-api` — the Hono/Cloudflare Workers backend this frontend calls (forms compile /
  save-to-library, system-forms catalog, test-scribe, clinic-specialities virtual rooms). Run both
  together locally.
- `../clinuxflow-abdm-gateway` — separate Worker for ABDM HFR/HPR registration, used only by the
  `/onboarding-abdm` route. Its local dev port collides with clinuxflow-api's default (8787), so
  run it on a different port (e.g. `wrangler dev --port 8788`) and point that route's in-page
  "Gateway Connection" field at it.
- `../../clinixflow` — the original Alpine.js/Express implementation of the same product. All 9
  pages have been ported here (index, front-desk, consultation-desk, onboarding, clinic-home,
  checkout, onboarding-abdm, designer, ai-engine). Treat it as read-only reference material for
  "how did the Alpine version behave" questions, not something to migrate further or sync with.

## Running locally

```
npm install         # postinstall vendors LHC-Forms into public/vendor/lforms/
npm run dev          # vite dev server
npm run build        # production build — verify no CDN references slip back in (see below)
```

Needs `clinuxflow-api` running (`wrangler dev`, default port 8787) for forms/system-forms/scribe
endpoints — see `src/config.js` (`VITE_API_BASE`, defaults to `http://localhost:8787`).

Every dependency that clinixflow loaded from a CDN (Tailwind, Alpine → Vue, Font Awesome, Google
Fonts, LHC-Forms, Cornerstone.js, jsPDF, js-yaml, Ace) is a local npm dependency here. After
`npm run build`, `dist/` should have zero live references to jsdelivr/cdnjs/unpkg/Google
Fonts/lforms-static — a stray CDN `<script src>` creeping back in is a regression.

## Architecture conventions

- **Pinia** = ephemeral UI state (theme, active step/tab, drawer open/closed, per-page wizard
  state). **TanStack DB local-collections** (`src/data/collections/*.js`) = durable business data
  (forms library, form data records, chat threads, users, encounter docs). Collections are
  local-only for now (localStorage-backed via `createLocalCollection`) but structured so swapping
  to a real Query Collection later is a config change inside that collection's own file — callers
  never touch storage details directly.
- **`dataVersion` idiom**: TanStack collection reads (`.toArray`/`.get`) are not Vue-reactive on
  their own. Every computed/function that reads a collection touches a `dataVersion` ref first
  (read-only, to register the dependency); every mutating action bumps it. Applied per-page or
  per-store as appropriate — look at `stores/onboarding.js` or any page's `<script setup>` for the
  pattern before introducing a new one.
- **`main.js` preloads every collection** (`await Promise.all(collections.map(c => c.preload()))`)
  before `app.mount()`. This is required — without it, a synchronous collection read at
  component-setup time (not inside a computed) races and can see stale/empty data on a hard page
  load. Add any new collection module to that array.
- **`LhcFormHost.vue`** wraps LForms' imperative `renderBlank`/`renderWithRecord`/`extractResponse`
  API. LForms only tracks one live form instance per page for extraction purposes — don't render
  two simultaneous `LhcFormHost` instances into different containers. Use `:key="formKey"` (bumped
  after a repeatable-form save) to force a clean remount to blank; a re-derived `questionnaire`
  prop isn't guaranteed to be a new object reference the component's own `watch()` would catch.
- **No `@click.outside` / `v-click-outside`** — Vue core has no built-in equivalent to Alpine's
  directive. Use a manual `document.addEventListener('click', handler)` with
  `e.target.closest(...)` containment checks, registered in `onMounted` and removed in
  `onUnmounted`. If the toggle button itself uses `@click.stop`, the handler only needs to check
  the panel/menu element; if it doesn't, wrap both the trigger and the panel in one containing
  element and check against that instead (avoids the "same click that opens it also closes it"
  race).
- Pages with their own full nav (`Index`, `ClinicHome`, `AiEngine`) set `meta: { hideAppNav: true
  }` in `src/router/index.js`; every other page uses `App.vue`'s shared nav via the `pageBadge`
  map keyed by route name.
- A few pages (`ClinicHome`, `AiEngine`) define their own self-contained, unprefixed CSS variable
  set (`--bg`/`--text`/`--border`/etc., distinct from the shared `--cf-*` tokens the rest of the
  app uses). Scoped `<style>` can't target `<html>` (it's not part of any component's own
  template), so their `:root`/`.dark` variable definitions need `:global(:root)`/`:global(.dark)`
  escapes — plain scoped `:root { ... }` silently matches nothing.

## Status

All 9 original clinixflow pages are ported and were Playwright-verified live against the real
backend(s) (clinuxflow-api, and clinuxflow-abdm-gateway for the ABDM page). No known open gaps
from the migration itself.
