// Single import surface mirroring clinixflow's window.SystemForms API — same function names,
// same behavior — so LhcFormHost.vue and the page components read exactly like the Alpine
// version did. The only thing that changed is the storage backend (TanStack DB collections
// instead of raw localStorage.getItem/setItem); the LForms glue functions below are pure DOM/
// global-API calls and needed no change at all.
export {
  formsLibrary,
  seedSystemForms,
  activeVersionNumber,
  activeQuestionnaire,
} from './collections/formsLibrary.js';

export {
  formData,
  listDataRecords,
  saveDataRecord,
  deleteDataRecord,
  patchRecordField,
  patchGroupInstanceField,
  recordSummary,
  summarizeItems,
  getGroupInstances,
  withGroupFields,
  getAnswer,
  getAnswers,
} from './collections/formData.js';

// Fixed sidebar/onboarding display order — must match clinuxflow-api's data/system-forms-library.json.
export const SYSTEM_FORM_IDS = [
  'system-provider-composition-v1',
  'system-patient-profile-v1',
  'system-encounter-composition-v1',
];

// LForms only properly tracks one "live" form instance per page for extraction purposes —
// rendering a second simultaneous addFormToPage() instance into a different container leaves
// the first one unextractable via getFormFHIRData afterwards. Render into one shared container
// reused across forms, same rule as clinixflow's system-forms.js.
export function renderBlank(questionnaire, containerId) {
  if (typeof window.LForms === 'undefined' || !questionnaire) return;
  window.LForms.Util.addFormToPage(questionnaire, containerId);
}

// mergeFHIRDataIntoLForms's second argument must already be in LForms' internal form-definition
// shape — a raw FHIR Questionnaire must go through convertQuestionnaireToLForms first, or the
// merge throws ("Cannot read properties of null, reading dataType"). Do not remove this step.
export function renderWithRecord(questionnaire, record, containerId) {
  if (typeof window.LForms === 'undefined' || !questionnaire || !record) {
    return renderBlank(questionnaire, containerId);
  }
  try {
    const lformsQuestionnaire = window.LForms.FHIR['R4'].SDC.convertQuestionnaireToLForms(questionnaire);
    const merged = window.LForms.Util.mergeFHIRDataIntoLForms(record.data, lformsQuestionnaire, 'R4');
    window.LForms.Util.addFormToPage(merged, containerId);
  } catch (err) {
    console.error('Failed to merge the saved record into the preview:', err);
    renderBlank(questionnaire, containerId);
  }
}

export function extractResponse(containerId) {
  if (typeof window.LForms === 'undefined') return null;
  try {
    return window.LForms.Util.getFormFHIRData('QuestionnaireResponse', 'R4', containerId);
  } catch (err) {
    console.error('Failed to read the entered data from the preview:', err);
    return null;
  }
}
