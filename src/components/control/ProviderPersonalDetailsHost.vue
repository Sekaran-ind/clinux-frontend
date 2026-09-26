<script setup>
// Practitioner's own Personal Details — one of 3 separate tree elements (Personal Details /
// Qualifications / Work Experience — explicit instruction, replacing ProviderMyProfileHost.vue's
// single tabbed card). Mirrors the real NHPR spec's own personalInformation + contactInformation
// blocks, plus the identity/jurisdiction fields createHprIdWithPreVerified needs (hpCategoryCode,
// hpSubCategoryCode, stateCode, districtCode, council) and the HPR Role this account registers
// under (PractitionerRole.code) — all genuinely single-instance facts about this one person, so
// they stay bundled in ONE tree element rather than inventing a 4th the user never asked for.
//
// Real bug found live (ProviderMyProfileHost.vue's own swap dropped these outright, no
// replacement UI): hp_category_code/hp_subcategory_code/state_code/district_code/council are
// `min: 1` (required) on ClinuxFlowProvider.json's own StructureDefinition — every save was
// silently failing /api/provider/conformance until now. Category/state/council are now real
// master-data dropdowns (FacilityHfrPanel.vue's own loadValueSet() pattern, against the already-
// working, already-cached gateway routes /hpr/master/system-of-medicine, /medical-councils,
// /states, /districts/:stateId) instead of free-typed codes — subcategory specifically was the
// user's own named gap ("I do not see subcategory code selection"): ABDM's system-of-medicine
// master nests each category's own subCategories, so the subcategory list is DERIVED from
// whichever category is selected, not a separate master route (none exists).
//
// Saves independently of Qualifications/Work Experience via patchGroupInstanceField (field-level,
// not mergeGroupResponseItems' replace-the-whole-instance) — all 3 tree elements share the SAME
// single section_staff instance, so a whole-instance replace from any one of them would silently
// wipe the other two. staff_role_active/staff_provider_role live on the separate, paired
// section_staff_role (PractitionerRole) instance — patched alongside in the same save.
import { computed, reactive, ref, watch } from 'vue';
import { getAnswer, getAnswers, getGroupInstances, ensureGroupInstance, patchGroupInstanceField } from '../../data/useSystemForms.js';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import { HPR_ROLE_CODE_CHOICES } from '../../data/control/hprRoles.js';

const props = defineProps({
  recordId: { type: String, required: true }, // onboarding.ensureProviderRecord()
  record: { type: Object, default: null }, // the FULL Provider record (spans 2 groups)
});
const emit = defineEmits(['saved']);

const SALUTATION_CHOICES = ['Dr.', 'Mr.', 'Mrs.', 'Ms.'];
const GENDER_CHOICES = ['male', 'female', 'other'];
const CLINICAL_ROLE_CHOICES = ['Chief of Medicine', 'Doctor', 'Nurse', 'Administrator', 'Receptionist', 'Radiologist'];
const SPECIALTY_CHOICES = ['Cardiology', 'Neurology', 'Radiology', 'Pediatrics', 'Orthopedics', 'Dermatology', 'General Medicine', 'ENT', 'Ophthalmology', 'Psychiatry'];

const STAFF_TEXT_FIELDS = [
  'staff_first_name', 'staff_middle_name', 'staff_last_name', 'staff_nationality',
  'staff_father_name', 'staff_mother_name', 'staff_spouse_name', 'staff_languages_spoken',
  'staff_date_of_birth', 'staff_phone', 'staff_email',
  'staff_address_line', 'staff_address_city', 'staff_address_district', 'staff_address_postal_code', 'staff_address_country',
  'staff_public_mobile', 'staff_landline', 'staff_public_email', 'staff_license',
];
const STAFF_CHOICE_FIELDS = ['staff_salutation', 'staff_gender', 'staff_role'];
const STAFF_MASTER_FIELDS = ['staff_hp_category_code', 'staff_hp_subcategory_code', 'staff_state_code', 'staff_address_state', 'staff_district_code', 'staff_council'];
const ROLE_CHOICE_FIELDS = ['staff_provider_role'];

