<script>
// Cornerstone.js suite (cornerstone-core@2.6.1/cornerstone-math@0.1.9/hammerjs@2.0.8/
// cornerstone-tools@4.21.1/cornerstone-web-image-loader@2.1.1) — same pinned versions as
// clinixflow used from unpkg, now local npm imports instead. This top-level (non-setup) script
// block runs the one-time global registration exactly once per module load, matching the
// original's "registered once at script load, not per-component-instance" comment — a
// <script setup> block alone re-runs its body on every component instance, which is why this
// needs to be split out.
import cornerstone from 'cornerstone-core';
import cornerstoneMath from 'cornerstone-math';
import Hammer from 'hammerjs';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneWebImageLoader from 'cornerstone-web-image-loader';
import { encounterImages, encounterAnnotations } from '../data/collections/encounterDocs.js';

cornerstoneWebImageLoader.external.cornerstone = cornerstone;
cornerstone.registerImageLoader('blob', cornerstoneWebImageLoader.loadImage);

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const contentType = header.match(/data:(.*?);base64/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

// A blob: URL is a fresh, one-off object per call, which would give every image a different
// cornerstone imageId each time it's displayed — annotation tool state is keyed by imageId, so
// annotations would never re-associate with "the same" image across a re-view or a reload. This
// registers a stable custom scheme ('labimg://<record.id>') that resolves to the current image
// via the encounterImages TanStack DB collection (previously: scanning every cf_encounter_images_*
// localStorage key by prefix, since the loader had no access to which encounter was active — a
// real correctness fix, this is now a direct lookup by id across the one flat collection).
cornerstone.registerImageLoader('labimg', function (imageId) {
  const recordId = imageId.replace('labimg://', '');
  const record = encounterImages.get(recordId);
  if (!record) return Promise.reject(new Error('Image record ' + recordId + ' not found.'));

  // cornerstoneWebImageLoader.loadImage() sets image.imageId to the blob URL we hand it, not our
  // stable scheme — and cornerstone's tool-state manager keys annotations by that resolved
  // image.imageId. Overwriting it back to our stable id before returning fixes that.
  const inner = cornerstoneWebImageLoader.loadImage(URL.createObjectURL(dataUrlToBlob(record.dataUrl)));
  const innerPromise = inner.promise || inner;
  const stampedPromise = innerPromise.then((image) => { image.imageId = imageId; return image; });
  return inner.promise ? { promise: stampedPromise, cancelFn: inner.cancelFn } : stampedPromise;
});

cornerstoneTools.external.cornerstone = cornerstone;
cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
cornerstoneTools.external.Hammer = Hammer;
cornerstoneTools.init();

export { cornerstone, cornerstoneTools, encounterAnnotations };
</script>

<script setup>
import { ref, useTemplateRef } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { encounterImages as imagesCollection } from '../data/collections/encounterDocs.js';
import { logEvent } from '../data/collections/encounterDocs.js';

const props = defineProps({
  encounterId: { type: String, required: true },
});

const { data: allImages } = useLiveQuery((q) => q.from({ img: imagesCollection }));
const images = () => allImages.value.filter((img) => img.encounterId === props.encounterId);

const viewportEl = useTemplateRef('viewport');
const stickyNoteInputEl = useTemplateRef('stickyNoteInput');
const fileInputEl = useTemplateRef('fileInput');

const activeImageId = ref(null);
const activeAnnotationTool = ref('Pan');
const stickyNote = ref({ visible: false, x: 0, y: 0, text: '', _onDone: null });
let viewportEnabled = false;

function handleImageUpload(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const record = { id: 'img-' + Date.now(), encounterId: props.encounterId, filename: file.name, dataUrl: reader.result, addedAt: new Date().toISOString(), source: 'imaging' };
    imagesCollection.insert(record);
    logEvent(props.encounterId, `Added image "${file.name}".`, 'border-emerald-500');
    viewImage(record.id);
  };
  reader.onerror = () => logEvent(props.encounterId, 'Could not read the selected file.', 'border-red-500');
  reader.readAsDataURL(file);
}

