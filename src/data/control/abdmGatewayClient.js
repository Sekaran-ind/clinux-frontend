// SPEC-24 §7 step 6 (Patient) — a small, shared "call clinuxflow-abdm-gateway" helper, extracted
// out of AbdmOnboarding.vue's own page-local callGateway() (which stays exactly as it was, an
// unrelated page) now that a SECOND consumer (PatientAbhaPanel.vue) needs the identical
// mechanism. Deliberately simpler than AbdmOnboarding.vue's own version: no user-editable
// gateway-URL override (that exists there for "a visitor may need to point it at a different
// gateway" — not a real need for a front-desk-in-the-moment patient flow) — just the fixed
// ABDM_GATEWAY_BASE, same apiFetch() call shape.
import { apiFetch, ABDM_GATEWAY_BASE } from '../../config.js';

export async function callAbdmGateway(path, { method = 'POST', body, extraHeaders } = {}) {
  try {
    const res = await apiFetch(`${ABDM_GATEWAY_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json;
    try { json = await res.json(); } catch (e) { json = { success: false, error: `Invalid response from gateway (${res.status}).` }; }
    return json;
  } catch (err) {
    return { success: false, error: 'Network error contacting the ABDM gateway — ' + err.message };
  }
}
