<script setup>
// Full rewrite of clinixflow's public/cubo-ai-cc/cubo-component.js + cubo-template.html as a
// genuine Vue SFC. The original was a native Web Component that fetched cubo-template.html as
// raw HTML text and rehydrated it with Alpine.initTree() — that trick existed only because
// Alpine had no other way to attach reactive behavior to server-fetched markup. With Alpine gone
// entirely, this is just a normal component; the fetch-and-rehydrate step disappears.
//
// Same attribute/prop contract as before: category, encounterId, encounterTitle, pageContext.
import { computed, onMounted, ref, watch } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { chatThreads } from '../data/collections/chatThreads.js';
import { useCuboStore } from '../stores/cubo.js';
import { classifyIntent } from '../nlp/intents.js';
import { recognizeSlots, applyFills } from '../nlp/formSlotEngine.js';

const props = defineProps({
  category: { type: String, default: 'general' },
  encounterId: { type: String, default: null },
  encounterTitle: { type: String, default: '' },
  pageContext: { type: String, default: 'General Shell Context Profile' },
});

const emit = defineEmits(['cubo-api-submit']);

const cubo = useCuboStore();
const { data: threads } = useLiveQuery((q) => q.from({ t: chatThreads }));

const activeThread = computed(() =>
  threads.value.find((t) => t.id === cubo.activeThreadId) || threads.value[0]
);

// Same routing rule as evaluateContextRouting() in the original component: an encounterId
// takes priority (creates/switches to an encounter-scoped thread); otherwise a non-general
// category gets its own persistent thread.
onMounted(() => {
  if (props.encounterId) {
    cubo.createNewThread('encounter', `Encounter: ${props.encounterTitle || props.encounterId}`, `enc-${props.encounterId}`, props.encounterId);
  } else if (props.category && props.category !== 'general') {
    const meta = cubo.categoryMeta(props.category);
    cubo.createNewThread(props.category, meta.label, `cat-${props.category}`);
  }
});

// Front Desk mounts Cubo before an encounter exists (Patient step comes before Encounter is
// created) — the onMounted routing above only runs once, so without this, a Cubo instance
// mounted pre-encounter never hands off to the enc-<id> thread once the encounter is created.
// Always switches the instant an id appears, mirroring onMounted's own behavior exactly (no
// "did the user manually switch away" tracking) — createNewThread() is idempotent (switches to
// an existing thread rather than resetting it) via its own chatThreads.has() check.
watch(() => props.encounterId, (newId, oldId) => {
  if (newId && newId !== oldId) {
    cubo.createNewThread('encounter', `Encounter: ${props.encounterTitle || newId}`, `enc-${newId}`, newId);
  }
});

const chatHistoryEl = ref(null);
function scrollChatToBottom() {
  setTimeout(() => {
    if (chatHistoryEl.value) chatHistoryEl.value.scrollTop = chatHistoryEl.value.scrollHeight;
  }, 50);
}

async function sendPrompt() {
  const prompt = cubo.promptText.trim();
  if (!prompt) return;

  cubo.addCuboMessage('user', prompt);
  cubo.promptText = '';
  scrollChatToBottom();

  // nlp.js intent classification runs first — additive, not a replacement for the LLM scribe
  // call. A recognized command gets a canned local reply; everything else (including
  // low-confidence matches) falls through to the normal contextString payload below.
  const { intent } = await classifyIntent(prompt);
  if (intent === 'switch_room') {
    cubo.addCuboMessage('assistant', 'Open the Profile panel (top-right) to pick a new speciality/role.');
    cubo.toggleProfileView();
    return;
  }

  // Form-field slot recognition — additive, alongside the command-shortcut check above. See
  // nlp/formSlotEngine.js for scope/tradeoffs (recognizes against every system form's fields
  // globally, not just this page's). A visual "please confirm" cue for filled fields is planned
  // separately — for now, filled fields are called out in chat so the user knows to check them.
  const slotCandidates = await recognizeSlots(prompt);
  if (slotCandidates.length > 0) {
    const { applied } = applyFills(slotCandidates);
    if (applied.length > 0) {
      cubo.addCuboMessage('assistant', `Filled ${applied.length} field(s) from that message on the active encounter — please review and confirm.`);
      scrollChatToBottom();
    }
  }

  const payload = {
    threadId: cubo.activeThreadId,
    threadType: activeThread.value?.category,
    contextString: cubo.buildCuboContext(props.pageContext),
    prompt,
    nlpIntent: intent,
  };

  setTimeout(() => {
    cubo.addCuboMessage('assistant', 'Command acknowledged under active workspace thread index. Instruction maps appended cleanly.');
    scrollChatToBottom();
  }, 450);

  emit('cubo-api-submit', payload);
}

