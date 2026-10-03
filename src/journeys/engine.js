// The journey engine: a journey is JSON (its steps, prompts and transitions) plus a small set of
// named handlers (the gateway calls and the prompt builders that need code), compiled into an
// XState machine. XState is the deterministic layer for the workspace, and — the same engine,
// framework-free — for cubo-diary and clinux-cubo's surfaces.
//
// Journey JSON (see specs/*.journey.json):
//   {
//     "id", "title", "summary", "icon", "start": "<step>",
//     "steps": {
//       "<id>": { "type": "ask",   "prompt": "<prompt name>", "run": "<action name>", "next": <next> },
//       "<id>": { "type": "auto",  "run": "<action name>", "next": <next>, "onError": "fail" | "continue" },
//       "<id>": { "type": "final", "run": "<action name>" },          // run returns { result }
//       "<id>": { "type": "final", "result": { "ok", "title", "text" } } // a fixed result
//     }
//   }
//   An ask step may say "signIn": "<registry>" (e.g. "hpr"): it signs the person in to that
//   registry. Cübo's profile holds that sign-in (journeys/profile.js), and the progress menu
//   shows who is signed in.
//   A step's ledger may name its `stage` ({ "label", "stage" }): a long journey's steps are grouped
//   under their stage in the progress menu (stagesOf), e.g. HPR's profile: Personal details ->
//   Address & contact -> Registration -> Qualifications -> Work -> Review & submit.
//   A ledger may also say `doneIf` (a condition): a step a resumed run skipped because an earlier
//   visit finished it (a saved draft section) still shows as done, and with "revisit" can be gone
//   back to.
//   An ask step may say "revisit": true: once answered, the person can go back to it (the progress
//   menu's done steps, the form's Back button) and the journey runs forward again from there. Only
//   mark steps whose action is safe to repeat — not OTPs or one-time transactions.
//   <next> is a step id, or [{ "if": "<condition>", "to": "<step>" }, ..., { "to": "<step>" }].
//   <condition> is a tiny, safe expression over the journey's data: `data.renewed`,
//   `!data.mobileMatched`, `data.mode == 'register'`, `data.count != 0`, joined by && / ||.
//
// Semantics (unchanged from the LangGraph runtime the journeys used before, runtime.js):
//   ask    waits for the person's answer, runs its action, and on success follows `next`; on a
//          thrown error it asks again with the error shown (answers are never kept in state).
//   auto   runs on its own; an error ends the journey through `failed`, or with onError:"continue"
//          is ignored and `next` is followed.
//   final  produces the journey's result and ends.
// Handlers keep the signatures they had: an ask action (answer, state, deps), an auto/final action
// (state, deps), a prompt (state, deps) -> prompt; state is { data, error }. An action returns
// { data } (merged) and/or { result }.
//
// The runner API is the one journeys/sessions.js drives: createRunner(journey, deps) -> { start,
// answer, cancel }, each resolving to { prompt } or { done: true, result }.
import { assign, createActor, createMachine, fromPromise, waitFor } from 'xstate';

const messageOf = (e) => (e && e.message) || String(e);
const FAILED = { ok: false, title: 'That did not work' };

// ── Conditions ───────────────────────────────────────────────────────────────────────────────
function valueAt(scope, path) {
  return path.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), scope);
}
function literal(token) {
  const t = token.trim();
  if (/^'.*'$|^".*"$/.test(t)) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return undefined;
}
/**
 * Evaluates a condition against { data }: `path`, `!path`, `path == literal`, `path != literal`,
 * joined by `&&` / `||` (|| binds looser; no parentheses). Never eval()s anything.
 */
export function evaluate(condition, scope) {
  const text = String(condition);
  if (text.includes('||')) return text.split('||').some((part) => evaluate(part, scope));
  if (text.includes('&&')) return text.split('&&').every((part) => evaluate(part, scope));
  const c = text.trim();
  const m = c.match(/^(!?)([A-Za-z_][\w.]*)\s*(==|!=)\s*(.+)$/);
  if (m) {
    const left = valueAt(scope, m[2]);
    const equal = left === literal(m[4]);
    return m[3] === '==' ? equal : !equal;
  }
  const neg = c.startsWith('!');
  const v = valueAt(scope, neg ? c.slice(1).trim() : c);
  return neg ? !v : !!v;
}

