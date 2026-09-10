// SPEC-24 §7 step 6 — the client side of clinuxflow-api's POST /api/provider/conformance, the
// Provider counterpart to facilityConformance.js. Same "read the WHOLE Provider record" reasoning
// applies here too: Practitioner/PractitionerRole references get auto-linked against whatever
// Organization is in the same bundle, so a meaningful check needs the whole record, not just the
// section_staff/section_staff_role slice the Care Team drawer edits.
import { apiFetch, API_BASE } from '../../config.js';

export async function checkProviderConformance(questionnaireJson, responseJson) {
  try {
    const res = await apiFetch(`${API_BASE}/api/provider/conformance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body; // { success, providers, nextActions }
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
