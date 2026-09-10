<script setup>
// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md §6/§9 — redeems a facility join token. Deliberately
// standalone, NOT wired into entryFormRegistry.js/entryWorkflow.js's tracked
// ENTRY_PLAN_DEFINITION the way Register/Login/etc. are: token redemption creates an account the
// same way staff registration itself does, and SPEC-23's own correction already pulled that kind
// of thing OUT of the tracked HFSM ("state machine only for clinical journeys"). This form owns
// its own local state instead, same shape as RegisterForm.vue/LoginForm.vue (props/emits, no
// opinion about being hosted in a modal vs. inline), just dispatching directly through
// joinTokenAdapter.js rather than entryWorkflow.focus().
//
// No auto-login after a staff redemption, on purpose — control.js's own .../redeem route never
// issues a session token for the newly-created (still 'pending') account (a real gap found and
// fixed while building this: a minted JWT would have passed requireUser() on every OTHER
// authenticated route even though POST /api/auth/login correctly refuses a NEW one for it). The
// person sees a "request sent" confirmation and logs in for the first time normally, once the
// admin approves it.
import { reactive, ref, watch, computed } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { redeemJoinToken, deliverJoinRequestPayload } from '../../data/control/joinTokenAdapter.js';
import { buildJoinRequestSharePayload } from '../../data/sessionShare.js';
import { derivePersonSetupState } from '../../data/control/personSetupMachine.js';

const props = defineProps({ initialToken: { type: String, default: '' } });
const emit = defineEmits(['success']);
const auth = useAuthStore();

const form = reactive({ token: props.initialToken, email: '', password: '', adminName: '', designation: '', declaredRole: '' });
const submitting = ref(false);
const error = ref('');
const result = ref(null); // { linkKind, admin, facilityName, personEmail } | null

// An already-logged-in caller redeems with their OWN account (the affiliate path) — no
// email/password fields needed; control.js's own route honors the stored session's Authorization
// header automatically (apiFetch), same as any other authenticated call.
const isAuthenticated = computed(() => !!auth.currentUser);

async function submit() {
  error.value = '';
  if (!form.token.trim()) { error.value = 'Enter your join code.'; return; }
  if (!isAuthenticated.value && (!form.email || !form.password)) {
    error.value = 'Email and password are required.';
    return;
  }
  submitting.value = true;
  const body = isAuthenticated.value ? undefined : { email: form.email, password: form.password, adminName: form.adminName, designation: form.designation };
  const res = await redeemJoinToken(form.token.trim().toUpperCase(), body);
  if (res.error) {
    submitting.value = false;
    error.value = res.error;
    return;
  }

  // Build + deliver the LForms-mapped request card (SPEC-26 §6) right away — the durable
  // .../deliver path (Cloudflare Queues, or a direct write in local dev without that binding
  // configured) doesn't need the admin to be online right now, unlike a live P2P chat send.
  const personEmail = isAuthenticated.value ? auth.currentUser.email : res.personEmail;
  const personName = isAuthenticated.value ? (auth.currentUser.adminName || auth.currentUser.email) : (form.adminName || personEmail);
  const personSetupStage = derivePersonSetupState({
    linkKind: res.linkKind,
    hasBasics: !!personName,
    hprVerified: false, // this form never captures an HPR login itself — a real one (if any) was
                         // already established earlier via ProviderHprPanel.vue, out of scope here
  });
  const { key } = await buildJoinRequestSharePayload({
    linkKind: res.linkKind, personName, personEmail,
    declaredRole: res.linkKind === 'affiliate' ? form.declaredRole : '',
    personSetupStage, token: form.token.trim().toUpperCase(),
  });
  await deliverJoinRequestPayload(form.token.trim().toUpperCase(), key);

  submitting.value = false;
  result.value = res;
  emit('success', res);
}

watch(() => props.initialToken, (t) => { if (t) form.token = t; });
</script>

<template>
  <div v-if="result" class="text-center py-4">
    <i class="fas fa-paper-plane text-3xl mb-3" style="color:var(--color-primary)"></i>
    <p class="text-sm font-semibold mb-1" style="color:var(--cf-text-strong)">Request sent to {{ result.admin?.name || 'the facility admin' }}.</p>
    <p class="text-xs" style="color:var(--cf-text)">
      Once {{ result.facilityName || 'they' }} approve{{ result.facilityName ? 's' : '' }} your request, you'll be able to log in{{ result.linkKind === 'staff' ? ' with the email and password you just set' : '' }}.
    </p>
  </div>
  <form v-else @submit.prevent="submit()" class="space-y-4">
    <div>
      <label class="cf-label">Join Code *</label>
      <input class="cf-input font-mono uppercase" v-model="form.token" placeholder="e.g. ABC12345" required maxlength="8" />
    </div>
    <template v-if="!isAuthenticated">
      <div class="grid grid-cols-2 gap-2">
        <input class="cf-input" v-model="form.adminName" placeholder="Full name" />
        <input class="cf-input" v-model="form.designation" placeholder="Designation" />
      </div>
      <div><label class="cf-label">Email Address *</label><input class="cf-input" type="email" v-model="form.email" placeholder="you@clinic.com" required /></div>
      <div><label class="cf-label">Set a Password *</label><input class="cf-input" type="password" v-model="form.password" placeholder="Min 8 characters" required minlength="8" /></div>
      <p class="text-xs" style="color:var(--cf-text)">Not registered yet? This creates your account — no separate registration needed.</p>
    </template>
    <template v-else>
      <input class="cf-input" v-model="form.declaredRole" placeholder="Your role (e.g. Visiting Cardiologist) — affiliates only" />
      <p class="text-xs" style="color:var(--cf-text)">Redeeming as {{ auth.currentUser.email }}.</p>
    </template>
    <p v-show="error" class="text-red-500 text-sm font-medium">{{ error }}</p>
    <button type="submit" class="btn-primary w-full mt-2" :disabled="submitting">
      <i class="fas" :class="submitting ? 'fa-spinner fa-spin' : 'fa-link'"></i> {{ submitting ? 'Sending request…' : 'Send Join Request' }}
    </button>
  </form>
</template>