/** The step a `next` resolves to, given the journey data after the step's own update. */
export function resolveNext(next, scope) {
  if (typeof next === 'string') return next;
  for (const branch of next || []) if (!branch.if || evaluate(branch.if, scope)) return branch.to;
  throw new Error('No transition matched');
}

/**
 * The journey's ledger (the Swastik-style stepper): every step that declares `ledger: { label }`,
 * in path order — visited steps are done, the current one active, and the rest of the likely path
 * (projected from the JSON with what the journey knows so far; unknown conditions take the default
 * branch) pending. Branches not taken are left out. Replaces hand-coded ledger stage lists.
 */
export function ledgerOf(spec, { data = {}, visited = [], current = null } = {}) {
  const path = [...new Set(visited)];
  let step = current;
  const seen = new Set(path);
  for (let guard = 0; step && guard < 50; guard++) {
    const def = spec.steps[step];
    if (!def || def.type === 'final') break;
    let next;
    try { next = resolveNext(def.next, { data }); } catch { break; }
    if (!next || next === 'failed' || seen.has(next)) break;
    path.push(next);
    seen.add(next);
    step = next;
  }
  // Steps done in an earlier visit (a resumed draft) that this run skipped: `ledger.doneIf` holds.
  // Each goes in before the first step of the path that comes after it in the JSON.
  const order = Object.keys(spec.steps);
  for (const id of order) {
    const cond = spec.steps[id]?.ledger?.doneIf;
    if (!cond || path.includes(id) || !evaluate(cond, { data })) continue;
    const at = path.findIndex((p) => order.indexOf(p) > order.indexOf(id));
    path.splice(at < 0 ? path.length : at, 0, id);
  }
  const doneBefore = (id) => !!spec.steps[id]?.ledger?.doneIf && evaluate(spec.steps[id].ledger.doneIf, { data });
  return path
    .filter((id) => spec.steps[id]?.ledger)
    .map((id) => ({
      id,
      label: spec.steps[id].ledger.label,
      ...(spec.steps[id].ledger.stage ? { stage: spec.steps[id].ledger.stage } : {}),
      ...(spec.steps[id].ledger.icon ? { icon: spec.steps[id].ledger.icon } : {}),
      ...(spec.steps[id].signIn ? { signIn: spec.steps[id].signIn } : {}),
      ...(spec.steps[id].revisit && spec.steps[id].type === 'ask' ? { revisit: true } : {}),
      state: id === current ? 'active' : visited.includes(id) || doneBefore(id) ? 'done' : 'pending',
    }));
}

/**
 * The ledger grouped by stage, in order: [{ stage, steps, state }] where state is done (every step
 * done), active (holds the active step, or is part done) or pending. Steps without a stage form
 * their own group (stage ''). A stage that appears again later starts a new group.
 */
export function stagesOf(ledger = []) {
  const groups = [];
  for (const st of ledger) {
    const stage = st.stage || '';
    const last = groups.at(-1);
    if (last && last.stage === stage) last.steps.push(st);
    else groups.push({ stage, steps: [st] });
  }
  for (const g of groups) {
    const states = g.steps.map((x) => x.state);
    g.state = states.every((x) => x === 'done') ? 'done' : states.includes('active') || states.includes('done') ? 'active' : 'pending';
  }
  return groups;
}

