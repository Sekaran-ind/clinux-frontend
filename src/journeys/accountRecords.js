// What the workspace keeps per account on this device — journey results (an HPR ID, an HFR
// tracking id, the FHIR resources they produced) and the account's consents: IndexedDB, every key
// scoped to the account, as clinux-cubo's localStore does, so people sharing a browser never see
// each other's records.
import { createStore, get, set } from 'idb-keyval';

const store = createStore('clinux-workspace-journeys', 'kv');

export function accountRecords(accountId) {
  if (!accountId) throw new Error('No signed-in account');
  return {
    get: (k) => get(`${accountId}:${k}`, store),
    set: (k, v) => set(`${accountId}:${k}`, v, store),
  };
}
