<script setup>
// The signed-in app shell — an admin-console layout modeled on the Swastik ABDM Connector:
// a fixed, grouped left sidebar (brand on top, the clinic/account card at the bottom) and a slim
// sticky top bar (connection mode, team chat, theme menu, profile menu). App.vue wraps every
// signed-in page in this; the public pages (Index, ClinicHome's public view) keep their own nav.
//
// The top bar is 56px on purpose — Cubo.vue's THREE_PANE layout sizes itself as
// calc(100vh - 56px), which was App.vue's old nav height.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth.js';
import { useClinicalStore } from '../../stores/clinical.js';
import { useClinicViewStore } from '../../stores/clinicView.js';
import { useEntryWorkflowStore } from '../../stores/entryWorkflow.js';
import { useThemeStore, ACCENTS } from '../../stores/theme.js';
import { ensureSharedModeDetected } from '../../data/sharedServerSync.js';
import ConnectionStatusControl from '../ConnectionStatusControl.vue';
import TeamChat from '../TeamChat.vue';
import SiteFooter from '../SiteFooter.vue';
import { useConsentStore } from '../../stores/consent.js';
import { buildNavGroups, activeNavKey, runsFacility, ROLE_LABELS } from './appNav.js';

// chrome=false renders the page bare (no sidebar/top bar) — used for the public surfaces. The
// default slot stays at the same position in the tree either way, so a page that flips between
// the two (ClinicHome: public page <-> Front Desk) is never remounted by the switch.
defineProps({ chrome: { type: Boolean, default: true } });

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const clinical = useClinicalStore();
const clinicView = useClinicViewStore();
const entryWorkflow = useEntryWorkflowStore();
const theme = useThemeStore();

const user = computed(() => auth.currentUser || {});
const groups = computed(() => buildNavGroups({ role: user.value.role, hasActiveEncounter: !!clinical.activeEncounterId }));
const activeKey = computed(() => activeNavKey(groups.value, { routePath: route.path, routeName: route.name, clinicView: clinicView.view }));
const activeItem = computed(() => groups.value.flatMap((g) => g.items).find((i) => i.key === activeKey.value));

const displayName = computed(() => user.value.adminName || user.value.email || 'Your account');
const initials = computed(() => {
  const parts = String(displayName.value).replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || 'U';
});
const roleLabel = computed(() => ROLE_LABELS[user.value.role] || 'Member');

function select(item) {
  if (item.disabled) return;
  sidebarOpen.value = false;
  if (item.view) {
    if (route.name === 'clinic-home') {
      clinicView.setView(item.view);
    } else {
      clinicView.arriveAt(item.view);
      router.push('/clinic-home');
    }
  } else if (item.to && item.to !== route.path) {
    router.push(item.to);
  }
}

// Mobile: the sidebar becomes an off-canvas drawer behind the hamburger.
const sidebarOpen = ref(false);
watch(() => route.fullPath, () => { sidebarOpen.value = false; });

// Same live-detected value ClinicHome passes ConnectionStatusControl (see that component's own
// comment on why it branches on the detected state, not the stored preference).
const sharedModeLive = ref(false);
ensureSharedModeDetected().then((active) => { sharedModeLive.value = active; });

const teamChatOpen = ref(false);

const themeMenuOpen = ref(false);
const userMenuOpen = ref(false);
function closeMenusOnOutsideClick(e) {
  if (!e.target.closest('.theme-menu-anchor')) themeMenuOpen.value = false;
  if (!e.target.closest('.user-menu-anchor')) userMenuOpen.value = false;
}
onMounted(() => document.addEventListener('click', closeMenusOnOutsideClick));
onUnmounted(() => document.removeEventListener('click', closeMenusOnOutsideClick));

const MODE_OPTIONS = [
  { id: 'light', icon: 'fa-sun', label: 'Light' },
  { id: 'dark', icon: 'fa-moon', label: 'Dark' },
  { id: 'system', icon: 'fa-desktop', label: 'System' },
];

const consentStore = useConsentStore();

function signOut() {
  userMenuOpen.value = false;
  entryWorkflow.logout();
  consentStore.reset();
  clinicView.setView('public');
  router.push('/');
}
</script>

