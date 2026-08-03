import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

// Replaces Alpine.store('theme') from clinixflow's public/js/store.js. Dark mode is a single
// UI preference, not a data record — kept as plain Pinia + localStorage rather than a full
// TanStack DB collection (see the "State split" note in src/data/collections for the general rule).
// Setup-store syntax (function form) so the localStorage persistence + <html class="dark"> toggle
// can live as a plain `watch` side effect, same idea as Alpine's :class="isDark ? 'dark' : ''"
// binding but expressed as an explicit effect instead of a template binding.
export const useThemeStore = defineStore('theme', () => {
  const isDark = ref(
    localStorage.getItem('cf_dark') === 'true'
      || window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  watch(isDark, (val) => {
    document.documentElement.classList.toggle('dark', val);
    localStorage.setItem('cf_dark', val ? 'true' : 'false');
  }, { immediate: true });

  function toggle() {
    isDark.value = !isDark.value;
  }

  return { isDark, toggle };
});
