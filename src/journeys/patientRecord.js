// Writes a verified ABHA onto a patient's local record — the same QuestionnaireResponse shape
// PatientBasicsHost.vue's extract() produces (one `section_patient` group, flat items), so
// PatientHome's directory/edit screens read it with no changes. Pure, so it gets a real test.
//
// The ABHA number and address always take the verified values. Everything else (name, gender,
// date of birth, mobile) is only filled in where the record is blank: what the clinic typed
// in is never overwritten by ABDM's copy — same rule PatientBasicsHost's onAbhaLinked() follows
// for empty fields.
export const PATIENT_FORM_ID = 'system-patient-profile-v1';
const GROUP = 'section_patient';

const answerOf = (items, linkId) => {
  const a = items.find((i) => i.linkId === linkId)?.answer?.[0];
  return a ? Object.values(a)[0] : undefined;
};

export function mergeAbhaIntoPatientResponse(existing, person) {
  const group = (existing?.item || []).find((i) => i.linkId === GROUP);
  const items = (group?.item || []).map((i) => ({ ...i }));
  const set = (linkId, value, key = 'valueString', { overwrite = false } = {}) => {
    if (value === undefined || value === null || value === '') return;
    const blank = [undefined, null, ''].includes(answerOf(items, linkId));
    if (!overwrite && !blank) return;
    const at = items.findIndex((i) => i.linkId === linkId);
    const item = { linkId, answer: [{ [key]: value }] };
    if (at >= 0) items[at] = item; else items.push(item);
  };
  set('patient_abha_number', person.abhaNumber, 'valueString', { overwrite: true });
  set('patient_abha_address', person.abhaAddress, 'valueString', { overwrite: true });
  set('patient_first_name', person.firstName);
  set('patient_last_name', person.lastName);
  set('patient_gender', person.gender);
  set('patient_birthdate', person.birthDate, 'valueDate');
  set('patient_mobile', person.mobile);
  if (answerOf(items, 'patient_active') === undefined) set('patient_active', true, 'valueBoolean');
  // patient_name is the legacy combined linkId PatientBasicsHost also derives — kept in step.
  const fullName = [answerOf(items, 'patient_first_name'), answerOf(items, 'patient_last_name')].filter(Boolean).join(' ');
  set('patient_name', fullName, 'valueString', { overwrite: true });

  const others = (existing?.item || []).filter((i) => i.linkId !== GROUP);
  return { resourceType: 'QuestionnaireResponse', status: 'completed', ...(existing || {}), item: [{ linkId: GROUP, item: items }, ...others] };
}
