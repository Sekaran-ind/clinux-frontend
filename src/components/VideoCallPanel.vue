<script setup>
// Phase E: video conferencing via Cloudflare RealtimeKit — originally Consultation Desk-only
// (POST /api/realtime/join), now also reused for contact-to-contact calls from Cübo's own
// Contacts pane (POST /api/realtime/contact-call/:peerAccountId/join — the real gap found while
// auditing the Hospital/Provider/Affiliate journey: chat already worked between any staff member
// and any linked affiliate, video never did). The account-level API token lives only server-side
// (clinuxflow-api), this component only ever sees the short-lived per-participant authToken the
// server mints. The original encounter-scoped path was live-tested end-to-end against a real
// Cloudflare RealtimeKit account this session; the contact-call path reuses the exact same
// RealtimeClient/init/mount code below and was ALSO live-verified this session (two real
// accounts, a real minted authToken + meetingId, confirmed shared across both sides of the call).
//
// Uses RealtimeKit's pre-built <rtk-meeting> web component (not a hand-built video grid) --
// explicit choice: their UI kit is well-tested by Cloudflare and gets a full-featured meeting UI
// (grid, mute/camera/leave controls, device picker) for free, at the cost of not visually
// matching ClinuxFlow's own design system inside the call surface itself (the panel CHROME
// around it does match). Mounted imperatively via a plain DOM ref rather than in the Vue
// template directly -- <rtk-meeting> is a native custom element expecting its `meeting` property
// set as a raw JS object (not a string attribute), and wiring that through Vue's own
// compilerOptions.isCustomElement would be an app-wide config change for one feature; assigning
// the property directly after createElement() sidesteps that entirely.
import { ref, onUnmounted } from 'vue';
import RealtimeKitClient from '@cloudflare/realtimekit';
import { defineCustomElements } from '@cloudflare/realtimekit-ui/loader';
import { API_BASE, apiFetch } from '../config.js';

// Hospital/Provider/Affiliate journey follow-up — generalized from encounter-only to also
// support a contact-to-contact call (staff<->staff or staff<->affiliate from Cübo's own Contacts
// pane, see CuboContactConversation.vue), reusing every RealtimeKit init/mount line below as-is —
// only the ONE apiFetch call site (startCall(), below) differs by which prop was given. Exactly
// one of encounterId or peerAccountId is expected; encounterId takes precedence if a caller
// somehow passes both (shouldn't happen — the two calling components never overlap).
const props = defineProps({
  encounterId: { type: String, default: '' },
  encounterTitle: { type: String, default: '' },
  peerAccountId: { type: String, default: '' },
  peerName: { type: String, default: '' },
});

defineCustomElements(); // idempotent -- safe even if another instance already called this

const status = ref('idle'); // 'idle' | 'connecting' | 'ready' | 'error' | 'unavailable'
const errorMessage = ref('');
const containerEl = ref(null);
let meetingInstance = null;
let mountedElement = null;

async function startCall() {
  status.value = 'connecting';
  errorMessage.value = '';
  try {
    const res = props.encounterId
      ? await apiFetch(`${API_BASE}/api/realtime/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encounterId: props.encounterId, encounterTitle: props.encounterTitle }),
        })
      : await apiFetch(`${API_BASE}/api/realtime/contact-call/${encodeURIComponent(props.peerAccountId)}/join`, { method: 'POST' });

    if (res.status === 501) {
      status.value = 'unavailable';
      errorMessage.value = 'Video calling has not been configured for this clinic yet.';
      return;
    }
    const body = await res.json().catch(() => ({ success: false, error: 'Unexpected response from the server.' }));
    if (!body.success) {
      status.value = 'error';
      errorMessage.value = body.error || 'Could not start the video call.';
      return;
    }

    meetingInstance = await RealtimeKitClient.init({
      authToken: body.authToken,
      defaults: { audio: true, video: true },
    });

    const el = document.createElement('rtk-meeting');
    el.meeting = meetingInstance;
    el.style.width = '100%';
    el.style.height = '100%';
    if (containerEl.value) {
      containerEl.value.innerHTML = '';
      containerEl.value.appendChild(el);
      mountedElement = el;
    }

    status.value = 'ready';
  } catch (e) {
    status.value = 'error';
    errorMessage.value = e?.message || 'Could not start the video call.';
  }
}

function endCall() {
  meetingInstance?.leave?.().catch(() => {});
  mountedElement?.remove();
  mountedElement = null;
  meetingInstance = null;
  status.value = 'idle';
}

onUnmounted(() => endCall());
</script>

<template>
  <div class="cf-card rounded-2xl p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-video mr-2" style="color:var(--color-primary)"></i>Video Call</h3>
      <button v-if="status === 'ready'" class="btn-outline text-xs" @click="endCall()"><i class="fas fa-phone-slash"></i> End Call</button>
    </div>

    <div v-if="status === 'idle'">
      <p class="text-sm mb-3" style="color:var(--cf-text)">
        {{ encounterId ? 'Start a video call with the care team on this encounter.' : `Start a video call with ${peerName || 'this contact'}.` }}
      </p>
      <button class="btn-teal text-sm" @click="startCall()"><i class="fas fa-video"></i> Start Video Call</button>
    </div>

    <div v-else-if="status === 'connecting'" class="text-sm text-center py-6" style="color:var(--cf-text)">
      <i class="fas fa-spinner fa-spin mr-2"></i>Connecting...
    </div>

    <div v-else-if="status === 'unavailable'" class="text-sm text-center py-4" style="color:var(--cf-text)">
      <i class="fas fa-circle-info mr-1"></i>{{ errorMessage }}
    </div>

    <div v-else-if="status === 'error'" class="text-sm text-center py-4" style="color:#b91c1c">
      {{ errorMessage }}
      <button class="btn-outline text-xs mt-2 block mx-auto" @click="startCall()">Try again</button>
    </div>

    <div v-show="status === 'ready'" ref="containerEl" style="width:100%;height:520px;border-radius:.75rem;overflow:hidden"></div>
  </div>
</template>
