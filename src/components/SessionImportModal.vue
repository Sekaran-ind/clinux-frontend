<script setup>
// Receive side of Phase C's QR/text-key session transfer. Camera scan and paste are shown
// together, equally prominent, for the same reason SessionShareModal shows the QR and text key
// together — a camera can't be assumed available (mid video-call, permission denied, no camera
// on this device at all), so paste is a first-class path, not a fallback link buried under a
// "camera not working?" message.
import { nextTick, ref, watch, onUnmounted } from 'vue';
import QrScanner from 'qr-scanner';
import { decodeSessionTransfer } from '../data/sessionTransfer.js';
import {
  isSameClinic, alreadyConsented,
  importEncounterSharePayload, consentAndImport,
} from '../data/sessionShare.js';
import { useOnboardingStore } from '../stores/onboarding.js';

// CALLER WARNING, hit 3 times already (FrontDesk.vue/Checkout.vue's encounter import,
// Onboarding.vue's and StaffOnboarding.vue's clinic-profile import) before this comment existed:
// on 'imported'/'profile-imported', do NOT set your `open` prop to false in the handler. This
// modal shows its own "...imported." success state and expects the USER to dismiss it (the X
// button / backdrop click already call emit('close') for you) — closing it yourself in the
// event handler races the success render and always wins, so the message flashes for 0ms and
// nobody ever sees it. Just react to the data (toast, refresh, navigate); leave `open` alone.
const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'imported', 'profile-imported']);
const onboarding = useOnboardingStore();

// 'scan' (idle, camera + paste both available) | 'consent' (cross-clinic encounter, awaiting
// confirm) | 'rejected' (cross-clinic clinic-profile — no consent option, just a clear no) |
// 'imported' (success) | 'error'
const stage = ref('scan');
const pastedKey = ref('');
const cameraError = ref('');
const errorMessage = ref('');
const pendingPayload = ref(null);
const importedKind = ref(''); // drives the success message's wording
const videoEl = ref(null);
let scanner = null;

function reset() {
  stage.value = 'scan';
  pastedKey.value = '';
  cameraError.value = '';
  errorMessage.value = '';
  pendingPayload.value = null;
}

async function handleDecoded(rawString) {
  const result = await decodeSessionTransfer(rawString);
  if (!result.ok) {
    errorMessage.value = result.error;
    stage.value = 'error';
    return;
  }
  const payload = result.data;

  if (payload?.kind === 'provider-profile') {
    // No consent path at all for a clinic profile -- importing a DIFFERENT clinic's profile
    // into your own would just overwrite your own clinic's public page with a stranger's data,
    // not a referral worth consenting into. See sessionShare.js's own comment on this.
    if (!isSameClinic(payload)) {
      pendingPayload.value = payload;
      stage.value = 'rejected';
      return;
    }
    onboarding.importProviderProfile(payload);
    importedKind.value = 'provider-profile';
    stage.value = 'imported';
    emit('profile-imported');
    return;
  }

  if (payload?.kind === 'encounter-session') {
    if (isSameClinic(payload) || alreadyConsented(payload)) {
      const { encounterId } = importEncounterSharePayload(payload);
      importedKind.value = 'encounter-session';
      stage.value = 'imported';
      emit('imported', encounterId);
    } else {
      pendingPayload.value = payload;
      stage.value = 'consent';
    }
    return;
  }

  errorMessage.value = 'This key is valid but is not something ClinüxFlow recognizes.';
  stage.value = 'error';
}

function confirmCrossClinicImport() {
  const { encounterId } = consentAndImport(pendingPayload.value);
  importedKind.value = 'encounter-session';
  stage.value = 'imported';
  emit('imported', encounterId);
}

function importPasted() {
  if (!pastedKey.value.trim()) return;
  handleDecoded(pastedKey.value);
}

