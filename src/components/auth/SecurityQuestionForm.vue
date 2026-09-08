<script setup>
// SPEC-20's post-register follow-up — sets the security question Forgot Password needs. A plain
// authStore.setSecurityQuestion() call, deliberately NOT a tracked ENTRY_PLAN_DEFINITION action
// (see entryPlanDefinition.js's header comment) — optional, skippable, not part of the closed
// loop's own sequencing. Also how a pre-existing account (no question set yet) adds one later.
import { reactive, ref } from 'vue';
import { useAuthStore } from '../../stores/auth.js';

const emit = defineEmits(['success', 'skip']);
const auth = useAuthStore();

const form = reactive({ securityQuestion: '', securityAnswer: '' });
const error = ref('');
const saving = ref(false);

async function submit() {
  error.value = '';
  if (!form.securityQuestion.trim() || !form.securityAnswer.trim()) { error.value = 'Both fields are required.'; return; }
  saving.value = true;
  const res = await auth.setSecurityQuestion(form.securityQuestion, form.securityAnswer);
  saving.value = false;
  if (res.error) { error.value = res.error; return; }
  emit('success');
}
</script>

<template>
  <div class="copilot-card">
    <div class="copilot-header"><i class="fas fa-shield-halved"></i> Set a recovery question</div>
    <p class="copilot-desc">This is how you'll get back in if you ever forget your password — there's no email recovery in this app.</p>
    <form @submit.prevent="submit()" class="space-y-3">
      <div><label class="cf-label">Security Question</label><input class="cf-input" v-model="form.securityQuestion" placeholder="e.g. What was your first pet's name?" /></div>
      <div><label class="cf-label">Your Answer</label><input class="cf-input" v-model="form.securityAnswer" /></div>
      <p v-show="error" class="text-red-500 text-sm font-medium">{{ error }}</p>
      <div class="flex gap-2">
        <button type="submit" class="btn-primary flex-1" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
        <button type="button" class="btn-outline" @click="emit('skip')">Skip for now</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.copilot-card { background: var(--cf-card-bg, #fff); border: 1px solid var(--color-primary); border-left: 3px solid var(--color-primary); border-radius: .75rem; padding: 1rem; }
.copilot-header { font-family: 'Poppins', sans-serif; font-weight: 700; font-size: .85rem; color: var(--cf-text-strong); display: flex; align-items: center; gap: .4rem; margin-bottom: .3rem; }
.copilot-desc { font-size: .78rem; color: var(--cf-text); line-height: 1.5; margin-bottom: .5rem; }
</style>
