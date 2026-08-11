<script setup>
import { useRoute, useRouter } from 'vue-router';
import { useThemeStore } from './stores/theme.js';
import { homeDestination } from './router/homeDestination.js';

const theme = useThemeStore();
const route = useRoute();
const router = useRouter();

// "Home" goes to the clinic's own published page once it's registered, matching Index.vue's own
// goToClinic() check (cf_clinic_profile) — see clinux-unified-header-and-home-routing memory
// note. A function (not a reactive :to binding) since cf_clinic_profile is plain localStorage,
// not a reactive store — same "compute at click time" convention Index.vue's goToClinic() uses.
function goHome() {
  router.push(homeDestination(!!localStorage.getItem('cf_clinic_profile')));
}

// front-desk/consultation-desk keys removed — those pages are no longer their own routes, see
// clinux-frontdesk-consultation-checkout-as-clinic-home-components memory note.
const pageBadge = {
  'onboarding-abdm': 'ABDM ONBOARDING',
  'designer': 'ROOM ARCHITECT',
};
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- index.html's route renders its own full marketing nav (see Index.vue) — this shared
         "app shell" nav is for every clinical-workflow page, matching the simple "logo + badge +
         dark toggle + back link" nav those pages already used individually. -->
    <nav v-if="!route.meta.hideAppNav" class="cf-nav sticky top-0 z-40">
      <div class="max-w-[1300px] mx-auto px-6 h-14 flex items-center justify-between">
        <RouterLink to="/" class="flex items-center gap-2.5 no-underline">
          <!-- <div class="bg-(--color-primary) text-(--color-secondary) font-black font-mono rounded shadow-lg" style="font-size:.85rem;line-height:1;padding:.35rem .5rem">Cü</div> -->
          <div class="bg-(--color-primary) text-(--color-secondary) font-black font-mono rounded shadow-lg" style="font-size:.85rem;line-height:1;padding:.35rem .5rem"></div>
          <span style="font-family:'Poppins',sans-serif;font-weight:700;font-size:1rem;color:var(--cf-text-strong)">Clinüx<span style="color:var(--color-primary)">Flow</span></span>
          <span class="badge badge-teal">{{ pageBadge[route.name] || 'CLINUX FRONTEND' }}</span>
        </RouterLink>
        <div class="flex items-center gap-2.5">
          <button @click="theme.toggle()" class="w-[34px] h-[34px] rounded-lg flex items-center justify-center cursor-pointer" style="border:1px solid var(--cf-border);background:var(--cf-bg-alt);color:var(--cf-text)">
            <i :class="theme.isDark ? 'fas fa-sun' : 'fas fa-moon'" style="font-size:.78rem"></i>
          </button>
          <!-- Front Desk/Consultation Desk/Checkout are no longer their own routes — all three
               are views inside Clinic Home now (see
               clinux-frontdesk-consultation-checkout-as-clinic-home-components memory note).
               One link stands in for the 3 that used to be here; full nav redesign is a separate,
               later phase (see clinux-unified-header-and-home-routing). -->
          <RouterLink to="/clinic-home" class="btn-ghost no-underline flex items-center gap-1.5">
            <i class="fas fa-house text-xs"></i>Clinic Home
          </RouterLink>
          <button class="btn-ghost flex items-center gap-1.5" @click="goHome()">
            <i class="fas fa-arrow-left text-xs"></i>Home
          </button>
        </div>
      </div>
    </nav>

    <RouterView />
  </div>
</template>
