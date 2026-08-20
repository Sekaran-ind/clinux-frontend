<script setup>
// Phase D: multi-user accounts per clinic. Lists everyone with a login on this clinic and lets
// an already-logged-in account add another one — see clinuxflow-api's POST /api/auth/invite and
// GET /api/auth/team, and auth.js's fetchTeam()/inviteTeammate() wrapping them. No invite email
// is ever sent (this app has no mail server); the admin sets a teammate's email+password here
// directly and shares it with them out of band, same shape /register already uses.
import { ref, watch, reactive } from 'vue';
import { useAuthStore } from '../stores/auth.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);
const auth = useAuthStore();

const activeTab = ref('staff'); // 'staff' | 'affiliates'

const accounts = ref([]);
const loading = ref(false);
const loadError = ref('');

const form = reactive({ email: '', password: '', adminName: '', designation: '' });
const submitting = ref(false);
const formError = ref('');
const formSuccess = ref('');

async function loadTeam() {
  loading.value = true;
  loadError.value = '';
  const { accounts: list, error } = await auth.fetchTeam();
  loading.value = false;
  if (error) { loadError.value = error; return; }
  accounts.value = list;
}

// Affiliates: an EXISTING independent practitioner's own account, linked here as a visiting
// consultant -- deliberately a SEPARATE flow from "Add a teammate" above. That form creates a
// brand-new login under THIS clinic's own subscription (counts against the 4-account cap);
// linking an affiliate never creates a login at all -- they keep their own account elsewhere
// (most likely their own individual-practitioner registration) and this just references them.
// See clinuxflow-api's POST/GET/DELETE /api/facility/affiliates and migrations/0005.
const affiliates = ref([]);
const affiliatesLoading = ref(false);
const affiliatesLoadError = ref('');

const affiliateForm = reactive({ practitionerEmail: '', role: '' });
const affiliateSubmitting = ref(false);
const affiliateFormError = ref('');
const affiliateFormSuccess = ref('');

async function loadAffiliates() {
  affiliatesLoading.value = true;
  affiliatesLoadError.value = '';
  const { affiliates: list, error } = await auth.fetchAffiliates();
  affiliatesLoading.value = false;
  if (error) { affiliatesLoadError.value = error; return; }
  affiliates.value = list;
}

async function submitAffiliate() {
  affiliateFormError.value = '';
  affiliateFormSuccess.value = '';
  if (!affiliateForm.practitionerEmail) {
    affiliateFormError.value = 'Enter the practitioner\'s email address.';
    return;
  }
  affiliateSubmitting.value = true;
  const { affiliate, error } = await auth.linkAffiliate({ ...affiliateForm });
  affiliateSubmitting.value = false;
  if (error) { affiliateFormError.value = error; return; }

  affiliateFormSuccess.value = `${affiliate.adminName || affiliate.email} linked as an affiliate.`;
  Object.assign(affiliateForm, { practitionerEmail: '', role: '' });
  await loadAffiliates();
}

async function removeAffiliate(accountId) {
  await auth.revokeAffiliate(accountId);
  await loadAffiliates();
}

async function submitInvite() {
  formError.value = '';
  formSuccess.value = '';
  if (!form.email || !form.password) {
    formError.value = 'Email and password are required.';
    return;
  }
  submitting.value = true;
  const { account, error } = await auth.inviteTeammate({ ...form });
  submitting.value = false;
  if (error) { formError.value = error; return; }

  formSuccess.value = `Account created for ${account.email}. Share the password with them directly — they'll sign in at the main login screen, then find "Staff Onboarding" in their own profile menu to add their details and import the clinic profile.`;
  Object.assign(form, { email: '', password: '', adminName: '', designation: '' });
  await loadTeam();
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    activeTab.value = 'staff';
    formError.value = '';
    formSuccess.value = '';
    affiliateFormError.value = '';
    affiliateFormSuccess.value = '';
    loadTeam();
    loadAffiliates();
  }
});
</script>

