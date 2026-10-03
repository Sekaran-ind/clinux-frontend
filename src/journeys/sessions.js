// Registry journeys as Cübo threads. A journey run (engine.js's runner) lives here, outside any
// page, so it survives moving between /registries/:journey and Cübo's full workspace; its
// conversation goes into the journey's own Cübo thread (chatThreads, category 'registry'), and the
// current prompt is what the form pane shows (ui/JourneyPanel.vue — on the Registries page next
// to Cübo's chat, and in Cübo's own Content tab).
//
// One thread per journey: `journey-hpr`, `journey-hfr`, `journey-abha`. A new run in the same
// thread starts with a divider row, so earlier runs stay readable above it.
//
// What goes into the thread is what the person saw and answered, secrets masked (promptForm's
// summarise). The ABHA photo (`image`) stays out of it: it is shown with the current question
// only. The runner itself is in memory: after a reload the log is still in the thread, and the
// journey starts again — an OTP step can't be resumed anyway (ABDM's transaction expires).
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { createRunner } from './runtime.js';
import { journeyById, journeyDeps } from './index.js';
import { useCuboStore } from '../stores/cubo.js';
import { chatThreads } from '../data/collections/chatThreads.js';
import { chatAnswer, summarise } from './ui/promptForm.js';
import { useCuboProfileStore } from './profile.js';

// A journey's thread: `journey-<id>` (registries), or `journey-<id>--<key>` when one journey runs
// once per something — the clinic journeys run once per visit (key = the encounter id).
export const threadIdFor = (journeyId, key = null) => (key ? `journey-${journeyId}--${key}` : `journey-${journeyId}`);
export const journeyIdOfThread = (threadId) => (String(threadId || '').startsWith('journey-') ? String(threadId).slice('journey-'.length).split('--')[0] : null);
export const threadKeyOf = (threadId) => (String(threadId || '').startsWith('journey-') ? String(threadId).split('--')[1] || null : null);

const sameInput = (a = {}, b = {}) => JSON.stringify(a) === JSON.stringify(b);

