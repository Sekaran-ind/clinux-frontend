// SPEC-24 §7 step 6 (Patient) — the client side of clinuxflow-api's POST /api/patient/conformance,
// same shape as facilityConformance.js. Single resource, not the "whole record" reasoning
// Facility/Provider/Affiliate Organization need (a Patient record has no auto-linked references
// to anything else — see that endpoint's own header on why there's no next-best-action step here
// either), so this only ever needs the Patient group's own slice, not the whole document.
import { apiFetch, API_BASE } from '../../config.js';

export async function checkPatientConformance(questionnaireJson, responseJson) {
  try {
    const res = await apiFetch(`${API_BASE}/api/patient/conformance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body; // { success, valid, errors, patient }
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
