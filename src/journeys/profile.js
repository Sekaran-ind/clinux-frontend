// Cübo's profile: the people Cübo is acting for, and what each is signed in to. Today that is one
// person — the signed-in account — with their registry identities: the HPR ID linked to the
// account (the HPR journey's record) and a live HPR session (vault.js, memory only). Journeys
// whose JSON marks a step `"signIn": "hpr"` read from here (a prefilled HPR ID, a session reused
// instead of asking again) and their sign-ins show up here.
//
// `persons` is a list on purpose: a context such as an Encounter involves more than one person
// (the practitioner, the patient, …). That is not modelled yet; every entry here is `kind:
// 'account'`.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { accountRecords } from './accountRecords.js';
import { vault } from './vault.js';
import { HPR_RECORD } from './hprJourney.js';

export const REGISTRIES = { hpr: { label: 'HPR', title: 'Healthcare Professional Registry', journeyId: 'hpr' } };

export const useCuboProfileStore = defineStore('cuboProfile', () => {
  const auth = useAuthStore();
  const linkedHpr = ref(null); // the HPR journey's record for this account: { hprId, name, ... }
  const tick = ref(0); // bumped when a session starts/ends, and each minute (sessions expire)

  async function refresh() {
    const id = auth.currentUser?.id;
    const linked = id ? (await accountRecords(id).get(HPR_RECORD)) || null : null;
    if (auth.currentUser?.id === id) linkedHpr.value = linked;
    tick.value++;
  }
  watch(() => auth.currentUser?.id, refresh, { immediate: true });
  vault.subscribe(() => refresh());
  setInterval(() => tick.value++, 60 * 1000);

  const persons = computed(() => {
    tick.value; // re-read the vault when it changes or a session may have expired
    const a = auth.currentUser;
    if (!a) return [];
    const session = vault.hpr(a.id);
    return [{
      id: a.id,
      kind: 'account',
      name: a.adminName || a.email,
      email: a.email,
      role: a.role,
      identities: {
        hpr: {
          id: session?.hprId || linkedHpr.value?.hprId || '',
          linked: linkedHpr.value?.hprId || '',
          session: session ? { hprId: session.hprId, expiresAt: session.expiresAt } : null,
        },
      },
    }];
  });

  /** The signed-in account's identity in a registry (what a journey's sign-in step uses). */
  const identity = (registry) => persons.value[0]?.identities?.[registry] || null;

  function signOut(registry) {
    if (registry === 'hpr' && auth.currentUser) vault.forgetHpr(auth.currentUser.id);
  }

  return { persons, identity, refresh, signOut };
});
