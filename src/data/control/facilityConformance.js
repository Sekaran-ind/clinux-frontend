// SPEC-24 §7 step 5 — the client side of the real chain clinuxflow-api's own
// POST /api/facility/conformance proves end to end (extract -> validate against
// ClinuxFlowFacility -> next-best-action). Deliberately reads the WHOLE Provider record/
// Questionnaire, not just the section_hospital slice the Hospital Profile drawer edits — a real
// Organization resource needs the ABDM extension fields too (ownershipCode, LGD codes, geo, ...),
// which FacilityHfrPanel.vue now captures on the SAME /onboarding page, right below the Hospital
// Profile drawer (see Onboarding.vue), landing in the SAME underlying Provider
// QuestionnaireResponse. Checking conformance is therefore inherently a "how much of the whole
// Facility profile has been captured across both panels so far" question, not a per-panel one.
import { apiFetch, API_BASE } from '../../config.js';

export async function checkFacilityConformance(questionnaireJson, responseJson) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/conformance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body; // { success, valid, errors, organization, nextActions }
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
