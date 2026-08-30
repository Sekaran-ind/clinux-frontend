<script setup>
// SPEC-14 (docs/SPEC-14-HFSM-RUNTIME-AND-CHAT-FIRST-CAPTURE.md) §7 — first real HFSM+chat-first
// capture flow, additive alongside HospitalOnboarding.vue's existing drawer (that flow is
// untouched; this is a parallel path to prove the pattern, not a replacement shipped without
// comparison). Reuses the EXACT same save pipeline HospitalOnboarding.vue's saveDrawer() uses
// (withGroupFields/saveDataRecord/publish/updateClinicName) so this never forks the data path —
// only how the values get captured differs.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useMachine } from '@xstate/vue';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { buildHospitalRegistrationMachine, fieldMetaFor, isComplete, isReview, orderedFieldIds } from '../workflow/hospitalRegistrationMachine.js';
import { HOSPITAL_FIELDS } from '../data/abdmSchema.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { activeVersionNumber, saveDataRecord, withGroupFields } from '../data/useSystemForms.js';

const router = useRouter();
const onboarding = useOnboardingStore();
const auth = useAuthStore();

const machine = buildHospitalRegistrationMachine();
const { snapshot, send } = useMachine(machine);

const orderedIds = orderedFieldIds();
const currentField = computed(() => (snapshot.value.context.currentField ? fieldMetaFor(snapshot.value.context.currentField) : null));
const currentIndex = computed(() => (currentField.value ? orderedIds.indexOf(currentField.value.linkId) : orderedIds.length));
const progressLabel = computed(() =>
  currentField.value ? `Question ${currentIndex.value + 1} of ${orderedIds.length} — ${currentField.value.section}` : 'Review'
);

const draft = ref('');
watch(
  () => snapshot.value.context.currentField,
  () => { draft.value = snapshot.value.context.values[snapshot.value.context.currentField] || ''; },
  { immediate: true }
);

// Already-answered fields, chat-transcript style — everything except the currently active question.
const answeredTranscript = computed(() =>
  orderedIds
    .filter((id) => id !== snapshot.value.context.currentField && snapshot.value.context.values[id] !== undefined && snapshot.value.context.values[id] !== '')
    .map((id) => {
      const f = fieldMetaFor(id);
      const raw = snapshot.value.context.values[id];
      const display =
        f.type === 'select' ? (f.options.find((o) => o.value === raw)?.label || raw) : f.type === 'checkbox' ? (raw === 'true' ? 'Yes' : 'No') : raw;
      return { linkId: id, label: f.label, display };
    })
);

// First real RxJS usage in this codebase (SPEC-14 §2/§7) — deliberately modest: debounce free-text
// keystrokes before they're committed into the machine's context, rather than firing an ANSWER
// event on every keystroke. Select/checkbox fields never touch this path — they commit immediately
// on click, per SPEC-12 §4.3's "coded fields never accept raw free text" rule.
const input$ = new Subject();
let sub = null;
onMounted(() => {
  sub = input$.pipe(debounceTime(300)).subscribe((value) => {
    if (currentField.value && currentField.value.type === 'text') send({ type: 'ANSWER', value });
  });
});
onBeforeUnmount(() => sub?.unsubscribe());

function onTextInput(e) {
  draft.value = e.target.value;
  input$.next(e.target.value);
}
function submitText() {
  send({ type: 'ANSWER', value: draft.value });
  send({ type: 'NEXT' });
}
function pickOption(opt) {
  send({ type: 'ANSWER', value: opt.value });
  send({ type: 'NEXT' });
}
function pickCheckbox(val) {
  send({ type: 'ANSWER', value: val });
  send({ type: 'NEXT' });
}
function goBack() {
  send({ type: 'BACK' });
}

const reviewing = computed(() => isReview(snapshot.value));
const done = computed(() => isComplete(snapshot.value));

// Identical save shape to HospitalOnboarding.vue's saveDrawer() — same groupLinkId split, same
// withGroupFields/saveDataRecord/publish/updateClinicName calls. Intentionally not deduplicated
// into a shared helper this pass (SPEC-14 §9 open item) so each surface stays independently
// readable while this is still a side-by-side comparison, not a committed replacement.
function confirmAndSave() {
  const values = snapshot.value.context.values;
  const byGroup = {};
  HOSPITAL_FIELDS.forEach((f) => {
    (byGroup[f.groupLinkId] ||= {})[f.linkId] = values[f.linkId];
  });

  const recordId = onboarding.ensureProviderRecord();
  const record = onboarding.getProviderRecord();
  let recordData = record?.data || { item: [] };
  Object.entries(byGroup).forEach(([groupLinkId, fieldValues]) => {
    recordData = withGroupFields(recordData, groupLinkId, fieldValues);
  });
  saveDataRecord(onboarding.PROVIDER_FORM_ID, activeVersionNumber(onboarding.PROVIDER_FORM_ID), recordData, recordId);
  onboarding.dataVersion++;
  onboarding.publish();

  const name = values.hospital_name;
  if (name) auth.updateClinicName(name).catch(() => {});

  send({ type: 'CONFIRM' });
}

