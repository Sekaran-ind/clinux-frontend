// Ported from clinux-cubo's test/legal.test.js.
import { describe, expect, it } from 'vitest';
import { AFFILIATIONS, CONTACT, PRIVACY, TERMS } from './legal.js';
import { CONSENTS } from '../consent/terms.js';

describe('legal content', () => {
  it('terms and privacy carry the exact consent text people accept', () => {
    const all = [...TERMS.sections, ...PRIVACY.sections].flatMap((s) => s.points);
    for (const c of CONSENTS) for (const p of c.points) expect(all).toContain(p);
  });

  it('names the grievance contact and does not claim ABDM certification', () => {
    expect(PRIVACY.sections.flatMap((s) => s.points).join(' ')).toContain(CONTACT);
    const abdm = AFFILIATIONS.programmes.find((p) => p.name.startsWith('Ayushman Bharat'));
    expect(abdm.detail).toMatch(/not yet certified/);
  });

  it('every affiliation and credit links somewhere', () => {
    for (const a of [...AFFILIATIONS.programmes, ...AFFILIATIONS.standards, ...AFFILIATIONS.builtWith]) expect(a.url).toMatch(/^https:\/\//);
  });
});
