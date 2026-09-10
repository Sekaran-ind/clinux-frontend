<script setup>
// SPEC-20's shared Register form — extracted from Index.vue's former inline modal markup, no
// opinion about being hosted in a modal (Index.vue) or inline in a Cübo message (Cubo.vue). Emits
// events; the host decides what happens next (close a modal + navigate, vs. narrate the next
// message in a thread). Dispatches through entryWorkflow.js's real ENTRY_PLAN_DEFINITION runtime
// — status/error come from there, not local component state, so the same Task/audit tracking
// this session built applies here regardless of which host is showing this form.
import { reactive, ref, watch } from 'vue';
import { RadioGroupRoot, RadioGroupItem, RadioGroupIndicator } from 'reka-ui';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';
import { HPR_ROLES } from '../../data/control/hprRoles.js';

const emit = defineEmits(['success', 'switch-to-login']);
const entryWorkflow = useEntryWorkflowStore();

const form = reactive({ email: '', password: '', confirmPassword: '', role: '' });
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
  // RadioGroupRoot is a headless ARIA radiogroup, not a native <input required> -- doesn't
  // participate in native HTML5 form validation the way password/email's required/minlength do.
  if (!form.role) { localError.value = 'Please select how you’re registering.'; return; }
  if (form.password !== form.confirmPassword) { localError.value = 'Passwords do not match.'; return; }
  submitting.value = true;
  entryWorkflow.focus('register', { email: form.email, password: form.password, role: form.role });
}

watch(() => entryWorkflow.statuses.register, (status) => {
  if (!submitting.value) return; // a different instance's submission, not ours — ignore it
  if (status === 'done') { submitting.value = false; emit('success', { role: form.role }); }
  else if (status !== 'active') submitting.value = false; // e.g. back to 'ready' after an error
});
</script>

<template>
  <form @submit.prevent="submit()" class="space-y-4">
    <!-- SPEC-11: role is the top-of-funnel fork -- routes which self-service HFR/HPR journeys
         ClinicHome offers afterward, not what this form collects. -->
    <div>
      <label class="cf-label">I'm registering as... *</label>
      <!-- Same vocabulary ProviderBasicsHost.vue's "HPR Role" field uses for the identical real
           HPR concept — see hprRoles.js's own header on why these used to be two drifted labels
           for one thing. -->
      <RadioGroupRoot v-model="form.role" class="grid grid-cols-1 gap-3 mt-1">
        <label
          v-for="opt in HPR_ROLES" :key="opt.accountRole"
          class="cf-card rounded-xl p-3 flex items-center gap-2 cursor-pointer"
          :style="`border:2px solid ${form.role === opt.accountRole ? 'var(--color-primary)' : 'transparent'}`"
        >
          <RadioGroupItem :value="opt.accountRole" class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center" style="border-color:var(--color-primary)">
            <RadioGroupIndicator class="w-2 h-2 rounded-full" style="background:var(--color-primary)" />
          </RadioGroupItem>
          <div>
            <div class="text-sm font-bold" style="color:var(--cf-text-strong)">{{ opt.label }}</div>
            <div class="text-xs" style="color:var(--cf-text)">{{ opt.description }}</div>
          </div>
        </label>
      </RadioGroupRoot>
    </div>
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