function viewImage(id) {
  const record = imagesCollection.get(id);
  if (!record) return;
  activeImageId.value = id;
  const imageId = 'labimg://' + id;

  requestAnimationFrame(() => {
    const el = viewportEl.value;
    if (!el) return;
    if (!viewportEnabled) {
      cornerstone.enable(el);
      viewportEnabled = true;
      // addTool() only attaches a tool to elements already enabled at call time, so this must
      // run after cornerstone.enable(el) above, not at module load.
      cornerstoneTools.addTool(cornerstoneTools.PanTool);
      // Default ArrowAnnotate uses window.prompt() for the label; overriding both callbacks
      // routes label capture through the inline sticky-note control instead.
      cornerstoneTools.addTool(cornerstoneTools.ArrowAnnotateTool, {
        configuration: {
          getTextCallback: (doneCb) => openStickyNoteForLatestArrow(doneCb),
          changeTextCallback: (data, eventData, doneCb) => openStickyNote(data.handles.end, data.text || '', doneCb),
        },
      });
      cornerstoneTools.addTool(cornerstoneTools.LengthTool);

      restoreAnnotations();
      ['cornerstonetoolsmeasurementadded', 'cornerstonetoolsmeasurementmodified', 'cornerstonetoolsmeasurementremoved']
        .forEach((evt) => el.addEventListener(evt, saveAnnotations));
    }

    cornerstone.loadImage(imageId).then((image) => {
      cornerstone.displayImage(el, image);
      setAnnotationTool(activeAnnotationTool.value || 'Pan');
      logEvent(props.encounterId, `Viewed image "${record.filename}".`);
    }).catch((err) => logEvent(props.encounterId, 'Could not render image: ' + err.message, 'border-red-500'));
  });
}

function deleteImage(id) {
  const record = imagesCollection.get(id);
  if (imagesCollection.has(id)) imagesCollection.delete(id);
  if (activeImageId.value === id) activeImageId.value = null;
  if (record) logEvent(props.encounterId, `Deleted image "${record.filename}".`, 'border-amber-500');
}

function zoomIn() {
  const vp = cornerstone.getViewport(viewportEl.value);
  vp.scale += 0.25;
  cornerstone.setViewport(viewportEl.value, vp);
}

function zoomOut() {
  const vp = cornerstone.getViewport(viewportEl.value);
  vp.scale = Math.max(0.25, vp.scale - 0.25);
  cornerstone.setViewport(viewportEl.value, vp);
}

function toggleInvert() {
  const vp = cornerstone.getViewport(viewportEl.value);
  vp.invert = !vp.invert;
  cornerstone.setViewport(viewportEl.value, vp);
}

function resetView() {
  cornerstone.reset(viewportEl.value);
}

function setAnnotationTool(name) {
  activeAnnotationTool.value = name;
  ['Pan', 'ArrowAnnotate', 'Length'].forEach((tool) => {
    if (tool === name) cornerstoneTools.setToolActive(tool, { mouseButtonMask: 1 });
    else cornerstoneTools.setToolPassive(tool);
  });
}

function clearAnnotations() {
  if (!activeImageId.value) return;
  const el = viewportEl.value;
  cornerstoneTools.clearToolState(el, 'ArrowAnnotate');
  cornerstoneTools.clearToolState(el, 'Length');
  cornerstone.updateImage(el);
  saveAnnotations();
  logEvent(props.encounterId, 'Cleared annotations on the current image.', 'border-amber-500');
}

function saveAnnotations() {
  try {
    const state = cornerstoneTools.globalImageIdSpecificToolStateManager.saveToolState();
    if (encounterAnnotations.has(props.encounterId)) {
      encounterAnnotations.update(props.encounterId, (draft) => { draft.toolState = state; });
    } else {
      encounterAnnotations.insert({ id: props.encounterId, encounterId: props.encounterId, toolState: state });
    }
  } catch (e) {
    logEvent(props.encounterId, 'Could not save annotations: ' + e.message, 'border-amber-500');
  }
}

function restoreAnnotations() {
  try {
    const saved = encounterAnnotations.get(props.encounterId);
    if (saved) cornerstoneTools.globalImageIdSpecificToolStateManager.restoreToolState(saved.toolState);
  } catch (e) {
    logEvent(props.encounterId, 'Could not restore annotations: ' + e.message, 'border-amber-500');
  }
}

function openStickyNoteForLatestArrow(doneCb) {
  const el = viewportEl.value;
  const state = cornerstoneTools.getToolState(el, 'ArrowAnnotate');
  const latest = state && state.data[state.data.length - 1];
  const point = latest ? latest.handles.end : { x: 0, y: 0 };
  openStickyNote(point, '', doneCb);
}

