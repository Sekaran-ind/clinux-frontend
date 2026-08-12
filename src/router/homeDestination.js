// Pure decision logic for the "Home" nav link across the app — extracted the same way
// guardLogic.js's resolveGuard() is, so it's testable without a live router/localStorage. A
// registered clinic's "Home" is its own published page; everyone else's is the marketing index.
// Mirrors Index.vue's own goToClinic() check (the cf_clinic_profile signal), just unconditional
// (no login gate — goToClinic() is a login-gated CTA, this is a plain nav link) and with a
// different not-registered destination (index, not onboarding).
export function homeDestination(hasClinicProfile) {
  return hasClinicProfile ? '/clinic-home' : '/';
}