const form = reactive({
  staff_photo: '',
  staff_status: true,
  staff_specialty: [],
  staff_role_active: false,
  ...Object.fromEntries(STAFF_TEXT_FIELDS.map((f) => [f, ''])),
  ...Object.fromEntries(STAFF_CHOICE_FIELDS.map((f) => [f, ''])),
  ...Object.fromEntries(STAFF_MASTER_FIELDS.map((f) => [f, ''])),
  ...Object.fromEntries(ROLE_CHOICE_FIELDS.map((f) => [f, ''])),
});

function loadFromRecord() {
  const staffInstance = props.record ? getGroupInstances(props.record, 'section_staff')[0] : null;
  const roleInstance = props.record ? getGroupInstances(props.record, 'section_staff_role')[0] : null;
  const staffRec = staffInstance ? { data: staffInstance } : null;
  const roleRec = roleInstance ? { data: roleInstance } : null;
  form.staff_photo = staffRec ? getAnswer(staffRec, 'staff_photo') : '';
  form.staff_status = staffRec ? (getAnswer(staffRec, 'staff_status') === true || getAnswer(staffRec, 'staff_status') === 'true') : true;
  [...STAFF_TEXT_FIELDS, ...STAFF_CHOICE_FIELDS, ...STAFF_MASTER_FIELDS].forEach((f) => { form[f] = (staffRec && getAnswer(staffRec, f)) || ''; });
  form.staff_specialty = staffRec ? getAnswers(staffRec, 'staff_specialty') : [];
  form.staff_role_active = roleRec ? (getAnswer(roleRec, 'staff_role_active') === true || getAnswer(roleRec, 'staff_role_active') === 'true') : false;
  form.staff_provider_role = (roleRec && getAnswer(roleRec, 'staff_provider_role')) || '';
}
watch(() => props.record, loadFromRecord, { immediate: true });

// ── Photo capture (base64, capped at ABDM's own 1MB profile-photo limit) ──
const MAX_PHOTO_BYTES = 1024 * 1024;
const photoError = ref('');
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_PHOTO_BYTES) { reject(new Error('Photo is too large (max 1MB).')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function onPhotoSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  photoError.value = '';
  try { form.staff_photo = await readFileAsBase64(file); }
  catch (e) { photoError.value = e.message || 'Could not read that file.'; }
}
function removePhoto() { form.staff_photo = ''; }

// ── Master data (mirrors FacilityHfrPanel.vue's own loadValueSet() pattern, against the real
// gateway's cached HPR master routes rather than a bundled ValueSet — no clinuxflow-api-side HPR
// ValueSet bundle exists yet, unlike HFR's). Each option is normalized to {code, label} regardless
// of which of ABDM's own field-naming variants the live sandbox actually returns. ──
function normalizeMasterOptions(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.data || raw?.list || raw?.content || []);
  return (Array.isArray(list) ? list : []).map((entry) => {
    if (typeof entry === 'string') return { code: entry, label: entry, raw: entry };
    const code = entry.code ?? entry.id ?? entry.value ?? entry.key ?? '';
    const label = entry.value ?? entry.display ?? entry.name ?? entry.label ?? entry.description ?? String(code);
    const subCategories = entry.subCategory ?? entry.subCategories ?? entry.children ?? entry.subcategories ?? null;
    return { code: String(code), label: String(label), raw: entry, subCategories };
  });
}

const master = reactive({ categories: [], councils: [], states: [], districts: [], loading: true });

async function loadMaster(path) {
  const res = await callAbdmGateway(path, { method: 'GET' }).catch(() => null);
  if (!res || !res.success) return [];
  return normalizeMasterOptions(res.data);
}

const subcategoryChoices = computed(() => {
  const selected = master.categories.find((c) => c.code === form.staff_hp_category_code);
  return normalizeMasterOptions(selected?.subCategories);
});

async function loadDistricts(stateCode) {
  if (!stateCode) return [];
  return loadMaster(`/hpr/master/districts/${encodeURIComponent(stateCode)}`);
}
watch(() => form.staff_hp_category_code, () => { form.staff_hp_subcategory_code = ''; });
watch(() => form.staff_state_code, async (code) => {
  form.staff_district_code = '';
  master.districts = await loadDistricts(code);
});

async function loadAllMaster() {
  master.loading = true;
  const [categories, councils, states] = await Promise.all([
    loadMaster('/hpr/master/system-of-medicine'),
    loadMaster('/hpr/master/medical-councils'),
    loadMaster('/hpr/master/states'),
  ]);
  master.categories = categories;
  master.councils = councils;
  master.states = states;
  if (form.staff_state_code) master.districts = await loadDistricts(form.staff_state_code);
  master.loading = false;
}
loadAllMaster();

