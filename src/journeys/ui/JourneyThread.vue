<script setup>
// One registry journey (HPR, HFR or Patient ABHA) as a conversation: Cübo asks, the person
// answers with a choice or a short form, and the LangGraph runner (../runtime.js) moves to the
// next step. Ported from clinux-cubo's src/journeys/JourneyThread.vue — same prompt contract
// (text/detail/list/map/link/choices/fields/resend), restyled with the workspace's own classes,
// plus `warning` and `image` (cubo-diary's ABHA confirm step uses both).
//
// The transcript shows what was answered, with secrets masked. It is kept in memory only: an
// OTP flow can't be resumed after a reload anyway (ABDM's transaction expires), and what a
// journey achieves (an HPR ID, a facility id, a patient's ABHA) is saved by the journey itself.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { createRunner } from '../runtime.js';
import { journeyDeps } from '../index.js';
import GeoPicker from './GeoPicker.vue';
import MapView from './MapView.vue';

const props = defineProps({
  account: { type: Object, required: true },
  journey: { type: Object, required: true },
  // Start input, e.g. { patientId } when the ABHA journey is opened from a patient record.
  input: { type: Object, default: () => ({}) },
});

const transcript = ref([]);
const ledger = ref([]); // the journey's stepper, from its JSON (engine.js ledgerOf)
const prompt = ref(null);
const result = ref(null);
const busy = ref(false);
const values = reactive({});
const invalid = ref('');
const list = ref(null);
const tick = ref(Date.now()); // drives the resend countdown
const tickTimer = setInterval(() => (tick.value = Date.now()), 1000);
let runner = null;

async function scrollDown() {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight });
}

let lastAnswer = null; // { step, values } of the last form sent, for a re-ask after an error

function show(view) {
  if (view.ledger) ledger.value = view.ledger;
  if (view.done) {
    prompt.value = null;
    result.value = view.result;
    return;
  }
  const p = view.prompt;
  tick.value = Date.now();
  prompt.value = p;
  for (const k of Object.keys(values)) delete values[k];
  // Asked again after an error: keep what was entered (not one-time codes) so only the wrong part needs fixing.
  const kept = p.error && lastAnswer?.step === p.step ? lastAnswer.values : {};
  for (const f of p.fields || []) {
    const v = !f.secret && Object.hasOwn(kept, f.name) ? kept[f.name] : undefined;
    values[f.name] = v ?? f.value ?? (f.type === 'checkbox' ? false : f.type === 'multiselect' ? [] : f.type === 'geo' ? null : f.type === 'consent' ? { agreed: false, language: 'en' } : '');
  }
  transcript.value.push({ id: crypto.randomUUID(), role: 'cubo', text: p.text, detail: p.detail, list: p.list, map: p.map, error: p.error, warning: p.warning, image: p.image, imageAlt: p.imageAlt });
}

async function run(step) {
  busy.value = true;
  invalid.value = '';
  try {
    show(await step());
  } catch (e) {
    prompt.value = null;
    result.value = { ok: false, title: 'Something went wrong', text: e.message };
  }
  busy.value = false;
  scrollDown();
}

function start() {
  runner?.cancel();
  transcript.value = [];
  result.value = null;
  runner = createRunner(props.journey, journeyDeps(props.account));
  run(() => runner.start(props.input));
}

onMounted(start);
onBeforeUnmount(() => {
  runner?.cancel();
  clearInterval(tickTimer);
});

const optionLabel = (f, v) => f.options?.find((o) => o.value === v)?.label ?? v;

function summarise(p, answer) {
  if (answer.choice !== undefined) return p.choices.find((c) => c.value === answer.choice)?.label ?? answer.choice;
  return (p.fields || [])
    .filter((f) => answer[f.name] !== '' && answer[f.name] !== false && !(Array.isArray(answer[f.name]) && !answer[f.name].length))
    .map((f) => {
      const v = answer[f.name];
      if (f.secret) return `${f.label}: ••••••`;
      if (f.mask === 'last4') return `${f.label}: ••••••${String(v).slice(-4)}`;
      if (f.type === 'checkbox') return `✓ ${f.label}`;
      if (f.type === 'multiselect') return `${f.label}: ${v.map((x) => optionLabel(f, x)).join(', ')}`;
      if (f.type === 'geo') return `📍 ${v.lat}, ${v.lng}`;
      if (f.type === 'consent') return `✓ Agreed to NHA's Aadhaar consent (${f.texts[v.language].label})`;
      if (f.readonly) return null;
      return `${f.label}: ${f.type === 'select' ? optionLabel(f, v) : v}`;
    })
    .filter(Boolean)
    .join('\n');
}

