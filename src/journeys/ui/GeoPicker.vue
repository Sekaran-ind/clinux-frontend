<script setup>
// Picks a point: find the address that was typed, tap the map, drag the pin, use the device's
// location, or type the coordinates. v-model is { lat, lng } (numbers) or null.
//
// `address` ({ parts, context, text } from promptForm's addressFor) is what "Find on map" looks up
// (geocode.js): the map zooms to it and drops the pin there, to be adjusted by dragging or tapping.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEFAULT_VIEW, TILE_ATTRIBUTION, TILE_URL } from '../tiles.js';
import { geocode } from '../geocode.js';

const model = defineModel({ type: Object, default: null });
const props = defineProps({
  label: { type: String, default: 'Location' },
  address: { type: Object, default: null },
});

const el = ref(null);
const lat = ref(model.value?.lat ?? '');
const lng = ref(model.value?.lng ?? '');
const status = ref('');
const finding = ref(false);
let map = null;
let marker = null;
let resizeObserver = null;
let search = null;

// A pin (not a dot), drawn with the icon font so no marker images need bundling.
const pin = L.divIcon({ className: 'geo-pin', html: '<i class="fas fa-location-dot"></i>', iconSize: [28, 36], iconAnchor: [14, 34] });

function place(p, { pan = true, zoom = null } = {}) {
  // Read back from `point`, not model.value: with a parent v-model, model.value still holds the
  // parent's old value until it re-renders.
  const point = { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
  model.value = point;
  lat.value = point.lat;
  lng.value = point.lng;
  if (!map) return;
  if (!marker) {
    marker = L.marker([p.lat, p.lng], { icon: pin, draggable: true, keyboard: true, title: 'Facility location (drag to adjust)' }).addTo(map);
    marker.on('dragend', () => place(marker.getLatLng(), { pan: false }));
  } else marker.setLatLng([p.lat, p.lng]);
  if (pan) map.setView([p.lat, p.lng], zoom ?? Math.max(map.getZoom(), 15));
}

function typed() {
  const a = Number(lat.value);
  const b = Number(lng.value);
  if (lat.value !== '' && lng.value !== '' && Math.abs(a) <= 90 && Math.abs(b) <= 180) place({ lat: a, lng: b });
}

function locate() {
  if (!navigator.geolocation) return (status.value = 'This browser cannot share its location.');
  status.value = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      status.value = `Located to within ${Math.round(pos.coords.accuracy)} m. Drag the pin or tap the map to adjust.`;
      place({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    () => (status.value = 'Location was not shared. Tap the map instead.'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

const canFind = computed(() => !!props.address?.text);
async function findAddress() {
  if (!canFind.value || finding.value) return;
  search?.abort();
  search = new AbortController();
  finding.value = true;
  status.value = `Looking up “${props.address.text}”…`;
  try {
    const hit = await geocode(props.address.parts, props.address.context, { signal: search.signal });
    if (!hit) status.value = 'Could not find that address on the map. Check the PIN code, or tap the map to place the pin.';
    else {
      place(hit, { zoom: hit.zoom });
      status.value = hit.note;
    }
  } catch (e) {
    if (e.name !== 'AbortError') status.value = e.message;
  } finally {
    finding.value = false;
  }
}

onMounted(() => {
  map = L.map(el.value, { scrollWheelZoom: false });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  map.on('click', (e) => place(e.latlng, { pan: false }));
  if (model.value) place(model.value);
  // The form pane can be mounted while hidden (the chat/form toggle on phones and tablets):
  // Leaflet sizes itself once, so re-measure whenever the map's box changes.
  resizeObserver = new ResizeObserver(() => map?.invalidateSize());
  resizeObserver.observe(el.value);
});
onBeforeUnmount(() => {
  search?.abort();
  resizeObserver?.disconnect();
  map?.remove();
});
watch(model, (v) => v && (v.lat !== Number(lat.value) || v.lng !== Number(lng.value)) && place(v));
</script>

<template>
  <div class="flex flex-col gap-2">
    <span class="text-xs font-semibold" style="color:var(--text-strong)">{{ label }}</span>
    <div v-if="address" class="flex flex-wrap items-center gap-2">
      <button type="button" class="ui-btn ui-btn-primary" style="padding:.35rem .7rem" :disabled="!canFind || finding" data-testid="geo-find" @click="findAddress">
        <i class="fas" :class="finding ? 'fa-spinner fa-spin' : 'fa-magnifying-glass-location'"></i>Find the address on the map
      </button>
      <span v-if="!canFind" class="text-xs" style="color:var(--shell-text-muted)">Enter the address above first.</span>
    </div>
    <div ref="el" class="picker rounded-xl" role="application" aria-label="Map: tap to set the location"></div>
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 w-32"><span class="text-xs">Latitude</span><input v-model="lat" class="cf-input" inputmode="decimal" aria-label="Latitude" @change="typed" /></label>
      <label class="flex flex-col gap-1 w-32"><span class="text-xs">Longitude</span><input v-model="lng" class="cf-input" inputmode="decimal" aria-label="Longitude" @change="typed" /></label>
      <button type="button" class="ui-btn" style="padding:.35rem .65rem" @click="locate"><i class="fas fa-location-crosshairs"></i>Use my location</button>
    </div>
    <p v-if="status" class="text-xs m-0" style="color:var(--shell-text-muted)" role="status" data-testid="geo-status">{{ status }}</p>
  </div>
</template>

<style scoped>
.picker { height: 260px; border: 1px solid var(--border); z-index: 0; cursor: crosshair; }
.picker :deep(.geo-pin) { color: var(--color-primary, #0f766e); font-size: 32px; line-height: 36px; text-align: center; filter: drop-shadow(0 2px 2px rgba(0, 0, 0, .35)); background: none; border: none; }
@media (prefers-color-scheme: dark) {
  .picker :deep(.leaflet-tile-pane) { filter: brightness(0.72) saturate(0.85); }
}
</style>
