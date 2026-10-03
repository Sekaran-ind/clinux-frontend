<script setup>
// Extracted from Cubo.vue's own middle-pane Profile overlay so THREE_PANE mode's right-pane
// "Profile" tab (see Cubo.vue) can render the exact same content without duplicating it — this
// component owns none of the positioning (absolute-overlay vs. normal-flow tab panel), only the
// content, which is identical either way. Self-contained (talks to useCuboStore() directly, same
// as Cubo.vue's own convention) rather than prop-drilled, since both call sites want the same
// live store state.
//
// "People" (journeys/profile.js): who Cübo is acting for and what each is signed in to — the HPR
// sign-in that registry journeys with a `signIn: "hpr"` step reuse. One person (this account) for
// now; a context such as an Encounter will list more than one.
import { computed, ref, onBeforeUnmount } from 'vue';
import { useCuboStore } from '../../stores/cubo.js';
import { useAuthStore } from '../../stores/auth.js';
import { useCuboProfileStore, REGISTRIES } from '../../journeys/profile.js';
import { useJourneySessionsStore } from '../../journeys/sessions.js';
const cubo = useCuboStore();
const auth = useAuthStore();
const profile = useCuboProfileStore();
const journeys = useJourneySessionsStore();
const ROLE_LABELS = { health_professional: 'Health professional', hospital_admin: 'Facility admin', admin_and_health_professional: 'Admin & health professional' };

const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 30 * 1000);
onBeforeUnmount(() => clearInterval(timer));
const minutesLeft = (t) => Math.max(0, Math.round((t - now.value) / 60000));
const registries = computed(() => Object.entries(REGISTRIES));

function signIn(registry) {
  if (!auth.currentUser) return;
  cubo.viewingProfile = false;
  journeys.open(REGISTRIES[registry].journeyId, { account: auth.currentUser });
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="profile.persons.length" class="space-y-2" data-testid="cubo-people">
      <div class="pb-1 border-b border-gray-100 dark:border-slate-800">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">People</span>
      </div>
      <div v-for="p in profile.persons" :key="p.id" class="p-2.5 rounded-lg border border-gray-200 dark:border-slate-700 text-xs space-y-2">
        <div class="flex items-center gap-2 min-w-0">
          <div class="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold" style="background:var(--color-primary);color:var(--color-on-primary)">{{ (p.name || '?').charAt(0).toUpperCase() }}</div>
          <div class="min-w-0">
            <div class="font-semibold text-gray-800 dark:text-slate-100 truncate">{{ p.name }}</div>
            <div class="text-[10px] text-gray-400 truncate">{{ ROLE_LABELS[p.role] || 'Member' }}<template v-if="p.email && p.email !== p.name"> · {{ p.email }}</template></div>
          </div>
        </div>
        <div v-for="[key, reg] in registries" :key="key" class="flex items-center justify-between gap-2 pt-2 border-t border-gray-100 dark:border-slate-800" :data-testid="`cubo-identity-${key}`">
          <div class="min-w-0">
            <div class="font-semibold text-gray-700 dark:text-slate-200">{{ reg.label }}<span v-if="p.identities[key]?.id" class="font-normal text-gray-500"> · {{ p.identities[key].id }}</span></div>
            <div class="text-[10px]" :class="p.identities[key]?.session ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'">
              <template v-if="p.identities[key]?.session">Signed in · {{ minutesLeft(p.identities[key].session.expiresAt) }} min left this session</template>
              <template v-else-if="p.identities[key]?.linked">Linked · not signed in this session</template>
              <template v-else>Not linked</template>
            </div>
          </div>
          <button v-if="p.identities[key]?.session" class="text-[11px] text-gray-500 hover:text-red-500 shrink-0" @click="profile.signOut(key)">Sign out</button>
          <button v-else class="text-[11px] font-semibold shrink-0" style="color:var(--color-primary-text)" @click="signIn(key)">{{ p.identities[key]?.linked ? 'Sign in' : 'Link' }}</button>
        </div>
      </div>
      <p class="text-[10px] text-gray-400 leading-relaxed">Registry journeys with a sign-in step use these. An HPR sign-in lasts for this session only and is never saved.</p>
    </div>

    <div class="pb-1 border-b border-gray-100 dark:border-slate-800">
      <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">User Profile — Virtual Room</span>
    </div>

    <div v-show="cubo.virtualRoom" class="p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="font-semibold text-emerald-700 dark:text-emerald-400 truncate">{{ cubo.virtualRoom?.roleTitle }}</div>
        <div class="text-[10px] text-gray-500 truncate">{{ cubo.virtualRoom?.specialityDisplay }}</div>
      </div>
      <button @click="cubo.clearVirtualRoom()" class="text-[10px] text-gray-400 hover:text-red-500 transition shrink-0">Clear</button>
    </div>

    <div class="space-y-2">
      <label class="block text-[11px] font-semibold text-gray-500 dark:text-slate-400">Speciality</label>
      <select v-model="cubo.profilePicker.code" @change="cubo.profilePicker.roleFile = ''"
              class="w-full text-xs p-2 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:text-white">
        <option value="">Select a speciality…</option>
        <option v-for="s in cubo.specialityCatalog" :key="s.code" :value="s.code">{{ s.display }}</option>
      </select>

      <label class="block text-[11px] font-semibold text-gray-500 dark:text-slate-400 mt-2">Role</label>
      <select v-model="cubo.profilePicker.roleFile" :disabled="!cubo.profilePicker.code"
              class="w-full text-xs p-2 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:text-white disabled:opacity-50">
        <option value="">Select a role…</option>
        <option v-for="r in cubo.rolesForPickerCode()" :key="r.file" :value="r.file">{{ r.title }}</option>
      </select>

      <button @click="cubo.applyVirtualRoomFromPicker()" :disabled="!cubo.profilePicker.code || !cubo.profilePicker.roleFile"
              class="w-full mt-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition">
        Load as My Context
      </button>
    </div>

    <p class="text-[10px] text-gray-400 leading-relaxed">
      The selected role's clinical scope and SOAP note constraints are applied to Cübo's persona here and are sent to the SOAP-generation step on Consultation Desk.
    </p>
  </div>
</template>
