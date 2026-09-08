import { createLocalCollection } from '../collectionFactory.js';
import { apiFetch } from '../../config.js';

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
  const res = await apiFetch(`${apiBase}/api/workflow/system-forms`).then((r) => r.json());
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

// A FHIR Questionnaire with just ONE of `questionnaire`'s top-level groups — used by Cübo's
// group-at-a-time system-flow capture (SPEC-22 §5.4) so LhcFormHost renders exactly one section
// of the real compiled Provider form instead of the whole 8-entity document Designer.vue's own
// drawer shows. A Questionnaire with a single group item is a perfectly valid, complete FHIR
// Questionnaire on its own — no special support needed from LForms/LhcFormHost, confirmed live
// (renders, pre-fills from the full existing record, and extracts back a correctly-shaped
// single-group QuestionnaireResponse — see mergeGroupResponseItem's own comment for the save
// side). Returns null if the group isn't found, same "caller checks" convention activeQuestionnaire
// itself uses.
export function sliceQuestionnaireGroup(questionnaire, groupLinkId) {
  if (!questionnaire) return null;
  const groupItem = (questionnaire.item || []).find((i) => i.linkId === groupLinkId);
  if (!groupItem) return null;
  return { ...questionnaire, item: [groupItem] };
}

// Custom forms tagged journey: 'patient'|'hospital' in their YAML (compiled through onto the
// active version's Questionnaire by clinuxflow-api's yaml-to-questionnaire.js) — lets Front
// Desk surface exactly the forms meant for it instead of every custom form only ever being
// reachable from Designer's own Data Explorer. See
// clinux-custom-forms-in-patient-hospital-journeys memory note.
export function journeyFormIds(journey) {
  return formsLibrary.toArray
    .filter((r) => activeQuestionnaire(r.formId)?.journey === journey)
    .map((r) => r.formId);
}
