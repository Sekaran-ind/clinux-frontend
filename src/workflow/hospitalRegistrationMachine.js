// SPEC-14 (docs/SPEC-14-HFSM-RUNTIME-AND-CHAT-FIRST-CAPTURE.md) §7 — the first hand-authored HFSM,
// built directly from HOSPITAL_FIELDS to prove the chat-first pattern before SPEC-13 §8 step 2's
// general PlanDefinition->machine compiler exists. Hierarchical on purpose: one parent (compound)
// state per display section, one child (atomic) state per field — SPEC-13 §2's Task.status is the
// room-level lifecycle this machine's overall `status` (running vs. `complete`) corresponds to;
// this file is what actually executes it for one room (Hospital registration).
//
// Deliberately framework-agnostic — no Pinia/Vue import here. This machine owns sequencing and
// captured values ONLY. ChatCapture.vue watches for the 'complete' state and performs the actual
// save itself, reusing HospitalOnboarding.vue's existing withGroupFields/saveDataRecord/publish
// path — same data pipe as the drawer flow, not a second one.
import { assign, createMachine } from 'xstate';
import { HOSPITAL_FIELDS, groupFieldsBySection } from '../data/abdmSchema.js';

function slug(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, '_');
}

export function buildHospitalRegistrationMachine(fields = HOSPITAL_FIELDS) {
  const sections = groupFieldsBySection(fields); // [{ section, fields: [...] }, ...]
  const flatFields = sections.flatMap((s) => s.fields);
  const flatIds = flatFields.map((f) => f.linkId);

  const nextFieldId = (linkId) => {
    const i = flatIds.indexOf(linkId);
    return i >= 0 && i < flatIds.length - 1 ? flatIds[i + 1] : null;
  };
  const prevFieldId = (linkId) => {
    const i = flatIds.indexOf(linkId);
    return i > 0 ? flatIds[i - 1] : null;
  };

  const states = {};
  sections.forEach((sec) => {
    const secId = slug(sec.section);
    const fieldStates = {};
    sec.fields.forEach((f) => {
      const prev = prevFieldId(f.linkId);
      const next = nextFieldId(f.linkId);
      fieldStates[f.linkId] = {
        id: `field_${f.linkId}`,
        entry: assign({ error: () => null, currentField: () => f.linkId }),
        on: {
          ANSWER: {
            actions: assign({
              values: ({ context, event }) => ({ ...context.values, [f.linkId]: event.value }),
            }),
          },
          NEXT: [
            {
              guard: ({ context }) => !f.required || !!(context.values[f.linkId] ?? '').toString().trim(),
              target: next ? `#field_${next}` : '#review',
            },
            { actions: assign({ error: () => `${f.label} is required.` }) },
          ],
          ...(prev ? { BACK: { target: `#field_${prev}` } } : {}),
        },
      };
    });
    states[secId] = { initial: sec.fields[0].linkId, states: fieldStates };
  });

  states.review = {
    id: 'review',
    entry: assign({ currentField: () => null }),
    on: {
      BACK: flatIds.length ? { target: `#field_${flatIds[flatIds.length - 1]}` } : undefined,
      CONFIRM: 'complete',
    },
  };
  states.complete = { id: 'complete', type: 'final' };

  return createMachine({
    id: 'hospitalRegistration',
    context: { values: {}, error: null, currentField: flatIds[0] || null },
    initial: slug(sections[0].section),
    states,
  });
}

export const hospitalRegistrationMachine = buildHospitalRegistrationMachine();

// Small selector helpers so ChatCapture.vue doesn't need to know this machine's internal shape.
export function fieldMetaFor(linkId, fields = HOSPITAL_FIELDS) {
  return fields.find((f) => f.linkId === linkId) || null;
}
export function isReview(snapshot) {
  return snapshot.matches('review');
}
export function isComplete(snapshot) {
  return snapshot.matches('complete');
}
export function orderedFieldIds(fields = HOSPITAL_FIELDS) {
  return groupFieldsBySection(fields).flatMap((s) => s.fields.map((f) => f.linkId));
}
