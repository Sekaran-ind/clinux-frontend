<script setup>
// Generate side of Phase C's QR/text-key session transfer (see sessionShare.js and the
// clinux-mobile-sync-multiuser-video-roadmap memory note for the full design). Shows the QR
// image and the copyable text key TOGETHER, both full prominence — not one gated behind the
// other as a "camera not working? try this" fallback. A camera isn't always available at the
// exact moment someone needs to hand off a session (e.g. mid video-call, camera already busy),
// so the text key has to be a genuinely equal option, per explicit user direction.
import { ref, watch } from 'vue';
import QRCode from 'qrcode';
import { buildEncounterSharePayload } from '../data/sessionShare.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  record: { type: Object, default: null }, // the encounter's own formData record
});
const emit = defineEmits(['close']);

const status = ref('idle'); // 'idle' | 'generating' | 'ready' | 'error'
const sessionKey = ref('');
const qrDataUrl = ref('');
const qrSkippedReason = ref('');
const errorMessage = ref('');
const copied = ref(false);

async function generate() {
  status.value = 'generating';
  qrDataUrl.value = '';
  qrSkippedReason.value = '';
  copied.value = false;
  try {
    const { key } = await buildEncounterSharePayload(props.record);
    sessionKey.value = key;
    try {
      qrDataUrl.value = await QRCode.toDataURL(key, { errorCorrectionLevel: 'L', margin: 2, width: 320 });
    } catch (qrErr) {
      // This visit's data compressed to something too large for a scannable QR (lots of
      // vitals readings, a long SOAP note, several prescriptions/payments...) — the text key
      // has no such size ceiling, so it's still shown below regardless.
      qrSkippedReason.value = 'This session has too much data to fit in a QR code reliably — use the text key below instead.';
    }
    status.value = 'ready';
  } catch (e) {
    errorMessage.value = e?.message || 'Could not generate a session key.';
    status.value = 'error';
  }
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(sessionKey.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    // Clipboard API can be denied/unavailable — the key is already selectable text in the
    // textarea below, so this failing silently still leaves a working fallback.
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen && props.record) generate();
});
</script>

<template>
  <div class="modal-backdrop" v-show="open" @click.self="emit('close')">
    <div class="modal-box" style="max-width:480px">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-share-nodes mr-2" style="color:var(--color-primary)"></i>Share / Sync Session</h3>
        <button @click="emit('close')" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
      </div>

      <p class="text-sm mb-4" style="color:var(--cf-text)">
        Scan this on another device to sync this visit, or paste the key below. Valid for 24 hours.
        If the other device is logged into a <strong>different</strong> clinic, they'll be asked to
        confirm before importing.
      </p>

      <div v-if="status === 'generating'" class="text-sm text-center py-6" style="color:var(--cf-text)">
        <i class="fas fa-spinner fa-spin mr-2"></i>Generating session key...
      </div>

      <div v-else-if="status === 'error'" class="text-sm text-center py-4" style="color:#b91c1c">
        {{ errorMessage }}
      </div>

      <div v-else-if="status === 'ready'">
        <div v-if="qrDataUrl" class="flex justify-center mb-4">
          <img :src="qrDataUrl" alt="Session transfer QR code" style="width:220px;height:220px;border-radius:.75rem;border:1px solid var(--cf-border)" />
        </div>
        <p v-else-if="qrSkippedReason" class="text-xs text-center mb-4" style="color:var(--cf-text)">
          <i class="fas fa-circle-info mr-1"></i>{{ qrSkippedReason }}
        </p>

        <p class="cf-label mb-1">Text key</p>
        <textarea readonly class="cf-input text-xs" style="height:88px;resize:none;font-family:var(--font-mono, monospace)" @click="$event.target.select()">{{ sessionKey }}</textarea>
        <button class="btn-outline text-xs mt-2 w-full" @click="copyKey()">
          <i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i> {{ copied ? 'Copied!' : 'Copy key' }}
        </button>
      </div>
    </div>
  </div>
</template>
