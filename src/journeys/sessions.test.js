import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { chatThreads } from '../data/collections/chatThreads.js';
import { useCuboStore } from '../stores/cubo.js';
import { useJourneySessionsStore, journeyIdOfThread, threadIdFor } from './sessions.js';

// The journey catalogue (index.js) pulls in the app's data layer; the store only needs lookups.
vi.mock('./index.js', () => {
  const demo = { id: 'demo', title: 'Demo ID', summary: 'Link a demo ID', icon: 'fa-id-card' };
  return { JOURNEYS: [demo], journeyById: (id) => (id === 'demo' ? demo : undefined), journeyDeps: () => ({}) };
});

vi.mock('./profile.js', () => ({ useCuboProfileStore: () => ({ refresh: vi.fn() }) }));

const account = { id: 'acc-1' };
const ASK_MODE = { text: 'Link or register?', choices: [{ value: 'login', label: 'Link it' }, { value: 'register', label: 'Register' }] };
const ASK_OTP = { text: 'Enter the OTP', step: 'otp', fields: [{ name: 'otp', label: 'OTP', secret: true, required: true }] };

/** A scripted runner: start -> mode; answer(login) -> otp; otp '000000' -> error re-ask; else done. */
function scriptedRunner() {
  const calls = [];
  return {
    calls,
    start: async () => ({ prompt: { ...ASK_MODE, step: 'mode' }, ledger: [{ id: 'mode', label: 'Choose', state: 'active' }, { id: 'otp', label: 'OTP', state: 'pending' }] }),
    answer: async (v) => {
      calls.push(v);
      if (v.choice) return { prompt: ASK_OTP, ledger: [{ id: 'mode', label: 'Choose', state: 'done' }, { id: 'otp', label: 'OTP', state: 'active' }] };
      if (v.otp === '000000') return { prompt: { ...ASK_OTP, error: 'Wrong OTP' } };
      return { done: true, result: { ok: true, title: 'Linked', facts: [['ID', 'x@demo']] } };
    },
    cancel: async () => {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const thread = () => chatThreads.get('journey-demo');
const texts = () => thread().messages.map((m) => `${m.role}: ${m.text}`);

describe('journey sessions', () => {
  let store;
  let runners;
  beforeEach(() => {
    chatThreads.toArray.forEach((r) => chatThreads.delete(r.id));
    setActivePinia(createPinia());
    store = useJourneySessionsStore();
    runners = [];
    store._setRunnerFactory(() => { const r = scriptedRunner(); runners.push(r); return r; });
  });

  it('names threads after journeys', () => {
    expect(threadIdFor('hpr')).toBe('journey-hpr');
    expect(journeyIdOfThread('journey-hfr')).toBe('hfr');
    expect(journeyIdOfThread('cat-billing')).toBeNull();
  });

  it('opens the journey in its own registry thread, made active, and narrates the first question', async () => {
    const id = store.open('demo', { account });
    await flush();
    expect(id).toBe('journey-demo');
    expect(thread().category).toBe('registry');
    expect(useCuboStore().activeThreadId).toBe('journey-demo');
    expect(store.sessions[id].prompt.text).toBe('Link or register?');
    expect(store.sessions[id].ledger[0].state).toBe('active');
    expect(texts().at(-1)).toBe('assistant: Link or register?');
  });

  it('logs answers with secrets masked, keeps a re-asked step’s values, and ends with the result', async () => {
    const id = store.open('demo', { account });
    await flush();
    store.answer(id, { choice: 'login' });
    await flush();
    store.answer(id, { otp: '000000' });
    await flush();
    expect(store.sessions[id].prompt.error).toBe('Wrong OTP');
    expect(store.keptFor(id, store.sessions[id].prompt)).toEqual({ otp: '000000' }); // initialValues drops the secret
    store.answer(id, { otp: '123456' });
    await flush();
    expect(texts()).toContain('user: Link it');
    expect(texts().filter((t) => t === 'user: OTP: ••••••')).toHaveLength(2);
    expect(texts().join('\n')).not.toMatch(/123456|000000/);
    const last = thread().messages.at(-1);
    expect(last).toMatchObject({ text: 'Linked', component: 'journey-result', componentProps: { ok: true } });
    expect(store.sessions[id].result.title).toBe('Linked');
  });

  it('answers a choice typed into the thread, and explains a step that needs the form', async () => {
    const id = store.open('demo', { account });
    await flush();
    store.chat(id, '1');
    await flush();
    expect(runners[0].calls).toEqual([{ choice: 'login' }]);
    store.chat(id, '123456');
    expect(runners[0].calls).toHaveLength(1); // an OTP never comes from the chat
    expect(texts().slice(-2)).toEqual(['user: 123456', 'assistant: This step needs the form — switch to Form to fill it in.']);
  });

  it('carries on with a run in progress when reopened, and starts a new one (with a divider) when asked', async () => {
    store.open('demo', { account });
    await flush();
    store.open('demo', { account });
    expect(runners).toHaveLength(1);
    store.open('demo', { account, restart: true });
    await flush();
    expect(runners).toHaveLength(2);
    expect(thread().messages.some((m) => m.component === 'journey-divider')).toBe(true);
  });

  it('starts again for a different account or input', async () => {
    store.open('demo', { account });
    store.open('demo', { account: { id: 'acc-2' } });
    store.open('demo', { account: { id: 'acc-2' }, input: { patientId: 'p1' } });
    expect(runners).toHaveLength(3);
  });

  it('goes back to a revisitable step, prefilled with what was entered there', async () => {
    const backs = [];
    store._setRunnerFactory(() => {
      const r = scriptedRunner();
      r.answer = async (v) => (v.choice ? { prompt: { ...ASK_OTP, step: 'name', fields: [{ name: 'name', label: 'Name' }] }, ledger: [{ id: 'mode', label: 'Choose', state: 'done', revisit: true }, { id: 'name', label: 'Name', state: 'active' }] }
        : { prompt: { text: 'Next', step: 'next', choices: [{ value: 'x', label: 'X' }] }, ledger: [{ id: 'mode', label: 'Choose', state: 'done', revisit: true }, { id: 'name', label: 'Name', state: 'done', revisit: true }, { id: 'next', label: 'Next', state: 'active' }] });
      r.back = async (step) => { backs.push(step); return { prompt: { text: 'Name?', step: 'name', fields: [{ name: 'name', label: 'Name' }] }, ledger: [{ id: 'mode', label: 'Choose', state: 'done', revisit: true }, { id: 'name', label: 'Name', state: 'active' }] }; };
      return r;
    });
    const id = store.open('demo', { account });
    await flush();
    store.answer(id, { choice: 'login' });
    await flush();
    store.answer(id, { name: 'Asha' });
    await flush();
    expect(store.back(id, 'next')).toBe(false); // not answered yet
    expect(store.back(id, 'name')).toBe(true);
    await flush();
    expect(backs).toEqual(['name']);
    expect(store.sessions[id].prompt.step).toBe('name');
    expect(store.keptFor(id, store.sessions[id].prompt)).toEqual({ name: 'Asha' });
    expect(texts()).toContain('user: ↩ Back to “Name”');
  });

  it('deleting the journey’s Cübo thread ends its run', async () => {
    const id = store.open('demo', { account });
    await flush();
    useCuboStore().deleteThread(id);
    expect(store.sessions[id]).toBeUndefined();
    expect(store.isLive(id)).toBe(false);
  });

  it('stops a run: nothing more is narrated and the form closes', async () => {
    const id = store.open('demo', { account });
    await flush();
    await store.stop(id);
    expect(store.sessions[id].prompt).toBeNull();
    expect(store.sessions[id].result.title).toBe('Stopped');
    expect(store.isLive(id)).toBe(false);
    store.chat(id, 'hello');
    expect(texts().at(-1)).toMatch(/not running/);
  });
});
