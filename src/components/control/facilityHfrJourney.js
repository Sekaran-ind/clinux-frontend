// FacilityHfrPanel.vue's own stage-gating logic for RegistrationLedger, split into a pure,
// testable function — the same "logic in a plain .js sibling, components verified by running the
// app" split adaptiveSectionNav.js/registrationLedger.js/facilityStatusCard.js already establish
// (no @vue/test-utils in this repo).
//
// REBUILT after a real bug a live user hit: the original version gated every stage on the ONE
// BEFORE it in the manual's own screen order (search -> basic -> additional -> detailed -> ...),
// treating that as if it were a technical dependency chain. It wasn't. The real ABDM API's own
// dependencies are much looser: Search itself needs ownershipCode/stateLGDCode/facilityName —
// fields the OLD ledger locked behind Search succeeding first, a genuine deadlock (confirmed live:
// HIS-1070 "Required OwnershipCode Field is empty" on a Search call, with nowhere to enter it).
// And per clinuxflow-abdm-gateway/src/routes/hfr.js's own real contract, Additional Information
// and Detailed Information each need ONLY a trackingId — neither needs the OTHER to have
// succeeded first; they were never actually sequential.
//
// Gating now encodes ONLY genuine technical prerequisites (a real HTTP 400 the gateway itself
// would return without it), never an invented "finish this screen before that one" order:
//   - Basic Information: needs the Facility Manager's HPR login (X-HPRID-Auth-Token).
//   - Additional Information / Detailed Information: each needs a trackingId (from Basic
//     Information) — independent of each other, so either can be done first, or in any order.
//   - Public Display Settings: no ABDM API of its own — never blocked.
//   - Attestation & e-Sign: needs a trackingId (there must be something to submit).
//   - Submitted: terminal.
// Search is no longer a separate stage — it's a "check for duplicates" action inside Basic
// Information itself, using whatever the manager has already typed on that same screen, so the
// exact fields it needs are right there, never locked behind themselves.
function computeState(done, blocked) {
  return done ? 'done' : blocked ? 'blocked' : 'active';
}

export function deriveLedgerStages({
  managerToken, trackingId, additionalInfoDone, detailedInfoDone, facilityId, publicDisplayConfirmed,
} = {}) {
  const hasTrackingId = !!trackingId;
  const submittedDone = !!facilityId;

  return [
    {
      id: 'basic', label: 'Basic Information', icon: 'fa-file',
      state: computeState(hasTrackingId, !managerToken),
      lockedReason: !managerToken ? "Log in with your Facility Manager's HPR ID first." : undefined,
    },
    {
      id: 'additional', label: 'Additional Information', icon: 'fa-file-circle-plus',
      state: computeState(!!additionalInfoDone, !hasTrackingId),
      lockedReason: !hasTrackingId ? 'Complete Basic Information first — this needs a tracking ID.' : undefined,
    },
    {
      id: 'detailed', label: 'Detailed Information', icon: 'fa-list-check',
      state: computeState(!!detailedInfoDone, !hasTrackingId),
      lockedReason: !hasTrackingId ? 'Complete Basic Information first — this needs a tracking ID.' : undefined,
    },
    {
      id: 'public_display', label: 'Public Display Settings', icon: 'fa-eye',
      state: computeState(!!publicDisplayConfirmed, false),
    },
    {
      id: 'attestation', label: 'Attestation & e-Sign', icon: 'fa-file-signature',
      state: computeState(submittedDone, !hasTrackingId),
      lockedReason: !hasTrackingId ? 'Complete Basic Information first — there needs to be a submission to sign.' : undefined,
    },
    {
      id: 'submitted', label: 'Submitted', icon: 'fa-circle-check',
      state: submittedDone ? 'done' : 'blocked',
      lockedReason: !submittedDone ? 'Sign and submit to reach this stage.' : undefined,
    },
  ];
}

// The stage a caller should land on right after a given stage's action succeeds — used both by
// rebuildFromRecord() (choosing where to open on load) and by each doX() success handler. Purely
// a suggestion now, not an enforced gate — Additional/Detailed/Public Display can be visited in
// any order, this just picks a sensible next stop.
export function nextStageAfter(stageId) {
  const order = ['basic', 'additional', 'detailed', 'public_display', 'attestation', 'submitted'];
  const i = order.indexOf(stageId);
  return i === -1 || i === order.length - 1 ? stageId : order[i + 1];
}

