<script setup>
// Extracted from Cubo.vue's own middle-pane Profile overlay so THREE_PANE mode's right-pane
// "Profile" tab (see Cubo.vue) can render the exact same content without duplicating it — this
// component owns none of the positioning (absolute-overlay vs. normal-flow tab panel), only the
// content, which is identical either way. Self-contained (talks to useCuboStore() directly, same
// as Cubo.vue's own convention) rather than prop-drilled, since both call sites want the same
// live store state.
import { useCuboStore } from '../../stores/cubo.js';
const cubo = useCuboStore();
</script>

<template>
  <div class="space-y-3">
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
