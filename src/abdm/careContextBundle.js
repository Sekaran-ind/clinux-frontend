// A closed visit as the FHIR document ABDM exchanges: an OPConsultRecord DocumentBundle (ABDM
// FHIR IG, nrces.in/ndhm/fhir/r4; section codes from its OPConsultRecord StructureDefinition, layout
// after its Bundle-OPConsultNote example). This is what the gateway stores as a care context when
// staff share a visit to the patient's ABHA, and serves (encrypted) to a HIU with the patient's
// consent. Pure, so it is tested directly.
//
// The visit is the Encounter composition record (clinuxflow-api system-encounter-composition-v1:
// section_encounter / vitals / soap / prescription), the patient the patient-profile record.
const NDHM = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/';
const SCT = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';

const uuid = () => crypto.randomUUID();
const ref = (entry, display) => ({ reference: entry.fullUrl, ...(display ? { display } : {}) });
const section = (title, code, display, entries) => (entries.length ? { title, code: { coding: [{ system: SCT, code, display }] }, entry: entries.map((e) => ({ reference: e.fullUrl })) } : null);
const GENDER = { m: 'male', male: 'male', f: 'female', female: 'female', o: 'other', other: 'other' };

const answerOf = (a) => {
  if (!a) return '';
  if (a.valueCoding) return a.valueCoding.display || a.valueCoding.code || '';
  for (const k of ['valueString', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime']) if (a[k] !== undefined && a[k] !== null) return String(a[k]);
  if (a.valueQuantity) return String(a.valueQuantity.value);
  return '';
};
/** Every instance of a section (repeating ones have several), as { linkId: value } maps. */
function instances(record, group) {
  const out = [];
  for (const g of record?.data?.item || []) {
    if (g.linkId !== group) continue;
    const values = {};
    const walk = (items) => (items || []).forEach((i) => { if (i.answer?.[0] && !(i.linkId in values)) values[i.linkId] = answerOf(i.answer[0]); walk(i.item); });
    walk(g.item);
    out.push(values);
  }
  return out;
}

/**
 * @param {object} p
 * @param {object} p.encounter      the visit's record ({ id, data: QuestionnaireResponse, updatedAt? })
 * @param {object} p.patient        { id, name, gender, birthDate, mobile, abhaNumber, abhaAddress }
 * @param {object} p.facility       { id (HFR id), name }
 * @param {object} [p.practitioner] { name, hprId }
 * @param {string} [p.date]         when the visit happened (ISO)
 */
export function opConsultBundle({ encounter, patient, facility, practitioner = {}, date = new Date().toISOString() }) {
  const entry = (resource) => ({ fullUrl: `urn:uuid:${uuid()}`, resource });
  const enc0 = instances(encounter, 'section_encounter')[0] || {};
  const soap = instances(encounter, 'section_soap')[0] || {};
  const vitals = instances(encounter, 'section_vitals');
  const meds = instances(encounter, 'section_prescription').filter((m) => m.rx_medication);

  const pat = entry({
    resourceType: 'Patient',
    meta: { profile: [`${NDHM}Patient`] },
    identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] }, system: `https://clinux.yaxb.ai/facility/${facility.id}/patient`, value: patient.id }],
    name: [{ text: patient.name }],
    ...(patient.mobile ? { telecom: [{ system: 'phone', value: patient.mobile, use: 'mobile' }] } : {}),
    ...(GENDER[String(patient.gender || '').toLowerCase()] ? { gender: GENDER[String(patient.gender).toLowerCase()] } : {}),
    ...(patient.birthDate ? { birthDate: patient.birthDate } : {}),
  });
  const org = entry({
    resourceType: 'Organization',
    meta: { profile: [`${NDHM}Organization`] },
    identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }] }, system: 'https://facility.ndhm.gov.in', value: facility.id }],
    name: facility.name || facility.id,
  });
  const doc = entry({
    resourceType: 'Practitioner',
    meta: { profile: [`${NDHM}Practitioner`] },
    identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MD', display: 'Medical License number' }] }, system: 'https://doctor.ndhm.gov.in', value: practitioner.hprId || 'unknown' }],
    name: [{ text: practitioner.name || facility.name || 'Clinician' }],
  });
  const enc = entry({
    resourceType: 'Encounter',
    meta: { profile: [`${NDHM}Encounter`] },
    identifier: [{ system: `https://clinux.yaxb.ai/facility/${facility.id}/encounter`, value: encounter.id }],
    status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: ref(pat, patient.name),
    period: { start: date },
    serviceProvider: ref(org),
  });
  const subject = ref(pat, patient.name);
  const observation = (text, value, extra = {}) => entry({ resourceType: 'Observation', meta: { profile: [`${NDHM}Observation`] }, status: 'final', code: { text }, subject, effectiveDateTime: date, valueString: value, ...extra });

  const complaints = enc0.encounter_chief_complaint
    ? [entry({ resourceType: 'Condition', meta: { profile: [`${NDHM}Condition`] }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] }, code: { text: enc0.encounter_chief_complaint }, subject, recordedDate: date })]
    : [];

  const exam = [];
  vitals.forEach((v) => {
    const vital = (code, display, value, unit, ucum) => exam.push(entry({
      resourceType: 'Observation', meta: { profile: [`${NDHM}ObservationVitalSigns`] }, status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: LOINC, code, display }], text: display }, subject, effectiveDateTime: date,
      valueQuantity: { value: Number(value), unit, system: 'http://unitsofmeasure.org', code: ucum },
    }));
    if (v.vitals_systolic && v.vitals_diastolic) {
      exam.push(entry({
        resourceType: 'Observation', meta: { profile: [`${NDHM}ObservationVitalSigns`] }, status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
        code: { coding: [{ system: LOINC, code: '85354-9', display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' }, subject, effectiveDateTime: date,
        component: [
          { code: { coding: [{ system: LOINC, code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: Number(v.vitals_systolic), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
          { code: { coding: [{ system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: Number(v.vitals_diastolic), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
        ],
      }));
    }
    if (v.vitals_pulse) vital('8867-4', 'Heart rate', v.vitals_pulse, 'beats/minute', '/min');
    if (v.vitals_temperature) vital('8310-5', 'Body temperature', v.vitals_temperature, 'degF', '[degF]');
  });
  if (soap.soap_objective) exam.push(observation('Examination findings', soap.soap_objective));

  const other = [
    soap.soap_subjective && observation('History of present illness', soap.soap_subjective),
    soap.soap_assessment && observation('Clinical assessment', soap.soap_assessment),
    soap.soap_plan && observation('Plan of care', soap.soap_plan),
  ].filter(Boolean);

  const medications = meds.map((m) => entry({
    resourceType: 'MedicationRequest', meta: { profile: [`${NDHM}MedicationRequest`] },
    status: ['active', 'completed', 'cancelled'].includes(m.rx_status) ? m.rx_status : 'active', intent: 'order',
    medicationCodeableConcept: { text: m.rx_medication }, subject, authoredOn: date, requester: ref(doc, practitioner.name),
    ...(m.rx_dosage ? { dosageInstruction: [{ text: m.rx_dosage }] } : {}),
  }));

  const sections = [
    section('Chief complaints', '422843007', 'Chief complaint section', complaints),
    section('Physical examination', '425044008', 'Physical exam section', exam),
    section('Medications', '721912009', 'Medication summary document', medications),
    section('Other observations', '404684003', 'Clinical finding', other),
  ].filter(Boolean);

  const composition = entry({
    resourceType: 'Composition',
    meta: { profile: [`${NDHM}OPConsultRecord`] },
    language: 'en-IN',
    identifier: { system: `https://clinux.yaxb.ai/facility/${facility.id}/document`, value: encounter.id },
    status: 'final',
    type: { coding: [{ system: SCT, code: '371530004', display: 'Clinical consultation report' }], text: 'Clinical Consultation report' },
    subject: ref(pat, patient.name),
    encounter: ref(enc),
    date,
    author: [ref(doc, practitioner.name)],
    title: 'Consultation Report',
    custodian: ref(org, facility.name),
    section: sections,
  });

  return {
    resourceType: 'Bundle',
    meta: { profile: [`${NDHM}DocumentBundle`], security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'V', display: 'very restricted' }] },
    identifier: { system: 'https://clinux.yaxb.ai/fhir/bundle', value: uuid() },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [composition, pat, doc, org, enc, ...complaints, ...exam, ...medications, ...other],
  };
}

/** A visit's bills as Scan & Pay procedures: each unpaid invoice of the visit, as an OPD consultation item. */
export function billProcedures(encounter, { patientName } = {}) {
  const unpaid = instances(encounter, 'section_billing').filter((b) => Number(b.billing_total) > 0 && !['balanced', 'cancelled'].includes(String(b.billing_status || '').toLowerCase()));
  if (!unpaid.length) return [];
  return [{
    category: 'OPD consultation',
    services: unpaid.map((b, n) => ({ serviceId: `${encounter.id}-${n + 1}`, name: unpaid.length > 1 ? `Visit charges (${n + 1})` : 'Visit charges', description: `${patientName ? `${patientName} · ` : ''}visit ${encounter.id}`, amount: Number(b.billing_total) })),
  }];
}
