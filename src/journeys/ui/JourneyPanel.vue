<script setup>
// A registry journey's form pane: the stepper (from the journey JSON's `ledger` labels), the
// question being asked now, and its answer form — choices, fields, resend — or the result. The
// conversation itself is the journey's Cübo thread (sessions.js writes it); this pane is what
// answers it. Shown next to Cübo on /registries/:journey and in Cübo's own Content tab.
//
// The current question is repeated here on purpose: on phones and tablets only one of chat and
// form is visible at a time, so the form must make sense without the chat beside it.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { journeyById } from '../index.js';
import { useJourneySessionsStore, journeyIdOfThread, threadKeyOf } from '../sessions.js';
import { useCuboProfileStore, REGISTRIES } from '../profile.js';
import { addressFor, check, initialValues } from './promptForm.js';
import { readImage } from './imageFile.js';
import GeoPicker from './GeoPicker.vue';
import SearchSelect from './SearchSelect.vue';
import MapView from './MapView.vue';
import LhcFormHost from '../../components/LhcFormHost.vue';
import { activeQuestionnaire, sliceQuestionnaireGroup, sliceRecordGroup } from '../../data/useSystemForms.js';

const props = defineProps({
  threadId: { type: String, required: true },
  // Hides the title row where the host already shows it (the Registries page's own header).
  compact: { type: Boolean, default: false },
});

const auth = useAuthStore();
const store = useJourneySessionsStore();

const session = computed(() => store.sessions[props.threadId] || null);
const journey = computed(() => journeyById(session.value?.journeyId || journeyIdOfThread(props.threadId)));
const prompt = computed(() => session.value?.prompt || null);
const busy = computed(() => !!session.value?.busy);
const result = computed(() => session.value?.result || null);
const ledger = computed(() => session.value?.ledger || []);
const running = computed(() => !!session.value && store.isLive(props.threadId));

// ── Progress menu (the header's progress button): the journey's steps top to bottom, from its
// JSON ledger, with Stop / Start again — in place of a stepper inside the form.
const menuOpen = ref(false);
const menuEl = ref(null);
const doneCount = computed(() => ledger.value.filter((st) => st.state === 'done').length);
const activeIndex = computed(() => ledger.value.findIndex((st) => st.state === 'active'));
const progressLabel = computed(() => {
  if (result.value?.readonly) return 'Read-only';
  if (result.value) return result.value.ok ? 'Finished' : result.value.title;
  if (!ledger.value.length) return busy.value ? 'Starting…' : 'Progress';
  return `Step ${activeIndex.value >= 0 ? activeIndex.value + 1 : doneCount.value} of ${ledger.value.length}`;
});
const progressPct = computed(() => (ledger.value.length ? Math.round((doneCount.value / ledger.value.length) * 100) : 0));
// Going back: any answered step the journey JSON marks "revisit": true, while a step is waiting.
const canGoBack = computed(() => !!prompt.value && !busy.value);
const backTarget = computed(() => {
  const i = activeIndex.value >= 0 ? activeIndex.value : ledger.value.length;
  return [...ledger.value.slice(0, i)].reverse().find((st) => st.state === 'done' && st.revisit) || null;
});
function goBack(st) {
  if (!st || !canGoBack.value) return;
  menuOpen.value = false;
  store.back(props.threadId, st.id);
}
function closeMenuOnOutsideClick(e) {
  if (menuEl.value && !menuEl.value.contains(e.target)) menuOpen.value = false;
}
onMounted(() => document.addEventListener('click', closeMenuOnOutsideClick));
onBeforeUnmount(() => document.removeEventListener('click', closeMenuOnOutsideClick));

// Sign-ins this journey's JSON declares (`"signIn": "<registry>"` steps), with who Cübo's profile
// has signed in — a journey reuses that sign-in rather than asking again.
const profile = useCuboProfileStore();
const signIns = computed(() => {
  const registries = [...new Set(Object.values(journey.value?.spec?.steps || {}).map((st) => st.signIn).filter(Boolean))];
  return registries.map((r) => ({ registry: r, label: REGISTRIES[r]?.label || r.toUpperCase(), identity: profile.identity(r) }));
});

