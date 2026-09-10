// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md §9 — client wrappers for clinuxflow-api's
// facility_join_tokens routes. apiFetch() (config.js) auto-attaches the stored session's
// Authorization header when one exists, which is exactly the "honored if present" behavior
// .../redeem needs (an anonymous staff candidate has none yet; an already-logged-in affiliate's
// is picked up automatically) — no special-casing needed here.
import { apiFetch, API_BASE } from '../../config.js';

async function parse(res) {
  const body = await res.json().catch(() => ({ success: false, error: `Request failed (${res.status}).` }));
  if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).`, status: res.status };
  return body;
}

export async function issueJoinToken(linkKind) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkKind }),
    });
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

export async function listJoinTokens() {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens`);
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

// SPEC-26 §6's discovery fix — every redeemed-but-undecided token this admin issued, WITH the
// redeemer's own name/email joined in, for Cübo's contacts pane to surface as a synthetic
// "pending join request" entry (fetchTeam()/fetchAffiliates() wouldn't include this person yet).
export async function listPendingJoinRequests() {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/pending`);
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

export async function renewJoinToken(token) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/${token}/renew`, { method: 'POST' });
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

// body: { email, password, adminName, designation } for a new staff account, or omitted entirely
// for an already-authenticated caller (an affiliate redeeming with their own existing account).
export async function redeemJoinToken(token, body) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/${token}/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

// The Cloudflare Queues durable-fallback leg (SPEC-26 §6) — called unconditionally alongside the
// live P2P chat send, never instead of it.
export async function deliverJoinRequestPayload(token, ciphertext) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/${token}/deliver`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext }),
    });
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

// The read side of the durable-fallback delivery (SPEC-26 §6) — the admin's client calls this to
// fetch the ciphertext a redeemer's .../deliver call (via the Queue consumer) already wrote.
export async function getJoinRequestPayload(token) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/${token}/payload`);
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

export async function decideJoinToken(token, decision, role) {
  try {
    const res = await apiFetch(`${API_BASE}/api/facility/join-tokens/${token}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, role }),
    });
    return await parse(res);
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}