/** Checks a journey's JSON against its handlers before anything runs. Returns a list of problems. */
export function checkJourney(journey) {
  const { spec, prompts = {}, actions = {} } = journey;
  const problems = [];
  if (!spec?.steps?.[spec?.start]) problems.push(`start step '${spec?.start}' is not defined`);
  for (const id of Object.keys(spec?.steps || {})) if (id.startsWith('__')) problems.push(`${id}: step ids starting with __ are reserved`);
  for (const [id, step] of Object.entries(spec?.steps || {})) {
    if (!['ask', 'auto', 'final'].includes(step.type)) problems.push(`${id}: unknown type '${step.type}'`);
    if (step.type === 'ask' && !prompts[step.prompt]) problems.push(`${id}: prompt '${step.prompt}' has no handler`);
    if (step.run && !actions[step.run]) problems.push(`${id}: action '${step.run}' has no handler`);
    if (step.type !== 'final') {
      const targets = typeof step.next === 'string' ? [step.next] : (step.next || []).map((b) => b.to);
      if (!targets.length) problems.push(`${id}: no next step`);
      for (const t of targets) if (t !== 'failed' && !spec.steps[t]) problems.push(`${id}: next step '${t}' is not defined`);
    }
  }
  return problems;
}

// ── Machine ──────────────────────────────────────────────────────────────────────────────────
/** An automatic step threw: keep the message and the step, and log the stack for the console. */
const failure = (step) => ({ event }) => {
  console.error(`[journey] step '${step}' failed:`, event.error);
  return { error: messageOf(event.error), failedStep: step };
};

