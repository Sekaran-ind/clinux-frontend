import { describe, expect, it } from 'vitest';
import { ROOM_DEFINITIONS, roomDefinition, roomFlowId } from './rooms.js';

describe('ROOM_DEFINITIONS', () => {
  it('has exactly the five real rooms, in the order the landing grid should show them', () => {
    expect(ROOM_DEFINITIONS.map((r) => r.roomId)).toEqual(['facility', 'provider', 'patient', 'encounter', 'account']);
  });

  it('every room has a unique roomId, a title, an icon, and a desc', () => {
    const ids = ROOM_DEFINITIONS.map((r) => r.roomId);
    expect(new Set(ids).size).toBe(ids.length);
    ROOM_DEFINITIONS.forEach((r) => {
      expect(r.title).toBeTruthy();
      expect(r.icon).toBeTruthy();
      expect(r.desc).toBeTruthy();
    });
  });

  it('only Facility has a real flowId today — the only room with an authored workflow-definition YAML', () => {
    const withFlow = ROOM_DEFINITIONS.filter((r) => r.flowId);
    expect(withFlow.map((r) => r.roomId)).toEqual(['facility']);
    expect(withFlow[0].flowId).toBe('hospital-setup-workflow-v1');
  });

  it('roomDefinition() finds a real room by id and returns null for an unknown one', () => {
    expect(roomDefinition('facility')?.title).toBe('Facility');
    expect(roomDefinition('not-a-real-room')).toBe(null);
  });

  describe('roomFlowId()', () => {
    it("uses the room's own real flowId when it has one", () => {
      expect(roomFlowId(roomDefinition('facility'))).toBe('hospital-setup-workflow-v1');
    });

    it('derives a deterministic default for a room with no flowId yet, so saving a new plan always has a stable target', () => {
      expect(roomFlowId(roomDefinition('provider'))).toBe('provider-workflow-v1');
      expect(roomFlowId(roomDefinition('patient'))).toBe('patient-workflow-v1');
      expect(roomFlowId(roomDefinition('encounter'))).toBe('encounter-workflow-v1');
      expect(roomFlowId(roomDefinition('account'))).toBe('account-workflow-v1');
    });
  });
});
