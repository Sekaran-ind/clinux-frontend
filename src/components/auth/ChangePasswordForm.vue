<script setup>
// SPEC-20's shared Change Password form. change_password is structurally ungated in
// ENTRY_PLAN_DEFINITION (see its own header comment) — the real gate is requireUser() on the
// backend. This component adds the honest client-side note ("log in first") since attempting it
// unauthenticated would just 401 with no useful context otherwise.
import { reactive, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';

const emit = defineEmits(['success']);
const auth = useAuthStore();
const entryWorkflow = useEntryWorkflowStore();

const form = reactive({ currentPassword: '', newPassword: '', confirmNewPassword: '' });
const localError = ref('');
// See RegisterForm.vue's header comment on `submitting` — same real multi-instance-shared-store
// bug, same fix.
const submitting = ref(false);

function submit() {
  localError.value = '';
  if (form.newPassword !== form.confirmNewPassword) { localError.value = 'Passwords do not match.'; return; }
  submitting.value = true;
  entryWorkflow.focus('change_password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
}

watch(() => entryWorkflow.statuses.change_password, (status) => {
  if (!submitting.value) return;
  if (status === 'done') { submitting.value = false; emit('success'); }
  else if (status !== 'active') submitting.value = false;
});
</script>

<template>
  <p v-if="!auth.currentUser" class="text-sm cf-text">Log in first — changing a password needs an active session.</p>
  <form v-else @submit.prevent="submit()" class="space-y-4">
    <div><label class="cf-label">Current Password *</label><input class="cf-input" type="password" v-model="form.currentPassword" required /></div>
    <div><label class="cf-label">New Password *</label><input class="cf-input" type="password" v-model="form.newPassword" placeholder="Min 8 characters" required minlength="8" /></div>
    <div><label class="cf-label">Confirm New Password *</label><input class="cf-input" type="password" v-model="form.confirmNewPassword" required minlength="8" /></div>
    <p v-show="localError || entryWorkflow.errors.change_password" class="text-red-500 text-sm font-medium">{{ localError || entryWorkflow.errors.change_password }}</p>
    <button type="submit" class="btn-primary w-full" :disabled="entryWorkflow.statuses.change_password === 'active'">
      {{ entryWorkflow.statuses.change_password === 'active' ? 'Updating…' : 'Change Password' }}
    </button>
  </form>
</template>