async function startCamera() {
  if (!videoEl.value) return;
  try {
    scanner = new QrScanner(
      videoEl.value,
      (result) => handleDecoded(result.data),
      { returnDetailedScanResult: true, highlightScanRegion: true, highlightCodeOutline: true },
    );
    await scanner.start();
  } catch (e) {
    // No camera, permission denied, or a non-HTTPS context — the paste textarea right below
    // this still works regardless, so this is informational, not a dead end.
    cameraError.value = 'Camera not available — paste the key below instead.';
  }
}

function stopCamera() {
  scanner?.stop();
  scanner?.destroy();
  scanner = null;
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    reset();
    await nextTick();
    startCamera();
  } else {
    stopCamera();
  }
});

onUnmounted(stopCamera);
</script>

<template>
  <div class="modal-backdrop" v-show="open" @click.self="emit('close')">
    <div class="modal-box" style="max-width:480px">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-qrcode mr-2" style="color:var(--color-primary)"></i>Scan / Paste to Import</h3>
        <button @click="emit('close')" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
      </div>

      <div v-if="stage === 'scan'">
        <div class="rounded-xl overflow-hidden mb-2" style="aspect-ratio:1/1;background:#000">
          <video ref="videoEl" style="width:100%;height:100%;object-fit:cover"></video>
        </div>
        <p v-if="cameraError" class="text-xs text-center mb-4" style="color:var(--cf-text)"><i class="fas fa-circle-info mr-1"></i>{{ cameraError }}</p>
        <p v-else class="text-xs text-center mb-4" style="color:var(--cf-text)">Point the camera at the other device's QR code.</p>

        <p class="cf-label mb-1">Or paste the text key</p>
        <textarea v-model="pastedKey" class="cf-input text-xs" style="height:72px;resize:none;font-family:var(--font-mono, monospace)" placeholder="cfx1...."></textarea>
        <button class="btn-teal text-xs mt-2 w-full" @click="importPasted()"><i class="fas fa-file-import"></i> Import</button>
      </div>

      <div v-else-if="stage === 'consent'" class="text-sm">
        <p class="mb-3" style="color:var(--cf-text-strong)">
          This session comes from <strong>{{ pendingPayload.sourceClinicName || 'another clinic' }}</strong>,
          a different clinic than the one you're logged into.
        </p>
        <p class="mb-4" style="color:var(--cf-text)">
          Importing it will be recorded as a consented cross-clinic referral. Continue?
        </p>
        <div class="flex gap-2">
          <button class="btn-outline text-xs flex-1" @click="emit('close')">Cancel</button>
          <button class="btn-teal text-xs flex-1" @click="confirmCrossClinicImport()">Allow &amp; Import</button>
        </div>
      </div>

      <div v-else-if="stage === 'rejected'" class="text-sm">
        <p class="mb-3" style="color:var(--cf-text-strong)">
          This clinic profile belongs to <strong>{{ pendingPayload.sourceClinicName || 'a different clinic' }}</strong>,
          not the one you're logged into.
        </p>
        <p class="mb-4" style="color:var(--cf-text)">
          A clinic profile can only be imported into a login on the SAME clinic it came from — importing
          it here would overwrite your own clinic's page with theirs, so this isn't allowed.
        </p>
        <button class="btn-outline text-xs w-full" @click="reset()">Close</button>
      </div>

      <div v-else-if="stage === 'imported'" class="text-sm text-center py-4">
        <i class="fas fa-check-circle text-2xl mb-2" style="color:var(--color-primary)"></i>
        <p style="color:var(--cf-text-strong)">{{ importedKind === 'provider-profile' ? 'Clinic profile imported.' : 'Session imported.' }}</p>
      </div>

      <div v-else-if="stage === 'error'" class="text-sm">
        <p class="text-center py-2" style="color:#b91c1c">{{ errorMessage }}</p>
        <button class="btn-outline text-xs w-full mt-2" @click="reset()">Try again</button>
      </div>
    </div>
  </div>
</template>
