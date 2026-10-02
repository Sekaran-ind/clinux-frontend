// The JSON transport the journeys use (ported from clinux-cubo's src/lib/api.js): parsed JSON plus
// status, never throwing for an HTTP error, only for a network failure, so a caller can tell
// "the server said no" from "the server isn't there". Built on apiFetch(), so every call carries
// X-Service-Key and the ClinuxFlow session token like the rest of this app's calls.
import { apiFetch, FHIR_API_BASE } from '../config.js';

export async function api(path, { method = 'GET', body, headers = {}, base = FHIR_API_BASE } = {}) {
  const res = await apiFetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
