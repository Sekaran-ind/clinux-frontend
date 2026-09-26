// FacilityStatusCard.vue's own pure mapping from facilitySetupMachine's single combined stage
// string (draft/basics_saved/published/hfr_in_progress/hfr_registered) to the two independent
// pills the card actually shows — split out for the same reason adaptiveSectionNav.js/
// registrationLedger.js are (no @vue/test-utils in this repo; plain logic gets a real test,
// components get verified by running the app).

const BASICS_PILL = {
  draft: { text: 'Not started', tone: 'muted' },
  basics_saved: { text: 'Saved — not published', tone: 'amber' },
  published: { text: 'Published', tone: 'teal' },
  hfr_in_progress: { text: 'Published', tone: 'teal' },
  hfr_registered: { text: 'Published', tone: 'teal' },
};

const ABDM_PILL = {
  draft: { text: 'Not started', tone: 'muted' },
  basics_saved: { text: 'Not started', tone: 'muted' },
  published: { text: 'Not started', tone: 'muted' },
  hfr_in_progress: { text: 'In progress', tone: 'amber' },
  hfr_registered: { text: 'Registered', tone: 'teal' },
};

export function facilityStatusPills(stage) {
  return {
    basics: BASICS_PILL[stage] || BASICS_PILL.draft,
    abdm: ABDM_PILL[stage] || ABDM_PILL.draft,
  };
}

// "Continue ABDM Registration ->" only makes sense once there's a real profile to register
// (hasBasics is true, i.e. anything past 'draft') and ABDM registration hasn't already finished.
// Deliberately not gated stricter than that (e.g. requiring 'published') — FacilityHfrPanel.vue's
// own UI never technically blocks starting HFR before publishing, so hiding this button earlier
// than the feature it links to actually becomes available would be a real inconsistency.
export function canContinueHfr(stage) {
  return stage === 'basics_saved' || stage === 'published' || stage === 'hfr_in_progress';
}
