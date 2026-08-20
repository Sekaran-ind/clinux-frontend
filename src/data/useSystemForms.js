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
  journeyFormIds,
} from './collections/formsLibrary.js';

export {
  formData,
  listDataRecords,
  saveDataRecord,
  deleteDataRecord,
  patchRecordField,
  patchGroupInstanceField,
  appendGroupInstance,
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

// LForms' coded/autocomplete widget (rendered for any 'choice'/'open-choice' item -- Dropdown,
// MultiSelect, and Autocomplete uiComponents all end up here, DOM class "lhc-datatype-CODING")
// only commits a typed value to its internal model when the typed text is either (a) an EXACT
// string match against one of the field's answer options, confirmed on blur with no click
// needed, or (b) a dropdown suggestion is explicitly clicked. Anything else -- the realistic case
// of a user typing a partial search term and moving to the next field, exactly how an autocomplete
// widget invites you to use it -- is silently discarded, and worse than just "not saved": live-
// confirmed via Designer.vue, the widget's own blur handler actively WIPES the input's DOM value
// back to empty the instant it loses focus with no match, so by the time anything downstream
// (getFormFHIRData, or a naive "read the input's value" recovery) gets to look, the text is
// already gone -- not merely uncommitted. Typing the full exact "Hypertension" (a real answer
// option) instead saved correctly with no click needed at all, confirming this is specifically an
// exact-match-or-explicit-click requirement, not a blanket "typing never works" one. This is the
// same failure class documented in the clinux-lforms-coded-field-data-loss-bug memory note (found
// via StaffOnboarding.vue's old LForms-based Specialty field, a MultiSelect) -- StaffOnboarding.vue
// itself was fixed by moving Staff registration off LForms entirely (see SPEC-09), but Encounter/
// Vitals/custom clinic-authored forms legitimately still need LForms for their arbitrary, clinic-
// defined structure, so the fix here has to work WITH the generic system, not replace it.
//
// Since the value is gone from the DOM by blur, the only place left to catch it is DURING the
// blur event itself, before the widget's own handler (bound directly to the input, fires at the
// DOM's target phase) runs. A capturing listener on an ANCESTOR (this shared container) is
// guaranteed by the DOM event spec to run during the capture phase, which completes in full
// before target-phase listeners on the input itself -- so it reliably sees the real typed value
// first. attachCodedFieldRecovery() wires this up once per container; recoverDiscardedCodedField-
// Values() (called from extractResponse()) then grafts whatever it caught into the extracted
// response tree, but ONLY where the real extraction still came back empty -- a properly confirmed
// answer (typed exact match, or a clicked suggestion) is never second-guessed or overwritten.
//
// A coded field with an unconfirmed value isn't just missing its *answer* -- LForms prunes the
// whole lhc-item node from getFormFHIRData's output when it has nothing it considers a committed
// value (live-confirmed: a group containing an answered plain-text field alongside an unconfirmed
// coded field extracts with the coded field's entire item node absent, not present-with-no-
// answer). So recovery has to reconstruct and graft a whole node, not just patch an existing
// answer -- LForms' own DOM id convention gives the exact nested position for free: every
// rendered lhc-item/lhc-item-group carries `id="item-<linkId>/<instanceNumber>/<pos>"`, where
// <instanceNumber> is the item's 1-based occurrence among siblings sharing that linkId --
// precisely the index needed to disambiguate a repeating group's Nth instance (e.g. a repeating
// Staff block's 2nd entry) rather than always grafting onto the first.
// Exported for unit testing (useSystemForms.test.js) -- pure DOM/tree logic, no window.LForms
// dependency, so it's testable without a real LForms instance.
export function domItemPath(node, container) {
  const path = [];
  let el = node;
  while (el && el !== container) {
    if (el.id && el.id.startsWith('item-')) {
      const parts = el.id.replace(/^item-/, '').split('/');
      const instanceIndex = Math.max(0, (parseInt(parts[1], 10) || 1) - 1);
      path.unshift({ linkId: parts[0], instanceIndex });
    }
    el = el.parentElement;
  }
  return path;
}

function attachCodedFieldRecovery(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // A fresh form just got loaded into this (reused) container -- whatever was pending from
  // whatever was rendered here before is no longer relevant.
  container._pendingCodedRecoveries = new Map(); // codedNode.id -> { path, typed }
  if (container.dataset.codedFieldRecoveryAttached) return; // listener itself only needs attaching once
  container.dataset.codedFieldRecoveryAttached = 'true';

  container.addEventListener('focusout', (event) => {
    const input = event.target;
    const codedNode = input.closest && input.closest('.lhc-datatype-CODING');
    if (!codedNode || input.tagName !== 'INPUT' || input.type !== 'text') return;
    const typed = (input.value || '').trim();
    // Deliberately never clear a pending entry just because THIS blur's value is empty: the
    // widget's own clearing of a non-matching value fires its own follow-up blur/focus cycle
    // (live-confirmed: a real capture immediately followed by a second focusout on the same
    // input with value="") which would otherwise wipe out the exact value we're here to save.
    // Only ever overwrite with a new NON-empty typed value.
    if (!typed) return;
    container._pendingCodedRecoveries.set(codedNode.id, { path: domItemPath(codedNode, container), typed });
  }, true); // capture: must observe the value before the widget's own (target-phase) blur handler can clear it
}

export function recoverDiscardedCodedFieldValues(containerId, response) {
  const container = document.getElementById(containerId);
  const pending = container?._pendingCodedRecoveries;
  if (!pending || pending.size === 0 || !response) return;

  if (!Array.isArray(response.item)) response.item = [];
  pending.forEach(({ path, typed }) => {
    let level = response.item;
    path.forEach(({ linkId, instanceIndex }, i) => {
      const siblings = level.filter((it) => it.linkId === linkId);
      let entry = siblings[instanceIndex];
      if (!entry) {
        entry = { linkId };
        level.push(entry); // missing instance -- best-effort append rather than dropping it
      }
      if (i === path.length - 1) {
        // A field with its own repeats:true (MultiSelect's chip-style multi-pick) can carry
        // several already-confirmed answers alongside one unconfirmed typed leftover -- only
        // fill in when there's truly nothing recorded yet, never overwrite a real, confirmed one.
        if (!entry.answer || entry.answer.length === 0) {
          entry.answer = [{ valueString: typed }];
        }
      } else {
        if (!Array.isArray(entry.item)) entry.item = [];
        level = entry.item;
      }
    });
  });
}

// LForms only properly tracks one "live" form instance per page for extraction purposes —
// rendering a second simultaneous addFormToPage() instance into a different container leaves
// the first one unextractable via getFormFHIRData afterwards. Render into one shared container
// reused across forms, same rule as clinixflow's system-forms.js.
export function renderBlank(questionnaire, containerId) {
  if (typeof window.LForms === 'undefined' || !questionnaire) return;
  window.LForms.Util.addFormToPage(questionnaire, containerId);
  attachCodedFieldRecovery(containerId);
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
    attachCodedFieldRecovery(containerId);
  } catch (err) {
    console.error('Failed to merge the saved record into the preview:', err);
    renderBlank(questionnaire, containerId);
  }
}

export function extractResponse(containerId) {
  if (typeof window.LForms === 'undefined') return null;
  try {
    const response = window.LForms.Util.getFormFHIRData('QuestionnaireResponse', 'R4', containerId);
    recoverDiscardedCodedFieldValues(containerId, response);
    return response;
  } catch (err) {
    console.error('Failed to read the entered data from the preview:', err);
    return null;
  }
}