export const useJourneySessionsStore = defineStore('journeySessions', () => {
  const cubo = useCuboStore();
  // threadId -> { journeyId, input, prompt, ledger, result, busy, run } (reactive, read by the UI)
  const sessions = reactive({});
  // threadId -> { runner, lastAnswer, answers } (not reactive: the XState actor stays out of Vue's
  // proxies). `answers` is each step's last form values, so a step asked again — after going back,
  // or on the way forward from there — starts from what was entered (never secrets: initialValues
  // drops them). Memory only, like the run.
  const live = new Map();
  // Overridable in tests.
  // The journey gets its own thread id too (Consultation's AI draft reads its dictation from it).
  let makeRunner = (journey, account, threadId) => createRunner(journey, { ...journeyDeps(account), threadId });

  function say(threadId, role, text, extra = {}) {
    cubo.addCuboMessage(role, text, { threadId, ...extra });
  }

  function ensureThread(journey, key = null, title = null) {
    const id = threadIdFor(journey.id, key);
    if (!chatThreads.has(id)) {
      cubo.createNewThread(journey.category || 'registry', title || journey.title, id, key && journey.category === 'encounter' ? key : null, `${journey.title}: ${journey.summary}. I'll ask one step at a time — answer in the form, or here when it's a simple choice.`);
    }
    return id;
  }

  // A prompt goes into the thread as Cübo's message: its text, plus detail/list/map/warning/error.
  function narrate(threadId, view) {
    const s = sessions[threadId];
    if (view.ledger) s.ledger = view.ledger;
    if (view.done) {
      s.prompt = null;
      s.result = view.result;
      // A journey may have linked an identity (an HPR ID) that Cübo's profile shows.
      useCuboProfileStore().refresh();
      const r = view.result || {};
      say(threadId, 'assistant', r.title || 'Done', { component: 'journey-result', componentProps: { ok: !!r.ok, text: r.text || '', facts: r.facts || [] } });
      return;
    }
    const p = view.prompt;
    s.prompt = p;
    s.result = null;
    const extras = {
      ...(p.detail ? { detail: p.detail } : {}),
      ...(p.list?.length ? { list: p.list } : {}),
      ...(p.map ? { map: p.map } : {}),
      ...(p.warning ? { warning: p.warning } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(p.link ? { link: p.link } : {}),
    };
    say(threadId, 'assistant', p.text, Object.keys(extras).length ? { component: 'journey-step', componentProps: extras } : {});
  }

  async function step(threadId, fn) {
    const s = sessions[threadId];
    const run = s.run;
    s.busy = true;
    try {
      const view = await fn();
      if (sessions[threadId]?.run === run) narrate(threadId, view);
    } catch (e) {
      if (sessions[threadId]?.run !== run) return;
      s.prompt = null;
      s.result = { ok: false, title: 'Something went wrong', text: e.message };
      say(threadId, 'assistant', s.result.title, { component: 'journey-result', componentProps: { ok: false, text: e.message, facts: [] } });
    } finally {
      if (sessions[threadId]?.run === run) s.busy = false;
    }
  }

  /** Starts a new run of the journey in its thread (any run already going there is stopped). */
  function start(journeyId, { account, input = {}, key = null, title = null } = {}) {
    const journey = journeyById(journeyId);
    if (!journey) throw new Error(`Unknown journey '${journeyId}'`);
    if (!account) throw new Error('Sign in to run a registry journey.');
    const threadId = ensureThread(journey, key, title);
    live.get(threadId)?.runner.cancel();
    const hadMessages = (chatThreads.get(threadId)?.messages || []).length > 1;
    const runner = makeRunner(journey, account, threadId);
    live.set(threadId, { runner, lastAnswer: null, answers: {} });
    sessions[threadId] = { journeyId, input, key, title, prompt: null, ledger: [], result: null, busy: false, run: (sessions[threadId]?.run || 0) + 1, accountId: account.id };
    if (hadMessages) say(threadId, 'system', `New ${journey.title} run`, { component: 'journey-divider' });
    step(threadId, () => runner.start(input));
    return threadId;
  }

  /**
   * Opens the journey's thread: carries on with the run already going there for this account and
   * input, otherwise starts one. Returns the thread id.
   */
  function open(journeyId, { account, input = {}, restart = false, key = null, title = null } = {}) {
    const journey = journeyById(journeyId);
    if (!journey) throw new Error(`Unknown journey '${journeyId}'`);
    const threadId = ensureThread(journey, key, title);
    cubo.switchThread(threadId);
    const s = sessions[threadId];
    const reusable = s && live.has(threadId) && !s.result && s.accountId === account?.id && sameInput(s.input, input);
    if (restart || !reusable) start(journeyId, { account, input, key, title });
    return threadId;
  }

  /** Sends an answer (a form's values, { choice }, or { resend: true }) to the thread's run. */
  function answer(threadId, value) {
    const s = sessions[threadId];
    const l = live.get(threadId);
    if (!s?.prompt || s.busy || !l) return false;
    const p = s.prompt;
    l.lastAnswer = { step: p.step, values: value.choice === undefined && !value.resend ? value : {} };
    if (value.choice === undefined && !value.resend) l.answers[p.step] = value;
    say(threadId, 'user', summarise(p, value));
    s.prompt = null;
    step(threadId, () => l.runner.answer(value));
    return true;
  }

  /** The values last sent for `prompt`'s step, when it is being asked again after an error. */
  function keptFor(threadId, prompt) {
    const l = live.get(threadId);
    if (prompt?.error && l?.lastAnswer?.step === prompt.step) return l.lastAnswer.values;
    return l?.answers?.[prompt?.step] || {};
  }

  /** Goes back to an answered step the journey marks "revisit": true. */
  function back(threadId, stepId) {
    const s = sessions[threadId];
    const l = live.get(threadId);
    if (!s?.prompt || s.busy || !l) return false;
    const st = s.ledger.find((x) => x.id === stepId);
    if (!st?.revisit || st.state !== 'done') return false;
    say(threadId, 'user', `↩ Back to “${st.label}”`);
    s.prompt = null;
    step(threadId, () => l.runner.back(stepId));
    return true;
  }

  /**
   * A message typed into the journey's thread. Answers the current prompt when it can (a choice,
   * or a one-field form); otherwise Cübo says what's needed. Returns true when it was handled here.
   */
  function chat(threadId, text) {
    const s = sessions[threadId];
    if (!s || !live.has(threadId)) {
      say(threadId, 'user', text);
      say(threadId, 'assistant', 'This journey is not running. Open it from Next Action (or the Registries page) to start it again.');
      return true;
    }
    if (s.busy) {
      say(threadId, 'user', text);
      say(threadId, 'assistant', 'Still working on the last step — one moment.');
      return true;
    }
    const out = chatAnswer(s.prompt, text);
    if (out.value) return answer(threadId, out.value);
    say(threadId, 'user', text);
    say(threadId, 'assistant', out.reason);
    return true;
  }

  async function stop(threadId) {
    const s = sessions[threadId];
    const l = live.get(threadId);
    if (!s || !l) return;
    s.run += 1; // a step still in flight must not narrate after this
    await l.runner.cancel();
    live.delete(threadId);
    s.prompt = null;
    s.busy = false;
    s.result = { ok: false, title: 'Stopped', text: 'Nothing more was sent.' };
    say(threadId, 'assistant', 'Stopped', { component: 'journey-result', componentProps: { ok: false, text: 'Nothing more was sent.', facts: [] } });
  }

  /** Ends a thread's run without a word in it (its thread was deleted). */
  function forget(threadId) {
    live.get(threadId)?.runner.cancel();
    live.delete(threadId);
    delete sessions[threadId];
  }
  cubo.onThreadDeleted((id) => { if (journeyIdOfThread(id)) forget(id); });

  /** Forgets every run (sign-out: the next account must not continue this one's journeys). */
  function reset() {
    for (const l of live.values()) l.runner.cancel();
    live.clear();
    for (const k of Object.keys(sessions)) delete sessions[k];
  }

  const isLive = (threadId) => live.has(threadId);

  return {
    sessions, open, start, answer, back, chat, stop, forget, reset, keptFor, isLive,
    _setRunnerFactory: (fn) => { makeRunner = fn; },
  };
});
