import { describe, expect, it, beforeEach } from 'vitest';
import { roomSettings, rolesForRoom, setRolesForRoom, isRoomVisibleToRole } from './roomSettings.js';

describe('roomSettings', () => {
  beforeEach(() => {
    // Module-level singleton collection — same isolation reasoning entryWorkflow.test.js's own
    // chatThreads/taskActorSnapshots cleanup already established.
    roomSettings.toArray.forEach((r) => roomSettings.delete(r.roomId));
  });

  it('rolesForRoom() seeds from the real ROOM_DEFINITIONS default on first read', () => {
    expect(roomSettings.has('facility')).toBe(false);
    expect(rolesForRoom('facility')).toEqual(['hospital_admin', 'admin_and_health_professional']);
    expect(roomSettings.has('facility')).toBe(true); // the row now exists, seeded
  });

  it('a room with no default roles (Patient) is universal — null, not an empty array', () => {
    expect(rolesForRoom('patient')).toBe(null);
  });

  it('setRolesForRoom() overrides the seeded default, and it sticks', () => {
    setRolesForRoom('provider', ['health_professional']);
    expect(rolesForRoom('provider')).toEqual(['health_professional']);
  });

  it('setRolesForRoom() with an empty array normalizes to null (universal), not a role nobody matches', () => {
    setRolesForRoom('facility', []);
    expect(rolesForRoom('facility')).toBe(null);
  });

  describe('isRoomVisibleToRole()', () => {
    it('a universal room (no roles) is visible regardless of role, including no role at all', () => {
      expect(isRoomVisibleToRole('patient', 'hospital_admin')).toBe(true);
      expect(isRoomVisibleToRole('patient', null)).toBe(true);
    });

    it('a role-gated room is visible only to a matching role', () => {
      expect(isRoomVisibleToRole('facility', 'hospital_admin')).toBe(true);
      expect(isRoomVisibleToRole('facility', 'health_professional')).toBe(false);
      expect(isRoomVisibleToRole('facility', null)).toBe(false); // signed out
    });
  });
});
