<script setup>
// A select with a search box, for long option lists (HFR's districts, sub-districts, facility
// types, ...). Type to filter, arrow keys to move, Enter to pick, Escape to close. v-model is the
// option's value, the same as the plain <select> it replaces.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const model = defineModel({ type: [String, Number], default: '' });
const props = defineProps({
  options: { type: Array, default: () => [] }, // [{ value, label }]
  id: { type: String, default: undefined },
  placeholder: { type: String, default: 'Choose…' },
});

const root = ref(null);
const input = ref(null);
const open = ref(false);
const query = ref('');
const active = ref(0);

const selected = computed(() => props.options.find((o) => o.value === model.value) || null);
const norm = (s) => String(s ?? '').toLowerCase();
const filtered = computed(() => {
  const q = norm(query.value).trim();
  if (!q) return props.options;
  // Labels starting with the text first, then any containing it.
  const starts = [];
  const contains = [];
  for (const o of props.options) {
    const l = norm(o.label);
    if (l.startsWith(q)) starts.push(o);
    else if (l.includes(q) || norm(o.value) === q) contains.push(o);
  }
  return [...starts, ...contains];
});
watch(query, () => (active.value = 0));

function show() {
  if (open.value) return;
  open.value = true;
  query.value = '';
  active.value = Math.max(0, filtered.value.findIndex((o) => o.value === model.value));
  nextTick(scrollActive);
}
function pick(o) {
  model.value = o.value;
  open.value = false;
  query.value = '';
}
function scrollActive() {
  root.value?.querySelector(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}
function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) return show();
    const n = filtered.value.length;
    if (n) active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    nextTick(scrollActive);
  } else if (e.key === 'Enter') {
    if (open.value && filtered.value[active.value]) {
      e.preventDefault(); // don't submit the form
      pick(filtered.value[active.value]);
    }
  } else if (e.key === 'Escape') {
    open.value = false;
  } else if (e.key === 'Tab') {
    open.value = false;
  }
}
function onOutside(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false;
}
onMounted(() => document.addEventListener('click', onOutside));
onBeforeUnmount(() => document.removeEventListener('click', onOutside));

const shown = computed(() => (open.value ? query.value : selected.value?.label || ''));
</script>

<template>
  <div ref="root" class="ss">
    <input
      :id="id"
      ref="input"
      class="cf-input ss-input"
      role="combobox"
      autocomplete="off"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      :aria-activedescendant="open && filtered[active] ? `${id}-opt-${active}` : undefined"
      :placeholder="open ? (selected?.label || 'Type to search…') : placeholder"
      :value="shown"
      @focus="show"
      @click="show"
      @input="query = $event.target.value; open = true"
      @keydown="onKey"
    />
    <i class="fas ss-icon" :class="open ? 'fa-magnifying-glass' : 'fa-chevron-down'" aria-hidden="true"></i>
    <ul v-show="open" :id="`${id}-list`" class="ss-list" role="listbox">
      <li
        v-for="(o, i) in filtered"
        :id="`${id}-opt-${i}`"
        :key="o.value"
        :data-index="i"
        role="option"
        :aria-selected="o.value === model"
        :class="{ active: i === active, chosen: o.value === model }"
        @mousedown.prevent="pick(o)"
        @mouseenter="active = i"
      >{{ o.label }}<i v-if="o.value === model" class="fas fa-check"></i></li>
      <li v-if="!filtered.length" class="ss-empty">No match for “{{ query }}”</li>
    </ul>
  </div>
</template>

<style scoped>
.ss { position: relative; }
.ss-input { width: 100%; padding-right: 2rem; }
.ss-icon { position: absolute; right: .75rem; top: 50%; transform: translateY(-50%); font-size: .7rem; color: var(--shell-text-muted); pointer-events: none; }
.ss-list { position: absolute; z-index: 40; left: 0; right: 0; top: calc(100% + .25rem); max-height: 240px; overflow-y: auto; margin: 0; padding: .25rem; list-style: none; background: var(--shell-surface); border: 1px solid var(--shell-border); border-radius: .5rem; box-shadow: 0 12px 28px -8px rgba(0, 0, 0, .25); }
.ss-list li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .45rem .6rem; border-radius: .375rem; font-size: .82rem; color: var(--shell-text-strong); cursor: pointer; }
.ss-list li.active { background: var(--shell-hover); }
.ss-list li.chosen { font-weight: 600; color: var(--color-primary-text); }
.ss-list li i { font-size: .7rem; }
.ss-list .ss-empty { color: var(--shell-text-muted); cursor: default; }
</style>