// ── Save (field-level patch — see this file's own header for why not a whole-instance replace) ──
const saving = ref(false);
function save() {
  saving.value = true;
  ensureGroupInstance(props.recordId, 'section_staff');
  ensureGroupInstance(props.recordId, 'section_staff_role');
  patchGroupInstanceField(props.recordId, 'section_staff', 0, {
    staff_photo: form.staff_photo,
    staff_status: form.staff_status,
    staff_specialty: form.staff_specialty,
    staff_name: [form.staff_first_name, form.staff_middle_name, form.staff_last_name].filter(Boolean).join(' '),
    ...Object.fromEntries([...STAFF_TEXT_FIELDS, ...STAFF_CHOICE_FIELDS, ...STAFF_MASTER_FIELDS].map((f) => [f, form[f]])),
  });
  patchGroupInstanceField(props.recordId, 'section_staff_role', 0, {
    staff_role_active: form.staff_role_active,
    staff_provider_role: form.staff_provider_role,
  });
  saving.value = false;
  emit('saved');
}
defineExpose({ save });
</script>

<template>
  <div class="cf-card rounded-2xl p-4 mb-3">
    <p class="cf-label mb-2">Profile Photo</p>
    <div class="flex items-center gap-3">
      <div style="width:72px;height:72px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--cf-bg-alt);border:1px solid var(--cf-border);display:flex;align-items:center;justify-content:center">
        <img v-if="form.staff_photo" :src="`data:image/jpeg;base64,${form.staff_photo}`" alt="" style="width:100%;height:100%;object-fit:cover" />
        <i v-else class="fas fa-user" style="color:var(--cf-text);font-size:1.5rem"></i>
      </div>
      <div>
        <label class="btn-outline text-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
          <i class="fas fa-camera"></i> {{ form.staff_photo ? 'Change Photo' : 'Add Photo' }}
          <input type="file" accept="image/*" style="display:none" @change="onPhotoSelected" />
        </label>
        <button v-if="form.staff_photo" class="btn-ghost text-sm ml-2" @click="removePhoto()"><i class="fas fa-trash"></i> Remove</button>
        <p v-if="photoError" style="font-size:.75rem;color:#dc2626;margin-top:.4rem"><i class="fas fa-circle-exclamation"></i> {{ photoError }}</p>
      </div>
    </div>
  </div>

  <div class="cf-card rounded-2xl p-4 mb-3">
    <p class="cf-label mb-3">Identity</p>
    <div class="cf-form-field-grid">
      <div>
        <label class="cf-label">Salutation</label>
        <select class="cf-input" v-model="form.staff_salutation">
          <option value="">Select…</option>
          <option v-for="c in SALUTATION_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div><label class="cf-label">First Name (as on Aadhaar)<span style="color:#dc2626"> *</span></label><input class="cf-input" v-model="form.staff_first_name" /></div>
      <div><label class="cf-label">Middle Name</label><input class="cf-input" v-model="form.staff_middle_name" /></div>
      <div><label class="cf-label">Last Name (as on Aadhaar)</label><input class="cf-input" v-model="form.staff_last_name" /></div>
      <div>
        <label class="cf-label">Gender</label>
        <select class="cf-input" v-model="form.staff_gender">
          <option value="">Select…</option>
          <option v-for="c in GENDER_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div><label class="cf-label">Date of Birth</label><input type="date" class="cf-input" v-model="form.staff_date_of_birth" /></div>
      <div><label class="cf-label">Nationality</label><input class="cf-input" v-model="form.staff_nationality" /></div>
      <div><label class="cf-label">Languages Spoken</label><input class="cf-input" v-model="form.staff_languages_spoken" /></div>
      <div><label class="cf-label">Father's Name</label><input class="cf-input" v-model="form.staff_father_name" /></div>
      <div><label class="cf-label">Mother's Name</label><input class="cf-input" v-model="form.staff_mother_name" /></div>
      <div><label class="cf-label">Spouse's Name</label><input class="cf-input" v-model="form.staff_spouse_name" /></div>
      <div><label class="flex items-center gap-2 text-sm" style="color:var(--cf-text)"><input type="checkbox" v-model="form.staff_status" />Active</label></div>
    </div>
  </div>

  <div class="cf-card rounded-2xl p-4 mb-3">
    <p class="cf-label mb-3">Contact &amp; Address</p>
    <div class="cf-form-field-grid">
      <div><label class="cf-label">Account Phone</label><input class="cf-input" v-model="form.staff_phone" /></div>
      <div><label class="cf-label">Account Email</label><input class="cf-input" v-model="form.staff_email" /></div>
      <div><label class="cf-label">Public Mobile Number</label><input class="cf-input" v-model="form.staff_public_mobile" /></div>
      <div><label class="cf-label">Landline Number</label><input class="cf-input" v-model="form.staff_landline" /></div>
      <div><label class="cf-label">Public Email</label><input class="cf-input" v-model="form.staff_public_email" /></div>
      <div><label class="cf-label">Address</label><input class="cf-input" v-model="form.staff_address_line" /></div>
      <div><label class="cf-label">City</label><input class="cf-input" v-model="form.staff_address_city" /></div>
      <div>
        <label class="cf-label">State (LGD)</label>
        <select class="cf-input" v-model="form.staff_address_state">
          <option value="">{{ master.loading ? 'Loading…' : 'Select…' }}</option>
          <option v-for="s in master.states" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </div>
      <div><label class="cf-label">District (LGD)</label><input class="cf-input" v-model="form.staff_address_district" /></div>
      <div><label class="cf-label">Pincode</label><input class="cf-input" v-model="form.staff_address_postal_code" /></div>
      <div><label class="cf-label">Country</label><input class="cf-input" v-model="form.staff_address_country" /></div>
    </div>
  </div>

  <div class="cf-card rounded-2xl p-4 mb-3">
    <p class="cf-label mb-1">HPR Registration Identity</p>
    <p class="text-sm mb-3" style="color:var(--cf-text)">Needed to create your Health Professional Registry (HPR) ID — see ABDM Registration below.</p>
    <div class="cf-form-field-grid">
      <div>
        <label class="cf-label">HP Category (HPR master: system-of-medicine)<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="form.staff_hp_category_code">
          <option value="">{{ master.loading ? 'Loading…' : 'Select…' }}</option>
          <option v-for="c in master.categories" :key="c.code" :value="c.code">{{ c.label }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">HP Sub-Category<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="form.staff_hp_subcategory_code" :disabled="!form.staff_hp_category_code">
          <option value="">{{ form.staff_hp_category_code ? 'Select…' : 'Select a category first' }}</option>
          <option v-for="s in subcategoryChoices" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">State LGD Code (HPR master: states)<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="form.staff_state_code">
          <option value="">{{ master.loading ? 'Loading…' : 'Select…' }}</option>
          <option v-for="s in master.states" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">District LGD Code (HPR master: districts)<span style="color:#dc2626"> *</span></label>
        <select class="cf-input" v-model="form.staff_district_code" :disabled="!form.staff_state_code">
          <option value="">{{ form.staff_state_code ? 'Select…' : 'Select a state first' }}</option>
          <option v-for="d in master.districts" :key="d.code" :value="d.code">{{ d.label }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">Registered With a Council</label>
        <select class="cf-input" v-model="form.staff_council">
          <option value="">Select…</option>
          <option v-for="c in master.councils" :key="c.code" :value="c.code">{{ c.label }}</option>
        </select>
      </div>
    </div>
  </div>

  <div class="cf-card rounded-2xl p-4">
    <p class="cf-label mb-3">Role</p>
    <div class="cf-form-field-grid">
      <div>
        <label class="cf-label">HPR Role (HPR master: role)</label>
        <select class="cf-input" v-model="form.staff_provider_role">
          <option value="">Select…</option>
          <option v-for="c in HPR_ROLE_CODE_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">Clinical Role</label>
        <select class="cf-input" v-model="form.staff_role">
          <option value="">Select…</option>
          <option v-for="c in CLINICAL_ROLE_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div>
        <label class="cf-label">Specialty</label>
        <select class="cf-input" multiple v-model="form.staff_specialty">
          <option v-for="c in SPECIALTY_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div><label class="flex items-center gap-2 text-sm" style="color:var(--cf-text)"><input type="checkbox" v-model="form.staff_role_active" />Currently Practicing</label></div>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
