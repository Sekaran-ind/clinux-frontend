<script setup>
// SPEC-20's shared Register form — extracted from Index.vue's former inline modal markup, no
// opinion about being hosted in a modal (Index.vue) or inline in a Cübo message (Cubo.vue). Emits
// events; the host decides what happens next (close a modal + navigate, vs. narrate the next
// message in a thread). Dispatches through entryWorkflow.js's real ENTRY_PLAN_DEFINITION runtime
// — status/error come from there, not local component state, so the same Task/audit tracking
// this session built applies here regardless of which host is showing this form.
import { reactive, ref, watch } from 'vue';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';

const emit = defineEmits(['success', 'switch-to-login']);
const entryWorkflow = useEntryWorkflowStore();

// UPDATE: sign-up asks only for email and password — no "I'm registering as..." role picker.
// clinuxflow-api gives an account created without a role its default (admin_and_health_
// professional), and the workspace no longer filters the registry journeys by role.
const form = reactive({ email: '', password: '', confirmPassword: '' });
const localError = ref('');

// This form can be mounted MORE THAN ONCE at a time — Index.vue's modal keeps its own instance
// mounted (v-show, not v-if) even while hidden, and Cübo's General thread can render a second,
// separate instance. entryWorkflow.statuses.register is real shared/global state (that's the
// whole point of Task-tracking), so a naive watch(() => statuses.register, ...) fires on EVERY
// instance whenever ANY instance's submit succeeds — caught live: submitting through Cübo's
// inline form was also triggering the modal's (hidden, untouched) success handler, which
// navigated away to /clinic-home mid-conversation. `submitting` scopes the reaction to only the
// instance that actually initiated THIS submission.
const submitting = ref(false);
function submit() {
  localError.value = '';
  if (form.password !== form.confirmPassword) { localError.value = 'Passwords do not match.'; return; }
  submitting.value = true;
  entryWorkflow.focus('register', { email: form.email, password: form.password });
}

watch(() => entryWorkflow.statuses.register, (status) => {
  if (!submitting.value) return; // a different instance's submission, not ours — ignore it
  if (status === 'done') { submitting.value = false; emit('success'); }
  else if (status !== 'active') submitting.value = false; // e.g. back to 'ready' after an error
});
</script>

<template>
  <form @submit.prevent="submit()" class="space-y-4">
    <div><label class="cf-label">Email Address *</label><input class="cf-input" type="email" v-model="form.email" placeholder="you@clinic.com" required /></div>
    <div><label class="cf-label">Password *</label><input class="cf-input" type="password" v-model="form.password" placeholder="Min 8 characters" required minlength="8" /></div>
    <div><label class="cf-label">Confirm Password *</label><input class="cf-input" type="password" v-model="form.confirmPassword" placeholder="Re-enter your password" required minlength="8" /></div>
    <p v-show="localError || entryWorkflow.errors.register" class="text-red-500 text-sm font-medium">{{ localError || entryWorkflow.errors.register }}</p>
    <button type="submit" class="btn-primary w-full mt-2" :disabled="entryWorkflow.statuses.register === 'active'">
      <i class="fas fa-hospital-user mr-2"></i>{{ entryWorkflow.statuses.register === 'active' ? 'Creating…' : 'Create Account' }}
    </button>
    <p class="text-center text-sm cf-text">Already registered? <button type="button" @click="emit('switch-to-login')" class="font-bold" style="color:var(--color-primary)">Sign in</button></p>
  </form>
</template>
