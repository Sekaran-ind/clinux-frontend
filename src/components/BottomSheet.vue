<script setup>
// Generic slide-up sheet for the ClinicHome/Onboarding "edit icon on a section → editor opens,
// Save closes it and the page reflects the change immediately" pattern (no separate preview step
// — explicit instruction). Deliberately content-agnostic, same "chrome vs. content" split
// AdaptiveSectionNav.vue already established for section nav: this component owns the open/close
// mechanics, the overlay, and the slide-up shell — it has zero knowledge of Facility vs. Staff vs.
// Services. The caller passes whatever Host component (or anything else) it wants through the
// default slot; a second, optional `footer` slot holds action buttons (typically Save/Cancel) so
// they stay pinned to the bottom of the sheet instead of scrolling away with a long form.
//
// Built on Reka's Dialog primitives (reka-ui — already this app's own established pattern for
// Tabs/Accordion/Dropdown in AdaptiveSectionNav.vue), not hand-rolled: focus trapping, ESC-to-
// close, outside-click-to-close, and body-scroll-lock all come from the primitive itself, the
// same reasoning that pattern already documents for reusing Reka elsewhere rather than
// reimplementing dialog accessibility by hand.
//
// Device/layout agnostic by design, not by branching into two components: ONE slide-up-from-the-
// bottom animation and interaction model everywhere; only the sheet's own width/height change
// per viewport via CSS (full-width, tall on a phone; centered with a max-width, still
// bottom-anchored, on a wider screen) — same BREAKPOINT_PX (768px) AdaptiveSectionNav.vue's own
// compact/expanded split already uses, for one consistent breakpoint across this app rather than
// a second invented threshold.
//
// Entrance animation (slide up + overlay fade-in) is a plain CSS @keyframes triggered off Reka's
// own [data-state="open"] attribute — the standard Radix-family convention, verified against
// this file's real DialogContent/DialogOverlay render. The matching close/exit slide-down
// depends on Reka's own presence-animation handling of [data-state="closed"] before unmount,
// which this hasn't been checked against a live render — worth confirming once this is wired
// into a real page; if it just unmounts instantly instead, the open animation and all other
// behavior (focus, ESC, outside click, scroll lock) are unaffected either way.
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui';

defineProps({
  title: { type: String, default: '' },
});

const open = defineModel('open', { default: false });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="bts-overlay" />
      <DialogContent class="bts-content">
        <div class="bts-handle" aria-hidden="true"></div>
        <div class="bts-header">
          <DialogTitle class="bts-title">{{ title }}</DialogTitle>
          <DialogClose class="bts-close" aria-label="Close">
            <i class="fas fa-times"></i>
          </DialogClose>
        </div>
        <div class="bts-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="bts-footer">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.bts-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .5);
  z-index: 1000; /* clears this app's own established dialog/dropdown floor — see
                    AdaptiveSectionNav.vue's own z-index header comment for why 1000, not lower */
}
.bts-overlay[data-state="open"] { animation: bts-fade-in .2s ease-out; }

.bts-content {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1001;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--cf-surface, #fff);
  border-radius: 1.25rem 1.25rem 0 0;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, .2);
  outline: none;
}
.bts-content[data-state="open"] { animation: bts-slide-up .28s cubic-bezier(.2, .8, .2, 1); }

/* Same 768px floor AdaptiveSectionNav.vue's own compact/expanded split already uses — one
   sheet, repositioned by CSS, not a second mobile-only component. */
@media (min-width: 768px) {
  .bts-content {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: 100%;
    max-width: 560px;
    max-height: 80vh;
  }
}

.bts-handle {
  width: 2.5rem;
  height: .3rem;
  border-radius: 999px;
  background: var(--cf-border);
  margin: .6rem auto 0;
  flex-shrink: 0;
}
/* Purely a visual affordance (this is a genuine bottom sheet, not a phone-only pattern) — no
   drag-to-dismiss gesture is wired to it; ESC, the close button, and clicking the overlay all
   dismiss the sheet the same way, same as any other Reka Dialog in this app. */

.bts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .75rem 1.25rem;
  flex-shrink: 0;
}
.bts-title { font-size: .95rem; font-weight: 700; color: var(--cf-text-strong); }
.bts-close {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--cf-text);
  font-size: 1.05rem;
  padding: .25rem;
}

.bts-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 1.25rem 1.25rem;
}

.bts-footer {
  flex-shrink: 0;
  padding: .875rem 1.25rem;
  border-top: 1px solid var(--cf-border);
  display: flex;
  justify-content: flex-end;
  gap: .625rem;
}

@keyframes bts-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes bts-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@media (min-width: 768px) {
  @keyframes bts-slide-up {
    from { transform: translateX(-50%) translateY(100%); }
    to { transform: translateX(-50%) translateY(0); }
  }
}
</style>
