// SPEC-24 §7 step 6 (Affiliate Practitioner Role) — the client side of clinuxflow-api's
// GET /api/facility/affiliates/conformance. Unlike facilityConformance.js/providerConformance.js,
// this entity was never YAML/QuestionnaireResponse-driven (see that endpoint's own header comment
// and the clinux-spec24-... memory note) — TeamSettingsModal.vue's existing Affiliates tab already
// captures everything needed (practitionerEmail + role, via /api/facility/affiliates), and the
// conformance check itself is entirely server-derived (the caller's own clinic's stored Provider
// composition + its own linked-affiliates list) — no questionnaireJson/responseJson to pass, just
// a plain GET against the caller's own session.
import { apiFetch, API_BASE } from '../../config.js';

export async function checkAffiliatePractitionerConformance() {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/affiliates/conformance`);
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body; // { success, hasOrganization, affiliates: [{affiliate, role, valid, errors}], nextActions }
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
