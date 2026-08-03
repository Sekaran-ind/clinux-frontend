import { defineStore } from 'pinia';
import { ref } from 'vue';
import { users } from '../data/collections/users.js';

// Replaces index.html's plain-object (non-FHIR) auth: Register/Login/Profile modals, backed by
// the `users` collection for the account list and a plain localStorage key (cf_user, same name
// as before) for "who's currently signed in" — a single pointer, not a list, so it stays a
// simple ref rather than its own collection (same reasoning as theme/virtualRoom).
export const useAuthStore = defineStore('auth', () => {
  const currentUser = ref(null);
  try {
    const saved = localStorage.getItem('cf_user');
    currentUser.value = saved ? JSON.parse(saved) : null;
  } catch (e) {
    currentUser.value = null;
  }

  function persist() {
    if (currentUser.value) localStorage.setItem('cf_user', JSON.stringify(currentUser.value));
    else localStorage.removeItem('cf_user');
  }

  function register(regForm) {
    if (users.toArray.find((u) => u.email === regForm.email)) {
      return { error: 'An account with this email already exists.' };
    }
    const user = { ...regForm, id: String(Date.now()), careTeam: '', address: '' };
    users.insert(user);
    currentUser.value = user;
    persist();
    return { user };
  }

  function login(email, password) {
    const user = users.toArray.find((u) => u.email === email && u.password === password);
    if (!user) return { error: 'Invalid email or password.' };
    currentUser.value = user;
    persist();
    return { user };
  }

  function logout() {
    currentUser.value = null;
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

  return { currentUser, register, login, logout, saveProfile };
});