function setFeedback(msg, value) {
  chatThreads.update(activeThread.value.id, (draft) => {
    const m = draft.messages.find((x) => x.id === msg.id);
    if (m) m.feedback = m.feedback === value ? null : value;
  });
}

function copyMsg(text) {
  navigator.clipboard.writeText(text);
}

// Layout-dependent wrapper classes — replaces the two near-duplicate EXPANDED/MODAL_DOCK blocks
// in the original template with one shared body, since Vue components make that de-duplication
// straightforward where Alpine's copy-pasted x-show blocks didn't.
const isDock = computed(() => cubo.currentLayout === 'MODAL_DOCK');
</script>

<template>
  <div v-if="cubo.currentLayout === 'FAB'" class="cubo-wrapper cubo-fab-container">
    <button @click="cubo.currentLayout = 'EXPANDED'" class="cubo-fab-trigger group">
      <span class="absolute inline-flex h-full w-full rounded bg-[var(--color-primary)] opacity-25 animate-ping group-hover:hidden"></span>
      Cü
    </button>
  </div>

  <div
    v-else
    :class="isDock
      ? 'fixed inset-0 z-[99999] bg-slate-900/40 backdrop-blur-sm flex justify-end'
      : 'cubo-wrapper cubo-expanded-panel'"
    @click.self="isDock && (cubo.currentLayout = 'FAB')"
  >
    <div
      :class="isDock
        ? 'cubo-side-pane transform transition-transform duration-300 flex flex-col h-full bg-white dark:bg-slate-950 border-l border-gray-200 dark:border-slate-800 w-full max-w-md'
        : 'w-full bg-blue-50/95 dark:bg-slate-900/95 rounded-xl border border-blue-100 dark:border-slate-800 shadow-2xl backdrop-blur-md overflow-hidden flex flex-col h-[500px]'"
    >
      <!-- Header -->
      <div :class="isDock
        ? 'flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-800 bg-gray-50/30 dark:bg-slate-900/20'
        : 'flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50'">
        <div class="flex items-center gap-2 min-w-0">
          <h3 class="font-bold text-sm text-blue-900 dark:text-blue-300 flex items-center gap-1.5 min-w-0">
            <i class="fas fa-shield-alt text-[var(--color-primary)]"></i>
            <span class="truncate">{{ isDock ? 'Cübo Workspace' : 'Cübo AI Command Center' }}</span>
          </h3>
          <span class="text-[10px] text-gray-400 font-medium whitespace-nowrap">· {{ cubo.resolveActivePersona().label }}</span>
        </div>
        <div class="flex items-center gap-2.5 text-gray-400 text-xs">
          <button @click="cubo.toggleThreadView()" class="hover:text-blue-500 transition px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 font-medium flex items-center gap-1">
            <i class="fas" :class="cubo.viewingThreads ? 'fa-comments' : 'fa-list'"></i>
            <span>{{ cubo.viewingThreads ? (isDock ? 'Open Chat' : 'Back to Chat') : (isDock ? 'Thread Directory' : 'Threads') }}</span>
          </button>
          <button @click="cubo.toggleProfileView()" class="hover:text-blue-500 transition px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 font-medium flex items-center gap-1 relative" title="User Profile — pick a speciality/role">
            <i class="fas" :class="cubo.viewingProfile ? 'fa-comments' : 'fa-user-doctor'"></i>
            <span>{{ cubo.viewingProfile ? (isDock ? 'Open Chat' : 'Back to Chat') : 'Profile' }}</span>
            <span v-show="cubo.virtualRoom && !cubo.viewingProfile" class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500"></span>
          </button>
          <button v-if="!isDock" @click="cubo.currentLayout = 'MODAL_DOCK'" class="hover:text-blue-500 transition" title="Maximize Workspace"><i class="fas fa-columns"></i></button>
          <button v-else @click="cubo.currentLayout = 'EXPANDED'" class="hover:text-blue-500 transition" title="Minimize to Float Window"><i class="fas fa-window-restore text-blue-600"></i></button>
          <button @click="cubo.currentLayout = 'FAB'" class="hover:text-red-500 transition" :title="isDock ? 'Minimize to Badge' : 'Minimize'"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <!-- Body: Threads / Profile / Chat -->
      <div class="flex-1 flex overflow-hidden relative">
        <!-- Thread directory -->
        <div v-show="cubo.viewingThreads" class="absolute inset-0 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto custom-scrollbar p-3 space-y-2">
          <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-slate-800">
            <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">{{ isDock ? 'Workspace Threads Matrix' : 'Active Workspace Threads' }}</span>
            <button @click="cubo.createNewThread('general')" class="text-[11px] bg-[var(--color-primary)]/10 text-[var(--color-primary)] px-2 py-0.5 rounded font-semibold hover:bg-[var(--color-primary)]/20 transition">+ General Thread</button>
          </div>

          <div v-for="thread in threads" :key="thread.id"
               class="flex items-center justify-between p-2.5 rounded-lg border transition group text-left"
               :class="cubo.activeThreadId === thread.id ? 'bg-blue-500/10 border-blue-500/30 text-blue-900 dark:text-blue-300' : 'bg-gray-50/50 dark:bg-slate-900/50 border-gray-200/60 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'">
            <div @click="cubo.switchThread(thread.id)" class="flex-1 cursor-pointer min-w-0 pr-2">
              <div class="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-slate-200">
                <i class="fas text-[11px]" :class="cubo.categoryMeta(thread.category).icon + ' ' + cubo.categoryMeta(thread.category).color"></i>
                <span class="truncate">{{ thread.title }}</span>
              </div>
              <div class="text-[10px] text-gray-400 mt-0.5 truncate">{{ thread.messages[thread.messages.length - 1]?.text || 'Empty trail workspace.' }}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button @click.stop="cubo.togglePinThread(thread.id)" class="text-xs transition p-1 hover:bg-gray-200 dark:hover:bg-slate-800 rounded">
                <i class="fas fa-thumbtack text-[10px]" :class="thread.pinned ? 'text-blue-500 rotate-0' : 'text-gray-300 dark:text-slate-600 -rotate-45'"></i>
              </button>
              <button @click.stop="cubo.deleteThread(thread.id)" class="text-xs text-gray-300 hover:text-red-500 transition p-1 rounded">
                <i class="fas fa-trash-alt text-[10px]"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- Profile / virtual room picker -->
        <div v-show="cubo.viewingProfile" class="absolute inset-0 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto custom-scrollbar p-3 space-y-3">
          <div class="pb-1 border-b border-gray-100 dark:border-slate-800">
            <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">User Profile — Virtual Room</span>
          </div>

          <div v-show="cubo.virtualRoom" class="p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="font-semibold text-emerald-700 dark:text-emerald-400 truncate">{{ cubo.virtualRoom?.roleTitle }}</div>
              <div class="text-[10px] text-gray-500 truncate">{{ cubo.virtualRoom?.specialityDisplay }}</div>
            </div>
            <button @click="cubo.clearVirtualRoom()" class="text-[10px] text-gray-400 hover:text-red-500 transition shrink-0">Clear</button>
          </div>

          <div class="space-y-2">
            <label class="block text-[11px] font-semibold text-gray-500 dark:text-slate-400">Speciality</label>
            <select v-model="cubo.profilePicker.code" @change="cubo.profilePicker.roleFile = ''"
                    class="w-full text-xs p-2 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:text-white">
              <option value="">Select a speciality…</option>
              <option v-for="s in cubo.specialityCatalog" :key="s.code" :value="s.code">{{ s.display }}</option>
            </select>

            <label class="block text-[11px] font-semibold text-gray-500 dark:text-slate-400 mt-2">Role</label>
            <select v-model="cubo.profilePicker.roleFile" :disabled="!cubo.profilePicker.code"
                    class="w-full text-xs p-2 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:text-white disabled:opacity-50">
              <option value="">Select a role…</option>
              <option v-for="r in cubo.rolesForPickerCode()" :key="r.file" :value="r.file">{{ r.title }}</option>
            </select>

            <button @click="cubo.applyVirtualRoomFromPicker()" :disabled="!cubo.profilePicker.code || !cubo.profilePicker.roleFile"
                    class="w-full mt-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition">
              Load as My Context
            </button>
          </div>

          <p class="text-[10px] text-gray-400 leading-relaxed">
            The selected role's clinical scope and SOAP note constraints are applied to Cübo's persona here and are sent to the SOAP-generation step on Consultation Desk.
          </p>
        </div>

        <!-- Chat -->
        <div v-show="!cubo.viewingThreads && !cubo.viewingProfile" class="flex-1 flex flex-col justify-between overflow-hidden bg-white dark:bg-slate-950">
          <div ref="chatHistoryEl" class="chat-history-container flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            <div class="text-center pb-2 border-b border-gray-100 dark:border-slate-900/60 flex items-center justify-between text-[11px] text-gray-400">
              <span class="font-medium">Active: <span class="text-gray-700 dark:text-slate-300">{{ activeThread?.title }}</span></span>
              <span>{{ activeThread?.category !== 'general' ? '🔒 Retention Checked (FIFO Limit: 25)' : '⚡ Temporary Session Stream' }}</span>
            </div>

            <div v-for="msg in activeThread?.messages || []" :key="msg.id" class="flex flex-col" :class="msg.role === 'user' ? 'items-end' : 'items-start'">
              <div class="max-w-[85%] rounded-xl p-3 text-xs shadow-sm border leading-relaxed group relative"
                   :class="msg.role === 'user' ? 'bg-blue-600 text-white border-transparent rounded-br-none' : 'bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-slate-200 border-gray-100 dark:border-slate-800 rounded-bl-none'">
                <span>{{ msg.text }}</span>

                <div v-if="msg.role === 'assistant'" class="flex items-center gap-2 mt-2 pt-1.5 border-t border-gray-200/40 dark:border-slate-700/40 text-gray-400">
                  <button @click="copyMsg(msg.text)" class="hover:text-blue-500 transition p-0.5" title="Copy response text">
                    <i class="fas fa-copy text-[10px]"></i>
                  </button>
                  <button @click="setFeedback(msg, 'up')" class="transition p-0.5 hover:text-green-500" title="Good response">
                    <i class="fas fa-thumbs-up text-[10px]" :class="msg.feedback === 'up' ? 'text-green-500 font-black' : ''"></i>
                  </button>
                  <button @click="setFeedback(msg, 'down')" class="transition p-0.5 hover:text-red-500" title="Bad response">
                    <i class="fas fa-thumbs-down text-[10px]" :class="msg.feedback === 'down' ? 'text-red-500 font-black' : ''"></i>
                  </button>
                </div>
              </div>
              <span class="text-[9px] text-gray-400 dark:text-slate-500 mt-0.5 px-0.5">{{ cubo.formatMsgTime(msg.timestamp) }}</span>
            </div>
          </div>

          <div :class="isDock ? 'p-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/10' : 'p-3 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/20'">
            <textarea v-model="cubo.promptText" @keydown.enter.prevent="!$event.shiftKey && sendPrompt()"
                      class="w-full p-2.5 resize-none rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white mb-2"
                      :rows="isDock ? 3 : 2" :placeholder="isDock ? 'Enter instructions here...' : 'Ask Cübo command center...'"></textarea>
            <div class="flex w-full items-center justify-between">
              <div class="flex items-center gap-2">
                <button @click="cubo.toggleVoiceInput()" class="cubo-mic-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 flex items-center justify-center transition" :class="cubo.isListening ? 'text-red-500 animate-pulse' : 'text-gray-500 dark:text-gray-400'" :title="cubo.isListening ? 'Listening… click to stop' : 'Voice input'"><i class="fas fa-microphone text-xs"></i></button>
                <button class="cubo-camera-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 text-gray-500 dark:text-gray-400 flex items-center justify-center transition"><i class="fas fa-camera text-xs"></i></button>
                <button class="cubo-attach-image-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 text-gray-500 dark:text-gray-400 flex items-center justify-center transition"><i class="fas fa-image text-xs"></i></button>
              </div>
              <button @click="sendPrompt()" class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition shadow-sm">{{ isDock ? 'Send Command' : 'Send' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import './cubo.css';
</style>
