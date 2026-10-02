// Consents, local-first — clinux-cubo's src/stores/consent.js on the workspace's own storage:
// FHIR R4 Consent resources (src/consent/consentResource.js, copied from Cübo) kept under the
// signed-in account (src/journeys/index.js's accountRecords) and validated by clinuxflow-fhir-api's
// $validate. A consent the API rejects (error-level issues) is not saved. If the API can't be
// reached, the consent is saved as "pending" and checked again next time, so a clinic with a
// flaky connection isn't locked out of work it has already agreed to.
//
// The workspace stays closed until every consent is given for the current terms version (the
// router guard, consentRedirect() below); withdrawing one closes it again.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../journeys/fhirApi.js';
import { accountRecords } from '../journeys/accountRecords.js';
import { CONSENTS } from '../consent/terms.js';
import { buildConsent, isCurrent, withdrawConsent } from '../consent/consentResource.js';

const KEY = 'consents';

export async function validateResource(resource) {
  try {
    const res = await api('/$validate', { method: 'POST', body: resource });
    if (res.status !== 200) return { status: 'pending', issues: [] };
    const issues = (res.data?.issue || []).filter((i) => i.severity === 'error' || i.severity === 'fatal');
    return { status: issues.length ? 'invalid' : 'valid', issues };
  } catch {
    return { status: 'pending', issues: [] };
  }
}

// Pages that never need consent: the public landing page, the legal text, and the consent page.
export const CONSENT_EXEMPT = ['index', 'legal', 'consent'];

/** Where a signed-in user must go instead of `toName`, or null. Pure, for the router guard. */
export function consentRedirect(toName, { signedIn, allGranted }) {
  if (!signedIn || CONSENT_EXEMPT.includes(toName)) return null;
  return allGranted ? null : 'consent';
}

export const useConsentStore = defineStore('consent', () => {
  const records = ref({}); // termKey -> { resource, validation: { status, checkedAt } }
  const accountId = ref(null);
  let storage = null;

  const granted = computed(() => Object.fromEntries(CONSENTS.map((t) => [t.key, isCurrent(records.value[t.key]?.resource, t.key)])));
  const allGranted = computed(() => CONSENTS.every((t) => granted.value[t.key]));

  /** `store` ({ get, set }) is injectable for tests; defaults to the account's IndexedDB records. */
  async function load(id, store = accountRecords(id)) {
    accountId.value = id;
    storage = store;
    records.value = (await storage.get(KEY)) || {};
    // Re-check anything saved while the API was unreachable.
    for (const [key, rec] of Object.entries(records.value)) {
      if (rec.validation?.status !== 'pending') continue;
      const v = await validateResource(rec.resource);
      if (v.status === 'invalid') delete records.value[key];
      else records.value[key] = { ...rec, validation: { status: v.status, checkedAt: new Date().toISOString() } };
    }
    await persist();
  }

  async function persist() {
    await storage?.set(KEY, JSON.parse(JSON.stringify(records.value)));
  }

  /** Grant every term; returns { ok } or { ok: false, errors } without saving anything. */
  async function grantAll(account) {
    const built = CONSENTS.map((t) => [t.key, buildConsent(t, account)]);
    const results = await Promise.all(built.map(([, r]) => validateResource(r)));
    const errors = results.flatMap((r) => r.issues.map((i) => i.diagnostics));
    if (results.some((r) => r.status === 'invalid')) return { ok: false, errors };
    const checkedAt = new Date().toISOString();
    built.forEach(([key, resource], i) => {
      records.value[key] = { resource, validation: { status: results[i].status, checkedAt } };
    });
    await persist();
    return { ok: true, pending: results.some((r) => r.status === 'pending') };
  }

  async function withdraw(termKey) {
    const rec = records.value[termKey];
    if (!rec) return;
    records.value[termKey] = { ...rec, resource: withdrawConsent(rec.resource) };
    await persist();
  }

  function reset() {
    records.value = {};
    accountId.value = null;
    storage = null;
  }

  return { records, accountId, granted, allGranted, load, grantAll, withdraw, reset };
});
