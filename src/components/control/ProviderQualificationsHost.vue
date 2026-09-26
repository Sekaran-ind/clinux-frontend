<script setup>
// Practitioner's own Qualifications — the 2nd of 3 separate tree elements (explicit instruction).
// Genuinely repeating (a practitioner can hold more than one degree/registration), unlike Personal
// Details/Work Experience — backed by section_staff_qualification, a real nested `type: "group"`
// field inside section_staff's own single instance (see system-provider-composition-v1.yaml's own
// comment on why it's nested, not a sibling top-level block: a sibling block was empirically
// confirmed to lose data / orphan onto a separate Practitioner resource).
//
// Degree code choices are the NHPR spec's own real table (register/update professional API), not
// invented. College/university have no master data anywhere in either backend yet — honest
// free-text, same "no fabricated dropdown" discipline system-provider-composition-v1.yaml's own
// comment documents; "Registered With Council" reuses the same /hpr/master/medical-councils route
// Personal Details' own council field already uses (the closest real master list available).
import { reactive, ref, watch } from 'vue';
import { getNestedGroupInstances, getAnswer, ensureGroupInstance, patchNestedGroupInstances } from '../../data/useSystemForms.js';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';

const props = defineProps({
  recordId: { type: String, required: true },
  record: { type: Object, default: null },
});
const emit = defineEmits(['saved']);

const DEGREE_CHOICES = [
  '4060 - MBBS (Modern Medicine)', '4074 - BDS (Dentistry)', '4079 - BAMS (Ayurvedic)',
  '4082 - BUMS (Unani)', '61 - BSMS (Siddha)', '74 - BTMS (Sowa-Rigpa)', '40 - BHMS (Homoeopathy)',
];
const PERMANENT_OR_RENEWABLE_CHOICES = ['Permanent', 'Renewable'];

const FIELDS = [
  'staff_qual_degree_code', 'staff_qual_country', 'staff_qual_state', 'staff_qual_college', 'staff_qual_university',
  'staff_qual_year_awarded', 'staff_qual_degree_certificate', 'staff_qual_degree_name_matches_aadhaar', 'staff_qual_degree_name_change_affidavit',
  'staff_qual_registered_council', 'staff_qual_registration_number', 'staff_qual_registration_date', 'staff_qual_registration_certificate',
  'staff_qual_registration_name_matches_aadhaar', 'staff_qual_registration_name_change_affidavit',
  'staff_qual_permanent_or_renewable', 'staff_qual_renewable_due_date',
];
const NAME_MATCH_CHOICES = ['Yes', 'No'];
function blankEntry() { return Object.fromEntries(FIELDS.map((f) => [f, ''])); }

const entries = ref([]); // [{ ...FIELDS }]
const expandedIndex = ref(null);

function loadFromRecord() {
  const instances = props.record ? getNestedGroupInstances(props.record, 'section_staff', 0, 'section_staff_qualification') : [];
  entries.value = instances.map((instance) => {
    const rec = { data: instance };
    return Object.fromEntries(FIELDS.map((f) => [f, getAnswer(rec, f) || '']));
  });
}
watch(() => props.record, loadFromRecord, { immediate: true });

function addEntry() {
  entries.value.push(blankEntry());
  expandedIndex.value = entries.value.length - 1;
}
function removeEntry(index) {
  entries.value.splice(index, 1);
  if (expandedIndex.value === index) expandedIndex.value = null;
}
function toggleExpanded(index) { expandedIndex.value = expandedIndex.value === index ? null : index; }

function entrySummary(entry) {
  const degree = (entry.staff_qual_degree_code || '').split(' - ')[1] || entry.staff_qual_degree_code;
  return [degree, entry.staff_qual_college, entry.staff_qual_registration_number].filter(Boolean).join(' · ') || 'New qualification';
}

