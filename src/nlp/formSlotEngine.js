// Auto-trains an NLP entity from every system form's field metadata (label/description/keywords
// — see formFieldHarvester.js) so Cübo can recognize which field a chat message refers to and
// auto-fill it, instead of the AiEngine.vue pattern this generalizes: a hand-coded switch with
// one case per hardcoded intent/linkId (see executeIntent() there). This is additive — it sits
// alongside classifyIntent() (nlp/intents.js) in Cubo.vue's send path, not a replacement for it
// or for the LLM scribe call.
//
// Scope, confirmed deliberately (not a default quietly chosen): recognition runs against every
// field across every system form regardless of which page Cübo is mounted on — not scoped to
// the current page/category. Real, accepted tradeoff: vocabulary collisions across forms (e.g.
// several fields share the literal label "Status" — encounter_status/rx_status/billing_status
// all do) and a fill can land on a field the current page isn't even displaying. Whichever
// field was registered last under a colliding trigger text wins the NER rule lookup.
//
// Same dynamic-import-and-fail-soft posture as aiEngineNlp.js/intents.js, for the same reason:
// @nlpjs/nlp's pinned alpha version has a fragile dependency graph under Vite's browser build.
import { harvestFieldMetadata } from './formFieldHarvester.js';
import { useClinicalStore } from '../stores/clinical.js';
import { withGroupFields, saveDataRecord, activeVersionNumber } from '../data/useSystemForms.js';

const ENTITY_NAME = 'formField';
let trainedPromise = null;
let fieldIndex = new Map(); // "formId::linkId" -> harvested field metadata

function optionKey(field) {
  return `${field.formId}::${field.linkId}`;
}

async function ensureTrained() {
  if (!trainedPromise) {
    trainedPromise = import('@nlpjs/nlp').then(({ Nlp }) => {
      const nlp = new Nlp({ languages: ['en'], forceNER: true, autoSave: false, nlu: { log: false } });

      const fields = harvestFieldMetadata();
      fieldIndex = new Map(fields.map((f) => [optionKey(f), f]));

      fields.forEach((field) => {
        const tokens = new Set(
          [field.label, ...field.keywords, field.description]
            .filter(Boolean)
            .map((t) => t.toLowerCase().trim())
            .filter(Boolean)
        );
        if (tokens.size === 0) return;
        nlp.addNerRuleOptionTexts('en', ENTITY_NAME, optionKey(field), Array.from(tokens));
      });

      return nlp.train().then(() => nlp);
    });
  }
  return trainedPromise;
}

// Called once at app startup (main.js) so training happens ahead of the first message rather
// than blocking the first send. Fails soft — a training failure just means no slot recognition
// this session, same posture as intents.js.
export function warmUp() {
  return ensureTrained().catch((err) => {
    console.warn('formSlotEngine: NLP training unavailable, slot-fill disabled this session:', err.message);
    trainedPromise = null;
    return null;
  });
}

// Exported for direct unit testing — not part of the module's real public surface otherwise.
export function extractValue(text, matchedText, field) {
  const lowerText = text.toLowerCase();
  const idx = lowerText.indexOf(matchedText.toLowerCase());
  const after = idx === -1 ? text : text.slice(idx + matchedText.length);

  if (field.type === 'decimal' || field.type === 'integer') {
    const m = after.match(/-?\d+(\.\d+)?/) || text.match(/-?\d+(\.\d+)?/);
    return m ? m[0] : null;
  }
  if ((field.type === 'choice' || field.type === 'open-choice') && field.choices.length) {
    const choice = field.choices.find((c) => lowerText.includes(c.toLowerCase()));
    return choice || null;
  }
  // Freeform: whatever follows the matched trigger phrase, up to sentence-ish punctuation, with
  // a leading connector word/punctuation stripped ("is", "to", ":", "=", ...).
  const cleaned = after.replace(/^[\s:,-]*\b(is|as|to|of|=)?\b[\s:,-]*/i, '').split(/[.;\n]/)[0].trim();
  return cleaned || null;
}

// Returns [{ formId, groupLinkId, linkId, value, confidence }] — one candidate per recognized
// field mention, or [] if the NLP engine failed to train or nothing matched.
export async function recognizeSlots(text) {
  const nlp = await ensureTrained().catch(() => null);
  if (!nlp) return [];

  const result = await nlp.process('en', text);
  const matches = (result.entities || []).filter((e) => e.entity === ENTITY_NAME);

  const candidates = [];
  matches.forEach((match) => {
    const field = fieldIndex.get(match.option);
    if (!field) return;
    const value = extractValue(text, match.sourceText || match.utteranceText || match.option, field);
    if (value === null || value === '') return;
    candidates.push({ formId: field.formId, groupLinkId: field.groupLinkId, linkId: field.linkId, value, confidence: match.accuracy ?? 0 });
  });
  return candidates;
}

// Applies recognized candidates to real records. Only the merged Encounter-composition record
// has a well-defined "current active record" today (clinical.getEncounter()) — Patient/Staff/
// other system forms don't have an equivalent shared "currently active" concept anywhere in this
// app (Front Desk tracks a selected patient in page-local state, for example), so fills for
// those forms come back as skipped rather than guessing at a record to write into. Returns what
// changed (and what didn't) for the caller — and, later, the separately-planned confirm-highlight
// UI — to show the user.
export function applyFills(candidates) {
  const clinical = useClinicalStore();
  const applied = [];
  const skipped = [];

  candidates.forEach((candidate) => {
    if (candidate.formId !== clinical.ENCOUNTER_FORM_ID) {
      skipped.push({ ...candidate, reason: 'no active-record resolver for this form yet' });
      return;
    }
    const encounter = clinical.getEncounter();
    if (!encounter) {
      skipped.push({ ...candidate, reason: 'no active encounter' });
      return;
    }
    const newData = withGroupFields(encounter.data, candidate.groupLinkId, { [candidate.linkId]: candidate.value });
    saveDataRecord(clinical.ENCOUNTER_FORM_ID, activeVersionNumber(clinical.ENCOUNTER_FORM_ID), newData, encounter.id);
    applied.push(candidate);
  });

  return { applied, skipped };
}
