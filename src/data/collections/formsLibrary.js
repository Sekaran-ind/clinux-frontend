import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cf_forms_library localStorage key. One record per formId:
//   { formId, isSystem, archived, bookmarked, activeVersion, versions: [{version, status, yaml, questionnaire, savedAt}] }
// getKey uses formId directly (was an object keyed by formId before; now a flat collection
// row per form, which is what TanStack DB collections expect).
export const formsLibrary = createLocalCollection('cf_forms_library_v2', {
  getKey: (r) => r.formId,
});

// Fetches clinuxflow-api's pre-compiled system-forms catalog and inserts any formId not
// already present — same "seed once, never overwrite a locally-edited copy" behavior as
// system-forms.js's seedSystemForms(). Returns true if anything was added.
export async function seedSystemForms(apiBase) {
  const res = await fetch(`${apiBase}/api/workflow/system-forms`).then((r) => r.json());
  if (!res.success) {
    console.warn('Could not load system forms catalog:', res.error);
    return false;
  }

  let changed = false;
  Object.entries(res.systemForms).forEach(([formId, entry]) => {
    if (!formsLibrary.has(formId)) {
      formsLibrary.insert({ formId, ...entry });
      changed = true;
    }
  });
  return changed;
}

export function activeVersionNumber(formId) {
  const entry = formsLibrary.get(formId);
  if (!entry) return null;
  return entry.activeVersion || entry.versions[entry.versions.length - 1]?.version;
}

export function activeQuestionnaire(formId) {
  const entry = formsLibrary.get(formId);
  if (!entry) return null;
  const version = activeVersionNumber(formId);
  const v = entry.versions.find((v) => v.version === version);
  return v ? v.questionnaire : null;
}
