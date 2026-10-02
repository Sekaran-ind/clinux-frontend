import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

// Replaces Alpine.store('theme') from clinixflow's public/js/store.js. Theme is a UI preference,
// not a data record — kept as plain Pinia + localStorage rather than a full TanStack DB
// collection (see the "State split" note in src/data/collections for the general rule).
//
// Two independent preferences (Swastik-style app shell rework):
//   mode   — 'light' | 'dark' | 'system' (the top bar's 3-way segmented control). 'system'
//            follows prefers-color-scheme live, not just once at load.
//   accent — one of ACCENTS below, applied as <html data-theme="..."> — style.css defines each
//            one's --color-primary/--color-on-primary/etc. token set, so every component that
//            already reads var(--color-primary) picks it up with no per-component changes.
// isDark/toggle() are kept with their old meaning so the pages that already call them
// (Index, the public ClinicHome page, Designer's Ace theme switch) keep working unchanged.
export const ACCENTS = [
  { id: 'teal', label: 'Teal', swatch: '#00D4B2' },
  { id: 'indigo', label: 'Indigo', swatch: '#4F46E5' },
  { id: 'ocean', label: 'Ocean', swatch: '#0284C7' },
  { id: 'saffron', label: 'Saffron', swatch: '#EA580C' },
];
const ACCENT_IDS = ACCENTS.map((a) => a.id);
const MODES = ['light', 'dark', 'system'];

function initialMode() {
  const saved = localStorage.getItem('cf_theme_mode');
  if (MODES.includes(saved)) return saved;
  // Pre-rework installs only stored cf_dark — honor it rather than resetting their choice.
  const legacy = localStorage.getItem('cf_dark');
  if (legacy === 'true') return 'dark';
  if (legacy === 'false') return 'light';
  return 'system';
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref(initialMode());
  const savedAccent = localStorage.getItem('cf_theme_accent');
  const accent = ref(ACCENT_IDS.includes(savedAccent) ? savedAccent : 'teal');

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const systemDark = ref(media.matches);
  media.addEventListener?.('change', (e) => { systemDark.value = e.matches; });

  const isDark = computed(() => (mode.value === 'system' ? systemDark.value : mode.value === 'dark'));

  watch(isDark, (val) => {
    document.documentElement.classList.toggle('dark', val);
  }, { immediate: true });

  watch(mode, (val) => {
    localStorage.setItem('cf_theme_mode', val);
    localStorage.setItem('cf_dark', isDark.value ? 'true' : 'false');
  });

  watch(accent, (val) => {
    document.documentElement.dataset.theme = val;
    localStorage.setItem('cf_theme_accent', val);
  }, { immediate: true });

  function setMode(val) {
    if (MODES.includes(val)) mode.value = val;
  }

  function setAccent(val) {
    if (ACCENT_IDS.includes(val)) accent.value = val;
  }

  // Old single-button toggle: flips to an explicit light/dark (leaves 'system').
  function toggle() {
    mode.value = isDark.value ? 'light' : 'dark';
  }

  return { mode, accent, isDark, setMode, setAccent, toggle };
});
