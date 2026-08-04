// clinuxflow-api (Hono/Workers) — the backend this frontend calls for forms/scribe/clinic-specialities.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8787';

// clinuxflow-abdm-gateway — separate Worker, only called by AbdmOnboarding.vue.
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
