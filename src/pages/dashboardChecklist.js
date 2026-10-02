// Dashboard.vue's "Getting set up" checklist (the Swastik console's "Getting connected" card),
// derived from real profile state — split out as plain logic so it gets a real test (no
// @vue/test-utils in this repo).
//
// stage is onboarding.facilitySetupStage (facilitySetupMachine: draft / basics_saved /
// published / hfr_in_progress / hfr_registered); counts are the per-section instance counts
// Dashboard already computes from the Provider record. section is the Onboarding.vue section a
// step's "Set it up" link opens (/onboarding?section=...).

const PUBLISHED_STAGES = ['published', 'hfr_in_progress', 'hfr_registered'];

export function buildSetupChecklist({ stage = 'draft', counts = {} } = {}) {
  const n = (k) => counts[k] || 0;
  const steps = [
    {
      key: 'account', title: 'Create your account', done: true,
      text: 'Your sign-in for this clinic workspace.',
    },
    {
      key: 'facility', title: 'Save your facility details', done: stage !== 'draft',
      text: 'Name, type, address and contact details. Everything else in your profile hangs off this.',
      section: 'section_hospital',
    },
    {
      key: 'publish', title: 'Publish your clinic page', done: PUBLISHED_STAGES.includes(stage),
      text: 'Your public page goes live as soon as the facility details are complete.',
      section: 'section_hospital',
    },
    {
      key: 'hfr', title: 'Register the facility in HFR', done: stage === 'hfr_registered',
      text: stage === 'hfr_in_progress'
        ? 'Registration started. Finish it to get the facility its ABDM identity.'
        : 'The Health Facility Registry gives the facility its ABDM identity.',
      section: 'section_hospital',
    },
    {
      key: 'staff', title: 'Add your care team', done: n('staff') > 0,
      text: 'Doctors, nurses and front-desk staff who work here.',
      section: 'section_staff',
    },
    {
      key: 'services', title: 'List your services', done: n('services') > 0,
      text: 'Consultations, tests and procedures, with fees and durations.',
      section: 'section_services_matrix',
    },
    {
      key: 'hours', title: 'Set office hours', done: n('hours') > 0,
      text: 'When patients can walk in or book.',
      section: 'section_hours',
    },
    {
      key: 'consents', title: 'Add consent forms', done: n('consents') > 0,
      text: 'What patients agree to before their records are captured or shared.',
      section: 'section_consent',
    },
  ];
  return { steps, doneCount: steps.filter((s) => s.done).length, total: steps.length };
}
