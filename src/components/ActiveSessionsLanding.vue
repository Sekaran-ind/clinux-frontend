<script setup>
// Shared "Active Sessions" landing — one component, mounted identically by Front Desk,
// Consultation Desk, and Checkout as their entry screen, replacing what used to be three
// separate inline implementations (Front Desk/Checkout each had their own; Consultation Desk
// got a fourth, page-specific one before this). A session row shows all 3 phase actions
// (Front Desk/Consultation/Checkout) regardless of which page you're currently on — this is a
// real navigation hub now, not "the list this one page happens to show before its own wizard."
// The stage's internal identifier stays 'onboarding' (clinical.js's ENCOUNTER_STAGES,
// stage_onboarding_complete) -- only the user-facing label changed, to match what staff actually
// call this step.
//
// Infinite scroll via TanStack Query's useInfiniteQuery — the "backend" it pages through is
// clinical.listAllSessions() (a local, already-sorted TanStack DB read), not a network call.
// Query's infinite-scroll primitive doesn't require the page-fetcher to be a real network
// round-trip, just a Promise-returning function, which a synchronous local slice wrapped in an
// async function satisfies exactly — worth being clear this is genuinely local-first "infinite
// scroll through history," not paginated server fetching.
//
// Timeline: a date-grouped chronological list (Today / Yesterday / a real date), not a plotted
// chart — there's no charting library anywhere in this project, and introducing one just to plot
// "sessions along a time axis" would be a heavier dependency than the actual need (see date/time
// grouping below) warrants.
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query';
import { useClinicalStore } from '../stores/clinical.js';
import { formData } from '../data/collections/formData.js';
import { ensureSharedModeDetected } from '../data/sharedServerSync.js';

const emit = defineEmits(['navigate-stage']);
const clinical = useClinicalStore();
const queryClient = useQueryClient();

// In Live Server mode this list is genuinely common across all three stages (near-real-time LAN
// sync). In Local Only mode it's this device's own island — a session created elsewhere simply
// isn't here until explicitly shared/imported. Surfaced directly on the list itself (not just
// the header badge) since this is exactly the point someone would otherwise be confused about
// "where did that session go."
const sharedModeLive = ref(false);
ensureSharedModeDetected().then((active) => { sharedModeLive.value = active; });

const PAGE_SIZE = 20;
const QUERY_KEY = ['active-sessions-timeline'];

const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
  queryKey: QUERY_KEY,
  queryFn: async ({ pageParam = 0 }) => {
    const all = clinical.listAllSessions();
    const page = all.slice(pageParam, pageParam + PAGE_SIZE);
    return { page, nextOffset: pageParam + PAGE_SIZE, hasMore: pageParam + PAGE_SIZE < all.length };
  },
  getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextOffset : undefined),
  initialPageParam: 0,
});

// Any local write — a new session created, a stage marked complete on another page, a
// background shared-server sync merge — re-slices from the current array. subscribeChanges is
// TanStack DB's own origin-agnostic change-notification primitive (see onboarding.js's identical
// wiring elsewhere in this app for the fuller story on why plain .toArray()/.filter() reads
// alone aren't enough here).
formData.subscribeChanges(() => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); });

const sessions = computed(() => (data.value?.pages || []).flatMap((p) => p.page));

function dateLabel(savedAt) {
  const d = new Date(savedAt);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}
