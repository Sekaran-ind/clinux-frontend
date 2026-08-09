// Flattens every leaf field's metadata (label/description/keywords/type/choices/path) across a
// set of compiled system forms, for formSlotEngine.js to train NER vocabulary from. Generalizes
// Designer.vue's formFields()/findBlueprintItem() group-walk to multiple forms and to capture
// more per-field metadata than Designer's own (label + section only) version needs.
import { activeQuestionnaire, SYSTEM_FORM_IDS } from '../data/useSystemForms.js';

// item.definition is "http://hl7.org/{ResourceType}#{field.path}" (see yaml-to-questionnaire.js)
// — strip the prefix to recover the plain FHIR path.
function pathFromDefinition(definition) {
  if (!definition) return null;
  const hashIdx = definition.indexOf('#');
  return hashIdx === -1 ? null : definition.slice(hashIdx + 1);
}

function walkGroup(items, formId, groupLinkId, out) {
  (items || []).forEach((item) => {
    if (item.type === 'group' && item.item) {
      // Top-level composition blocks (Encounter/Vitals/SOAP/...) are the groups
      // withGroupFields() patches by linkId — track the innermost one a leaf field sits under.
      walkGroup(item.item, formId, item.linkId, out);
      return;
    }
    if (!item.linkId) return;
    out.push({
      formId,
      groupLinkId,
      linkId: item.linkId,
      path: pathFromDefinition(item.definition),
      label: item.text || '',
      description: item.description || '',
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      type: item.type,
      choices: Array.isArray(item.answerOption) ? item.answerOption.map((o) => o.valueString).filter(Boolean) : [],
    });
  });
}

// Returns a flat array of field-metadata records across every form in formIds. label is the
// only universally-populated metadata field today (93/93 fields across the system forms, vs.
// only a handful with description/keywords) — callers must treat it as the required primary
// vocabulary source, not description/keywords.
export function harvestFieldMetadata(formIds = SYSTEM_FORM_IDS) {
  const out = [];
  formIds.forEach((formId) => {
    const q = activeQuestionnaire(formId);
    if (q && q.item) walkGroup(q.item, formId, null, out);
  });
  return out;
}