// Where to open a returning/reloaded session — the first stage that isn't already done AND isn't
// blocked on the transient (never-persisted) manager-login signal, i.e. the real frontier of what
// there's actually real data for. managerToken is passed as `true` here on purpose (same reason
// currentStageFor always did) — a fresh page load always starts logged out, and we don't want that
// alone to make a returning session land back on Basic Information every time.
export function currentStageFor({ trackingId, additionalInfoDone, detailedInfoDone, facilityId, publicDisplayConfirmed } = {}) {
  const stages = deriveLedgerStages({ managerToken: true, trackingId, additionalInfoDone, detailedInfoDone, facilityId, publicDisplayConfirmed });
  const frontier = stages.find((s) => s.state !== 'done');
  return frontier ? frontier.id : 'submitted';
}

// Real ABDM HIS-4xx/HIS-5xx error bodies (clinuxflow-abdm-gateway's own 502 passthrough shape:
// {success:false, error, abdmStatus, abdmBody: {code, message, details:[{message, code,
// attribute}]}}) — live-confirmed the `attribute` field is often just null (HIS-1070's own real
// response: "Required OwnershipCode Field is empty.", attribute: null), so there's no reliable
// structured field reference to key off. This is a best-effort text match against a small, real
// vocabulary of field names these HFR error messages actually use — extend the list as new error
// messages are seen live, never assume it's exhaustive. Every raw message is always shown to the
// user regardless of whether a match is found (see FacilityHfrPanel.vue's own error rendering) —
// this only adds a "jump to the right stage" shortcut on top, it never hides or replaces the real
// diagnostic text.
const FIELD_HINTS = [
  { pattern: /ownership/i, stageId: 'basic', label: 'Ownership' },
  { pattern: /facility ?type/i, stageId: 'basic', label: 'Facility Type' },
  { pattern: /system ?of ?medicine/i, stageId: 'basic', label: 'System of Medicine' },
  { pattern: /type ?of ?service/i, stageId: 'basic', label: 'Type of Service' },
  { pattern: /speciality ?type/i, stageId: 'basic', label: 'Speciality Type' },
  { pattern: /facility ?region/i, stageId: 'basic', label: 'Facility Region' },
  { pattern: /state.?lgd|\bstate\b/i, stageId: 'basic', label: 'State (LGD)' },
  { pattern: /district.?lgd|\bdistrict\b/i, stageId: 'basic', label: 'District (LGD)' },
  { pattern: /sub.?district/i, stageId: 'basic', label: 'Sub-district (LGD)' },
  { pattern: /latitude|longitude|geo.?location/i, stageId: 'basic', label: 'Latitude / Longitude' },
  { pattern: /facility ?name/i, stageId: 'basic', label: 'Facility Name (Hospital Profile)' },
  { pattern: /pharmacy|jan ?aushadhi/i, stageId: 'detailed', label: 'Pharmacy Details' },
  { pattern: /blood ?bank|e-?raktkosh/i, stageId: 'detailed', label: 'Blood Bank Details' },
  { pattern: /imaging/i, stageId: 'detailed', label: 'Imaging Services' },
  { pattern: /diagnostic/i, stageId: 'detailed', label: 'Diagnostic Lab Services' },
  { pattern: /bed|ventilator|dental ?chair/i, stageId: 'detailed', label: 'Medical Infrastructure' },
  { pattern: /linked ?program|nhrr|rohini|pmjay|cghs|echs/i, stageId: 'additional', label: 'Linked Program IDs' },
  { pattern: /tracking ?id/i, stageId: 'basic', label: 'Basic Information (tracking ID)' },
];

// Returns [{ message, stageId, label } | { message }] — one entry per real ABDM error detail
// (or one entry for a flat error string when the response has no `details` array), each with a
// best-effort stage/field match attached when one is found.
export function parseAbdmErrorDetails(res) {
  const rawMessages = Array.isArray(res?.abdmBody?.details) && res.abdmBody.details.length
    ? res.abdmBody.details.map((d) => d.message).filter(Boolean)
    : [res?.abdmBody?.message || res?.error].filter(Boolean);

  return rawMessages.map((message) => {
    const hint = FIELD_HINTS.find((h) => h.pattern.test(message));
    return hint ? { message, stageId: hint.stageId, label: hint.label } : { message };
  });
}
