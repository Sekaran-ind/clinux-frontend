import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SWITCHABLE_MODES,
  MODES,
  BREAKPOINT_PX,
  resolveViewport,
  loadStoredMode,
  saveStoredMode,
  resolveEffectiveMode,
  resolveActiveId,
} from './adaptiveSectionNav.js';

// This test environment (plain vitest, no jsdom) has no global `localStorage` — same stub
// established in encounterCoordination.test.js.
function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

beforeEach(() => {
  localStorage.removeItem('cf_adaptive_nav_mode_facility-editor');
  localStorage.removeItem('cf_adaptive_nav_mode_provider-editor');
});

describe('resolveViewport', () => {
  it('is compact just under the md: breakpoint', () => {
    expect(resolveViewport(767)).toBe('compact');
  });

  it('is expanded exactly at the md: breakpoint (min-width semantics)', () => {
    expect(resolveViewport(BREAKPOINT_PX)).toBe('expanded');
  });

  it('is expanded well above the breakpoint', () => {
    expect(resolveViewport(1280)).toBe('expanded');
  });

  it('honors a custom breakpoint when given one', () => {
    expect(resolveViewport(900, 1024)).toBe('compact');
  });
});

describe('loadStoredMode / saveStoredMode', () => {
  it('returns null when nothing has ever been stored for this instance', () => {
    expect(loadStoredMode('facility-editor')).toBeNull();
  });

  it('round-trips a valid switchable mode', () => {
    saveStoredMode('facility-editor', 'sidebar');
    expect(loadStoredMode('facility-editor')).toBe('sidebar');
  });

  it('keeps different component instances isolated from each other', () => {
    saveStoredMode('facility-editor', 'sidebar');
    saveStoredMode('provider-editor', 'accordion');
    expect(loadStoredMode('facility-editor')).toBe('sidebar');
    expect(loadStoredMode('provider-editor')).toBe('accordion');
  });

  it('refuses to persist "panes" — it is never a user-chosen override', () => {
    saveStoredMode('facility-editor', 'panes');
    expect(loadStoredMode('facility-editor')).toBeNull();
  });

  it('ignores a corrupt/stale stored value instead of returning it', () => {
    localStorage.setItem('cf_adaptive_nav_mode_facility-editor', 'not-a-real-mode');
    expect(loadStoredMode('facility-editor')).toBeNull();
  });

  it('loadStoredMode does not throw when localStorage.getItem throws (private-browsing quota)', () => {
    const original = localStorage.getItem;
    localStorage.getItem = () => { throw new Error('quota'); };
    expect(() => loadStoredMode('facility-editor')).not.toThrow();
    expect(loadStoredMode('facility-editor')).toBeNull();
    localStorage.getItem = original;
  });

  it('saveStoredMode does not throw when localStorage.setItem throws', () => {
    const original = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('quota'); };
    expect(() => saveStoredMode('facility-editor', 'tabs')).not.toThrow();
    localStorage.setItem = original;
  });
});

describe('resolveEffectiveMode', () => {
  it('defaults to tabs with no prop and nothing stored', () => {
    expect(resolveEffectiveMode({})).toBe('tabs');
  });

  it('falls back to the prop hint when nothing is stored', () => {
    expect(resolveEffectiveMode({ propMode: 'sidebar' })).toBe('sidebar');
  });

  it('a stored override wins over the prop hint', () => {
    expect(resolveEffectiveMode({ propMode: 'sidebar', storedMode: 'accordion' })).toBe('accordion');
  });

  it('ignores an invalid stored value and falls back to the prop hint', () => {
    expect(resolveEffectiveMode({ propMode: 'sidebar', storedMode: 'not-a-real-mode' })).toBe('sidebar');
  });

  it('"panes" from the prop always wins, even over a stored override — Cübo\'s case is never user-switchable', () => {
    expect(resolveEffectiveMode({ propMode: 'panes', storedMode: 'accordion' })).toBe('panes');
  });
});

describe('resolveActiveId', () => {
  const sections = [{ id: 'basics', label: 'Basics' }, { id: 'contacts', label: 'Contacts' }];

  it('keeps a requested id that still names a real section', () => {
    expect(resolveActiveId(sections, 'contacts')).toBe('contacts');
  });

  it('falls back to the first section when nothing is requested', () => {
    expect(resolveActiveId(sections, null)).toBe('basics');
  });

  it('falls back to the first section when the requested id no longer exists (sections changed under it)', () => {
    expect(resolveActiveId(sections, 'deleted-section')).toBe('basics');
  });

  it('returns null for an empty section list rather than throwing', () => {
    expect(resolveActiveId([], 'anything')).toBeNull();
  });
});

describe('module exports stay internally consistent', () => {
  it('MODES is exactly the switchable modes plus panes', () => {
    expect(MODES).toEqual([...SWITCHABLE_MODES, 'panes']);
  });
});
