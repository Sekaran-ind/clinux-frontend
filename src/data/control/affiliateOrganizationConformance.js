// SPEC-24 §7 step 6 (Affiliate Organization) — the client side of clinuxflow-api's
// POST /api/affiliate-organization/conformance, same shape as facilityConformance.js/
// providerConformance.js. Reads the WHOLE Provider record for the same reason those do —
// OrganizationAffiliation.organization auto-links against whatever Organization is in the same
// bundle (local-extractor.js), so a meaningful check needs the whole record, not just the
// section_affiliate_organization slice the drawer edits.
import { apiFetch, API_BASE } from '../../config.js';

export async function checkAffiliateOrganizationConformance(questionnaireJson, responseJson) {
  try {
    const res = await apiFetch(`${API_BASE}/api/affiliate-organization/conformance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body; // { success, affiliations, nextActions }
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