function finish() {
  router.push('/clinic-home');
}
</script>

<template>
  <main style="max-width:640px;margin:0 auto;padding:2rem 1.25rem 4rem;display:flex;flex-direction:column;gap:1rem">
    <div>
      <span class="section-eyebrow">Facility Registration (HFR) — Chat Setup</span>
      <h1 style="font-size:1.4rem;font-weight:800;color:var(--cf-text-strong);margin:.4rem 0 .3rem;letter-spacing:-.5px">
        Let's set up your facility, one question at a time.
      </h1>
      <p style="font-size:.8rem;color:var(--cf-text)">{{ progressLabel }}</p>
    </div>

    <div v-if="answeredTranscript.length" style="display:flex;flex-direction:column;gap:.6rem;max-height:34vh;overflow-y:auto;padding-right:.25rem">
      <div v-for="a in answeredTranscript" :key="a.linkId" style="display:flex;flex-direction:column;gap:.25rem;align-items:flex-start">
        <div style="font-size:.72rem;color:var(--cf-muted,#6b7280);padding:.3rem .7rem">{{ a.label }}</div>
        <div style="background:var(--color-primary,#00D4B2);color:#fff;font-size:.82rem;font-weight:600;padding:.45rem .8rem;border-radius:.9rem;max-width:80%">
          {{ a.display }}
        </div>
      </div>
    </div>

    <div v-if="currentField" class="cf-card" style="padding:1.25rem;border-radius:1rem">
      <p style="font-weight:700;color:var(--cf-text-strong);margin-bottom:.3rem">
        {{ currentField.label }}<span v-if="currentField.required" style="color:#dc2626"> *</span>
      </p>
      <p v-if="currentField.help" style="font-size:.75rem;color:var(--cf-text);margin-bottom:.75rem;line-height:1.5">{{ currentField.help }}</p>

      <div v-if="currentField.type === 'select'" style="display:flex;flex-wrap:wrap;gap:.5rem">
        <button v-for="opt in currentField.options" :key="opt.value" class="btn-outline" style="font-size:.82rem" @click="pickOption(opt)">
          {{ opt.label }}
        </button>
      </div>
      <div v-else-if="currentField.type === 'checkbox'" style="display:flex;gap:.5rem">
        <button class="btn-outline" style="font-size:.82rem" @click="pickCheckbox('true')">Yes</button>
        <button class="btn-outline" style="font-size:.82rem" @click="pickCheckbox('false')">No</button>
      </div>
      <div v-else style="display:flex;gap:.5rem">
        <input type="text" class="cf-input" :value="draft" @input="onTextInput" @keyup.enter="submitText" :placeholder="currentField.label" />
        <button class="btn-teal" style="white-space:nowrap" @click="submitText">Next</button>
      </div>

      <p v-if="snapshot.context.error" style="font-size:.72rem;color:#dc2626;margin-top:.6rem"><i class="fas fa-circle-exclamation"></i> {{ snapshot.context.error }}</p>
      <button
        v-if="currentIndex > 0"
        style="margin-top:.85rem;font-size:.75rem;background:transparent;border:none;color:var(--cf-text);cursor:pointer;padding:0"
        @click="goBack"
      >
        ← Back
      </button>
    </div>

    <div v-else-if="reviewing" class="cf-card" style="padding:1.25rem;border-radius:1rem">
      <h3 style="font-weight:700;color:var(--cf-text-strong);margin-bottom:.75rem">Review before saving</h3>
      <div style="display:flex;flex-direction:column;gap:.45rem;margin-bottom:1.1rem">
        <div v-for="a in answeredTranscript" :key="a.linkId" style="display:flex;justify-content:space-between;font-size:.8rem;gap:1rem">
          <span style="color:var(--cf-text)">{{ a.label }}</span>
          <span style="font-weight:600;color:var(--cf-text-strong);text-align:right">{{ a.display }}</span>
        </div>
      </div>
      <div style="display:flex;gap:.6rem">
        <button style="background:transparent;border:none;color:var(--cf-text);cursor:pointer;font-size:.82rem" @click="goBack">← Back</button>
        <button class="btn-teal" @click="confirmAndSave"><i class="fas fa-floppy-disk"></i> Confirm &amp; Save</button>
      </div>
    </div>

    <div v-else-if="done" class="cf-card" style="padding:1.5rem;border-radius:1rem;text-align:center">
      <p style="font-weight:700;color:var(--cf-text-strong);margin-bottom:1rem">
        <i class="fas fa-check-circle" style="color:var(--color-primary)"></i> Facility details saved.
      </p>
      <button class="btn-primary" @click="finish">Go to Clinic Home <i class="fas fa-arrow-right ml-2"></i></button>
    </div>
  </main>
</template>
