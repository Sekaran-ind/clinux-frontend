<script setup>
// Shared connection-status control — one component, mounted once in ClinicHome.vue's ops-nav
// (which already wraps Front Desk/Consultation Desk/Checkout, so it's automatically visible on
// all three without duplicating it into each page) and once in the public header, replacing what
// used to be a profile-menu-only toggle nobody saw while actually using the app.
//
// Why this matters enough to be a header-level control, not a buried setting: in Live Server mode
// (the Tauri desktop app's LAN shared server), the Active Sessions list (ActiveSessionsLanding.vue)
// is genuinely common across all three stages — near-real-time sync means whoever's on Front Desk,
// Consultation, and Checkout all see the same encounters. In Local Only mode, each device's local
// TanStack DB is its own island — a session created on one device simply doesn't exist on
// another's until explicitly shared/imported (SessionShareModal/SessionImportModal, the QR/
// text-key transfer from Phase C). Staff need to know which world they're in at a glance, not
// discover it the hard way when a session they expect to see just isn't there.
import { ref, onMounted, onUnmounted } from 'vue';
import { setSyncMode, checkServerHealth, syncNow } from '../data/sharedServerSync.js';

// Branching on this prop (the ACTUAL live-detected state), not the raw stored preference string
// — real bug found live: getSyncMode() defaults to 'server', so a fresh account whose Tauri
// server simply isn't reachable had syncModePref === 'server' even though sharedModeLive was
// false, and "Switch to Live Server" (gated on syncModePref === 'local') never showed at all in
// exactly the situation someone would want it. sharedModeLive is the single source of truth for
// what the buttons below offer; the two are the same info the visible badge already uses, so
// there's no way for the buttons to disagree with what's on screen.
const props = defineProps({ sharedModeLive: { type: Boolean, default: false } });

const open = ref(false);
const checking = ref(false);
const checkFailed = ref(false);
const syncing = ref(false);

async function switchToServer() {
  checking.value = true;
  checkFailed.value = false;
  const healthy = await checkServerHealth();
  checking.value = false;
  if (!healthy) { checkFailed.value = true; return; }
  setSyncMode('server'); // reloads the page — see setSyncMode's own comment for why
}

function switchToLocal() {
  // No health check needed to go local — that's always a safe, always-available operation,
  // unlike enabling something that might not actually be reachable.
  setSyncMode('local');
}

async function handleSyncNow() {
  syncing.value = true;
  try {
    await syncNow();
  } finally {
    syncing.value = false;
  }
}

// No v-click-outside directive ships with core Vue (same reasoning as ClinicHome.vue's own
// identical pattern for its profile-menu dropdown) — a plain document click listener instead.
function closeOnOutsideClick(e) {
  if (!e.target.closest('.connection-status-anchor')) open.value = false;
}
onMounted(() => document.addEventListener('click', closeOnOutsideClick));
onUnmounted(() => document.removeEventListener('click', closeOnOutsideClick));
</script>

<template>
  <div class="connection-status-anchor relative">
    <button
      class="connection-status-badge"
      :class="sharedModeLive ? 'connection-status-live' : 'connection-status-local'"
      @click="open = !open"
    >
      <i class="fas" :class="sharedModeLive ? 'fa-satellite-dish' : 'fa-house-laptop'"></i>
      <span>{{ sharedModeLive ? 'Live Server' : 'Local Only' }}</span>
      <i class="fas fa-chevron-down" style="font-size:0.6rem;opacity:0.6"></i>
    </button>

    <div v-if="open" class="connection-status-dropdown cf-card">
      <p class="text-xs font-bold mb-1" style="color:var(--cf-text-strong)">
        <i class="fas" :class="sharedModeLive ? 'fa-satellite-dish' : 'fa-house-laptop'" :style="sharedModeLive ? 'color:var(--color-primary)' : ''"></i>
        {{ sharedModeLive ? 'Connected to the shared LAN server' : "Local only — this device's own data" }}
      </p>
      <p class="text-xs mb-3" style="color:var(--cf-text)">
        {{ sharedModeLive
          ? 'Sessions and staff data sync across every device on this network.'
          : "Sessions created here won't show up on other devices unless shared or imported." }}
      </p>

      <template v-if="sharedModeLive">
        <button class="btn-outline text-xs w-full mb-1.5" @click="switchToLocal()">
          <i class="fas fa-house-laptop"></i> Switch to Local Only
        </button>
        <button class="btn-outline text-xs w-full" :disabled="syncing" @click="handleSyncNow()">
          <i class="fas" :class="syncing ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
          {{ syncing ? 'Syncing...' : 'Sync Now' }}
        </button>
      </template>
      <template v-else>
        <button
          class="btn-outline text-xs w-full"
          :disabled="checking"
          @click="switchToServer()"
        >
          <i class="fas" :class="checking ? 'fa-spinner fa-spin' : 'fa-satellite-dish'"></i>
          {{ checking ? 'Checking server...' : 'Switch to Live Server' }}
        </button>
        <p v-if="checkFailed" class="text-xs mt-1.5" style="color:#b91c1c">
          <i class="fas fa-circle-exclamation mr-1"></i>Live server not reachable right now — staying on Local Only.
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.connection-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.4rem 0.65rem;
  border-radius: 0.5rem;
  border: 1px solid var(--cf-border);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}
.connection-status-live {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: rgba(0, 212, 178, 0.08);
}
.connection-status-local {
  color: var(--cf-text);
}
.connection-status-dropdown {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  width: 260px;
  padding: 0.875rem;
  border-radius: 0.75rem;
  z-index: 50;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
</style>
