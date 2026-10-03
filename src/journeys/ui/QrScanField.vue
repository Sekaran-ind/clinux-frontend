<script setup>
// A journey field of type 'qrscan': the text a QR code decodes to. Three ways in, because front
// desks differ: the device camera (qr-scanner, already used by the session-import modal), a photo
// of the code, or pasting what a handheld scanner typed. The value is the decoded text only; the
// journey decides what it means (patientAbhaJourney.js's parseAbhaQr).
import { onBeforeUnmount, ref } from 'vue';
import QrScanner from 'qr-scanner';

const props = defineProps({ modelValue: { type: String, default: '' }, label: { type: String, default: 'QR code' } });
const emit = defineEmits(['update:modelValue']);

const video = ref(null);
const scanning = ref(false);
const problem = ref('');
const pasting = ref(false);
let scanner = null;

function stop() {
  scanner?.stop();
  scanner?.destroy();
  scanner = null;
  scanning.value = false;
}
onBeforeUnmount(stop);

async function startCamera() {
  problem.value = '';
  if (!(await QrScanner.hasCamera())) { problem.value = 'No camera found. Upload a photo of the QR code instead.'; return; }
  scanning.value = true;
  await Promise.resolve();
  scanner = new QrScanner(video.value, (r) => { emit('update:modelValue', r.data); stop(); }, { returnDetailedScanResult: true, preferredCamera: 'environment', highlightScanRegion: true });
  try {
    await scanner.start();
  } catch (err) {
    stop();
    problem.value = `The camera couldn’t start (${err?.message || err}). Upload a photo instead.`;
  }
}

async function fromPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  problem.value = '';
  try {
    const r = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
    emit('update:modelValue', r.data);
  } catch {
    problem.value = 'No QR code found in that photo. Try a closer, sharper photo.';
  }
}
</script>

<template>
  <div class="qr-field" data-testid="qrscan-field">
    <label class="qr-label">{{ label }}</label>
    <div v-if="modelValue" class="qr-done">
      <i class="fas fa-circle-check"></i>
      <span>QR code read</span>
      <button type="button" class="ui-btn" style="padding:.25rem .6rem" @click="emit('update:modelValue', '')">Scan again</button>
    </div>
    <template v-else>
      <div v-show="scanning" class="qr-video"><video ref="video" playsinline muted></video></div>
      <div class="qr-actions">
        <button v-if="!scanning" type="button" class="ui-btn ui-btn-primary" style="padding:.35rem .7rem" @click="startCamera"><i class="fas fa-camera"></i> Use the camera</button>
        <button v-else type="button" class="ui-btn" style="padding:.35rem .7rem" @click="stop"><i class="fas fa-stop"></i> Stop camera</button>
        <label class="ui-btn" style="padding:.35rem .7rem;cursor:pointer"><i class="fas fa-image"></i> Photo of the QR<input type="file" accept="image/*" class="sr-only" data-testid="qrscan-photo" @change="fromPhoto" /></label>
        <button type="button" class="ui-btn" style="padding:.35rem .7rem" @click="pasting = !pasting"><i class="fas fa-keyboard"></i> Paste</button>
      </div>
      <textarea v-if="pasting" class="cf-input" rows="3" placeholder="What a handheld scanner reads from the QR" data-testid="qrscan-paste" @change="emit('update:modelValue', $event.target.value.trim())"></textarea>
    </template>
    <p v-if="problem" class="qr-problem" role="alert">{{ problem }}</p>
  </div>
</template>

<style scoped>
.qr-field { display: flex; flex-direction: column; gap: .4rem; }
.qr-label { font-size: .75rem; font-weight: 600; color: var(--shell-text-strong); }
.qr-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.qr-video { border-radius: .5rem; overflow: hidden; background: #000; max-width: 360px; }
.qr-video video { width: 100%; display: block; }
.qr-done { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--shell-text-strong); }
.qr-done i { color: #16a34a; }
.qr-problem { margin: 0; font-size: .75rem; color: #b91c1c; }
</style>
