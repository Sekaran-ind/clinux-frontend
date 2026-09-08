<script setup>
// SPEC-20's shared Forgot Password form — security-question recovery (no email infrastructure
// anywhere in this app). Two-step internal flow: fetch the real question (a plain, untracked
// authStore.getSecurityQuestion() lookup — see entryPlanDefinition.js's header comment on why not
// everything needs to be a tracked Task), then answer it via the real forgot_password action.
import { reactive, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';

const emit = defineEmits(['success', 'switch-to-login']);
const auth = useAuthStore();
const entryWorkflow = useEntryWorkflowStore();

const step = ref('email'); // 'email' | 'answer'
const form = reactive({ email: '', securityQuestion: '', securityAnswer: '', newPassword: '', confirmNewPassword: '' });
const lookupError = ref('');
// See RegisterForm.vue's header comment on `submitting` — same real multi-instance-shared-store
// bug, same fix.
const submitting = ref(false);

async function lookupQuestion() {
  lookupError.value = '';
  const res = await auth.getSecurityQuestion(form.email);
  if (res.error) { lookupError.value = res.error; return; }
  form.securityQuestion = res.securityQuestion;
  step.value = 'answer';
}

function submit() {
  lookupError.value = '';
  if (form.newPassword !== form.confirmNewPassword) { lookupError.value = 'Passwords do not match.'; return; }
  submitting.value = true;
  entryWorkflow.focus('forgot_password', { email: form.email, securityAnswer: form.securityAnswer, newPassword: form.newPassword });
}

watch(() => entryWorkflow.statuses.forgot_password, (status) => {
  if (!submitting.value) return;
  if (status === 'done') { submitting.value = false; emit('success'); }
  else if (status !== 'active') submitting.value = false;
});
</script>

<template>
  <form v-if="step === 'email'" @submit.prevent="lookupQuestion()" class="space-y-4">
    <div><label class="cf-label">Email Address</label><input class="cf-input" type="email" v-model="form.email" placeholder="admin@clinic.com" required /></div>
    <p v-show="lookupError" class="text-red-500 text-sm font-medium">{{ lookupError }}</p>
    <button type="submit" class="btn-primary w-full"><i class="fas fa-key mr-2"></i>Continue</button>
    <p class="text-center text-sm cf-text">Remembered it? <button type="button" @click="emit('switch-to-login')" class="font-bold" style="color:var(--color-primary)">Sign in</button></p>
  </form>
  <form v-else @submit.prevent="submit()" class="space-y-4">
    <p class="text-sm font-bold" style="color:var(--cf-text-strong)">{{ form.securityQuestion }}</p>
    <div><label class="cf-label">Your Answer *</label><input class="cf-input" v-model="form.securityAnswer" required /></div>
    <div><label class="cf-label">New Password *</label><input class="cf-input" type="password" v-model="form.newPassword" placeholder="Min 8 characters" required minlength="8" /></div>
    <div><label class="cf-label">Confirm New Password *</label><input class="cf-input" type="password" v-model="form.confirmNewPassword" required minlength="8" /></div>
    <p v-show="lookupError || entryWorkflow.errors.forgot_password" class="text-red-500 text-sm font-medium">{{ lookupError || entryWorkflow.errors.forgot_password }}</p>
    <button type="submit" class="btn-primary w-full" :disabled="entryWorkflow.statuses.forgot_password === 'active'">
      {{ entryWorkflow.statuses.forgot_password === 'active' ? 'Resetting…' : 'Reset Password' }}
    </button>
  </form>
</template>
