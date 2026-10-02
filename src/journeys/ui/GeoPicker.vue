<script setup>
// Picks a point: tap the map, use the device's location, or type the coordinates.
// v-model is { lat, lng } (numbers) or null.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEFAULT_VIEW, TILE_ATTRIBUTION, TILE_URL } from '../tiles.js';

const model = defineModel({ type: Object, default: null });
defineProps({ label: { type: String, default: 'Location' } });

const el = ref(null);
const lat = ref(model.value?.lat ?? '');
const lng = ref(model.value?.lng ?? '');
const status = ref('');
let map = null;
let marker = null;

const primary = () => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#0f766e';

function place(p, pan = true) {
  // Read back from `point`, not model.value: with a parent v-model, model.value still holds the
  // parent's old value until it re-renders.
  const point = { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
  model.value = point;
  lat.value = point.lat;
  lng.value = point.lng;
  if (!map) return;
  if (!marker) marker = L.circleMarker([p.lat, p.lng], { radius: 9, color: primary(), weight: 2, fillOpacity: 0.6 }).addTo(map);
  else marker.setLatLng([p.lat, p.lng]);
  if (pan) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
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
      status.value = `Located to within ${Math.round(pos.coords.accuracy)} m. Drag the map and tap to adjust.`;
      place({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    () => (status.value = 'Location was not shared. Tap the map instead.'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

onMounted(() => {
  map = L.map(el.value, { scrollWheelZoom: false });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  map.on('click', (e) => place(e.latlng, false));
  if (model.value) place(model.value);
});
onBeforeUnmount(() => map?.remove());
watch(model, (v) => v && (v.lat !== Number(lat.value) || v.lng !== Number(lng.value)) && place(v));
</script>

<template>
  <div class="flex flex-col gap-2">
    <span class="text-xs font-semibold" style="color:var(--text-strong)">{{ label }}</span>
    <div ref="el" class="picker rounded-xl" role="application" aria-label="Map: tap to set the location"></div>
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 w-32"><span class="text-xs">Latitude</span><input v-model="lat" class="cf-input" inputmode="decimal" aria-label="Latitude" @change="typed" /></label>
      <label class="flex flex-col gap-1 w-32"><span class="text-xs">Longitude</span><input v-model="lng" class="cf-input" inputmode="decimal" aria-label="Longitude" @change="typed" /></label>
      <button type="button" class="ui-btn" style="padding:.35rem .65rem" @click="locate"><i class="fas fa-location-crosshairs"></i>Use my location</button>
    </div>
    <p v-if="status" class="text-xs m-0" style="color:var(--shell-text-muted)" role="status">{{ status }}</p>
  </div>
</template>

<style scoped>
.picker { height: 240px; border: 1px solid var(--border); z-index: 0; cursor: crosshair; }
@media (prefers-color-scheme: dark) {
  .picker :deep(.leaflet-tile-pane) { filter: brightness(0.72) saturate(0.85); }
}
</style>
