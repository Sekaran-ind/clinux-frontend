<script setup>
// SPEC-24 §5 — one shared responsive navigation shell, replacing per-surface reinvention: two
// real, live, separately-hand-rolled mobile adaptations already exist for this exact problem
// (Cübo's own `threePaneMobileView` sub-tab strip and its FAB/MODAL_DOCK toggle buttons; see the
// spec doc) before this component existed. Retrofitting Cübo onto this is its own later pass
// (spec §7 item 8) — this build proves the shell on the entity editor first.
//
// Owns navigation CHROME only. Section content is always hand-authored by the caller via a named
// scoped slot per section id — exactly TeamSettingsModal.vue's own v-if/v-else style, just with
// the chrome that switches between them made shared and reusable instead of copied per surface
// (the actual fix for "CustomFormHost is a duplicate of lhcforms": the field-rendering half was
// never the reusable part, only the chrome around it is).
//
// Below the app's own `md:` (768px) breakpoint every mode collapses to one content area plus a
// "⋮" dropdown listing sections (spec's own explicit instruction — tabs/accordion grouping eats
// too much space on a phone, a corner context menu doesn't). At/above it, renders the caller's
// requested chrome via the matching Reka UI primitive: `sidebar` is a plain vertical button list,
// not Reka's NavigationMenuRoot (that primitive is built for hover-flyout mega-menus — the wrong
// fit for a static in-panel list, per the spec's own note).
//
// A genuine reading call, flagged rather than silently made: the spec text says a chosen mode is
// "persisted per-component-instance... defaulting to tabs" but never describes a control for
// choosing it. Interpreted here as: the same "⋮" affordance the spec already asks for (repurposed
// above the breakpoint, where it isn't needed for section-picking — a tab/sidebar/accordion bar
// already does that job there) offers "Display as" when the caller's own `mode` hint isn't
// 'panes' (Cübo's fixed simultaneous case, never user-switchable — see adaptiveSectionNav.js).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  TabsRoot, TabsList, TabsTrigger, TabsContent,
  AccordionRoot, AccordionItem, AccordionHeader, AccordionTrigger, AccordionContent,
  DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent, DropdownMenuItem,
} from 'reka-ui';
import {
  BREAKPOINT_PX, SWITCHABLE_MODES, resolveViewport, resolveEffectiveMode, resolveActiveId,
  loadStoredMode, saveStoredMode,
} from './adaptiveSectionNav.js';

const props = defineProps({
  sections: { type: Array, required: true }, // [{ id, label, icon?, badge? }] — badge is an optional short status string (e.g. "3 added"), rendered next to the label in every mode; omit for a plain section.
  mode: { type: String, default: 'tabs' }, // 'tabs' | 'sidebar' | 'accordion' | 'panes' — a hint, see header
  storageKey: { type: String, required: true }, // unique per component instance on the page
});

const activeId = defineModel('activeId', { default: null });

const storedMode = ref(loadStoredMode(props.storageKey));
const effectiveMode = computed(() => resolveEffectiveMode({ propMode: props.mode, storedMode: storedMode.value }));
const modeIsSwitchable = computed(() => props.mode !== 'panes');

function chooseMode(next) {
  storedMode.value = next;
  saveStoredMode(props.storageKey, next);
}

// matchMedia, not a resize listener — fires only when the compact/expanded boundary is actually
// crossed, and (unlike a bare `window.innerWidth` read) works the same in a Tauri/Capacitor
// WebView as it does in a desktop browser tab.
const viewport = ref('expanded');
let mql;
function syncViewport() { viewport.value = resolveViewport(window.innerWidth, BREAKPOINT_PX); }
onMounted(() => {
  mql = window.matchMedia(`(min-width: ${BREAKPOINT_PX}px)`);
  syncViewport();
  mql.addEventListener('change', syncViewport);
});
onBeforeUnmount(() => { mql?.removeEventListener('change', syncViewport); });

watch(
  () => props.sections,
  (sections) => { activeId.value = resolveActiveId(sections, activeId.value); },
  { immediate: true },
);
</script>

