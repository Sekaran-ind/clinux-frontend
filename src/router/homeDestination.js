// Pure decision logic for the "Home" nav link across the app — extracted the same way
// guardLogic.js's resolveGuard() is, so it's testable without a live router/localStorage. A
// registered clinic's "Home" is its own published page; everyone else's is the marketing index.
// Mirrors Index.vue's own goToClinic() check (the cf_clinic_profile signal), just unconditional
// (no login gate — goToClinic() is a login-gated CTA, this is a plain nav link) and with a
// different not-registered destination (index, not onboarding).
//
// role param added as a real bug fix: cf_clinic_profile is device-wide localStorage, not scoped
// to the current account, so a health_professional account on a device that had ever seen a
// published clinic (even someone else's, e.g. shared browser/prior test session) was routed to
// /clinic-home by this same "Home" link — a facility they have no relationship to. A pure
// practitioner's home is always /practitioner-home; only roles that can actually run a facility
// fall through to the clinic-profile check.
export function homeDestination(role, hasClinicProfile) {
  if (role === 'health_professional') return '/practitioner-home';
  return hasClinicProfile ? '/clinic-home' : '/';
}
