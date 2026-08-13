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
    formError.value = '';
    formSuccess.value = '';
    loadTeam();
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
    </div>
  </div>
</template>
