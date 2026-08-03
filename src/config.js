// clinuxflow-api (Hono/Workers) — the backend this frontend calls for forms/scribe/clinic-specialities.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8787';

// clinuxflow-abdm-gateway — separate Worker, only called by AbdmOnboarding.vue.
export const ABDM_GATEWAY_BASE = import.meta.env.VITE_ABDM_GATEWAY_BASE || 'http://localhost:8788';