function buildMachine(journey, deps) {
  const { spec, actions = {} } = journey;
  const merge = (context, output) => ({ ...context.data, ...(output?.data || {}) });
  const run = (name) => fromPromise(async ({ input }) => {
    const fn = actions[name];
    const state = { data: input.data, error: null };
    const out = input.answer !== undefined ? await fn(input.answer, state, deps) : await fn(state, deps);
    return out || {};
  });

  const after = (step) => ({
    target: '#journey.__route',
    actions: assign(({ context, event }) => {
      const pending = step.type === 'final' ? '__done' : resolveNext(step.next, { data: merge(context, event.output) });
      return {
        data: merge(context, event.output),
        result: event.output?.result ?? context.result,
        error: null,
        pending,
        visited: spec.steps[pending] ? [...context.visited, pending] : context.visited,
      };
    }),
  });

  const states = {};
  const invokes = {};
  for (const [id, step] of Object.entries(spec.steps)) {
    if (step.run) invokes[`${id}:run`] = run(step.run);
    if (step.type === 'ask') {
      states[id] = {
        initial: 'waiting',
        states: {
          waiting: { on: { ANSWER: { target: 'running', actions: assign({ answer: ({ event }) => event.value }) } } },
          running: step.run
            ? {
                invoke: {
                  src: `${id}:run`,
                  input: ({ context }) => ({ data: context.data, answer: context.answer ?? {} }),
                  onDone: { ...after(step), actions: [after(step).actions, assign({ answer: null })] },
                  // Asked again with the error shown; the answer (OTPs, Aadhaar…) is not kept.
                  onError: { target: 'waiting', actions: assign({ error: ({ event }) => messageOf(event.error), answer: null }) },
                },
              }
            : { always: { target: '#journey.__route', actions: assign(({ context }) => { const pending = resolveNext(step.next, { data: context.data }); return { answer: null, pending, visited: [...context.visited, pending] }; }) } },
        },
      };
    } else if (step.type === 'auto') {
      states[id] = {
        invoke: {
          src: `${id}:run`,
          input: ({ context }) => ({ data: context.data }),
          onDone: after(step),
          onError: step.onError === 'continue'
            ? { target: '#journey.__route', actions: assign(({ context }) => { const pending = resolveNext(step.next, { data: context.data }); return { pending, visited: [...context.visited, pending] }; }) }
            : { target: '#journey.__failed', actions: assign(failure(id)) },
        },
      };
    } else {
      states[id] = step.run
        ? {
            invoke: {
              src: `${id}:run`,
              input: ({ context }) => ({ data: context.data }),
              onDone: after(step),
              onError: { target: '#journey.__failed', actions: assign(failure(id)) },
            },
          }
        : { always: { target: '#journey.__done', actions: assign({ result: () => step.result || { ok: true, title: 'Done' } }) } };
    }
  }

  // `__route` dispatches to the step chosen by the last transition (resolveNext): one place that
  // turns JSON `next` into an XState transition, so every step's `next` can be data-driven.
  const routeTargets = [
    { guard: ({ context }) => context.pending === '__done', target: '__done' },
    { guard: ({ context }) => context.pending === 'failed', target: '__failed' },
    ...Object.keys(spec.steps).map((id) => ({ guard: ({ context }) => context.pending === id, target: id })),
  ];

  // Going back to a step already answered ("revisit": true). The runner sends GOTO only while the
  // journey waits for an answer, never mid-action. Steps after it count as not visited again.
  const doneEarlier = (context, step) => !!spec.steps[step]?.ledger?.doneIf && evaluate(spec.steps[step].ledger.doneIf, { data: context.data });
  const canRevisit = ({ context, event }) => !!spec.steps[event.step]?.revisit && spec.steps[event.step].type === 'ask' && (context.visited.includes(event.step) || doneEarlier(context, event.step));

  return createMachine({
    id: 'journey',
    initial: spec.start,
    on: {
      GOTO: {
        guard: canRevisit,
        target: '.__route',
        actions: assign(({ context, event }) => ({
          pending: event.step,
          answer: null,
          error: null,
          visited: context.visited.includes(event.step) ? context.visited.slice(0, context.visited.indexOf(event.step) + 1) : [...context.visited, event.step],
        })),
      },
    },
    context: ({ input }) => ({ data: input || {}, answer: null, error: null, result: null, pending: null, visited: [spec.start] }),
    states: {
      ...states,
      // Engine-internal states: reserved names, so a journey may name its own steps `done` or `failed`.
      __route: { always: routeTargets },
      // Says which step failed, so a report ("That did not work") can be traced to its handler.
      __failed: { always: { target: '__done', actions: assign(({ context }) => ({ result: { ...FAILED, text: context.error, failedStep: context.failedStep } })) } },
      __done: { type: 'final' },
    },
  }, { actors: invokes });
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────
const askStepOf = (snapshot) => {
  const v = snapshot.value;
  if (v && typeof v === 'object') {
    const [step, sub] = Object.entries(v)[0];
    if (sub === 'waiting') return step;
  }
  return null;
};

export function createXStateRunner(journey, deps) {
  const problems = checkJourney(journey);
  if (problems.length) throw new Error(`Journey '${journey.spec?.id}' is invalid: ${problems.join('; ')}`);
  let actor = null;
  let finished = false;

  const settle = () => waitFor(actor, (s) => s.status === 'done' || !!askStepOf(s), { timeout: Infinity });

  function view(snapshot) {
    if (snapshot.status === 'done') {
      finished = true;
      const ledger = ledgerOf(journey.spec, { data: snapshot.context.data, visited: snapshot.context.visited, current: null });
      return { done: true, result: snapshot.context.result ?? { ok: true, title: 'Done' }, ledger };
    }
    const step = askStepOf(snapshot);
    const state = { data: snapshot.context.data, error: snapshot.context.error };
    const prompt = journey.prompts[journey.spec.steps[step].prompt](state, deps);
    const ledger = ledgerOf(journey.spec, { data: snapshot.context.data, visited: snapshot.context.visited, current: step });
    return { prompt: { ...prompt, step, error: snapshot.context.error || null }, ledger };
  }

  async function start(input = {}) {
    actor = createActor(buildMachine(journey, deps), { input });
    actor.start();
    return view(await settle());
  }

  async function answer(value) {
    if (finished || !actor) throw new Error('This journey has ended.');
    // send() moves the machine out of `waiting` synchronously, so settle() waits for this step's
    // own run to finish (back to an ask — the same one with an error, or the next — or done).
    actor.send({ type: 'ANSWER', value });
    return view(await settle());
  }

  /** Goes back to an answered step marked "revisit": true; resolves to its prompt. */
  async function back(step) {
    if (finished || !actor) throw new Error('This journey has ended.');
    if (!askStepOf(actor.getSnapshot())) throw new Error('Wait for the current step to finish.');
    if (!journey.spec.steps[step]?.revisit) throw new Error('That step can’t be changed now.');
    actor.send({ type: 'GOTO', step });
    return view(await settle());
  }

  async function cancel() {
    finished = true;
    actor?.stop();
  }

  return { start, answer, back, cancel, threadId: crypto.randomUUID() };
}
