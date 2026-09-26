// ProviderHprPanel.vue's own stage-gating logic for RegistrationLedger — the Provider/HPR
// counterpart to facilityHfrJourney.js (see that file's own header for the "genuine technical
// prerequisite, never an invented screen order" discipline this mirrors exactly). Split into a
// pure, testable function for the same reason: no @vue/test-utils in this repo, components get
// verified by running the app, plain logic like this by a real test.
//
// Real HPR technical dependencies (per clinuxflow-abdm-gateway/src/routes/hpr.js and
// abdmAdapter.js's own buildHprCreateBody/buildHprRegisterProfessionalBody):
//   - Identity Verification (Aadhaar OTP -> account-check -> mobile confirm/OTP -> HPID
//     suggestions, all still one internal micro-step sequence inside this one stage's own slot —
//     same "one stage, several internal actions" shape FacilityHfrPanel.vue's own Basic
//     Information stage already uses): needs hpCategoryCode/hpSubCategoryCode/stateCode/
//     districtCode already saved on Personal Details — createHprIdWithPreVerified 400s without
//     them. Real gap found live: the old flat step machine let a user complete the entire
//     Aadhaar/OTP dance before ever discovering this, only failing at the very last step.
//   - Create HPR Account: needs Identity Verification's own HPID suggestions to already exist
//     (there must be something to select).
//   - Preview Profile: needs a created HPR ID (there must be an account to attach a full profile
//     submission to). Purely a review step — no ABDM API of its own, same role Facility's own
//     Public Display Settings stage plays.
//   - Attestation & e-Sign: needs Preview to be confirmed. Not a technical API dependency (the
//     real register-professional-new call needs nothing Preview itself produces) but the one
//     deliberate exception this file makes to "gate only on genuine API prerequisites" — signing a
//     submission the professional never actually reviewed is a real risk the manual's own Step
//     19-21 ordering exists specifically to prevent.
//   - Submitted: terminal.
function computeState(done, blocked) {
  return done ? 'done' : blocked ? 'blocked' : 'active';
}

export function deriveLedgerStages({
  categoryReady, hpidSuggestionsReady, createdHprId, previewConfirmed, fullProfileSubmitted,
} = {}) {
  const hasHprId = !!createdHprId;
  const identityDone = !!hpidSuggestionsReady || hasHprId;

  return [
    {
      id: 'identity', label: 'Identity Verification', icon: 'fa-fingerprint',
      state: computeState(identityDone, !categoryReady),
      lockedReason: !categoryReady ? 'Save your HP Category, Sub-Category, State and District on Personal Details first.' : undefined,
    },
    {
      id: 'account', label: 'Create HPR Account', icon: 'fa-user-check',
      state: computeState(hasHprId, !identityDone),
      lockedReason: !identityDone ? 'Complete Identity Verification first — this needs your HPID suggestions.' : undefined,
    },
    {
      id: 'preview', label: 'Preview Profile', icon: 'fa-eye',
      state: computeState(!!previewConfirmed, !hasHprId),
      lockedReason: !hasHprId ? 'Create your HPR account first — there needs to be a profile to preview.' : undefined,
    },
    {
      id: 'attestation', label: 'Attestation & e-Sign', icon: 'fa-file-signature',
      state: computeState(!!fullProfileSubmitted, !previewConfirmed),
      lockedReason: !previewConfirmed ? 'Review your Preview Profile first.' : undefined,
    },
    {
      id: 'submitted', label: 'Submitted', icon: 'fa-circle-check',
      state: fullProfileSubmitted ? 'done' : 'blocked',
      lockedReason: !fullProfileSubmitted ? 'Sign and submit to reach this stage.' : undefined,
    },
  ];
}

// The stage a caller should land on right after a given stage's action succeeds.
export function nextStageAfter(stageId) {
  const order = ['identity', 'account', 'preview', 'attestation', 'submitted'];
  const i = order.indexOf(stageId);
  return i === -1 || i === order.length - 1 ? stageId : order[i + 1];
}

// Where to open a returning/reloaded session — the first stage that isn't already done. Unlike
// facilityHfrJourney.js's own currentStageFor, categoryReady is a real PERSISTED fact (Personal
// Details' own saved fields), not a transient never-persisted credential like Facility's
// managerToken — so it's passed through as-is here, never forced to true.
export function currentStageFor({ categoryReady, hpidSuggestionsReady, createdHprId, previewConfirmed, fullProfileSubmitted } = {}) {
  const stages = deriveLedgerStages({ categoryReady, hpidSuggestionsReady, createdHprId, previewConfirmed, fullProfileSubmitted });
  const frontier = stages.find((s) => s.state !== 'done');
  return frontier ? frontier.id : 'submitted';
}

// Real ABDM HPR error bodies flow through the same generic gateway-client shape HFR's own
// parseAbdmErrorDetails already documents (abdmGatewayClient.js's uniform {success, error,
// abdmStatus, abdmBody} across every route). Deliberately a SMALLER hint vocabulary than
// facilityHfrJourney.js's own FIELD_HINTS: several real HPR fields (hpCategoryCode, Role,
// Qualifications, currentWorkDetails) live on OTHER page tabs (Personal Details/Qualifications/
// Work Experience), not inside this panel at all, so there is no in-panel stage a "Fix in X" jump
// button could honestly point to for them — those are left as plain messages, no stageId. Only
// fields that genuinely live inside one of THIS panel's own ledger stages get a jump hint.
const FIELD_HINTS = [
  { pattern: /aadhaar/i, stageId: 'identity', label: 'Identity Verification' },
  { pattern: /mobile/i, stageId: 'identity', label: 'Identity Verification' },
  { pattern: /\botp\b/i, stageId: 'identity', label: 'Identity Verification' },
  { pattern: /hprid|hp.?id\b/i, stageId: 'account', label: 'Create HPR Account' },
  { pattern: /password/i, stageId: 'account', label: 'Create HPR Account' },
  { pattern: /\bemail\b/i, stageId: 'account', label: 'Create HPR Account' },
];

// Returns [{ message, stageId, label } | { message }] — same shape as
// facilityHfrJourney.js's own parseAbdmErrorDetails, reused verbatim by ProviderHprPanel.vue.
export function parseAbdmErrorDetails(res) {
  const rawMessages = Array.isArray(res?.abdmBody?.details) && res.abdmBody.details.length
    ? res.abdmBody.details.map((d) => d.message).filter(Boolean)
    : [res?.abdmBody?.message || res?.error].filter(Boolean);

  return rawMessages.map((message) => {
    const hint = FIELD_HINTS.find((h) => h.pattern.test(message));
    return hint ? { message, stageId: hint.stageId, label: hint.label } : { message };
  });
}