const values = reactive({});
const invalid = ref('');
const tick = ref(Date.now()); // drives the resend countdown
const tickTimer = setInterval(() => (tick.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(tickTimer));

watch(prompt, (p) => {
  for (const k of Object.keys(values)) delete values[k];
  invalid.value = '';
  tick.value = Date.now();
  if (p) Object.assign(values, initialValues(p, store.keptFor(props.threadId, p)));
}, { immediate: true });

// ── A form step (prompt.form = { formId, group?, record?, scrollTo? }): one of the app's own
// forms (LHC-Forms), shown whole or as one section (`group`) of its record. Saving sends the
// extracted QuestionnaireResponse as { qr }; an action button (prompt.actions) as { action, qr }.
const formHost = ref(null);
const formQuestionnaire = computed(() => {
  const f = prompt.value?.form;
  if (!f) return null;
  const q = activeQuestionnaire(f.formId);
  return f.group ? sliceQuestionnaireGroup(q, f.group) : q;
});
const formRecord = computed(() => {
  const f = prompt.value?.form;
  if (!f?.record) return null;
  return f.group ? sliceRecordGroup(f.record, f.group) : f.record;
});
const formContainerId = computed(() => `jform-${props.threadId.replace(/[^\w-]/g, '_')}`);
const formKey = ref(0);
watch(prompt, () => { formKey.value++; });
function sendForm(action) {
  const p = prompt.value;
  if (!p || busy.value) return;
  const qr = formHost.value?.extract();
  if (!qr && !action) {
    invalid.value = 'The form could not be read. Check the fields and try again.';
    return;
  }
  store.answer(props.threadId, { ...(action ? { action } : {}), ...(qr ? { qr } : {}) });
}

function send(choice) {
  const p = prompt.value;
  if (!p || busy.value) return;
  if (choice !== undefined) return store.answer(props.threadId, { choice });
  invalid.value = check(p, values);
  if (invalid.value) return;
  store.answer(props.threadId, JSON.parse(JSON.stringify(values)));
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
  if (canResend.value && !busy.value) store.answer(props.threadId, { resend: true });
}

function restart() {
  if (!journey.value || !auth.currentUser) return;
  // A read-only result's "again" can start afresh (e.g. ABHA for another patient), not for the same input.
  const fresh = result.value?.readonly && result.value.againFresh;
  const key = session.value?.key ?? threadKeyOf(props.threadId);
  // A clinic journey's thread is keyed by its visit, so after a reload the visit is known from it.
  const input = fresh ? {} : session.value?.input || (key ? { encounterId: key } : {});
  store.start(journey.value.id, { account: auth.currentUser, input, key, title: session.value?.title });
}

// A photo field: kept as { name, value: base64 } (shrunk first when large — imageFile.js).
const reading = ref('');
async function pickImage(f, e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  reading.value = f.name;
  invalid.value = '';
  try {
    values[f.name] = await readImage(file);
  } catch (err) {
    invalid.value = `${f.label}: ${err.message}`;
  } finally {
    reading.value = '';
  }
}
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Long lists get a search: a select past SEARCH_SELECT_AT options becomes a SearchSelect, a
// multiselect past FILTER_MULTI_AT gets a filter box (what's chosen always stays in view).
const SEARCH_SELECT_AT = 8;
const FILTER_MULTI_AT = 12;
const filters = reactive({});
function shownOptions(f) {
  const q = String(filters[f.name] || '').trim().toLowerCase();
  if (!q) return f.options;
  return f.options.filter((o) => values[f.name].includes(o.value) || String(o.label).toLowerCase().includes(q));
}

function toggle(name, value) {
  const set = new Set(values[name]);
  set.has(value) ? set.delete(value) : set.add(value);
  values[name] = [...set];
}
</script>

<template>
  <section class="journey-panel" data-testid="journey-panel">
    <div v-if="journey" class="jp-head" :class="{ compact }">
      <div v-if="!compact" style="min-width:0">
        <div class="jp-title"><i class="fas" :class="journey.icon"></i>{{ journey.title }}</div>
        <div class="jp-sub">{{ journey.summary }}</div>
        <!-- Pages this journey relates to (its JSON's "related"), e.g. HFR → Facility profile. -->
        <div v-if="journey.spec?.related?.length" class="jp-related">
          <RouterLink v-for="r in journey.spec.related" :key="r.to" :to="r.to" class="jp-related-link" :title="r.note || ''" data-testid="journey-related">
            <i class="fas" :class="r.icon || 'fa-link'"></i>{{ r.label }}
          </RouterLink>
        </div>
      </div>
      <div class="jp-actions">
        <button v-if="!running && !result" class="ui-btn" style="padding:.3rem .65rem" @click="restart"><i class="fas fa-play"></i> Start</button>
        <div v-else ref="menuEl" class="jp-menu-anchor">
          <button type="button" class="jp-progress-btn" :aria-expanded="menuOpen" aria-haspopup="menu" data-testid="journey-progress" @click="menuOpen = !menuOpen">
            <span class="jp-progress-text">{{ progressLabel }}</span>
            <span class="jp-progress-bar"><span :style="{ width: `${result?.ok ? 100 : progressPct}%` }"></span></span>
            <i class="fas fa-chevron-down" style="font-size:.6rem"></i>
          </button>
          <div v-show="menuOpen" class="jp-menu" role="menu" data-testid="journey-progress-menu">
            <div class="jp-menu-title">{{ journey.title }} · {{ result?.ok ? 100 : progressPct }}%</div>
            <!-- The journey's steps top to bottom (its JSON ledger): done / now / still to come. -->
            <ol class="jp-steps">
              <li v-for="(st, i) in ledger" :key="st.id" :class="[st.state, { revisitable: st.state === 'done' && st.revisit && canGoBack }]" :aria-current="st.state === 'active' ? 'step' : undefined">
                <span class="dot"><i v-if="st.state === 'done'" class="fas fa-check"></i><template v-else>{{ i + 1 }}</template></span>
                <span class="lbl">
                  <!-- An answered step that can be changed: go back to it. -->
                  <button v-if="st.state === 'done' && st.revisit && canGoBack" type="button" class="jp-step-link" role="menuitem" :data-testid="`journey-goto-${st.id}`" @click="goBack(st)">
                    {{ st.label }}<span class="jp-step-edit"><i class="fas fa-pen"></i> Change</span>
                  </button>
                  <template v-else>{{ st.label }}</template>
                  <span v-if="st.signIn && profile.identity(st.signIn)?.session" class="jp-step-note">as {{ profile.identity(st.signIn).session.hprId }}</span>
                </span>
              </li>
              <li v-if="!ledger.length" class="pending"><span class="lbl">Steps appear once the journey starts.</span></li>
            </ol>
            <!-- Sign-ins come from Cübo's profile (journeys/profile.js). -->
            <div v-for="si in signIns" :key="si.registry" class="jp-signin" data-testid="journey-signin">
              <i class="fas fa-id-badge"></i>
              <span v-if="si.identity?.session">Signed in to {{ si.label }} as <strong>{{ si.identity.session.hprId }}</strong> · Cübo profile</span>
              <span v-else-if="si.identity?.linked">{{ si.label }} ID {{ si.identity.linked }} on your Cübo profile — this journey will ask you to sign in</span>
              <span v-else>Not signed in to {{ si.label }} — this journey will ask</span>
            </div>
            <div class="jp-menu-actions">
              <button v-if="prompt || busy" type="button" class="jp-menu-item danger" role="menuitem" data-testid="journey-stop" @click="menuOpen = false; store.stop(threadId)"><i class="fas fa-stop"></i>Stop this journey</button>
              <!-- A completed record is read-only: no Start again over it, only what the journey offers next. -->
              <button v-if="result?.readonly && result.again" type="button" class="jp-menu-item" role="menuitem" @click="menuOpen = false; restart()"><i class="fas fa-arrow-right"></i>{{ result.again }}</button>
              <button v-else-if="!result?.readonly" type="button" class="jp-menu-item" role="menuitem" @click="menuOpen = false; restart()"><i class="fas fa-rotate-left"></i>Start again</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="jp-body">
      <div v-if="!running && !result" class="empty-state" style="padding:2rem 1rem">
        <div class="empty-state-icon"><i class="fas fa-route"></i></div>
        <div class="empty-state-title">Not running</div>
        <p class="empty-state-text">The log of earlier runs is in this journey’s Cübo thread. Start it to continue.</p>
      </div>

      <p v-if="busy" class="jp-muted"><i class="fas fa-spinner fa-spin"></i> Working…</p>

      <div v-if="result" class="journey-result" :class="result.ok ? 'ok' : 'bad'" data-testid="journey-result">
        <p class="result-title">
          <i class="fas" :class="result.ok ? 'fa-circle-check' : 'fa-circle-xmark'"></i> {{ result.title }}
          <span v-if="result.readonly" class="jp-readonly" data-testid="journey-readonly"><i class="fas fa-lock"></i> Read-only</span>
        </p>
        <p v-if="result.text" class="jp-text" style="margin-top:.25rem">{{ result.text }}</p>
        <dl v-if="result.facts?.length" class="result-facts">
          <template v-for="[k, v] in result.facts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
        <!-- A completed record's contents, section by section (e.g. a closed encounter). -->
        <div v-for="sec in result.sections || []" :key="sec.title" class="result-section">
          <div class="result-section-title">{{ sec.title }}</div>
          <dl class="result-facts">
            <template v-for="([k, v], n) in sec.rows" :key="n"><dt>{{ k }}</dt><dd class="plain">{{ v }}</dd></template>
          </dl>
        </div>
        <div v-if="result.next || (result.readonly && result.again)" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem">
          <!-- Where this leads (e.g. a checked-in visit → Consultation). -->
          <RouterLink v-if="result.next" :to="result.next.to" class="ui-btn ui-btn-primary" style="padding:.35rem .75rem" data-testid="journey-next"><i class="fas fa-arrow-right"></i> {{ result.next.label }}</RouterLink>
          <button v-if="result.readonly && result.again" type="button" class="ui-btn" style="padding:.35rem .75rem" data-testid="journey-again" @click="restart"><i class="fas fa-arrow-right"></i> {{ result.again }}</button>
        </div>
      </div>

      <div v-if="prompt && !busy" class="journey-prompt" data-testid="journey-prompt">
        <div class="jp-question">
          <p v-if="prompt.error" class="msg-error" role="alert"><i class="fas fa-circle-exclamation"></i> {{ prompt.error }}</p>
          <p class="jp-text" data-testid="journey-question">{{ prompt.text }}</p>
          <p v-if="prompt.detail" class="jp-muted">{{ prompt.detail }}</p>
          <p v-if="prompt.warning" class="msg-warning" role="alert"><i class="fas fa-triangle-exclamation"></i> {{ prompt.warning }}</p>
          <img v-if="prompt.image" :src="prompt.image" :alt="prompt.imageAlt || ''" class="msg-image" />
          <ul v-if="prompt.list?.length" class="msg-list">
            <li v-for="(i, n) in prompt.list" :key="n"><strong>{{ i.name }}</strong> <span>{{ i.detail }}</span></li>
          </ul>
          <MapView v-if="prompt.map" style="margin-top:.5rem" :markers="prompt.map.markers" :selected="prompt.map.selected" height="220px" />
        </div>

        <!-- A page to finish elsewhere first (NHA's Aadhaar verification), opened in a new tab. -->
        <a v-if="prompt.link" :href="prompt.link.href" target="_blank" rel="noopener noreferrer" class="ui-btn ui-btn-primary" style="align-self:flex-start" data-testid="journey-link">
          <i class="fas fa-up-right-from-square"></i> {{ prompt.link.label }}
        </a>
        <div v-if="prompt.choices" class="choices">
          <button v-if="backTarget" type="button" class="choice choice-back" data-testid="journey-back" :title="`Back to ${backTarget.label}`" @click="goBack(backTarget)">
            <span class="choice-label"><i class="fas fa-arrow-left"></i> Back</span><span class="choice-detail">{{ backTarget.label }}</span>
          </button>
          <button v-for="c in prompt.choices" :key="c.value" class="choice" @click="send(c.value)">
            <span class="choice-label">{{ c.label }}</span><span v-if="c.detail" class="choice-detail">{{ c.detail }}</span>
          </button>
        </div>

        <!-- A form step: one section of the encounter (or a whole form), saved as it is. -->
        <div v-else-if="prompt.form" class="jp-form" data-testid="journey-form">
          <LhcFormHost v-if="formQuestionnaire" :key="formKey" ref="formHost" :questionnaire="formQuestionnaire" :record="formRecord" :container-id="formContainerId" :scroll-to-link-id="prompt.form.scrollTo || null" />
          <p v-else class="msg-error">This form isn’t available yet — clinuxflow-api may not be reachable to load it.</p>
          <p v-if="invalid" class="msg-error" role="alert">{{ invalid }}</p>
          <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem">
            <button v-if="backTarget" type="button" class="ui-btn" data-testid="journey-back" :title="`Back to ${backTarget.label}`" @click="goBack(backTarget)"><i class="fas fa-arrow-left"></i> Back</button>
            <button type="button" class="ui-btn ui-btn-primary" :disabled="!formQuestionnaire" data-testid="journey-form-save" @click="sendForm()">{{ prompt.submitLabel || 'Save and continue' }}</button>
            <button v-for="a in prompt.actions || []" :key="a.value" type="button" class="ui-btn" :title="a.detail || ''" :data-testid="`journey-action-${a.value}`" @click="sendForm(a.value)">
              <i v-if="a.icon" class="fas" :class="a.icon"></i> {{ a.label }}
            </button>
          </div>
        </div>

        <form v-else class="fields" novalidate @submit.prevent="send()">
          <!-- hiddenWhen: a field that doesn't apply while that checkbox is ticked (opening times vs 24×7). -->
          <template v-for="f in prompt.fields.filter((x) => !(x.hiddenWhen && values[x.hiddenWhen]))" :key="f.name">
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
              <GeoPicker v-model="values[f.name]" :label="f.label" :address="f.near ? addressFor(prompt, f, values) : null" />
            </div>
            <div v-else-if="f.type === 'image'" class="field" data-testid="image-field">
              <label>{{ f.label }}</label>
              <div class="photo" :class="{ filled: values[f.name] }">
                <img v-if="values[f.name]" :src="`data:${values[f.name].type || 'image/jpeg'};base64,${values[f.name].value}`" alt="" />
                <i v-else class="fas fa-image"></i>
                <div style="min-width:0;flex:1">
                  <div v-if="values[f.name]" class="photo-name">{{ values[f.name].name }}</div>
                  <div class="field-hint">{{ values[f.name]?.size ? kb(values[f.name].size) : f.hint }}</div>
                </div>
                <label class="ui-btn" style="padding:.3rem .65rem;cursor:pointer">
                  <i class="fas" :class="reading === f.name ? 'fa-spinner fa-spin' : 'fa-camera'"></i>{{ values[f.name] ? 'Change' : 'Choose' }}
                  <input type="file" accept="image/png,image/jpeg" class="sr-only" :data-testid="`image-${f.name}`" @change="pickImage(f, $event)" />
                </label>
              </div>
            </div>
            <div v-else-if="f.type === 'multiselect'" class="field wide">
              <label>{{ f.label }}<span v-if="f.options?.length > FILTER_MULTI_AT && values[f.name].length" class="ms-count">{{ values[f.name].length }} chosen</span></label>
              <div v-if="f.options?.length > FILTER_MULTI_AT" class="ms-filter">
                <i class="fas fa-magnifying-glass"></i>
                <input v-model="filters[f.name]" class="cf-input" type="search" :placeholder="`Search ${f.options.length} options…`" :aria-label="`Search ${f.label}`" @keydown.enter.prevent />
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:.4rem" :class="{ 'many-options': f.options?.length > FILTER_MULTI_AT }">
                <span v-if="!shownOptions(f).length" class="field-hint">No match for “{{ filters[f.name] }}”</span>
                <button v-for="o in shownOptions(f)" :key="o.value" type="button" class="ui-btn" style="padding:.3rem .65rem" :aria-pressed="values[f.name].includes(o.value)" :class="{ 'ui-btn-primary': values[f.name].includes(o.value) }" @click="toggle(f.name, o.value)">{{ o.label }}</button>
              </div>
            </div>
            <div v-else class="field" :class="{ wide: f.wide }">
              <label :for="`jf-${threadId}-${f.name}`">{{ f.label }}</label>
              <SearchSelect v-if="f.type === 'select' && f.options?.length > SEARCH_SELECT_AT" :id="`jf-${threadId}-${f.name}`" v-model="values[f.name]" :options="f.options" />
              <select v-else-if="f.type === 'select'" :id="`jf-${threadId}-${f.name}`" v-model="values[f.name]" class="cf-input">
                <option value="" disabled>Choose…</option>
                <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <input
                v-else
                :id="`jf-${threadId}-${f.name}`"
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
            <button v-if="backTarget" type="button" class="ui-btn" data-testid="journey-back" :title="`Back to ${backTarget.label}`" @click="goBack(backTarget)"><i class="fas fa-arrow-left"></i> Back</button>
            <button class="ui-btn ui-btn-primary" type="submit">{{ prompt.submitLabel || 'Continue' }}</button>
            <button v-if="resendLabel" type="button" class="ui-btn" :disabled="!canResend" data-testid="resend" @click="resend">{{ resendLabel }}</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.journey-panel { display: flex; flex-direction: column; min-height: 0; background: var(--shell-surface); border: 1px solid var(--shell-border); border-radius: .75rem; }
.jp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; padding: .875rem 1rem; border-bottom: 1px solid var(--shell-border); }
.jp-head.compact { justify-content: flex-end; padding: .5rem 1rem; }
.jp-title { font-weight: 700; font-size: .92rem; color: var(--shell-text-strong); display: flex; align-items: center; gap: .45rem; }
.jp-title i { color: var(--color-primary-text); }
.jp-form { display: flex; flex-direction: column; }
.jp-form :deep(.lhc-form) { margin: 0; }
.jp-related { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .45rem; }
.jp-related-link { display: inline-flex; align-items: center; gap: .35rem; font-size: .72rem; font-weight: 600; padding: .15rem .55rem; border-radius: 99px; border: 1px solid var(--shell-border); color: var(--color-primary-text); text-decoration: none; background: var(--shell-bg); }
.jp-related-link:hover { border-color: var(--color-primary); }
.jp-readonly { display: inline-flex; align-items: center; gap: .3rem; margin-left: .5rem; font-size: .68rem; font-weight: 600; padding: .1rem .45rem; border-radius: 99px; background: var(--shell-bg); border: 1px solid var(--shell-border); color: var(--shell-text-muted); vertical-align: middle; }
.result-section { margin-top: .75rem; padding-top: .6rem; border-top: 1px solid var(--shell-border); }
.result-section-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--shell-text-muted); }
.result-facts dd.plain { font-family: inherit; }
.jp-sub { font-size: .75rem; color: var(--shell-text-muted); margin-top: .15rem; }
.jp-actions { display: flex; gap: .5rem; flex-shrink: 0; }
.jp-body { padding: 1rem; display: flex; flex-direction: column; gap: .75rem; }
.jp-text { margin: 0; font-size: .86rem; color: var(--shell-text-strong); line-height: 1.5; }
.jp-muted { margin: .25rem 0 0; font-size: .76rem; color: var(--shell-text-muted); }
.jp-question { background: var(--shell-bg); border: 1px solid var(--shell-border); border-radius: .625rem; padding: .75rem .875rem; }
.jp-menu-anchor { position: relative; }
.jp-progress-btn { display: inline-flex; align-items: center; gap: .5rem; padding: .35rem .65rem; border: 1px solid var(--shell-border-strong); border-radius: .5rem; background: var(--shell-surface); color: var(--shell-text-strong); font-size: .76rem; font-weight: 600; cursor: pointer; }
.jp-progress-btn:hover { border-color: var(--color-primary); }
.jp-progress-text { white-space: nowrap; }
.jp-progress-bar { width: 56px; height: 5px; border-radius: 99px; background: var(--shell-border); overflow: hidden; }
.jp-progress-bar span { display: block; height: 100%; background: var(--color-primary); transition: width .3s; }
.jp-menu { position: absolute; right: 0; top: calc(100% + .375rem); z-index: 30; width: min(320px, 85vw); background: var(--shell-surface); border: 1px solid var(--shell-border); border-radius: .625rem; box-shadow: 0 12px 32px -8px rgba(0, 0, 0, .25); padding: .75rem; }
.jp-menu-title { font-size: .72rem; font-weight: 700; color: var(--shell-text-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: .5rem; }
.jp-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.jp-steps li { position: relative; display: flex; align-items: flex-start; gap: .55rem; padding: 0 0 .7rem; font-size: .8rem; color: var(--shell-text-muted); }
.jp-steps li:not(:last-child)::before { content: ''; position: absolute; left: 10px; top: 22px; bottom: 2px; width: 2px; background: var(--shell-border); }
.jp-steps li.done:not(:last-child)::before { background: #16a34a; }
.jp-steps .dot { width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: .66rem; font-weight: 700; border: 1px solid var(--shell-border-strong); background: var(--shell-surface); }
.jp-steps .lbl { padding-top: .15rem; display: flex; flex-direction: column; }
.jp-steps li.active { color: var(--shell-text-strong); font-weight: 600; }
.jp-steps li.active .dot { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-on-primary); }
.jp-steps li.done .dot { background: #16a34a; border-color: #16a34a; color: #fff; }
.jp-step-link { display: inline-flex; flex-direction: column; align-items: flex-start; border: none; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
.jp-step-link:hover { color: var(--color-primary-text); }
.jp-step-edit { font-size: .68rem; font-weight: 600; color: var(--color-primary-text); display: inline-flex; align-items: center; gap: .25rem; }
.jp-step-edit i { font-size: .58rem; }
.choice-back { border-style: dashed; }
.jp-step-note { font-size: .7rem; font-weight: 400; color: var(--shell-text-muted); }
.jp-signin { display: flex; gap: .45rem; align-items: flex-start; font-size: .74rem; color: var(--shell-text); background: var(--shell-bg); border-radius: .45rem; padding: .45rem .55rem; margin-top: .25rem; }
.jp-signin i { color: var(--color-primary-text); margin-top: .15rem; }
.jp-menu-actions { border-top: 1px solid var(--shell-border); margin-top: .6rem; padding-top: .4rem; display: flex; flex-direction: column; }
.jp-menu-item { display: flex; align-items: center; gap: .55rem; padding: .45rem .4rem; border: none; background: none; border-radius: .375rem; font-size: .8rem; color: var(--shell-text-strong); cursor: pointer; text-align: left; }
.jp-menu-item:hover { background: var(--shell-hover); }
.jp-menu-item.danger, .jp-menu-item.danger i { color: #dc2626; }
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
.journey-prompt { display: flex; flex-direction: column; gap: .75rem; }
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
.photo { display: flex; align-items: center; gap: .625rem; padding: .5rem; border: 1px dashed var(--shell-border-strong); border-radius: .5rem; background: var(--shell-bg); }
.photo.filled { border-style: solid; }
.photo img { width: 48px; height: 48px; object-fit: cover; border-radius: .375rem; flex-shrink: 0; }
.photo > i { width: 48px; text-align: center; font-size: 1.25rem; color: var(--shell-text-muted); }
.photo-name { font-size: .78rem; font-weight: 600; color: var(--shell-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-count { margin-left: .4rem; font-weight: 500; color: var(--color-primary-text); }
.ms-filter { position: relative; }
.ms-filter i { position: absolute; left: .7rem; top: 50%; transform: translateY(-50%); font-size: .72rem; color: var(--shell-text-muted); }
.ms-filter input { padding-left: 2rem; width: 100%; }
.many-options { max-height: 200px; overflow-y: auto; padding: .25rem; border: 1px solid var(--shell-border); border-radius: .5rem; }
.is-readonly { background: var(--shell-bg); color: var(--shell-text-muted); cursor: not-allowed; }
@media (max-width: 640px) { .fields { grid-template-columns: 1fr; } }
</style>