function check(p) {
  for (const f of p.fields || []) {
    const v = values[f.name];
    const empty = v === '' || v === false || v == null || (Array.isArray(v) && !v.length) || (f.type === 'consent' && !v.agreed);
    if (f.type === 'consent' && f.required && empty) return 'Please read and agree to the consent to continue.';
    if (f.required && empty) return `${f.label} is required.`;
    if (!empty && f.pattern && !new RegExp(f.pattern).test(String(v).trim())) return `${f.label} doesn't look right${f.hint ? ` (${f.hint})` : ''}.`;
    if (f.type === 'geo' && !empty && !(Number.isFinite(v.lat) && Number.isFinite(v.lng))) return 'Pin the location on the map.';
  }
  return '';
}

function answer(choice) {
  const p = prompt.value;
  if (!p || busy.value) return;
  let value;
  if (choice !== undefined) value = { choice };
  else {
    invalid.value = check(p);
    if (invalid.value) return;
    value = JSON.parse(JSON.stringify(values));
  }
  lastAnswer = { step: p.step, values: choice === undefined ? value : {} };
  transcript.value.push({ id: crypto.randomUUID(), role: 'user', text: summarise(p, value) });
  prompt.value = null;
  run(() => runner.answer(value));
}

// Resend OTP (NHA HPR-008): the journey says when it is allowed; the button counts down to it.
const resendLabel = computed(() => {
  const r = prompt.value?.resend;
  if (!r) return null;
  if (r.blockedUntil && tick.value < r.blockedUntil) return `Resend blocked until ${new Date(r.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const wait = Math.ceil(((r.availableAt ?? 0) - tick.value) / 1000);
  if (wait > 0) return `Resend OTP in ${wait}s`;
  return `Resend OTP${r.remaining ? ` (${r.remaining} left)` : ''}`;
});
const canResend = computed(() => {
  const r = prompt.value?.resend;
  return !!r && !(r.blockedUntil && tick.value < r.blockedUntil) && tick.value >= (r.availableAt ?? Infinity);
});

function resend() {
  if (!canResend.value || busy.value) return;
  transcript.value.push({ id: crypto.randomUUID(), role: 'user', text: 'Resend OTP' });
  prompt.value = null;
  run(() => runner.answer({ resend: true }));
}

async function cancel() {
  await runner?.cancel();
  prompt.value = null;
  result.value = { ok: false, title: 'Stopped', text: 'Nothing more was sent.' };
}

function toggle(name, value) {
  const set = new Set(values[name]);
  set.has(value) ? set.delete(value) : set.add(value);
  values[name] = [...set];
}

defineExpose({ start });
</script>

<template>
  <section class="panel journey">
    <div class="panel-head">
      <div style="min-width:0">
        <div class="panel-title"><i class="fas" :class="journey.icon" style="color:var(--color-primary-text);margin-right:.4rem"></i>{{ journey.title }}</div>
        <div class="panel-sub">{{ journey.summary }}</div>
      </div>
      <div style="display:flex;gap:.5rem;flex-shrink:0">
        <button v-if="prompt" class="ui-btn" style="padding:.3rem .65rem" @click="cancel">Stop</button>
        <button v-if="result" class="ui-btn" style="padding:.3rem .65rem" @click="start"><i class="fas fa-rotate-left"></i> Start again</button>
      </div>
    </div>

    <!-- Stepper (Swastik-style), generated from the journey JSON's `ledger` labels: done / active / pending. -->
    <ol v-if="ledger.length > 1" class="journey-ledger" aria-label="Progress">
      <li v-for="(st, i) in ledger" :key="st.id" :class="st.state" :aria-current="st.state === 'active' ? 'step' : undefined">
        <span class="dot"><i v-if="st.state === 'done'" class="fas fa-check"></i><template v-else>{{ i + 1 }}</template></span>
        <span class="lbl">{{ st.label }}</span>
      </li>
    </ol>

    <div ref="list" class="journey-messages" data-testid="journey-messages">
      <div v-for="m in transcript" :key="m.id" class="msg-row" :class="m.role === 'user' ? 'from-user' : 'from-cubo'">
        <div v-if="m.role === 'user'" class="bubble bubble-user">{{ m.text }}</div>
        <div v-else class="bubble bubble-cubo" data-role="cubo">
          <p v-if="m.error" class="msg-error" role="alert"><i class="fas fa-circle-exclamation"></i> {{ m.error }}</p>
          <p class="msg-text">{{ m.text }}</p>
          <p v-if="m.detail" class="msg-detail">{{ m.detail }}</p>
          <p v-if="m.warning" class="msg-warning" role="alert"><i class="fas fa-triangle-exclamation"></i> {{ m.warning }}</p>
          <img v-if="m.image" :src="m.image" :alt="m.imageAlt || ''" class="msg-image" />
          <ul v-if="m.list?.length" class="msg-list">
            <li v-for="(i, n) in m.list" :key="n"><strong>{{ i.name }}</strong> <span>{{ i.detail }}</span></li>
          </ul>
          <MapView v-if="m.map" style="margin-top:.5rem" :markers="m.map.markers" :selected="m.map.selected" height="220px" />
        </div>
      </div>

      <div v-if="result" class="journey-result" :class="result.ok ? 'ok' : 'bad'" data-testid="journey-result">
        <p class="result-title"><i class="fas" :class="result.ok ? 'fa-circle-check' : 'fa-circle-xmark'"></i> {{ result.title }}</p>
        <p v-if="result.text" class="msg-text" style="margin-top:.25rem">{{ result.text }}</p>
        <dl v-if="result.facts?.length" class="result-facts">
          <template v-for="[k, v] in result.facts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
      </div>
      <p v-if="busy" class="msg-detail"><i class="fas fa-spinner fa-spin"></i> Working…</p>
    </div>

    <div v-if="prompt && !busy" class="journey-prompt" data-testid="journey-prompt">
      <!-- A page to finish elsewhere first (NHA's Aadhaar verification), opened in a new tab. -->
      <a v-if="prompt.link" :href="prompt.link.href" target="_blank" rel="noopener noreferrer" class="ui-btn ui-btn-primary" style="align-self:flex-start" data-testid="journey-link">
        <i class="fas fa-up-right-from-square"></i> {{ prompt.link.label }}
      </a>
      <div v-if="prompt.choices" class="choices">
        <button v-for="c in prompt.choices" :key="c.value" class="choice" @click="answer(c.value)">
          <span class="choice-label">{{ c.label }}</span><span v-if="c.detail" class="choice-detail">{{ c.detail }}</span>
        </button>
      </div>

      <form v-else class="fields" novalidate @submit.prevent="answer()">
        <template v-for="f in prompt.fields" :key="f.name">
          <label v-if="f.type === 'checkbox'" class="wide check">
            <input v-model="values[f.name]" type="checkbox" />{{ f.label }}
          </label>
          <div v-else-if="f.type === 'consent'" class="wide" style="display:flex;flex-direction:column;gap:.5rem" data-testid="consent">
            <div style="display:flex;gap:.4rem" role="group" aria-label="Consent language">
              <button v-for="(t, lang) in f.texts" :key="lang" type="button" class="ui-btn" style="padding:.3rem .65rem" :class="{ 'ui-btn-primary': values[f.name].language === lang }" :aria-pressed="values[f.name].language === lang" @click="values[f.name].language = lang">{{ t.label }}</button>
            </div>
            <div class="consent-text" tabindex="0" :lang="values[f.name].language" aria-label="Consent text">
              <p v-for="(para, n) in f.texts[values[f.name].language].paragraphs" :key="n" :style="n ? 'margin-top:.5rem' : ''">{{ para }}</p>
            </div>
            <label class="check" style="font-weight:600"><input v-model="values[f.name].agreed" type="checkbox" name="consent" />{{ f.texts[values[f.name].language].agree }}</label>
          </div>
          <div v-else-if="f.type === 'geo'" class="wide">
            <GeoPicker v-model="values[f.name]" :label="f.label" />
          </div>
          <div v-else-if="f.type === 'multiselect'" class="field wide">
            <label>{{ f.label }}</label>
            <div style="display:flex;flex-wrap:wrap;gap:.4rem">
              <button v-for="o in f.options" :key="o.value" type="button" class="ui-btn" style="padding:.3rem .65rem" :aria-pressed="values[f.name].includes(o.value)" :class="{ 'ui-btn-primary': values[f.name].includes(o.value) }" @click="toggle(f.name, o.value)">{{ o.label }}</button>
            </div>
          </div>
          <div v-else class="field" :class="{ wide: f.wide }">
            <label :for="`jf-${f.name}`">{{ f.label }}</label>
            <select v-if="f.type === 'select'" :id="`jf-${f.name}`" v-model="values[f.name]" class="cf-input">
              <option value="" disabled>Choose…</option>
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input
              v-else
              :id="`jf-${f.name}`"
              v-model="values[f.name]"
              class="cf-input"
              :type="f.type || 'text'"
              :inputmode="f.inputmode"
              :placeholder="f.placeholder"
              :autocomplete="f.secret ? 'off' : undefined"
              :readonly="f.readonly"
              :aria-readonly="f.readonly ? 'true' : undefined"
              :class="{ 'is-readonly': f.readonly }"
            />
            <span v-if="f.hint" class="field-hint">{{ f.hint }}</span>
          </div>
        </template>
        <p v-if="invalid" class="msg-error wide" role="alert">{{ invalid }}</p>
        <div class="wide" style="display:flex;flex-wrap:wrap;gap:.5rem">
          <button class="ui-btn ui-btn-primary" type="submit">{{ prompt.submitLabel || 'Continue' }}</button>
          <button v-if="resendLabel" type="button" class="ui-btn" :disabled="!canResend" data-testid="resend" @click="resend">{{ resendLabel }}</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.journey { display: flex; flex-direction: column; min-height: 0; }
.journey-ledger { list-style: none; margin: 0; padding: .75rem 1rem; display: flex; flex-wrap: wrap; gap: .4rem 1rem; border-bottom: 1px solid var(--shell-border); }
.journey-ledger li { display: flex; align-items: center; gap: .4rem; font-size: .76rem; color: var(--shell-text-muted); }
.journey-ledger li + li::before { content: ''; width: 18px; height: 1px; background: var(--shell-border-strong); margin-right: .2rem; }
.journey-ledger .dot { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: .66rem; font-weight: 700; border: 1px solid var(--shell-border-strong); background: var(--shell-surface); }
.journey-ledger li.active { color: var(--shell-text-strong); font-weight: 600; }
.journey-ledger li.active .dot { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-on-primary); }
.journey-ledger li.done .dot { background: #16a34a; border-color: #16a34a; color: #fff; }
.journey-messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: .75rem; min-height: 180px; max-height: 56vh; }
.msg-row { display: flex; }
.from-user { justify-content: flex-end; }
.from-cubo { justify-content: flex-start; }
.bubble { padding: .6rem .8rem; border-radius: .75rem; font-size: .84rem; line-height: 1.5; }
.bubble-user { max-width: 80%; background: var(--color-primary); color: var(--color-on-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble-cubo { max-width: 92%; background: var(--shell-bg); border: 1px solid var(--shell-border); color: var(--shell-text-strong); }
.msg-text { margin: 0; }
.msg-detail { margin: .25rem 0 0; font-size: .75rem; color: var(--shell-text-muted); }
.msg-error { margin: 0 0 .5rem; font-size: .78rem; color: #b91c1c; }
.msg-warning { margin: .5rem 0 0; font-size: .78rem; color: #b45309; }
.msg-image { margin-top: .5rem; width: 96px; height: 96px; object-fit: cover; border-radius: .5rem; border: 1px solid var(--shell-border); }
.msg-list { margin: .5rem 0 0; padding-left: 1rem; font-size: .75rem; display: flex; flex-direction: column; gap: .15rem; }
.msg-list span { color: var(--shell-text-muted); }
.journey-result { border: 1px solid; border-radius: .625rem; padding: .875rem 1rem; background: var(--shell-surface); }
.journey-result.ok { border-color: #16a34a; }
.journey-result.bad { border-color: #dc2626; }
.result-title { margin: 0; font-weight: 700; font-size: .88rem; }
.journey-result.ok .result-title { color: #15803d; }
.journey-result.bad .result-title { color: #b91c1c; }
.result-facts { margin: .5rem 0 0; display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; font-size: .8rem; }
.result-facts dt { color: var(--shell-text-muted); }
.result-facts dd { margin: 0; font-family: 'JetBrains Mono', monospace; overflow-wrap: anywhere; color: var(--shell-text-strong); }
.journey-prompt { padding: .875rem 1rem; border-top: 1px solid var(--shell-border); display: flex; flex-direction: column; gap: .625rem; }
.choices { display: flex; flex-wrap: wrap; gap: .5rem; }
.choice { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: .1rem; padding: .55rem .8rem; border-radius: .5rem; border: 1px solid var(--shell-border-strong); background: var(--shell-surface); cursor: pointer; max-width: 100%; }
.choice:hover { border-color: var(--color-primary); background: var(--color-primary-soft); }
.choice-label { font-size: .82rem; font-weight: 600; color: var(--shell-text-strong); }
.choice-detail { font-size: .72rem; color: var(--shell-text-muted); }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: .625rem .75rem; }
.wide { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: .25rem; }
.field label { font-size: .75rem; font-weight: 600; color: var(--shell-text-strong); }
.field-hint { font-size: .7rem; color: var(--shell-text-muted); }
.check { display: flex; align-items: flex-start; gap: .5rem; font-size: .8rem; color: var(--shell-text-strong); }
.check input { margin-top: .2rem; }
.consent-text { max-height: 220px; overflow-y: auto; background: var(--shell-bg); border: 1px solid var(--shell-border); border-radius: .5rem; padding: .75rem; font-size: .8rem; line-height: 1.6; }
.is-readonly { background: var(--shell-bg); color: var(--shell-text-muted); cursor: not-allowed; }
@media (max-width: 640px) { .fields { grid-template-columns: 1fr; } }
</style>