// ── Master data: council (shared master list with Personal Details' own field) ──
const councils = reactive([]);
async function loadCouncils() {
  const res = await callAbdmGateway('/hpr/master/medical-councils', { method: 'GET' }).catch(() => null);
  if (!res || !res.success) return;
  const list = Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.list || []);
  councils.push(...list.map((entry) => (typeof entry === 'string'
    ? { code: entry, label: entry }
    : { code: String(entry.code ?? entry.id ?? entry.value ?? ''), label: String(entry.value ?? entry.display ?? entry.name ?? entry.label ?? '') })));
}
loadCouncils();

// ── Upload (base64, mirrors FacilityHfrPanel.vue's own file-capture pattern) ──
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const uploadError = ref('');
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) { reject(new Error('File is too large (max 2MB).')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function onFileSelected(entry, field, event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  uploadError.value = '';
  try { entry[field] = await readFileAsBase64(file); }
  catch (e) { uploadError.value = e.message || 'Could not read that file.'; }
}

// ── Save (field-level replace of the nested set — see formData.js's own patchNestedGroupInstances
// header for why not mergeGroupResponseItems, which would replace the WHOLE section_staff instance
// and wipe Personal Details / Work Experience). ──
function save() {
  ensureGroupInstance(props.recordId, 'section_staff');
  const childResponseItems = entries.value
    .filter((entry) => entry.staff_qual_degree_code) // the one required field per entry
    .map((entry) => ({
      linkId: 'section_staff_qualification',
      item: FIELDS.filter((f) => entry[f] !== '' && entry[f] !== null && entry[f] !== undefined)
        .map((f) => ({ linkId: f, answer: [{ valueString: entry[f] }] })),
    }));
  patchNestedGroupInstances(props.recordId, 'section_staff', 0, 'section_staff_qualification', childResponseItems);
  emit('saved');
}
defineExpose({ save });
</script>

<template>
  <div v-if="entries.length === 0" class="cf-card rounded-2xl p-4 mb-3 text-sm" style="color:var(--cf-text)">
    No qualifications added yet — add your degree/diploma and council registration below.
  </div>

  <div v-for="(entry, index) in entries" :key="index" class="cf-card rounded-2xl p-4 mb-3">
    <div class="flex items-center justify-between cursor-pointer" @click="toggleExpanded(index)">
      <div>
        <p style="font-weight:600;color:var(--cf-text-strong)">{{ entrySummary(entry) }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-ghost text-sm" @click.stop="removeEntry(index)"><i class="fas fa-trash"></i></button>
        <i class="fas" :class="expandedIndex === index ? 'fa-chevron-up' : 'fa-chevron-down'" style="color:var(--cf-text)"></i>
      </div>
    </div>

    <div v-show="expandedIndex === index" class="cf-form-field-grid mt-3" style="padding-top:1rem;border-top:1px solid var(--cf-border)">
      <div>
        <label class="cf-label">Degree / Diploma Obtained<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="entry.staff_qual_degree_code">
          <option value="">Select…</option>
          <option v-for="c in DEGREE_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div><label class="cf-label">Country</label><input class="cf-input" v-model="entry.staff_qual_country" /></div>
      <div><label class="cf-label">State (LGD)</label><input class="cf-input" v-model="entry.staff_qual_state" /></div>
      <div><label class="cf-label">College</label><input class="cf-input" v-model="entry.staff_qual_college" /></div>
      <div><label class="cf-label">University</label><input class="cf-input" v-model="entry.staff_qual_university" /></div>
      <div><label class="cf-label">Year of Awarding</label><input class="cf-input" v-model="entry.staff_qual_year_awarded" /></div>
      <div>
        <label class="cf-label">Degree Certificate</label>
        <label class="btn-outline text-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
          <i class="fas fa-upload"></i> {{ entry.staff_qual_degree_certificate ? 'Replace' : 'Upload' }}
          <input type="file" style="display:none" @change="onFileSelected(entry, 'staff_qual_degree_certificate', $event)" />
        </label>
        <span v-if="entry.staff_qual_degree_certificate" class="text-sm ml-2" style="color:var(--cf-text)"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i> Attached</span>
      </div>
      <div>
        <label class="cf-label">Is your name in the Degree Certificate the same as in Aadhaar?</label>
        <select class="cf-input" v-model="entry.staff_qual_degree_name_matches_aadhaar">
          <option value="">Select…</option>
          <option v-for="c in NAME_MATCH_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div v-if="entry.staff_qual_degree_name_matches_aadhaar === 'No'">
        <label class="cf-label">Name Change Affidavit (Degree)<span style="color:#dc2626"> *</span></label>
        <label class="btn-outline text-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
          <i class="fas fa-upload"></i> {{ entry.staff_qual_degree_name_change_affidavit ? 'Replace' : 'Upload' }}
          <input type="file" style="display:none" @change="onFileSelected(entry, 'staff_qual_degree_name_change_affidavit', $event)" />
        </label>
        <span v-if="entry.staff_qual_degree_name_change_affidavit" class="text-sm ml-2" style="color:var(--cf-text)"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i> Attached</span>
      </div>
      <div>
        <label class="cf-label">Registered With Council (HPR master: medical-councils)<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="entry.staff_qual_registered_council">
          <option value="">Select…</option>
          <option v-for="c in councils" :key="c.code" :value="c.code">{{ c.label }}</option>
        </select>
      </div>
      <div><label class="cf-label">Registration Number<span style="color:#dc2626"> *</span></label><input class="cf-input" v-model="entry.staff_qual_registration_number" /></div>
      <div><label class="cf-label">Registration Date</label><input type="date" class="cf-input" v-model="entry.staff_qual_registration_date" /></div>
      <div>
        <label class="cf-label">Registration Certificate</label>
        <label class="btn-outline text-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
          <i class="fas fa-upload"></i> {{ entry.staff_qual_registration_certificate ? 'Replace' : 'Upload' }}
          <input type="file" style="display:none" @change="onFileSelected(entry, 'staff_qual_registration_certificate', $event)" />
        </label>
        <span v-if="entry.staff_qual_registration_certificate" class="text-sm ml-2" style="color:var(--cf-text)"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i> Attached</span>
      </div>
      <div>
        <label class="cf-label">Is your name in the Registration Certificate the same as in Aadhaar?</label>
        <select class="cf-input" v-model="entry.staff_qual_registration_name_matches_aadhaar">
          <option value="">Select…</option>
          <option v-for="c in NAME_MATCH_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div v-if="entry.staff_qual_registration_name_matches_aadhaar === 'No'">
        <label class="cf-label">Name Change Affidavit (Registration)<span style="color:#dc2626"> *</span></label>
        <label class="btn-outline text-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
          <i class="fas fa-upload"></i> {{ entry.staff_qual_registration_name_change_affidavit ? 'Replace' : 'Upload' }}
          <input type="file" style="display:none" @change="onFileSelected(entry, 'staff_qual_registration_name_change_affidavit', $event)" />
        </label>
        <span v-if="entry.staff_qual_registration_name_change_affidavit" class="text-sm ml-2" style="color:var(--cf-text)"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i> Attached</span>
      </div>
      <div>
        <label class="cf-label">Permanent or Renewable</label>
        <select class="cf-input" v-model="entry.staff_qual_permanent_or_renewable">
          <option value="">Select…</option>
          <option v-for="c in PERMANENT_OR_RENEWABLE_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div v-if="entry.staff_qual_permanent_or_renewable === 'Renewable'">
        <label class="cf-label">Renewable Due Date<span style="color:#dc2626"> *</span></label>
        <input type="date" class="cf-input" v-model="entry.staff_qual_renewable_due_date" />
      </div>
    </div>
  </div>

  <p v-if="uploadError" style="font-size:.75rem;color:#dc2626;margin-bottom:.75rem"><i class="fas fa-circle-exclamation"></i> {{ uploadError }}</p>
  <button class="btn-outline text-sm" @click="addEntry()"><i class="fas fa-plus"></i> Add Qualification</button>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
