import { createLocalCollection } from '../collectionFactory.js';

// Replaces the seven cf_encounter_<subtype>_<id> localStorage keys consultation-desk.html used
// (one physical key per encounter per subtype). Each collection here holds rows for ALL
// encounters, each row carrying an `encounterId` field — callers filter with useLiveQuery
// instead of templating the id into a key name. This is a genuine correctness fix, not just a
// mechanical port: clinixflow's image lookup-by-id had to scan every localStorage key by prefix
// (`localStorage.key(i)` + `startsWith('cf_encounter_images_')`) to find one image across
// encounters; here it's a normal indexed query.

// { id, encounterId, time, user, action, color }
export const encounterLogs = createLocalCollection('cf_encounter_logs_v2');

// One row per encounter: { id: encounterId, stage }
export const encounterStage = createLocalCollection('cf_encounter_stage_v2');

// One row per encounter: { id: encounterId, status, decidedAt }
export const encounterConsent = createLocalCollection('cf_encounter_consent_v2');

// { id, encounterId, createdAt, dataUrl }
export const prescriptions = createLocalCollection('cf_encounter_prescriptions_v2');

// { id, encounterId, filename, dataUrl, addedAt, source }
export const encounterImages = createLocalCollection('cf_encounter_images_v2');

// { id, encounterId, imageId, toolState } — cornerstone-tools' own opaque per-image tool state
export const encounterAnnotations = createLocalCollection('cf_encounter_annotations_v2');

// One row per encounter: { id: encounterId, staffIds: [...] }
export const careTeam = createLocalCollection('cf_encounter_careteam_v2');

function currentUserLabel() {
  try {
    const u = JSON.parse(localStorage.getItem('cf_user') || 'null');
    return (u && (u.adminName || u.email)) || 'Unknown user';
  } catch (e) {
    return 'Unknown user';
  }
}

// Single funnel every mutating action in Consultation Desk calls — same convention as
// clinixflow's _log()/severity-color scheme (border-emerald-500 success, border-red-500 error,
// border-amber-500 warning, border-blue-500 info, border-slate-700 neutral default).
export function logEvent(encounterId, action, color = 'border-slate-700') {
  if (!encounterId) return;
  encounterLogs.insert({
    id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    encounterId,
    time: new Date().toISOString(),
    user: currentUserLabel(),
    action,
    color,
  });
}

export function getEncounterLogs(encounterId) {
  return encounterLogs.toArray
    .filter((l) => l.encounterId === encounterId)
    .sort((a, b) => a.time.localeCompare(b.time));
}

export function getEncounterImages(encounterId) {
  return encounterImages.toArray.filter((img) => img.encounterId === encounterId);
}

export function getCareTeam(encounterId) {
  return careTeam.get(encounterId)?.staffIds ?? [];
}

export function addCareTeamMember(encounterId, staffId) {
  const current = getCareTeam(encounterId);
  if (current.includes(staffId)) return;
  if (careTeam.has(encounterId)) {
    careTeam.update(encounterId, (draft) => draft.staffIds.push(staffId));
  } else {
    careTeam.insert({ id: encounterId, staffIds: [staffId] });
  }
}

export function removeCareTeamMember(encounterId, staffId) {
  if (!careTeam.has(encounterId)) return;
  careTeam.update(encounterId, (draft) => {
    draft.staffIds = draft.staffIds.filter((id) => id !== staffId);
  });
}
