// clinuxflow-api's real URL is baked in at BUILD time (VITE_API_BASE, normally
// http://localhost:8787 for local dev) -- fine for the device that build actually ran on, but a
// literal "localhost:8787" means something different on every device, so a LAN device loading
// this app from the Tauri shared server would resolve it to ITSELF, not the Tauri host, and get
// a network error trying to log in. When this page was served BY that shared server
// (window.__CLINUX_SHARED_SERVER__, injected server-side -- see src-tauri/src/shared_server.rs),
// API_BASE becomes '' instead: a relative /api/... call lands on that SAME origin, which proxies
// it through to the real clinuxflow-api from the host machine's own network position. Found and
// fixed after a live user hit this exact "network error" logging in from a second device.
const SHARED_SERVER_PAGE = typeof window !== 'undefined' && window.__CLINUX_SHARED_SERVER__ === true;
export const API_BASE = SHARED_SERVER_PAGE ? '' : (import.meta.env.VITE_API_BASE || 'http://localhost:8787');

// clinuxflow-abdm-gateway — separate Worker, only called by FacilityHfrPanel.vue/
// ProviderHprPanel.vue/PatientAbhaPanel.vue (real HFR/HPR/ABHA registration). NOT proxied by
// the shared server (only clinuxflow-api is, so far) -- those panels will hit the same class of
// network error from a second device until that's built too.
export const ABDM_GATEWAY_BASE = import.meta.env.VITE_ABDM_GATEWAY_BASE || 'http://localhost:8788';

// Shared secret both backends require as X-Service-Key (see their own src/index.js auth
// middleware) — must match the SERVICE_KEY each Worker has set. Not a real confidentiality
// boundary (this bundle is public, so the value is extractable by anyone who inspects it) —
// it exists to stop opportunistic/bot traffic hitting the raw *.workers.dev URLs directly,
// backed by CORS + rate limiting server-side for the operations that actually matter.
const SERVICE_KEY = import.meta.env.VITE_SERVICE_KEY || '';

export const SESSION_TOKEN_KEY = 'cf_session_token';

// Drop-in replacement for fetch() against either backend — attaches X-Service-Key so callers
// don't have to remember to, plus the per-account session token (if one exists) as a Bearer
// token so clinuxflow-api's requireUser()/requirePaidTier() routes work. Harmless no-op against
// clinuxflow-abdm-gateway, which doesn't read this header.
export function apiFetch(url, options = {}) {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Service-Key': SERVICE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
