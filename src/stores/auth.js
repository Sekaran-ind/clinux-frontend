import { defineStore } from 'pinia';
import { ref } from 'vue';
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

  async function register(regForm) {
    const res = await apiFetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clinicName: regForm.clinicName, email: regForm.email, password: regForm.password,
        adminName: regForm.adminName, designation: regForm.designation,
      }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    setSession(res.account, res.token);
    // services/phone/city are local-only extras the server doesn't model.
    users.update(res.account.id, (draft) => Object.assign(draft, {
      services: regForm.services || '', phone: regForm.phone || '', city: regForm.city || '',
    }));
    currentUser.value = users.get(res.account.id);
    persist();
    return { user: currentUser.value };
  }

  async function login(email, password) {
    const res = await apiFetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json()).catch(() => ({ success: false, error: 'Network error — please try again.' }));

    if (!res.success) return { error: res.error };
    setSession(res.account, res.token);
    return { user: currentUser.value };
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

  function saveProfile(profileForm) {
    if (!currentUser.value) return;
    const updated = { ...currentUser.value, ...profileForm };
    if (users.has(currentUser.value.id)) {
      users.update(currentUser.value.id, (draft) => Object.assign(draft, profileForm));
    }
    currentUser.value = updated;
    persist();
  }

  return { currentUser, register, login, logout, saveProfile, refreshSession };
});
