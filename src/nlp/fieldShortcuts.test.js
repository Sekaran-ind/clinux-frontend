import { describe, it, expect, vi, beforeEach } from 'vitest';

const FAKE_FIELDS = [
  { formId: 'system-encounter-composition-v1', groupLinkId: 'section_encounter', linkId: 'encounter_status', label: 'Status' },
  { formId: 'system-encounter-composition-v1', groupLinkId: 'section_prescription', linkId: 'rx_status', label: 'Status' },
  { formId: 'system-encounter-composition-v1', groupLinkId: 'section_billing', linkId: 'billing_status', label: 'Status' },
  { formId: 'system-encounter-composition-v1', groupLinkId: 'section_encounter', linkId: 'encounter_chief_complaint', label: 'Chief Complaint' },
  { formId: 'system-encounter-composition-v1', groupLinkId: 'section_vitals', linkId: 'vitals_systolic', label: 'Systolic BP' },
];

vi.mock('./formFieldHarvester.js', () => ({
  harvestFieldMetadata: () => FAKE_FIELDS,
}));

// buildShortcutIndex() caches its result at module scope — reset the module registry between
// tests so each test's mock/expectations aren't polluted by a previous test's cached index.
beforeEach(() => vi.resetModules());

describe('buildShortcutIndex', () => {
  it('derives multi-word-initial keys, de-duplicating collisions with an incrementing suffix', async () => {
    const { buildShortcutIndex } = await import('./fieldShortcuts.js');
    const index = buildShortcutIndex();

    // All three "Status" fields collapse to the same single-word fallback key ("sta") and must
    // still end up with distinct entries, in harvest order.
    expect(index.get('sta')).toMatchObject({ linkId: 'encounter_status' });
    expect(index.get('sta2')).toMatchObject({ linkId: 'rx_status' });
    expect(index.get('sta3')).toMatchObject({ linkId: 'billing_status' });

    expect(index.get('cc')).toMatchObject({ linkId: 'encounter_chief_complaint' });
    expect(index.get('sb')).toMatchObject({ linkId: 'vitals_systolic' });
  });
});

describe('matchShortcuts', () => {
  it('returns every key starting with the given prefix, sorted', async () => {
    const { matchShortcuts } = await import('./fieldShortcuts.js');
    const matches = matchShortcuts('sta');
    expect(matches.map((m) => m.key)).toEqual(['sta', 'sta2', 'sta3']);
  });

  it('returns [] for a prefix matching nothing', async () => {
    const { matchShortcuts } = await import('./fieldShortcuts.js');
    expect(matchShortcuts('zzz')).toEqual([]);
  });
});

describe('resolveShortcutMessage', () => {
  it('resolves an exact key + value to {field, value}', async () => {
    const { resolveShortcutMessage } = await import('./fieldShortcuts.js');
    const result = resolveShortcutMessage('/cc sore throat for 3 days');
    expect(result.field).toMatchObject({ linkId: 'encounter_chief_complaint' });
    expect(result.value).toBe('sore throat for 3 days');
  });

  it('flags an exact key typed with no trailing value as incomplete', async () => {
    const { resolveShortcutMessage } = await import('./fieldShortcuts.js');
    const result = resolveShortcutMessage('/cc');
    expect(result).toMatchObject({ incomplete: true });
    expect(result.field.linkId).toBe('encounter_chief_complaint');
  });

  it('flags a prefix matching multiple keys as ambiguous', async () => {
    const { resolveShortcutMessage } = await import('./fieldShortcuts.js');
    const result = resolveShortcutMessage('/st arrived');
    expect(result.ambiguous.map((c) => c.key)).toEqual(['sta', 'sta2', 'sta3']);
  });

  it('returns null for a non-slash message or a prefix matching nothing', async () => {
    const { resolveShortcutMessage } = await import('./fieldShortcuts.js');
    expect(resolveShortcutMessage('systolic is 148')).toBeNull();
    expect(resolveShortcutMessage('/zzz something')).toBeNull();
  });
});