function openStickyNote(imagePoint, initialText, doneCb) {
  const el = viewportEl.value;
  const canvasPoint = cornerstone.pixelToCanvas(el, imagePoint);
  stickyNote.value = { visible: true, x: canvasPoint.x + 12, y: canvasPoint.y - 8, text: initialText, _onDone: doneCb };
  requestAnimationFrame(() => stickyNoteInputEl.value && stickyNoteInputEl.value.focus());
}

function saveStickyNote() {
  const cb = stickyNote.value._onDone;
  const text = stickyNote.value.text.trim();
  stickyNote.value.visible = false;
  if (cb) cb(text);
  cornerstone.updateImage(viewportEl.value);
  logEvent(props.encounterId, text ? `Added annotation: "${text}".` : 'Annotation label left blank.', 'border-emerald-500');
}

function cancelStickyNote() {
  const cb = stickyNote.value._onDone;
  stickyNote.value.visible = false;
  if (cb) cb(undefined);
  cornerstone.updateImage(viewportEl.value);
}
</script>

<template>
  <div class="flex flex-col p-3">
    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="handleImageUpload" />
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Labs &amp; Imaging</span>
      <button @click="fileInputEl.click()" class="btn-ghost text-xs">+ Add Image</button>
    </div>

    <div class="flex gap-2 overflow-x-auto pb-2 mb-2">
      <div v-for="img in images()" :key="img.id" class="shrink-0 relative group">
        <img :src="img.dataUrl" @click="viewImage(img.id)"
             class="w-16 h-16 object-cover rounded cursor-pointer border-2"
             :class="activeImageId === img.id ? 'border-(--color-primary)' : 'border-transparent'" />
        <button @click="deleteImage(img.id)" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] opacity-0 group-hover:opacity-100 transition">×</button>
      </div>
    </div>

    <div class="cornerstone-viewport" ref="viewport" style="width:100%;height:320px;background:#000;position:relative;overflow:hidden;cursor:grab;border-radius:0.5rem">
      <canvas></canvas>
      <div v-show="stickyNote.visible" :style="`position:absolute;left:${stickyNote.x}px;top:${stickyNote.y}px;z-index:10`" @click.self="cancelStickyNote()">
        <textarea ref="stickyNoteInput" v-model="stickyNote.text" rows="2" placeholder="Type annotation…"
                  class="text-xs p-1.5 rounded border border-(--color-border) bg-white dark:bg-slate-800"
                  @keydown.enter.prevent="saveStickyNote()" @keydown.escape="cancelStickyNote()"></textarea>
      </div>
    </div>

    <div class="flex items-center gap-1.5 mt-2">
      <button @click="setAnnotationTool('Pan')" class="w-7 h-7 rounded text-xs" :class="activeAnnotationTool === 'Pan' ? 'bg-(--color-primary) text-(--color-secondary)' : 'bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'" title="Pan"><i class="fas fa-up-down-left-right"></i></button>
      <button @click="setAnnotationTool('ArrowAnnotate')" class="w-7 h-7 rounded text-xs" :class="activeAnnotationTool === 'ArrowAnnotate' ? 'bg-(--color-primary) text-(--color-secondary)' : 'bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'" title="Arrow annotation"><i class="fas fa-arrow-up-right-from-square"></i></button>
      <button @click="setAnnotationTool('Length')" class="w-7 h-7 rounded text-xs" :class="activeAnnotationTool === 'Length' ? 'bg-(--color-primary) text-(--color-secondary)' : 'bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'" title="Measure length"><i class="fas fa-ruler"></i></button>
      <span class="w-px h-5 bg-(--cf-border) mx-1"></span>
      <button @click="zoomIn()" class="w-7 h-7 rounded text-xs bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300"><i class="fas fa-magnifying-glass-plus"></i></button>
      <button @click="zoomOut()" class="w-7 h-7 rounded text-xs bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300"><i class="fas fa-magnifying-glass-minus"></i></button>
      <button @click="toggleInvert()" class="w-7 h-7 rounded text-xs bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300"><i class="fas fa-circle-half-stroke"></i></button>
      <button @click="resetView()" class="w-7 h-7 rounded text-xs bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300"><i class="fas fa-arrows-rotate"></i></button>
      <button @click="clearAnnotations()" class="w-7 h-7 rounded text-xs bg-slate-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300" title="Clear annotations"><i class="fas fa-eraser"></i></button>
    </div>
  </div>
</template>