function timeLabel(savedAt) {
  return new Date(savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Groups the flat, already-most-recent-first list into date-header sections for the timeline —
// a plain reduce over an array already sorted by clinical.listAllSessions(), not a re-sort.
const groupedSessions = computed(() => {
  const groups = [];
  let currentLabel = null;
  sessions.value.forEach((s) => {
    const label = dateLabel(s.savedAt);
    if (label !== currentLabel) {
      groups.push({ label, sessions: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].sessions.push(s);
  });
  return groups;
});

const STAGE_META = [
  { key: 'onboarding', icon: 'fa-hospital-user', label: 'Front Desk' },
  { key: 'consultation', icon: 'fa-user-doctor', label: 'Consultation' },
  { key: 'checkout', icon: 'fa-flag-checkered', label: 'Checkout' },
];

function goToStage(session, stage) {
  clinical.setActive(session.id);
  emit('navigate-stage', stage);
}

// Auto-load-on-scroll rather than a manual "Load more" button — a small sentinel element at the
// bottom of the list, observed via IntersectionObserver, triggers the next page exactly once it
// scrolls into view. No new dependency needed; IntersectionObserver is a standard browser API.
const loadMoreTrigger = ref(null);
let observer = null;
onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && hasNextPage.value && !isFetchingNextPage.value) fetchNextPage();
  }, { rootMargin: '200px' });
  if (loadMoreTrigger.value) observer.observe(loadMoreTrigger.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="max-w-[820px] mx-auto">
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-2xl font-bold" style="color:var(--cf-text-strong)">Active Sessions</h2>
      <slot name="actions" />
    </div>

    <div v-if="!sharedModeLive" class="text-xs mb-3 px-3 py-2 rounded-lg" style="color:var(--cf-text);background:var(--cf-bg);border:1px solid var(--cf-border)">
      <i class="fas fa-house-laptop mr-1.5"></i>Local Only — sessions created on other devices won't appear here unless shared or imported. Switch to Live Server (top right) if this clinic runs the shared LAN server.
    </div>

    <div v-if="isLoading" class="cf-card rounded-2xl p-5 text-sm text-center" style="color:var(--cf-text)">
      <i class="fas fa-spinner fa-spin mr-2"></i>Loading sessions...
    </div>
    <div v-else-if="sessions.length === 0" class="cf-card rounded-2xl p-5 text-sm" style="color:var(--cf-text)">
      No sessions yet. Start a new check-in from Front Desk.
    </div>

    <div v-else class="flex flex-col gap-5">
      <div v-for="group in groupedSessions" :key="group.label">
        <div class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--cf-text)">{{ group.label }}</div>
        <div class="flex flex-col gap-2">
          <div v-for="s in group.sessions" :key="s.id" class="record-card flex items-center justify-between p-3 gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="text-xs font-mono shrink-0" style="color:var(--cf-text);min-width:4.5rem">{{ timeLabel(s.savedAt) }}</div>
              <div class="min-w-0">
                <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ s.patientRef || 'Unknown patient' }}</span>
                <span v-if="s.chiefComplaint" class="text-xs ml-2" style="color:var(--cf-text)">{{ s.chiefComplaint }}</span>
                <div class="text-xs mt-0.5">
                  <span class="badge badge-teal">{{ s.status || 'arrived' }}</span>
                  <span v-if="s.priority === 'Emergency'" class="badge ml-1" style="background:#fee2e2;color:#b91c1c">Emergency</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                v-for="stage in STAGE_META" :key="stage.key"
                class="stage-action-btn"
                :class="s.stages[stage.key] ? 'stage-action-complete' : ''"
                :title="stage.label + (s.stages[stage.key] ? ' — complete' : '')"
                @click="goToStage(s, stage.key)"
              >
                <i class="fas" :class="s.stages[stage.key] ? 'fa-check' : stage.icon"></i>
                <span class="hidden sm:inline">{{ stage.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div ref="loadMoreTrigger" class="text-center py-3 text-xs" style="color:var(--cf-text)">
        <span v-if="isFetchingNextPage"><i class="fas fa-spinner fa-spin mr-1.5"></i>Loading more...</span>
        <span v-else-if="!hasNextPage && sessions.length > 0">— end of history —</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.35rem 0.55rem;
  border-radius: 0.5rem;
  border: 1px solid var(--cf-border);
  background: transparent;
  color: var(--cf-text);
  cursor: pointer;
  transition: all 0.15s;
}
.stage-action-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.stage-action-complete {
  border-color: var(--color-primary);
  background: rgba(0, 212, 178, 0.1);
  color: var(--color-primary);
}
</style>