<template>
  <div class="adaptive-section-nav">
    <!-- Compact: single content area + a "⋮" section picker. -->
    <template v-if="viewport === 'compact'">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-bold flex items-center gap-2" style="color:var(--cf-text-strong)">
          {{ sections.find((s) => s.id === activeId)?.label }}
          <span v-if="sections.find((s) => s.id === activeId)?.badge" class="badge" :class="sections.find((s) => s.id === activeId)?.badgeTone === 'teal' ? 'badge-teal' : 'badge-muted'">{{ sections.find((s) => s.id === activeId)?.badge }}</span>
        </span>
        <DropdownMenuRoot>
          <DropdownMenuTrigger class="btn-ghost text-xs px-2 py-1" aria-label="Choose a section">
            <i class="fas fa-ellipsis-vertical"></i>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="cf-card rounded-xl p-1 adaptive-nav-menu" style="z-index:1000" :side-offset="4" align="end">
              <DropdownMenuItem
                v-for="section in sections"
                :key="section.id"
                class="text-xs px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between gap-3"
                :style="section.id === activeId ? 'color:var(--color-primary);font-weight:600' : 'color:var(--cf-text)'"
                @select="activeId = section.id"
              >
                <span><i v-if="section.icon" class="fas mr-2" :class="section.icon"></i>{{ section.label }}</span>
                <span v-if="section.badge" class="badge" :class="section.badgeTone === 'teal' ? 'badge-teal' : 'badge-muted'">{{ section.badge }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
      <div>
        <slot :name="activeId" />
      </div>
    </template>

    <!-- Expanded, panes: every section shown simultaneously (Cübo's own case). -->
    <template v-else-if="effectiveMode === 'panes'">
      <div class="adaptive-section-nav-panes">
        <div v-for="section in sections" :key="section.id">
          <div class="text-xs font-bold mb-2" style="color:var(--cf-text-strong)">
            <i v-if="section.icon" class="fas mr-1" :class="section.icon"></i>{{ section.label }}
          </div>
          <slot :name="section.id" />
        </div>
      </div>
    </template>

    <!-- Expanded, tabs. -->
    <template v-else-if="effectiveMode === 'tabs'">
      <div class="flex items-center justify-between mb-3">
        <TabsRoot v-model="activeId" class="flex-1">
          <TabsList class="flex gap-1" style="border-bottom:1px solid var(--cf-border)">
            <TabsTrigger
              v-for="section in sections"
              :key="section.id"
              :value="section.id"
              class="text-xs font-bold px-3 py-2 flex items-center gap-2"
              :style="section.id === activeId ? 'color:var(--color-primary);border-bottom:2px solid var(--color-primary)' : 'color:var(--cf-text)'"
            >
              <span><i v-if="section.icon" class="fas mr-1" :class="section.icon"></i>{{ section.label }}</span>
              <span v-if="section.badge" class="badge" :class="section.badgeTone === 'teal' ? 'badge-teal' : 'badge-muted'">{{ section.badge }}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent v-for="section in sections" :key="section.id" :value="section.id" class="mt-3">
            <slot :name="section.id" />
          </TabsContent>
        </TabsRoot>
        <span v-if="modeIsSwitchable" class="ml-2">
          <DropdownMenuRoot>
            <DropdownMenuTrigger class="btn-ghost text-xs px-2 py-1" aria-label="Change display">
              <i class="fas fa-ellipsis-vertical"></i>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="cf-card rounded-xl p-1 adaptive-nav-menu" style="z-index:1000" :side-offset="4" align="end">
                <DropdownMenuItem
                  v-for="option in SWITCHABLE_MODES"
                  :key="option"
                  class="text-xs px-3 py-2 rounded-lg cursor-pointer capitalize"
                  :style="option === effectiveMode ? 'color:var(--color-primary);font-weight:600' : 'color:var(--cf-text)'"
                  @select="chooseMode(option)"
                >{{ option }}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
        </span>
      </div>
    </template>

    <!-- Expanded, sidebar: a plain button list (not NavigationMenuRoot — see header). -->
    <template v-else-if="effectiveMode === 'sidebar'">
      <div class="flex gap-4">
        <div class="flex flex-col gap-1" style="min-width:160px">
          <button
            v-for="section in sections"
            :key="section.id"
            class="text-left text-xs font-bold px-3 py-2 rounded-lg flex items-center justify-between gap-2"
            :style="section.id === activeId ? 'color:var(--color-primary);background:color-mix(in srgb, var(--color-primary) 12%, transparent)' : 'color:var(--cf-text)'"
            @click="activeId = section.id"
          >
            <span><i v-if="section.icon" class="fas mr-2" :class="section.icon"></i>{{ section.label }}</span>
            <span v-if="section.badge" class="badge" :class="section.badgeTone === 'teal' ? 'badge-teal' : 'badge-muted'">{{ section.badge }}</span>
          </button>
          <DropdownMenuRoot v-if="modeIsSwitchable">
            <DropdownMenuTrigger class="btn-ghost text-xs px-3 py-2 text-left" aria-label="Change display">
              <i class="fas fa-ellipsis-vertical mr-2"></i>Display
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="cf-card rounded-xl p-1 adaptive-nav-menu" style="z-index:1000" :side-offset="4" align="start">
                <DropdownMenuItem
                  v-for="option in SWITCHABLE_MODES"
                  :key="option"
                  class="text-xs px-3 py-2 rounded-lg cursor-pointer capitalize"
                  :style="option === effectiveMode ? 'color:var(--color-primary);font-weight:600' : 'color:var(--cf-text)'"
                  @select="chooseMode(option)"
                >{{ option }}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
        </div>
        <div class="flex-1 min-w-0">
          <slot :name="activeId" />
        </div>
      </div>
    </template>

    <!-- Expanded, accordion. -->
    <template v-else>
      <div class="flex items-center justify-end mb-2">
        <DropdownMenuRoot v-if="modeIsSwitchable">
          <DropdownMenuTrigger class="btn-ghost text-xs px-2 py-1" aria-label="Change display">
            <i class="fas fa-ellipsis-vertical"></i>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="cf-card rounded-xl p-1 adaptive-nav-menu" style="z-index:1000" :side-offset="4" align="end">
              <DropdownMenuItem
                v-for="option in SWITCHABLE_MODES"
                :key="option"
                class="text-xs px-3 py-2 rounded-lg cursor-pointer capitalize"
                :style="option === effectiveMode ? 'color:var(--color-primary);font-weight:600' : 'color:var(--cf-text)'"
                @select="chooseMode(option)"
              >{{ option }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
      <AccordionRoot v-model="activeId" type="single" collapsible class="flex flex-col gap-1">
        <AccordionItem v-for="section in sections" :key="section.id" :value="section.id" class="cf-card rounded-xl overflow-hidden">
          <AccordionHeader>
            <AccordionTrigger class="w-full text-left text-xs font-bold px-3 py-2 flex items-center justify-between" style="color:var(--cf-text-strong)">
              <span><i v-if="section.icon" class="fas mr-2" :class="section.icon"></i>{{ section.label }}</span>
              <span class="flex items-center gap-2">
                <span v-if="section.badge" class="badge" :class="section.badgeTone === 'teal' ? 'badge-teal' : 'badge-muted'">{{ section.badge }}</span>
                <i class="fas fa-chevron-down text-xs" style="color:var(--cf-text)"></i>
              </span>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionContent class="px-3 pb-3">
            <slot :name="section.id" />
          </AccordionContent>
        </AccordionItem>
      </AccordionRoot>
    </template>
  </div>
</template>

<style scoped>
/* Real bug found live (Playwright-driven check of the mode-switcher, SPEC-24 §7 step 5): Reka's
   DropdownMenuPortal teleports DropdownMenuContent to the end of document.body with no z-index of
   its own. A positioned ancestor with an EXPLICIT z-index (e.g. Onboarding.vue's own .drawer-panel
   at z-index:101) then paints ABOVE it regardless of DOM order — the menu rendered, fully visible
   in a screenshot, and still silently swallowed every click; a plain "add a scoped z-index class"
   fix looked right and DID NOT WORK — confirmed via getComputedStyle that the class landed with
   position:static/z-index:auto. Vue's scoped-CSS data-v attribute is applied to elements written
   directly in THIS template; DropdownMenuContent's own rendered DOM root is Reka's, one layer
   further in, and does not carry it through the teleport. The real fix is inline `style` on the
   component itself (Reka forwards style/class the same way any wrapped root does) — see the four
   `style="z-index:1000"` occurrences on DropdownMenuContent above; this scoped rule is kept only
   as harmless documentation/belt-and-suspenders for the (non-teleported) inner elements sharing
   the class, not as the actual fix. 1000 comfortably clears every z-index already in
   src/style.css (the highest today is 9999 on an unrelated fixed banner; this only needs to beat
   this app's various drawer/modal layers, not that one). */
.adaptive-nav-menu { z-index: 1000; }
</style>