<template>
  <div :class="chrome ? 'app-shell' : 'min-h-screen flex flex-col'">
    <template v-if="chrome">
      <div class="app-backdrop" :class="{ open: sidebarOpen }" @click="sidebarOpen = false"></div>
      <aside class="app-sidebar" :class="{ open: sidebarOpen }">
        <RouterLink to="/" class="app-sidebar-brand">
          <div class="app-sidebar-logo">CÜ</div>
          <div>
            <div class="app-sidebar-name">ClinüxFlow</div>
            <div class="app-sidebar-sub">Clinic workspace</div>
          </div>
        </RouterLink>

        <nav class="app-sidebar-scroll" aria-label="Main">
          <div v-for="group in groups" :key="group.label" class="app-nav-group">
            <div class="app-nav-label">{{ group.label }}</div>
            <button
              v-for="item in group.items" :key="item.key"
              type="button"
              class="app-nav-item"
              :class="{ active: item.key === activeKey }"
              :disabled="item.disabled"
              :title="item.hint || ''"
              :aria-current="item.key === activeKey ? 'page' : undefined"
              @click="select(item)"
            >
              <i class="fas" :class="item.icon"></i>
              <span>{{ item.label }}</span>
              <span v-if="item.badge" class="app-nav-badge">{{ item.badge }}</span>
            </button>
          </div>
        </nav>

        <div class="app-sidebar-footer">
          <RouterLink :to="runsFacility(user.role) ? '/onboarding' : '/staff-onboarding'" class="app-org-card" title="Edit profile">
            <div class="app-avatar" style="border-radius:.375rem">{{ (user.clinicName || displayName).charAt(0).toUpperCase() }}</div>
            <div style="min-width:0;flex:1">
              <div class="org-name">{{ user.clinicName || displayName }}</div>
              <div class="org-role">{{ roleLabel }}</div>
            </div>
            <i class="fas fa-chevron-right" style="font-size:.6rem;color:var(--shell-text-muted)"></i>
          </RouterLink>
        </div>
      </aside>
    </template>

    <div :class="chrome ? 'app-main' : 'flex-1 flex flex-col'">
      <header v-if="chrome" class="app-topbar">
        <div style="display:flex;align-items:center;gap:.625rem;min-width:0">
          <button class="app-icon-btn app-hamburger" aria-label="Open menu" @click.stop="sidebarOpen = !sidebarOpen"><i class="fas fa-bars"></i></button>
          <span class="app-topbar-title">{{ activeItem?.label || '' }}</span>
        </div>

        <div class="app-topbar-actions">
          <ConnectionStatusControl :shared-mode-live="sharedModeLive" />
          <button class="app-icon-btn" title="Team chat" @click="teamChatOpen = true"><i class="fas fa-comment-dots"></i></button>

          <div class="theme-menu-anchor" style="position:relative">
            <button class="app-icon-btn" title="Theme" :aria-expanded="themeMenuOpen" @click="themeMenuOpen = !themeMenuOpen"><i class="fas fa-palette"></i></button>
            <div v-show="themeMenuOpen" class="app-menu" style="padding:.875rem;min-width:236px">
              <div class="app-nav-label" style="padding:0 0 .5rem">Appearance</div>
              <div class="seg" role="radiogroup" aria-label="Appearance">
                <button
                  v-for="m in MODE_OPTIONS" :key="m.id" type="button"
                  :class="{ on: theme.mode === m.id }" :title="m.label" role="radio" :aria-checked="theme.mode === m.id"
                  @click="theme.setMode(m.id)"
                ><i class="fas" :class="m.icon"></i></button>
              </div>
              <div class="app-nav-label" style="padding:1rem 0 .5rem">Accent color</div>
              <div style="display:flex;gap:.625rem" role="radiogroup" aria-label="Accent color">
                <button
                  v-for="a in ACCENTS" :key="a.id" type="button"
                  class="swatch" :class="{ on: theme.accent === a.id }" :style="{ background: a.swatch }"
                  :title="a.label" role="radio" :aria-checked="theme.accent === a.id"
                  @click="theme.setAccent(a.id)"
                ></button>
              </div>
              <div style="font-size:.72rem;color:var(--shell-text-muted);margin-top:.5rem">{{ ACCENTS.find((a) => a.id === theme.accent)?.label }}</div>
            </div>
          </div>

          <div class="user-menu-anchor" style="position:relative">
            <button
              type="button"
              style="display:flex;align-items:center;gap:.5rem;background:none;border:none;cursor:pointer;padding:.25rem;color:var(--shell-text-strong)"
              :aria-expanded="userMenuOpen"
              @click="userMenuOpen = !userMenuOpen"
            >
              <span class="app-avatar">{{ initials }}</span>
              <span class="hidden sm:inline" style="font-size:.8rem;font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ displayName }}</span>
              <i class="fas fa-chevron-down" style="font-size:.6rem;color:var(--shell-text-muted)"></i>
            </button>
            <div v-show="userMenuOpen" class="app-menu">
              <div class="app-menu-header">
                <div style="font-size:.8rem;font-weight:700;color:var(--shell-text-strong)" class="truncate">{{ displayName }}</div>
                <div style="font-size:.72rem;color:var(--shell-text-muted)" class="truncate">{{ user.email }}</div>
              </div>
              <RouterLink v-if="runsFacility(user.role)" to="/onboarding" class="app-menu-item" @click="userMenuOpen = false"><i class="fas fa-building"></i>Facility profile</RouterLink>
              <RouterLink v-else to="/staff-onboarding" class="app-menu-item" @click="userMenuOpen = false"><i class="fas fa-user-doctor"></i>Professional profile</RouterLink>
              <RouterLink to="/account/consents" class="app-menu-item" @click="userMenuOpen = false"><i class="fas fa-file-signature"></i>Consents</RouterLink>
              <RouterLink to="/" class="app-menu-item" @click="userMenuOpen = false"><i class="fas fa-house"></i>ClinüxFlow home</RouterLink>
              <button class="app-menu-item" style="color:#DC2626;border-top:1px solid var(--shell-border)" @click="signOut()"><i class="fas fa-arrow-right-from-bracket" style="color:#DC2626"></i>Sign out</button>
            </div>
          </div>
        </div>
      </header>
      <slot v-else name="nav" />

      <main :class="chrome ? 'app-content' : 'flex-1 flex flex-col'">
        <slot />
      </main>
      <!-- Affiliations · Terms · Privacy, one line at the foot of every workspace page (clinux-cubo's compact footer). -->
      <SiteFooter v-if="chrome" compact />
    </div>

    <TeamChat v-if="chrome" :show="teamChatOpen" @close="teamChatOpen = false" />
  </div>
</template>
