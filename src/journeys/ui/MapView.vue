<script setup>
// A Leaflet map of OpenStreetMap tiles with a marker per place. Markers are circle markers
// drawn by Leaflet itself, so no marker images need bundling. `selected` pans to that place.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEFAULT_VIEW, TILE_ATTRIBUTION, TILE_URL } from '../tiles.js';

const props = defineProps({
  markers: { type: Array, default: () => [] }, // [{ id, lat, lng, label, detail? }]
  selected: { type: String, default: null },
  height: { type: String, default: '260px' },
});
const emit = defineEmits(['select']);

const el = ref(null);
let map = null;
let layer = null;
let resizeObserver = null;
const byId = new Map();

function color(active) {
  const css = getComputedStyle(document.documentElement);
  return active ? '#b91c1c' : css.getPropertyValue('--color-primary').trim() || '#0f766e';
}

function draw() {
  layer.clearLayers();
  byId.clear();
  const valid = props.markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
  for (const m of valid) {
    const active = m.id === props.selected;
    const marker = L.circleMarker([m.lat, m.lng], { radius: active ? 10 : 7, color: color(active), weight: 2, fillOpacity: 0.55 })
      .bindTooltip(m.label)
      .on('click', () => emit('select', m.id));
    marker.addTo(layer);
    byId.set(m.id, marker);
  }
  if (valid.length === 1) map.setView([valid[0].lat, valid[0].lng], 14);
  else if (valid.length > 1) map.fitBounds(L.latLngBounds(valid.map((m) => [m.lat, m.lng])), { padding: [24, 24], maxZoom: 14 });
  else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
}

onMounted(() => {
  map = L.map(el.value, { scrollWheelZoom: false, attributionControl: true });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  layer = L.layerGroup().addTo(map);
  draw();
  // Mounted inside a pane that may be hidden (chat/form toggle) or a chat bubble still laying out:
  // re-measure whenever the box changes, or the tiles render into a 0×0 viewport.
  resizeObserver = new ResizeObserver(() => map?.invalidateSize());
  resizeObserver.observe(el.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  map?.remove();
});

watch(() => props.markers, () => map && draw(), { deep: true });
watch(
  () => props.selected,
  (id) => {
    if (!map) return;
    draw();
    const m = byId.get(id);
    if (m) map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.6 });
  },
);
</script>

<template>
  <div ref="el" class="map rounded-xl" :style="{ height }" role="region" aria-label="Map"></div>
</template>

<style scoped>
.map { border: 1px solid var(--border); z-index: 0; }
/* OpenStreetMap's tiles are bright; dim them in dark mode rather than glare. */
@media (prefers-color-scheme: dark) {
  .map :deep(.leaflet-tile-pane) { filter: brightness(0.72) saturate(0.85); }
}
</style>
