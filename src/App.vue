<script setup>
import { useRoute } from 'vue-router';
import { useThemeStore } from './stores/theme.js';
import { useClinicalStore } from './stores/clinical.js';

const theme = useThemeStore();
const route = useRoute();
const clinical = useClinicalStore();

const pageBadge = {
  'front-desk': 'FRONT DESK',
  'consultation-desk': 'AI ENCOUNTER WORKSPACE',
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
          <RouterLink to="/front-desk" class="btn-ghost no-underline flex items-center gap-1.5">
            <i class="fas fa-house text-xs"></i>Front Desk
          </RouterLink>
          <RouterLink to="/consultation-desk" class="btn-ghost no-underline flex items-center gap-1.5">
            <i class="fas fa-stethoscope text-xs"></i>Consultation Desk
          </RouterLink>
          <!-- Was previously unreachable from anywhere in the app except typing the URL
               directly — only shown once there's an active encounter, matching Checkout.vue's
               own "no active encounter" guard for its main content. -->
          <RouterLink v-if="clinical.activeEncounterId" to="/checkout" class="btn-ghost no-underline flex items-center gap-1.5">
            <i class="fas fa-receipt text-xs"></i>Checkout
          </RouterLink>
          <RouterLink to="/" class="btn-ghost no-underline flex items-center gap-1.5">
            <i class="fas fa-arrow-left text-xs"></i>Home
          </RouterLink>
        </div>
      </div>
    </nav>

    <RouterView />
  </div>
</template>
