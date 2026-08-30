import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { buildHospitalRegistrationMachine, orderedFieldIds } from './hospitalRegistrationMachine.js';
import { HOSPITAL_FIELDS } from '../data/abdmSchema.js';

// SPEC-14 §7 — exercises the actual state transitions, not just that the file parses. A green
// build only proves syntax; this proves the HFSM behaves: required-field guards block advance,
// answered values land in context, the full sequence reaches 'complete' with every field captured.
describe('hospitalRegistrationMachine', () => {
  it('blocks NEXT on a required field left empty, and unblocks once answered', () => {
    const actor = createActor(buildHospitalRegistrationMachine()).start();
    expect(actor.getSnapshot().context.currentField).toBe('hospital_name'); // first field, required

    actor.send({ type: 'NEXT' }); // no answer yet
    expect(actor.getSnapshot().context.currentField).toBe('hospital_name'); // still blocked
    expect(actor.getSnapshot().context.error).toBeTruthy();

    actor.send({ type: 'ANSWER', value: 'Malar Hospital' });
    actor.send({ type: 'NEXT' });
    expect(actor.getSnapshot().context.currentField).toBe('hospital_legalname'); // advanced
  });

  it('lets an optional field advance with no answer', () => {
    const actor = createActor(buildHospitalRegistrationMachine()).start();
    actor.send({ type: 'ANSWER', value: 'Malar Hospital' });
    actor.send({ type: 'NEXT' }); // -> hospital_legalname (optional)
    actor.send({ type: 'NEXT' }); // no answer, should still advance
    expect(actor.getSnapshot().context.currentField).toBe('hospital_type');
  });

  it('crosses a section boundary correctly (Basics/Contact&Address are both section_hospital, but different display sections)', () => {
    const actor = createActor(buildHospitalRegistrationMachine()).start();
    const ids = orderedFieldIds();
    const contactAddressStart = ids.indexOf('hospital_address');
    expect(contactAddressStart).toBeGreaterThan(0);
    // walk from the start up to (not including) hospital_address
    for (let i = 0; i < contactAddressStart; i++) {
      const field = HOSPITAL_FIELDS.find((f) => f.linkId === ids[i]);
      if (field.required) actor.send({ type: 'ANSWER', value: 'x' });
      actor.send({ type: 'NEXT' });
    }
    expect(actor.getSnapshot().context.currentField).toBe('hospital_address');
  });

  it('BACK returns to the previous field without losing its previously captured value', () => {
    const actor = createActor(buildHospitalRegistrationMachine()).start();
    actor.send({ type: 'ANSWER', value: 'Malar Hospital' });
    actor.send({ type: 'NEXT' });
    actor.send({ type: 'BACK' });
    expect(actor.getSnapshot().context.currentField).toBe('hospital_name');
    expect(actor.getSnapshot().context.values.hospital_name).toBe('Malar Hospital');
  });

  it('walks every field end to end and reaches review then complete, LGD fields required as select', () => {
    const actor = createActor(buildHospitalRegistrationMachine()).start();
    const ids = orderedFieldIds();
    ids.forEach((linkId) => {
      const field = HOSPITAL_FIELDS.find((f) => f.linkId === linkId);
      if (field.required) {
        const value = field.type === 'select' ? field.options[0].value : field.type === 'checkbox' ? 'true' : 'demo value';
        actor.send({ type: 'ANSWER', value });
      }
      actor.send({ type: 'NEXT' });
    });
    expect(actor.getSnapshot().matches('review')).toBe(true);

    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().matches('complete')).toBe(true);
    expect(actor.getSnapshot().value).toBe('complete');
  });

  it('LGD state/district fields are select-typed with non-numeric demo codes, not free text (Defect 4 fix)', () => {
    const state = HOSPITAL_FIELDS.find((f) => f.linkId === 'hospital_state_lgd_code');
    const district = HOSPITAL_FIELDS.find((f) => f.linkId === 'hospital_district_lgd_code');
    expect(state.type).toBe('select');
    expect(district.type).toBe('select');
    expect(state.options.every((o) => /-DEMO$/.test(o.value))).toBe(true);
    expect(district.options.every((o) => /-DEMO$/.test(o.value))).toBe(true);
  });
});
