import { describe, expect, it } from 'vitest';
import { checkJourney, createXStateRunner, evaluate, ledgerOf, resolveNext } from './engine.js';
import { hprJourney } from './hprJourney.js';
import { hfrJourney } from './hfrJourney.js';
import { patientAbhaJourney } from './patientAbhaJourney.js';

describe('conditions', () => {
  const scope = { data: { mode: 'register', renewed: false, n: 0, saved: { trackingId: 'T1' } } };
  it('evaluates paths, negation, ==, != and && / ||', () => {
    expect(evaluate("data.mode == 'register'", scope)).toBe(true);
    expect(evaluate("data.mode != 'register'", scope)).toBe(false);
    expect(evaluate('data.renewed', scope)).toBe(false);
    expect(evaluate('!data.renewed', scope)).toBe(true);
    expect(evaluate('data.n == 0', scope)).toBe(true);
    expect(evaluate('data.saved.trackingId && !data.saved.facilityId', scope)).toBe(true);
    expect(evaluate('data.missing.deep || data.renewed', scope)).toBe(false);
  });
  it('takes the first matching branch, else the default', () => {
    const next = [{ if: 'data.renewed', to: 'again' }, { to: 'onward' }];
    expect(resolveNext(next, scope)).toBe('onward');
    expect(resolveNext('x', scope)).toBe('x');
  });
});

describe('journey JSON', () => {
  it('every journey is consistent with its handlers', () => {
    for (const j of [hprJourney, hfrJourney, patientAbhaJourney]) expect(checkJourney(j), j.id).toEqual([]);
  });
  it('rejects broken journeys before running', () => {
    const broken = { spec: { id: 'x', start: 'a', steps: { a: { type: 'ask', prompt: 'p', run: 'r', next: 'nowhere' }, __done: { type: 'final' } } }, prompts: {}, actions: {} };
    expect(checkJourney(broken)).toEqual(expect.arrayContaining([
      "a: prompt 'p' has no handler", "a: action 'r' has no handler", "a: next step 'nowhere' is not defined", '__done: step ids starting with __ are reserved',
    ]));
    expect(() => createXStateRunner(broken, {})).toThrow(/is invalid/);
  });
});

describe('runner semantics', () => {
  const journey = {
    spec: {
      id: 't', start: 'begin',
      steps: {
        begin: { type: 'auto', run: 'load', next: 'ask' },
        ask: { type: 'ask', prompt: 'ask', run: 'check', next: [{ if: "data.choice == 'b'", to: 'b' }, { to: 'a' }], ledger: { label: 'Ask' } },
        a: { type: 'final', result: { ok: true, title: 'A' } },
        b: { type: 'auto', run: 'boom', next: 'a', ledger: { label: 'B' } },
      },
    },
    prompts: { ask: (s) => ({ text: `Hi ${s.data.name}` }) },
    actions: {
      load: async () => ({ data: { name: 'Asha' } }),
      check: async (a) => { if (a.choice === 'bad') throw new Error('Not that one'); return { data: { choice: a.choice } }; },
      boom: async () => { throw new Error('ABDM is down'); },
    },
  };

  it('asks, retries an ask on error with the message, and ends with a fixed result', async () => {
    const r = createXStateRunner(journey, {});
    const first = await r.start();
    expect(first.prompt).toMatchObject({ text: 'Hi Asha', step: 'ask', error: null });
    expect((await r.answer({ choice: 'bad' })).prompt).toMatchObject({ step: 'ask', error: 'Not that one' });
    expect(await r.answer({ choice: 'a' })).toMatchObject({ done: true, result: { title: 'A' } });
  });

  it('an auto step failure ends the journey through failed', async () => {
    const r = createXStateRunner(journey, {});
    await r.start();
    expect(await r.answer({ choice: 'b' })).toMatchObject({ done: true, result: { ok: false, title: 'That did not work', text: 'ABDM is down' } });
  });
});

describe('ledger (from the journey JSON)', () => {
  it('shows visited steps done, the current one active, and the projected rest pending', () => {
    const l = ledgerOf(hprJourney.spec, { data: { mode: 'register' }, visited: ['begin', 'mode', 'aadhaar'], current: 'aadhaar' });
    expect(l.map((s) => [s.label, s.state])).toEqual([
      ['Aadhaar consent', 'active'],
      ["Verify on NHA's page", 'pending'],
      ['Mobile', 'pending'],
      ['HPR ID and category', 'pending'],
      ['System of medicine and state', 'pending'],
      ['District, role and password', 'pending'],
    ]);
  });
  it('leaves out the branch not taken', () => {
    const l = ledgerOf(hprJourney.spec, { data: { mode: 'link' }, visited: ['begin', 'mode', 'login'], current: 'login' });
    expect(l.map((s) => s.label)).toEqual(['Sign in to HPR']);
  });
});
