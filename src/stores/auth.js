import { defineStore } from 'pinia';
import { ref, toRaw } from 'vue';
import { users } from '../data/collections/users.js';
import { API_BASE, apiFetch, SESSION_TOKEN_KEY } from '../config.js';

const USER_KEY = 'cf_user';

// Local-only profile fields the server doesn't model — merging preserves whatever's already in
// the local `users` row for this id (e.g. from a prior saveProfile), defaulting to blank on a
// brand-new registration. Server identity fields (id/clinicId/email/adminName/designation/
// clinicName/tier) always win over any stale local copy. Extracted as a pure function so it's
// unit-testable without localStorage/DOM.
export function mergeAccountWithLocalProfile(account, existingLocalRow) {
  return {
    ...(existingLocalRow || { services: '', phone: '', city: '', careTeam: '', address: '' }),
    ...account,
  };
}

// Replaces index.html's plain-object (non-FHIR) auth: Register/Login/Profile modals. Credentials
// are now verified server-side by clinuxflow-api (D1-backed, PBKDF2-hashed) — this store no
// longer compares any password itself, and never writes a password into the local `users`
// collection. currentUser merges the server-issued identity with whatever local-only profile
// fields (services/phone/city/careTeam/address) already exist for that id.
export const useAuthStore = defineStore('auth', () => {
  const currentUser = ref(null);
  try {
    const saved = localStorage.getItem(USER_KEY);
    currentUser.value = saved ? JSON.parse(saved) : null;
  } catch (e) {
    currentUser.value = null;
  }

  function persist() {
    if (currentUser.value) localStorage.setItem(USER_KEY, JSON.stringify(currentUser.value));
    else localStorage.removeItem(USER_KEY);
  }

  function setSession(account, token) {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    const existingLocalRow = users.has(account.id) ? users.get(account.id) : null;
    const merged = mergeAccountWithLocalProfile(account, existingLocalRow);
    if (users.has(account.id)) users.update(account.id, (draft) => Object.assign(draft, merged));
    else users.insert(merged);
    currentUser.value = merged;
    persist();
  }

  // SPEC-11: sign-up collects only email/password/role now -- role ('hospital_admin' |
  // 'health_professional' | 'admin_and_health_professional') is the new top-of-funnel fork,
  // replacing facilityType (still set server-side, just no longer client-supplied). clinicName/
  // adminName/designation/services/phone/city are no longer collected at registration at all --
  // clinicName starts as a server-derived placeholder, replaced for real once the new Hospital/
  // HFR journey runs (see updateClinicName() below); services/phone/city stay local-only extras,
  // untouched here since nothing collects them at sign-up anymore either.
  async function register(regForm) {
    const res = await apiFetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regForm.email, password: regForm.password, role: regForm.role }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    setSession(res.account, res.token);
    // toRaw() — currentUser is a ref(), so .value on an object holds a Vue reactive Proxy, not the
    // plain merged object. This result flows straight into entryWorkflow.js's XState context
    // (planDefinitionRunner.js's `result_register`/`result_login`, via event.output) and gets
    // persisted on every snapshot — a real, live DataCloneError: IndexedDB's structured-clone
    // algorithm (taskActorSnapshots.js's backend, unlike the old JSON.stringify-based localStorage
    // one) cannot clone a Proxy at all. Same root cause ProviderBasicsHost.vue's own header
    // documents for structuredClone() — a reactive Proxy crossing a structured-clone boundary.
    return { user: toRaw(currentUser.value) };
  }

  async function login(email, password) {
    const res = await apiFetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    setSession(res.account, res.token);
    return { user: toRaw(currentUser.value) }; // see register()'s own comment above on why toRaw()
  }

  // Re-fetches account+clinic (fresh tier) from the server — call on app boot if a token exists.
  // Logs out silently if the token is no longer valid (expired, or account/clinic deleted).
  async function refreshSession() {
    const tokenAtStart = localStorage.getItem(SESSION_TOKEN_KEY);
    if (!tokenAtStart) return;
    const res = await apiFetch(`${API_BASE}/api/auth/me`).then((r) => r.json()).catch(() => ({ success: false }));
    // Discard a stale response if the session changed (logout, or a fresh login) while this
    // request was in flight — otherwise a late-arriving response here can silently resurrect a
    // session the user already signed out of.
    if (localStorage.getItem(SESSION_TOKEN_KEY) !== tokenAtStart) return;
    if (!res.success) { logout(); return; }
    setSession(res.account, tokenAtStart);
  }

  function logout() {
    currentUser.value = null;
    localStorage.removeItem(SESSION_TOKEN_KEY);
    persist();
  }

  // Phase D: multi-user accounts per clinic. Every login on the CALLER's own clinic — the
  // server derives clinicId from the caller's own JWT (via requireUser()), never from anything
  // the client sends, so there's no clinicId to pass here either.
  async function fetchTeam() {
    const res = await apiFetch(`${API_BASE}/api/auth/team`).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));
    if (!res.success) return { error: res.error };
    return { accounts: res.accounts };
  }

  // SPEC-11: replaces the placeholder clinicName registration left behind with the real facility
  // name, once the new Hospital/HFR journey captures hospital_name — updates the server (so it
  // survives a fresh login/refreshSession) AND the local session immediately (so ClinicHome's
  // user-menu/nav don't wait for a round trip to stop showing the placeholder).
  async function updateClinicName(clinicName) {
    const res = await apiFetch(`${API_BASE}/api/auth/clinic-name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clinicName }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    saveProfile({ clinicName: res.clinicName });
    return { clinicName: res.clinicName };
  }

  // Real backend for the register/login/change-password small closed loop (see
  // clinux-planDefinition-runtime-built memory note) — PATCH /api/auth/change-password didn't
  // exist anywhere in this app before this pass. Mirrors updateClinicName's exact shape above.
  async function changePassword(currentPassword, newPassword) {
    const res = await apiFetch(`${API_BASE}/api/auth/change-password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    return { success: true };
  }

  // SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §4's
  // Forgot Password design — security-question recovery, no email infrastructure. Three thin
  // wrappers mirroring changePassword's exact shape above:
  //   setSecurityQuestion — called once authenticated (right after register succeeds, or later);
  //   getSecurityQuestion / resetPassword — both public/unauthenticated, used by the new entry-flow
  //   UI's two-step "show the question, then answer it" interaction.
  async function setSecurityQuestion(securityQuestion, securityAnswer) {
    const res = await apiFetch(`${API_BASE}/api/auth/security-question`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityQuestion, securityAnswer }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    return { success: true };
  }

  async function getSecurityQuestion(email) {
    const res = await apiFetch(`${API_BASE}/api/auth/forgot-password/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    return { success: true, securityQuestion: res.securityQuestion };
  }

  async function resetPassword(email, securityAnswer, newPassword) {
    const res = await apiFetch(`${API_BASE}/api/auth/forgot-password/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, securityAnswer, newPassword }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    return { success: true };
  }

  function saveProfile(profileForm) {
    if (!currentUser.value) return;
    const updated = { ...currentUser.value, ...profileForm };
    if (users.has(currentUser.value.id)) {
      users.update(currentUser.value.id, (draft) => Object.assign(draft, profileForm));
    }
    currentUser.value = updated;
    persist();
  }

  // Affiliates are an EXISTING independent practitioner's own account, linked to THIS clinic as
  // a visiting/affiliate consultant -- never a new login. See clinuxflow-api's GET/DELETE
  // /api/facility/affiliates and migrations/0005's own comment for why this is a separate
  // relationship type from staff. SPEC-26 retired this store's OWN linkAffiliate()/inviteTeammate()
  // (the admin-initiated email-lookup and admin-invents-a-password flows) — TeamSettingsModal.vue
  // now creates both relationship types through the unified join-token flow
  // (data/control/joinTokenAdapter.js) instead; POST /api/facility/affiliates itself stays server-
  // side only as the underlying write .../decide's approval performs, not a client-facing flow.
  async function fetchAffiliates() {
    const res = await apiFetch(`${API_BASE}/api/facility/affiliates`).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));
    if (!res.success) return { error: res.error };
    return { affiliates: res.affiliates };
  }

  async function revokeAffiliate(accountId) {
    const res = await apiFetch(`${API_BASE}/api/facility/affiliates/${encodeURIComponent(accountId)}`, { method: 'DELETE' })
      .then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));
    if (!res.success) return { error: res.error };
    return { success: true };
  }

  return {
    currentUser, register, login, logout, saveProfile, updateClinicName, changePassword, refreshSession, fetchTeam,
    setSecurityQuestion, getSecurityQuestion, resetPassword,
    fetchAffiliates, revokeAffiliate,
  };
});
