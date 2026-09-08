// SPEC-22 §5.8's Room-Architect redesign, made real — the top-level entities Designer.vue's
// landing view now lists instead of raw forms ("the designer actually starts as a Room Architect
// listing the forms in the library.. instead we list the Rooms" — user's own words). Five rooms,
// hand-authored/static (not user-creatable in this pass — a room is a structural concept, unlike
// the forms/flows underneath it, which ARE user-authorable): Facility and Provider split the old
// single "Provider composition" card grid apart (matching real ABDM HFR/HPR separation, see
// clinux-spec22-four-foundational-decisions memory note's §5.8 entry); Patient and Encounter keep
// their existing single-form identity; Account is the fifth room (entryPlanDefinition.js's
// ENTRY_PLAN_DEFINITION, extended §5.8 with logout/facility_registration/staff_registration).
//
// `flowId` links a room to its compiled/extracted workflow-definition plan in flowsLibrary.js
// (null where none has been authored yet — Provider/Patient/Encounter don't have a system-flow
// YAML today, only Facility does, via hospital-setup-workflow-v1.yaml). `defaultRoles` seeds
// roomSettings.js's own per-room override row — null means universal (every signed-in role sees
// it), matching entryPlanDefinition.js's own convention for an action with no `roles` field.
export const ROOM_DEFINITIONS = [
  {
    roomId: 'facility',
    title: 'Facility',
    icon: 'fas fa-hospital',
    color: '#3B82F6',
    bg: 'rgba(59,130,246,.1)',
    desc: 'Hospital profile, branches, services, hours, and consents.',
    flowId: 'hospital-setup-workflow-v1',
    defaultRoles: ['hospital_admin', 'admin_and_health_professional'],
  },
  {
    roomId: 'provider',
    title: 'Provider',
    icon: 'fas fa-user-md',
    color: '#00D4B2',
    bg: 'rgba(0,212,178,.1)',
    desc: 'Practitioners and staff on your care team.',
    flowId: null,
    defaultRoles: ['hospital_admin', 'health_professional', 'admin_and_health_professional'],
  },
  {
    roomId: 'patient',
    title: 'Patient',
    icon: 'fas fa-user-injured',
    color: '#8B5CF6',
    bg: 'rgba(139,92,246,.1)',
    desc: 'Patient profile and intake.',
    flowId: null,
    defaultRoles: null,
  },
  {
    roomId: 'encounter',
    title: 'Encounter',
    icon: 'fas fa-clipboard-list',
    color: '#F59E0B',
    bg: 'rgba(245,158,11,.1)',
    desc: 'Visit documentation — SOAP, vitals, billing.',
    flowId: null,
    defaultRoles: null,
  },
  {
    roomId: 'account',
    title: 'Account',
    icon: 'fas fa-address-card',
    color: '#EC4899',
    bg: 'rgba(236,72,153,.1)',
    desc: 'Register, log in, and the other global account actions.',
    // No YAML source exists for this one — entryPlanDefinition.js has always been hand-authored
    // directly in JS (see that file's own header comment), never compiled from a workflow-
    // definition YAML. Left null deliberately rather than pointed at a fake/nonexistent flowId —
    // Design & Compile Room shows this room's real, honest state (hand-authored in code, no YAML
    // to edit here yet) instead of pretending otherwise.
    flowId: null,
    defaultRoles: null,
  },
];

export function roomDefinition(roomId) {
  return ROOM_DEFINITIONS.find((r) => r.roomId === roomId) || null;
}

// The flowsLibrary.js catalog key to read/write a room's workflow-definition plan under —
// `room.flowId` when one is already real and pre-authored (Facility only, today); otherwise a
// deterministic default (`${roomId}-workflow-v1`) so "Design & Compile Room" always has a stable
// place to save a NEWLY-authored plan for a room that doesn't have one yet, without needing to
// mutate this static, hand-authored ROOM_DEFINITIONS constant at runtime. Whether that saved plan
// is actually wired to a LIVE runtime store is a separate question — see Designer.vue's own
// ROOM_RUNTIME_WIRED constant, deliberately NOT decided here (this file only knows storage, not
// which Pinia store, if any, reads a given flowId).
export function roomFlowId(room) {
  return room.flowId || `${room.roomId}-workflow-v1`;
}