<template>
  <div class="modal-backdrop" v-show="open" @click.self="emit('close')">
    <div class="modal-box" style="max-width:560px">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-lg font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-users mr-2" style="color:var(--color-primary)"></i>Team</h3>
          <p class="text-xs" style="color:var(--cf-text)">Everyone with a login on this clinic — up to 4 accounts share one subscription.</p>
        </div>
        <button @click="emit('close')" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
      </div>

      <!-- Staff (a real login/seat on THIS clinic) vs. Affiliates (an independent practitioner's
           own account, just referenced -- see the script's own comment) are deliberately two
           different flows, not two views of the same list. -->
      <div class="flex gap-1 mb-4" style="border-bottom:1px solid var(--cf-border)">
        <button class="text-xs font-bold px-3 py-2" :class="activeTab === 'staff' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="activeTab = 'staff'">Staff</button>
        <button class="text-xs font-bold px-3 py-2" :class="activeTab === 'affiliates' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="activeTab = 'affiliates'">Affiliates</button>
      </div>

      <template v-if="activeTab === 'staff'">
        <div v-if="loading" class="text-sm text-center py-4" style="color:var(--cf-text)"><i class="fas fa-spinner fa-spin mr-2"></i>Loading team...</div>
        <p v-else-if="loadError" class="text-sm text-center py-2" style="color:#b91c1c">{{ loadError }}</p>
        <div v-else class="flex flex-col gap-2 mb-5">
          <div v-for="a in accounts" :key="a.id" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.designation" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.designation }}</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
          </div>
        </div>

        <div class="cf-card rounded-2xl p-4" v-show="accounts.length < 4">
          <p class="cf-label mb-2">Add a teammate</p>
          <div class="grid grid-cols-2 gap-2 mb-2">
            <input class="cf-input" v-model="form.adminName" placeholder="Full name" />
            <input class="cf-input" v-model="form.designation" placeholder="Designation" />
          </div>
          <input class="cf-input mb-2" type="email" v-model="form.email" placeholder="Email address" />
          <input class="cf-input mb-2" type="password" v-model="form.password" placeholder="Set a password (min 8 characters)" minlength="8" />
          <p v-show="formError" class="text-red-500 text-xs font-medium mb-2">{{ formError }}</p>
          <p v-show="formSuccess" class="text-xs font-medium mb-2" style="color:var(--color-primary)">{{ formSuccess }}</p>
          <button class="btn-teal w-full text-sm" :disabled="submitting" @click="submitInvite()">
            <i class="fas" :class="submitting ? 'fa-spinner fa-spin' : 'fa-user-plus'"></i> {{ submitting ? 'Adding...' : 'Add Teammate' }}
          </button>
        </div>
        <p v-show="!loading && accounts.length >= 4" class="text-xs text-center" style="color:var(--cf-text)">
          This clinic already has the maximum of 4 team accounts.
        </p>
      </template>

      <template v-else>
        <p class="text-xs mb-3" style="color:var(--cf-text)">
          Visiting or consulting practitioners with their own ClinuxFlow account, linked here without using one of this clinic's 4 team seats.
        </p>
        <div v-if="affiliatesLoading" class="text-sm text-center py-4" style="color:var(--cf-text)"><i class="fas fa-spinner fa-spin mr-2"></i>Loading affiliates...</div>
        <p v-else-if="affiliatesLoadError" class="text-sm text-center py-2" style="color:#b91c1c">{{ affiliatesLoadError }}</p>
        <div v-else class="flex flex-col gap-2 mb-5">
          <div v-show="affiliates.length === 0" class="text-xs text-center py-2" style="color:var(--cf-text)">No affiliates linked yet.</div>
          <div v-for="a in affiliates" :key="a.accountId" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.role" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.role }}</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
            <button class="btn-ghost text-xs px-2 py-1" @click="removeAffiliate(a.accountId)"><i class="fas fa-times"></i> Remove</button>
          </div>
        </div>

        <div class="cf-card rounded-2xl p-4">
          <p class="cf-label mb-2">Link an affiliate</p>
          <input class="cf-input mb-2" type="email" v-model="affiliateForm.practitionerEmail" placeholder="Their ClinuxFlow email address" />
          <input class="cf-input mb-2" v-model="affiliateForm.role" placeholder="Role (e.g. Visiting Cardiologist)" />
          <p v-show="affiliateFormError" class="text-red-500 text-xs font-medium mb-2">{{ affiliateFormError }}</p>
          <p v-show="affiliateFormSuccess" class="text-xs font-medium mb-2" style="color:var(--color-primary)">{{ affiliateFormSuccess }}</p>
          <button class="btn-teal w-full text-sm" :disabled="affiliateSubmitting" @click="submitAffiliate()">
            <i class="fas" :class="affiliateSubmitting ? 'fa-spinner fa-spin' : 'fa-user-plus'"></i> {{ affiliateSubmitting ? 'Linking...' : 'Link Affiliate' }}
          </button>
          <p class="text-xs mt-2" style="color:var(--cf-text)">They need their own ClinuxFlow account first — most likely their own individual-practitioner registration.</p>
        </div>
      </template>
    </div>
  </div>
</template>
