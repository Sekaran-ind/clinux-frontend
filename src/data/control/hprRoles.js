// Single source of truth for the real HPR (ABDM Healthcare Professional Registry) role
// vocabulary — createHprId's own `role` field is bound to exactly 3 values (see
// ClinuxFlowProviderRole.json's own PractitionerRole.code comment: 1=Healthcare Professional,
// 2=Facility Manager, 3=Healthcare Professional and Facility Manager).
//
// RegisterForm.vue's sign-up role picker and ProviderBasicsHost.vue's own "HPR Role" field on
// each staff member are the SAME real-world concept ("what kind of person is this") captured at
// two different moments — sign-up used to paraphrase it as its own drifted vocabulary ("Hospital
// Admin" / "Health Professional" / "Admin and Health Professional"), reading as a second,
// unrelated concept to someone who later fills in "HPR Role" as what looks like a different
// question with the same 3 answers. Found live, not hypothetical.
//
// `accountRole` is the stable internal enum this app's role-gating already keys on everywhere —
// onboardingJourneys.js's `roles` arrays, ClinicHome.vue's isFacilityRole/
// isHealthProfessionalRole, clinuxflow-api's accounts.role D1 column — deliberately UNCHANGED
// here (renaming it would be a real backend/gating migration, not a labeling fix); only the
// user-facing label/description is unified. Ordered to match the real HPR code table (1/2/3), not
// the old ad-hoc sign-up order — both places now present the identical vocabulary in the same
// order, not just the same words.
export const HPR_ROLES = [
  { accountRole: 'health_professional', label: 'Healthcare Professional', description: 'I work at a facility someone else runs.' },
  { accountRole: 'hospital_admin', label: 'Facility Manager', description: "I administer a facility's operations." },
  { accountRole: 'admin_and_health_professional', label: 'Healthcare Professional and Facility Manager', description: 'I run and practice at my own facility.' },
];

export const HPR_ROLE_LABELS = Object.fromEntries(HPR_ROLES.map((r) => [r.accountRole, r.label]));
export function hprRoleLabel(accountRole) { return HPR_ROLE_LABELS[accountRole] || accountRole; }

// Plain label list, same order as HPR_ROLES above — for PractitionerRole.code's own choice field
// (ProviderBasicsHost.vue's "HPR Role" column), a per-staff-member capture independent of who's
// logged in, so it reads from `label` only, never the account-role enum.
export const HPR_ROLE_CODE_CHOICES = HPR_ROLES.map((r) => r.label);
