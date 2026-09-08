<script setup>
// SPEC-20's shared Login form — extracted from Index.vue's former inline modal markup. See
// RegisterForm.vue's header comment for the shared "no opinion about host" contract.
import { reactive, ref, watch } from 'vue';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';

const emit = defineEmits(['success', 'switch-to-register']);
const entryWorkflow = useEntryWorkflowStore();

const form = reactive({ email: '', password: '' });
// See RegisterForm.vue's header comment on `submitting` — same real multi-instance-shared-store
// bug, same fix: only react to a status change THIS instance's own submit() caused.
const submitting = ref(false);

function submit() {
  submitting.value = true;
  entryWorkflow.focus('login', { email: form.email, password: form.password });
}

watch(() => entryWorkflow.statuses.login, (status) => {
  if (!submitting.value) return;
  if (status === 'done') { submitting.value = false; emit('success'); }
  else if (status !== 'active') submitting.value = false;
});
</script>

<template>
  <form @submit.prevent="submit()" class="space-y-4">
    <div><label class="cf-label">Email Address</label><input class="cf-input" type="email" v-model="form.email" placeholder="admin@clinic.com" required /></div>
    <div><label class="cf-label">Password</label><input class="cf-input" type="password" v-model="form.password" placeholder="Your password" required @keyup.enter="submit()" /></div>
    <p v-show="entryWorkflow.errors.login" class="text-red-500 text-sm font-medium">{{ entryWorkflow.errors.login }}</p>
    <button type="submit" class="btn-primary w-full" :disabled="entryWorkflow.statuses.login === 'active'">
      <i class="fas fa-sign-in-alt mr-2"></i>{{ entryWorkflow.statuses.login === 'active' ? 'Signing in…' : 'Sign In' }}
    </button>
    <p class="text-center text-sm cf-text">New here? <button type="button" @click="emit('switch-to-register')" class="font-bold" style="color:var(--color-primary)">Register your clinic</button></p>
  </form>
</template>
