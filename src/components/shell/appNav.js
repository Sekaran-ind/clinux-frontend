// AppShell.vue's sidebar, as plain data — split out for the same reason adaptiveSectionNav.js/
// registrationLedger.js are (no @vue/test-utils in this repo; plain logic gets a real test,
// components get verified by running the app).
//
// Grouped the way the Swastik ABDM Connector groups its console (Overview / day-to-day work /
// registries / tools), with ClinuxFlow's own destinations. Two kinds of item:
//   { to }   — a real route
//   { view } — one of ClinicHome's in-page clinic-operations views (stores/clinicView.js)
// badge is the small mono tag on the right (Swastik shows M1-M4 there; here it marks which ABDM
// registry an item feeds).
//
// Registries are never role-filtered: every account sees the HPR, HFR and Patient ABHA journeys
// (src/journeys/). Profiles (the facility/professional data-entry pages) keep their role gating.

const FACILITY_ROLES = ['hospital_admin', 'admin_and_health_professional'];
const PROFESSIONAL_ROLES = ['health_professional', 'admin_and_health_professional'];

// Same defensive default ClinicHome's showsHfrJourney/showsHprJourney use: a missing role shows
// both journeys rather than stranding a legitimate user with neither.
export function runsFacility(role) {
  return !role || FACILITY_ROLES.includes(role);
}
export function isProfessional(role) {
  return !role || PROFESSIONAL_ROLES.includes(role);
}

export const ROLE_LABELS = {
  hospital_admin: 'Hospital admin',
  health_professional: 'Health professional',
  admin_and_health_professional: 'Admin & health professional',
};

export function buildNavGroups({ role, hasActiveEncounter = false } = {}) {
  const facility = runsFacility(role);
  const professional = isProfessional(role);

  const groups = [
    {
      label: 'Overview',
      items: [
        // Everyone's landing page after sign-in, so never role-filtered.
        { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', to: '/dashboard' },
        facility && { key: 'clinic-page', label: 'Clinic page', icon: 'fa-hospital', view: 'public' },
        professional && { key: 'practitioner-home', label: 'My profile', icon: 'fa-id-badge', to: '/practitioner-home' },
      ],
    },
    {
      label: 'Clinic operations',
      items: [
        { key: 'front-desk', label: 'Front Desk', icon: 'fa-clipboard-user', view: 'front-desk' },
        { key: 'consultation-desk', label: 'Consultation Desk', icon: 'fa-stethoscope', view: 'consultation-desk' },
        {
          key: 'checkout', label: 'Checkout', icon: 'fa-receipt', view: 'checkout',
          // Checkout works on the active encounter only — same gate ClinicHome's old ops-nav used
          // (it hid the button); shown disabled here so the destination stays discoverable.
          disabled: !hasActiveEncounter,
          hint: hasActiveEncounter ? '' : 'Open a session at Front Desk first',
        },
        { key: 'patients', label: 'Patients', icon: 'fa-user-injured', to: '/patient-home' },
      ],
    },
    {
      label: 'Registries',
      items: [
        { key: 'registries', label: 'All registries', icon: 'fa-landmark', to: '/registries' },
        { key: 'registry-hpr', label: 'HPR ID', icon: 'fa-user-doctor', to: '/registries/hpr', badge: 'HPR' },
        { key: 'registry-hfr', label: 'Facility registration', icon: 'fa-hospital-user', to: '/registries/hfr', badge: 'HFR' },
        { key: 'registry-abha', label: 'Patient ABHA', icon: 'fa-id-card', to: '/registries/abha', badge: 'ABHA' },
      ],
    },
    {
      label: 'Profiles',
      items: [
        facility && { key: 'facility-profile', label: 'Facility profile', icon: 'fa-building', to: '/onboarding' },
        professional && { key: 'professional-profile', label: 'Professional profile', icon: 'fa-address-card', to: '/staff-onboarding' },
      ],
    },
    {
      // Every role sees these; what they show is scoped server-side (whole clinic vs. own activity).
      label: 'Operations',
      items: [
        { key: 'ops-activity', label: 'Activity log', icon: 'fa-wave-square', to: '/operations/activity' },
        { key: 'ops-abdm', label: 'ABDM transactions', icon: 'fa-right-left', to: '/operations/abdm-transactions' },
        { key: 'ops-access', label: 'Access & roles', icon: 'fa-user-shield', to: '/operations/access' },
      ],
    },
    {
      // Swastik's Account group, holding clinux-cubo/cubo-diary's Account & consents and Records.
      label: 'Account',
      items: [
        { key: 'account-consents', label: 'Consents', icon: 'fa-file-signature', to: '/account/consents' },
        { key: 'account-records', label: 'Records', icon: 'fa-folder-open', to: '/account/records' },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { key: 'cubo', label: 'Cübo workspace', icon: 'fa-comments', to: '/ai-engine' },
        facility && { key: 'designer', label: 'Forms library', icon: 'fa-layer-group', to: '/designer' },
      ],
    },
  ];

  return groups
    .map((g) => ({ ...g, items: g.items.filter(Boolean) }))
    .filter((g) => g.items.length);
}

// Which item is highlighted: a ClinicHome view item when ClinicHome is the current route
// (matched on the view), otherwise the route item whose path matches.
export function activeNavKey(groups, { routePath, routeName, clinicView }) {
  const items = groups.flatMap((g) => g.items);
  if (routeName === 'clinic-home') {
    return items.find((i) => i.view === clinicView)?.key ?? null;
  }
  return items.find((i) => i.to && i.to === routePath)?.key ?? null;
}
