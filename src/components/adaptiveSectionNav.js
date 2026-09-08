// SPEC-24 §5 — pure, testable helpers behind AdaptiveSectionNav.vue's own mode/breakpoint
// decisions. Split out from the component because this repo has no @vue/test-utils (nothing
// mounts a .vue component in its own tests — see encounterCoordination.test.js's own header);
// components get verified by running the app (live-verified), plain logic like this by a real
// test, the same split workflowRuntime.js/entryWorkflow.js already establish elsewhere.

// 'panes' is Cübo's own fixed simultaneous-display case (SPEC-24 §5) — shows every section at
// once, never "one at a time," so it's never one of the three switchable single-section chromes a
// per-instance user preference can override.
export const SWITCHABLE_MODES = ['tabs', 'sidebar', 'accordion'];
export const MODES = [...SWITCHABLE_MODES, 'panes'];
export const DEFAULT_MODE = 'tabs';

// The app's existing Tailwind `md:` breakpoint (768px) — reused, not reinvented (SPEC-24 §5).
export const BREAKPOINT_PX = 768;

export function resolveViewport(widthPx, breakpointPx = BREAKPOINT_PX) {
  return widthPx >= breakpointPx ? 'expanded' : 'compact';
}

function storageKey(instanceKey) {
  return `cf_adaptive_nav_mode_${instanceKey}`;
}

// Returns a remembered switchable mode for this component instance, or null when nothing valid
// is stored (never-visited, cleared storage, or a stale/corrupt value from an older MODES list).
export function loadStoredMode(instanceKey) {
  try {
    const stored = localStorage.getItem(storageKey(instanceKey));
    return SWITCHABLE_MODES.includes(stored) ? stored : null;
  } catch (e) {
    return null;
  }
}

// 'panes' is deliberately never persisted — it isn't a user choice to remember, it's the caller's
// own fixed hint (see resolveEffectiveMode). A quota/private-browsing write failure is swallowed:
// losing a remembered display preference shouldn't break navigation.
export function saveStoredMode(instanceKey, mode) {
  if (!SWITCHABLE_MODES.includes(mode)) return;
  try {
    localStorage.setItem(storageKey(instanceKey), mode);
  } catch (e) {
    // best-effort
  }
}

// The mode a component instance actually renders with, at/above the breakpoint: a caller asking
// for 'panes' always gets it (Cübo's own case, never user-switchable); otherwise a remembered
// per-instance override wins over the caller's own `mode` prop hint, which itself falls back to
// 'tabs' when neither is set.
export function resolveEffectiveMode({ propMode, storedMode } = {}) {
  if (propMode === 'panes') return 'panes';
  if (SWITCHABLE_MODES.includes(storedMode)) return storedMode;
  if (SWITCHABLE_MODES.includes(propMode)) return propMode;
  return DEFAULT_MODE;
}

// The active section id to render: keeps a caller/localStorage-supplied id only while it still
// names a real section (sections can change out from under a long-lived instance), otherwise
// falls back to the first section — never an id belonging to nothing.
export function resolveActiveId(sections, requestedId) {
  const ids = (sections || []).map((s) => s.id);
  if (requestedId && ids.includes(requestedId)) return requestedId;
  return ids[0] ?? null;
}
