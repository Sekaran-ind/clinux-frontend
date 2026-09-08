import { createLocalCollection } from '../collectionFactory.js';
import { ROOM_DEFINITIONS } from '../../workflow/rooms.js';

// SPEC-22 §5.8's "Roles-per-Room" requirement, made real and editable — "we also need to design
// the roles who can be part of the Room so we will be able to load them in the runtime" (user's
// own words). ROOM_DEFINITIONS (rooms.js) is static/hand-authored code — a room's identity, icon,
// and flowId aren't user-editable in this pass — but WHICH ACCOUNT ROLES can see/use a room is a
// real per-clinic setting, so it lives here instead: one row per roomId, `roles: [...] | null`
// (null = universal), seeded from each room's own defaultRoles the first time it's read/toggled.
export const roomSettings = createLocalCollection('cf_room_settings_v1', {
  getKey: (r) => r.roomId,
});

// Ensures a settings row exists before reading/writing it — same "seed on first real read" idiom
// formsLibrary.js's seedSystemForms() uses, just local (no network call, ROOM_DEFINITIONS is
// already in memory).
function ensureRow(roomId) {
  if (roomSettings.has(roomId)) return roomSettings.get(roomId);
  const def = ROOM_DEFINITIONS.find((r) => r.roomId === roomId);
  const row = { roomId, roles: def?.defaultRoles || null };
  roomSettings.insert(row);
  return row;
}

export function rolesForRoom(roomId) {
  return ensureRow(roomId).roles;
}

export function setRolesForRoom(roomId, roles) {
  ensureRow(roomId); // guarantees the row exists before update() below
  roomSettings.update(roomId, (draft) => { draft.roles = roles && roles.length ? roles : null; });
}

// Same isVisible() gate entryPlanDefinition.js's own actions use (null/absent roles = universal,
// otherwise the signed-in role must be in the list) — kept here as its own small pure function
// (not imported from entryWorkflow.js, which is a Pinia store, not a plain module) so Designer.vue
// and any future room-aware consumer can both use the identical rule.
export function isRoomVisibleToRole(roomId, role) {
  const roles = rolesForRoom(roomId);
  return !roles || (!!role && roles.includes(role)); // !!role: a real boolean, not a falsy null falling through
}
