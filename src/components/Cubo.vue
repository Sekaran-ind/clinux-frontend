<script setup>
// Full rewrite of clinixflow's public/cubo-ai-cc/cubo-component.js + cubo-template.html as a
// genuine Vue SFC. The original was a native Web Component that fetched cubo-template.html as
// raw HTML text and rehydrated it with Alpine.initTree() — that trick existed only because
// Alpine had no other way to attach reactive behavior to server-fetched markup. With Alpine gone
// entirely, this is just a normal component; the fetch-and-rehydrate step disappears.
//
// Same attribute/prop contract as before: category, encounterId, encounterTitle, pageContext.
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useLiveQuery } from '@tanstack/vue-db';
import { throttle } from '@tanstack/pacer';
import { chatThreads } from '../data/collections/chatThreads.js';
import { listConversations } from '../data/collections/userChats.js';
import { useCuboStore } from '../stores/cubo.js';
import { useAuthStore } from '../stores/auth.js';
import { useEntryWorkflowStore } from '../stores/entryWorkflow.js';
import { useClinicalStore } from '../stores/clinical.js';
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';
import { classifyIntent } from '../nlp/intents.js';
import { recognizeSlots, applyFills } from '../nlp/formSlotEngine.js';
import { matchShortcuts, resolveShortcutMessage } from '../nlp/fieldShortcuts.js';
import { ENTRY_FORM_COMPONENTS, ENTRY_MENU_OPTIONS, ENTRY_INTROS } from './auth/entryFormRegistry.js';
import { ENTRY_PLAN_DEFINITION } from '../workflow/entryPlanDefinition.js';
import { ONBOARDING_JOURNEYS, visibleOnboardingJourneys } from '../workflow/onboardingJourneys.js';
import CuboProfilePanel from './cubo/CuboProfilePanel.vue';
import CuboContactConversation from './cubo/CuboContactConversation.vue';

const props = defineProps({
  category: { type: String, default: 'general' },
  encounterId: { type: String, default: null },
  encounterTitle: { type: String, default: '' },
  pageContext: { type: String, default: 'General Shell Context Profile' },
  // A route breakpoint, not a page-level concept — set only by router/index.js's /ai-engine entry
  // (Cubo.vue mounts directly as that route's own component, no wrapper page). Forces this
  // instance's layout on mount instead of leaving cubo.currentLayout at whatever it already was,
  // and is reset back to 'FAB' on unmount so navigating away doesn't leave THREE_PANE mode active
  // for Cübo's OTHER instances elsewhere (the floating FAB badge, inline hosts on other pages).
  forceLayout: { type: String, default: null },
});

const emit = defineEmits(['cubo-api-submit']);

const router = useRouter();
const cubo = useCuboStore();
const auth = useAuthStore();
const entryWorkflow = useEntryWorkflowStore();
const slotFillHighlights = useSlotFillHighlightsStore();
const { data: threads } = useLiveQuery((q) => q.from({ t: chatThreads }));

// Runs synchronously during setup (not inside onMounted) so this instance never flashes as FAB
// first before switching to the forced layout.
if (props.forceLayout) cubo.currentLayout = props.forceLayout;

const activeThread = computed(() =>
  threads.value.find((t) => t.id === cubo.activeThreadId) || threads.value[0]
);

// SPEC-20's real unauthenticated entry point, hosted directly in the 'general' category thread
// (already existed as "a persistent session channel" — stores/cubo.js's own CUBO_CATEGORIES
// comment) rather than a standalone page.
//
// UPDATE (SPEC-22 §5.1, correcting SPEC-20 §6's shipped inline-in-chat forms): the actual form no
// longer renders inline in the chat message stream. Selecting an option sets
// entryWorkflow.activeEntryAction (a shared Pinia ref) and narrates in chat; the form itself
// renders in whichever content pane is currently responsible for it — in THREE_PANE mode that's
// this same file's own right pane (Cübo owns all three panes on its dedicated /ai-engine route,
// there's no separate host page); in FAB/EXPANDED/MODAL_DOCK, a host page can read the same shared
// ref if it wants to (currently unused there — the entry journey only ever runs in THREE_PANE
// mode, reached via Index.vue's "Try Guided Setup" button).
function showEntryOption(actionId) {
  const meta = ENTRY_MENU_OPTIONS.find((o) => o.id === actionId);
  cubo.addCuboMessage('user', meta.label);
  cubo.addCuboMessage('assistant', ENTRY_INTROS[actionId]);
  entryWorkflow.selectEntryAction(actionId);
  // Real gap found live: picking an action from Next Action left the form sitting unseen in
  // Content until the user discovered they had to switch tabs themselves.
  rightPaneTab.value = 'content';
}
// The content-pane side of the above — what happens once a form in the right pane succeeds/is
// skipped. Chains register into the security-question follow-up, narrates completion, otherwise
// clears back to the "pick an option" placeholder.
function onEntryFormSuccess() {
  const actionId = entryWorkflow.activeEntryAction;
  if (actionId === 'register') {
    cubo.addCuboMessage('assistant', 'Registered! Want to set a recovery question in case you forget your password?');
    entryWorkflow.selectEntryAction('security_question');
  } else if (actionId === 'login') {
    cubo.addCuboMessage('assistant', "Welcome back — you're signed in.");
    entryWorkflow.clearEntryAction();
  } else if (actionId === 'forgot_password') {
    cubo.addCuboMessage('assistant', 'Password reset. Log in with your new password whenever you’re ready.');
    entryWorkflow.selectEntryAction('login');
  } else if (actionId === 'change_password') {
    cubo.addCuboMessage('assistant', 'Password changed.');
    entryWorkflow.clearEntryAction();
  } else if (actionId === 'security_question') {
    cubo.addCuboMessage('assistant', "Recovery question saved. You're all set!");
    entryWorkflow.clearEntryAction();
  }
}
function onSecurityQuestionSkip() {
  cubo.addCuboMessage('assistant', 'No problem — you can set one later from your profile.');
  entryWorkflow.clearEntryAction();
}
// Lets the user switch INTO 3-pane mode from any other layout (FAB/EXPANDED/MODAL_DOCK), on
// whichever page they're currently on — "3 pane mode is also another option for the user to
// switch" (explicit instruction). Since THREE_PANE only makes sense filling a whole page, this
// navigates to its dedicated route rather than trying to render 3 columns inside whatever narrow
// host container the current Cübo instance happens to be embedded in.
function switchToThreePane() {
  router.push('/ai-engine');
}
const ENTRY_INTRO_TEXT = "I can help you register, log in, recover a forgotten password, or change your password. Check Next Action on the right, or just tell me what you need.";
function seedEntryMenuIfNeeded() {
  const thread = activeThread.value;
  if (!thread || thread.category !== 'general') return;
  // Real bug found live: a plain "thread already has messages" guard silently loses this seed
  // whenever stores/cubo.js's own cleanCuboHistory() has already inserted its unrelated
  // 'default-general' thread + "Welcome back to Cübo Command Center." fallback message first (it
  // runs on a totally fresh/cleared state) — the narration a first-time unauthenticated visitor
  // should see never appeared. Match on this specific text instead, mirroring the original
  // (pre-SPEC-22 §5.1) guard's own precedent of checking for a specific marker, not "any message".
  if ((thread.messages || []).some((m) => m.text === ENTRY_INTRO_TEXT)) return;
  cubo.addCuboMessage('assistant', ENTRY_INTRO_TEXT);
  // SPEC-22 §5.7 — real correction: these are xstate-driven current-state suggestions, they
  // belong in Next Action, not narrated as a chat message or a standing nav strip. Auto-switches
  // the right pane there the moment the entry journey actually starts, so a first-time visitor
  // sees them immediately instead of having to discover the tab themselves.
  rightPaneTab.value = 'next-best-action';
}

// SPEC-22 §5.8 UPDATE — real replacement, not a refinement: ROLE_SUGGESTIONS (a role-keyed map
// deciding both WHETHER to suggest something and WHAT to say) and the separate
// omnipresentEntryActionIds computed (its own hand-picked "which 4 ids, minus login post-auth"
// list) are gone. "fix it with real plan definitions instead of a hardcoded map" (explicit
// instruction), landed via the fifth-room extension to ENTRY_PLAN_DEFINITION (entryPlanDefinition.js
// — logout/facility_registration/staff_registration, each carrying its own `roles`/`requiresAuth`
// gate) — entryWorkflow.js's primaryActionIds/secondaryActionIds now derive BOTH the "what's
// available" and "what's a targeted suggestion vs. universally useful" split straight from that one
// plan's own action metadata. Nothing here decides eligibility any more; this file only renders
// whatever the store already computed and dispatches clicks.
//
// ICON is the one thing that's still legitimately presentation-only (a PlanDefinition action has
// no business carrying a font-awesome class) — titles come straight from ENTRY_PLAN_DEFINITION
// itself via entryActionMeta() below, not duplicated here.
const ENTRY_ACTION_ICONS = {
  register: 'fa-user-plus',
  login: 'fa-right-to-bracket',
  forgot_password: 'fa-key',
  change_password: 'fa-lock',
  logout: 'fa-right-from-bracket',
};
function entryActionMeta(actionId) {
  const action = ENTRY_PLAN_DEFINITION.action.find((a) => a.id === actionId);
  return { label: action?.title || actionId, icon: ENTRY_ACTION_ICONS[actionId] || 'fa-circle' };
}
// The dispatcher for every tracked entry/account action click (register/login/forgot_password/
// change_password/logout), whether from the Next Action tab or a nav-suggestion chat message.
// register/login/forgot_password/change_password open their real form in the content pane
// (showEntryOption) — genuinely small, single-purpose forms, fine in the right pane's width.
// logout is COMPLETE-driven — clicking IS the real action, no form needed.
function activateAccountAction(actionId) {
  if (actionId === 'logout') {
    entryWorkflow.logout(); // auth.logout() + tracked focus/complete + Cübo thread reset, all centralized
    cubo.addCuboMessage('assistant', "You're signed out.");
  } else {
    showEntryOption(actionId);
  }
}

// Real onboarding-UI rebuild — Facility/Provider/Patient registration are plain, untracked page-
// route journeys now (workflow/onboardingJourneys.js; "no plan definition or workflow is
// required" for these 3 entities, explicit instruction), a genuinely different shape from
// activateAccountAction's PlanDefinition-tracked actions above: no focus()/complete(), no status,
// no service — clicking one is real navigation to a real full-page journey (/onboarding,
// /staff-onboarding), full page width, not squeezed into this right pane's content tab ("the
// hospital setup has many parts... narrow lhcforms is getting difficult" is exactly the problem a
// real page route, not panel content, fixes).
const journeyLinks = computed(() => visibleOnboardingJourneys(auth.currentUser));
function activateJourney(journey) {
  router.push(journey.route);
}

// "all state transitions and actions taken by user will be created as timestamped audit log"
// (explicit instruction). workflowRuntime.js's auditLog is real, already populated on every
// transition/blocked event — entryWorkflow.js's own comment flagged it as "not surfaced in any UI
// in this pass" until now. Synthesized into the SAME shape as a regular chat message (a
// pseudo-message with `isAudit: true`) and merged chronologically, rather than a parallel
// rendering path — the existing per-message template above needed only one new branch, not a
// rewrite, since id/role/text/timestamp are still there for every entry either way.
//
// Scoped to 'general' — the one real thread↔runtime binding that exists today (entryWorkflow's
// ENTRY_PLAN_DEFINITION runs in whichever thread is active when its actions fire, which is
// 'general' for every action left in that plan now that facility_registration/staff_registration
// moved to plain page-route journeys — see onboardingJourneys.js — with no tracked runtime/audit
// trail of their own). Other categories (encounter, front-desk, ...) don't have a persisted
// runtime/thread link yet either; giving every thread a real audit trail needs the same Task/
// PlanDefinition persistence Notebooks does (SPEC-22 decision #1) — not built yet, not pretended
// here.
const AUDIT_VISIBLE_CATEGORIES = ['general'];
function describeAuditEntry(e) {
  if (e.type === 'transition') return `${e.actionId}: ${e.from} → ${e.to}`;
  if (e.type === 'blocked') return `${e.actionId} blocked — "${e.eventType}" isn't valid from its current state`;
  return e.type;
}
const timelineMessages = computed(() => {
  const messages = activeThread.value?.messages || [];
  if (!AUDIT_VISIBLE_CATEGORIES.includes(activeThread.value?.category)) return messages;
  const audit = entryWorkflow.auditLog.map((e, i) => ({
    id: `audit-${e.at}-${i}`,
    role: 'system',
    text: describeAuditEntry(e),
    timestamp: new Date(e.at).getTime(),
    isAudit: true,
  }));
  return [...messages, ...audit].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
});
let unsubscribeRoleKnown = null;

// Same routing rule as evaluateContextRouting() in the original component: an encounterId
// takes priority (creates/switches to an encounter-scoped thread); otherwise a non-general
// category gets its own persistent thread. The plain default case (general, no encounter) now
// seeds the entry menu for a signed-out visitor — previously did nothing at all.
onMounted(() => {
  if (props.encounterId) {
    cubo.createNewThread('encounter', `Encounter: ${props.encounterTitle || props.encounterId}`, `enc-${props.encounterId}`, props.encounterId);
  } else if (props.category && props.category !== 'general') {
    const meta = cubo.categoryMeta(props.category);
    cubo.createNewThread(props.category, meta.label, `cat-${props.category}`);
  } else if (!auth.currentUser) {
    seedEntryMenuIfNeeded();
    // Scoped to this same branch (the general/unauth-entry context), not every Cubo instance
    // app-wide — AI Engine's/Designer's own category-specific instances have no reason to
    // subscribe to this. entryWorkflow's runtime is a real Pinia singleton regardless of which
    // Cubo instance subscribes, so this only ever fires for a genuine register/login completion,
    // never on a later remount replaying something that already happened.
    unsubscribeRoleKnown = entryWorkflow.onRoleKnown((role) => {
      // Real replacement for ROLE_SUGGESTIONS[role] — the same visibleOnboardingJourneys()
      // journeyLinks reads from is the source here too — whichever journeys have a `roles` match
      // for the role that just became known. No second role-keyed lookup. UPDATE: sourced from
      // onboardingJourneys.js's plain ONBOARDING_JOURNEYS now, not ENTRY_PLAN_DEFINITION — see
      // that file's own header comment ("no plan definition or workflow is required" for these 3
      // onboarding entities, explicit instruction).
      const matches = ONBOARDING_JOURNEYS.filter((j) => j.roles?.includes(role));
      if (!matches.length) return;
      const text = matches.length > 1
        ? "You're set up for more than one role — you can do either, or both."
        : `Let's get your ${matches[0].title.toLowerCase()} done.`;
      cubo.addCuboMessage('assistant', text, {
        component: 'nav-suggestion',
        componentProps: { links: matches.map((j) => ({ label: j.title, route: j.route })) },
      });
    });
  }

  // Contacts are real only when authenticated (fetchTeam/fetchAffiliates both need a session) and
  // only relevant in THREE_PANE mode (the only layout with a left-pane Contacts section) — no
  // point fetching them for a Front Desk/Designer-embedded Cübo instance that never shows them.
  // Covers mounting while ALREADY authenticated (e.g. navigating here via an existing session);
  // the watch() below covers becoming authenticated LATER within this same mounted instance.
  if (isThreePane.value && auth.currentUser) loadContacts();
});

// Real bug found live: onMounted's own check above only ever ran ONCE, at initial mount — a
// visitor who opens /ai-engine unauthenticated (the real, common path here: Index.vue's "Try
// Guided Setup" button) has auth.currentUser === null at that moment, so contacts were never
// fetched; the Contacts section stayed on "Loading contacts…" forever even after registering,
// since onMounted never re-fires. Reactive to auth state instead of a one-time mount check.
watch(() => !!auth.currentUser, (isAuthed) => {
  if (isAuthed && isThreePane.value && !contactsLoaded.value) loadContacts();
});

// Front Desk mounts Cubo before an encounter exists (Patient step comes before Encounter is
// created) — the onMounted routing above only runs once, so without this, a Cubo instance
// mounted pre-encounter never hands off to the enc-<id> thread once the encounter is created.
// Always switches the instant an id appears, mirroring onMounted's own behavior exactly (no
// "did the user manually switch away" tracking) — createNewThread() is idempotent (switches to
// an existing thread rather than resetting it) via its own chatThreads.has() check.
watch(() => props.encounterId, (newId, oldId) => {
  if (newId && newId !== oldId) {
    cubo.createNewThread('encounter', `Encounter: ${props.encounterTitle || newId}`, `enc-${newId}`, newId);
  }
});

const chatHistoryEl = ref(null);
function scrollChatToBottom() {
  setTimeout(() => {
    if (chatHistoryEl.value) chatHistoryEl.value.scrollTop = chatHistoryEl.value.scrollHeight;
  }, 50);
}

// --- Pacer: rate-limit sending so a rapid double-click/double-Enter can't fire two overlapping
// requests. leading:true fires the first call immediately; trailing:false deliberately drops (as
// opposed to silently queuing) any call made while throttled — isThrottled below is what visibly
// disables the Send affordance for that window instead, rather than letting a click appear to do
// nothing.
const SEND_THROTTLE_MS = 800;
const isThrottled = ref(false);
const throttledDispatch = throttle((fn) => fn(), { wait: SEND_THROTTLE_MS, leading: true, trailing: false });

// --- Progress indicator: cycles while a message is being processed. There's no real multi-stage
// backend pipeline behind this today (the existing setTimeout-canned-reply below is the only
// "processing" there is) — this labels that same wait with the requested stage names rather than
// leaving it unlabeled.
const PROGRESS_STAGES = ['Thinking', 'Planning', 'Doing', 'Verifying'];
const isProcessing = ref(false);
const progressStage = ref(0);
let progressTimer = null;
function startProgress() {
  progressStage.value = 0;
  isProcessing.value = true;
  progressTimer = setInterval(() => { progressStage.value = (progressStage.value + 1) % PROGRESS_STAGES.length; }, 900);
}
function stopProgress() {
  isProcessing.value = false;
  clearInterval(progressTimer);
}
onBeforeUnmount(() => {
  clearInterval(progressTimer);
  unsubscribeRoleKnown?.();
  // Leaving the dedicated /ai-engine route — reset so Cübo's OTHER instances elsewhere (the
  // floating FAB badge, inline hosts on other pages) don't inherit THREE_PANE, which only makes
  // sense filling this route's own full width.
  if (props.forceLayout) cubo.currentLayout = 'FAB';
});

// --- /shortcut autocomplete dropdown state.
const slashOpen = ref(false);
const slashActiveIndex = ref(0);
const slashMatches = computed(() => {
  const text = cubo.promptText;
  if (!text.startsWith('/') || text.includes(' ')) return [];
  return matchShortcuts(text.slice(1)).slice(0, 8);
});
watch(() => cubo.promptText, (text) => {
  slashOpen.value = text.startsWith('/') && !text.includes(' ');
  slashActiveIndex.value = 0;
});
function pickSlashMatch(m) {
  cubo.promptText = `/${m.key} `;
  slashOpen.value = false;
}
// Single entry point for every keydown on the textarea — handles slash-dropdown navigation when
// it's open, otherwise Shift+Enter inserts a newline and plain Enter sends. Kept as one function
// (rather than a separate @keydown.enter modifier alongside a generic @keydown) so Enter is never
// evaluated by two competing handlers on the same keypress.
function onTextareaKeydown(e) {
  if (slashOpen.value && slashMatches.value.length > 0) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashActiveIndex.value = (slashActiveIndex.value + 1) % slashMatches.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashActiveIndex.value = (slashActiveIndex.value - 1 + slashMatches.value.length) % slashMatches.value.length; return; }
    if (e.key === 'Enter') { e.preventDefault(); pickSlashMatch(slashMatches.value[slashActiveIndex.value]); return; }
    if (e.key === 'Escape') { e.preventDefault(); slashOpen.value = false; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
}

// Shared by both the NLP path (recognizeSlots/applyFills) and the /shortcut path below — same
// "please confirm" chat callout plus the visual highlight cue on whatever actually got applied.
function announceFills(applied) {
  if (applied.length === 0) return;
  slotFillHighlights.markFilled(applied.map((a) => a.linkId));
  cubo.addCuboMessage('assistant', `Filled ${applied.length} field(s) from that message on the active encounter — please review and confirm.`);
  scrollChatToBottom();
}

async function sendPrompt() {
  const prompt = cubo.promptText.trim();
  if (!prompt || isThrottled.value) return;

  isThrottled.value = true;
  setTimeout(() => { isThrottled.value = false; }, SEND_THROTTLE_MS);
  throttledDispatch(() => dispatchPrompt(prompt));
}

async function dispatchPrompt(prompt) {
  cubo.addCuboMessage('user', prompt);
  cubo.promptText = '';
  slashOpen.value = false;
  scrollChatToBottom();
  startProgress();

  // Deterministic /shortcut path — bypasses NLP ambiguity entirely. Checked first and, when it
  // resolves, returns early rather than also running the probabilistic paths below.
  if (prompt.startsWith('/')) {
    const resolved = resolveShortcutMessage(prompt);
    if (resolved?.field && resolved.value) {
      const clinical = useClinicalStore();
      const { applied } = applyFills([{ formId: clinical.ENCOUNTER_FORM_ID, groupLinkId: resolved.field.groupLinkId, linkId: resolved.field.linkId, value: resolved.value }]);
      if (applied.length > 0) announceFills(applied);
      else cubo.addCuboMessage('assistant', `Couldn't apply /${resolved.field.label} — is there an active encounter?`);
      stopProgress();
      return;
    }
    if (resolved?.incomplete) {
      cubo.addCuboMessage('assistant', `Type a value after /${prompt.slice(1).trim()} — that's "${resolved.field.label}".`);
      stopProgress();
      return;
    }
    if (resolved?.ambiguous) {
      cubo.addCuboMessage('assistant', `That shortcut matches more than one field: ${resolved.ambiguous.map((c) => `/${c.key} (${c.field.label})`).join(', ')}.`);
      stopProgress();
      return;
    }
    cubo.addCuboMessage('assistant', "Unrecognized shortcut — type / to see the available fields.");
    stopProgress();
    return;
  }

  // nlp.js intent classification runs first — additive, not a replacement for the LLM scribe
  // call. A recognized command gets a canned local reply; everything else (including
  // low-confidence matches) falls through to the normal contextString payload below.
  const { intent } = await classifyIntent(prompt);
  if (intent === 'switch_room') {
    cubo.addCuboMessage('assistant', 'Open the Profile panel (top-right) to pick a new speciality/role.');
    cubo.toggleProfileView();
    stopProgress();
    return;
  }

  // Form-field slot recognition — additive, alongside the command-shortcut check above. See
  // nlp/formSlotEngine.js for scope/tradeoffs (recognizes against every system form's fields
  // globally, not just this page's).
  const slotCandidates = await recognizeSlots(prompt);
  if (slotCandidates.length > 0) {
    const { applied } = applyFills(slotCandidates);
    announceFills(applied);
  }

  const payload = {
    threadId: cubo.activeThreadId,
    threadType: activeThread.value?.category,
    contextString: cubo.buildCuboContext(props.pageContext),
    prompt,
    nlpIntent: intent,
  };

  setTimeout(() => {
    cubo.addCuboMessage('assistant', 'Command acknowledged under active workspace thread index. Instruction maps appended cleanly.');
    scrollChatToBottom();
    stopProgress();
  }, 450);

  emit('cubo-api-submit', payload);
}

function setFeedback(msg, value) {
  chatThreads.update(activeThread.value.id, (draft) => {
    const m = draft.messages.find((x) => x.id === msg.id);
    if (m) m.feedback = m.feedback === value ? null : value;
  });
}

function copyMsg(text) {
  navigator.clipboard.writeText(text);
}

// Layout-dependent wrapper classes — replaces the two near-duplicate EXPANDED/MODAL_DOCK blocks
// in the original template with one shared body, since Vue components make that de-duplication
// straightforward where Alpine's copy-pasted x-show blocks didn't.
const isDock = computed(() => cubo.currentLayout === 'MODAL_DOCK');
// THREE_PANE reuses the exact same header+body markup below (unchanged, zero duplication) as a
// third variant of the same wrapper ternary — see wrapperOuterClass/wrapperCardClass — with real
// left (Threads) and right (dynamic content) panes added as siblings around it. isRoomy replaces
// isDock for pure STYLING/label choices (both MODAL_DOCK and THREE_PANE get the roomier chrome);
// isDock itself stays scoped to its one remaining MODAL_DOCK-specific behavior (backdrop-click).
const isThreePane = computed(() => cubo.currentLayout === 'THREE_PANE');
const isRoomy = computed(() => isDock.value || isThreePane.value);
// Right pane's own tab selection — 'content' (whatever the active thread needs shown, currently
// just the entry-journey forms), 'profile' (CuboProfilePanel, same content the overlay uses
// elsewhere), 'next-best-action' (journeyLinks + entryWorkflow's own secondaryActionIds). Local,
// not store state — purely this pane's own presentation, nothing else needs to read or drive it.
// "next action tab is after content.. i have to click next action first and then content to
// enter data instead if next action can be first step then click there to fill data will be
// easier" (explicit instruction) — Next Action first, matching the real workflow order (see what
// to do, then go do it), not the order these were originally built in. Default starting tab moved
// to match, not just the auto-switches already in place — whichever way a user reaches this pane,
// "what should I do" is what they see first.
const RIGHT_PANE_TABS = [
  { id: 'next-best-action', label: 'Next Action', icon: 'fa-lightbulb' },
  { id: 'content', label: 'Content', icon: 'fa-window-maximize' },
  { id: 'profile', label: 'Profile', icon: 'fa-user-doctor' },
];
const rightPaneTab = ref('next-best-action');
// THREE_PANE's own responsive collapse — "The Panes will be collapsed into a single pane...
// expansion and collapse should be based on the viewport of the device. This should address the
// mobile issue you raised earlier" (explicit instruction, closing the gap flagged when this shell
// first shipped). Same CSS-class-toggle idiom src/style.css's .chat-forms-shell already
// established for FrontDesk/ConsultationDesk/Checkout's 2-pane collapse, extended to 3 states —
// a `mode-<x>` class on the shell (see wrapperOuterClass) plus a matching @media rule in cubo.css
// does the actual hiding, this ref just tracks which pane is currently the visible one below the
// breakpoint. Defaults to 'chat' — the primary interaction surface.
const threePaneMobileView = ref('chat'); // 'threads' | 'chat' | 'content'

// Left pane's 4-section accordion state — Contacts/Threads default open (the two real sections),
// Contact Groups/Notebooks default closed (placeholders, see the template's own comment).
const leftPaneOpenSections = reactive({ contacts: true, contactGroups: false, threads: true, notebooks: false });

// Contacts — real data, ported from TeamChat.vue's own loadContacts()/sortedContacts (same
// fetchTeam/fetchAffiliates calls, same userChats-backed "most recently messaged first" sort).
// Loaded once, the first time THREE_PANE mounts — not on every Cubo instance, since only the
// left-pane Contacts section ever needs this.
const contacts = ref([]);
const contactsLoaded = ref(false);
async function loadContacts() {
  const [teamRes, affiliatesRes] = await Promise.all([auth.fetchTeam(), auth.fetchAffiliates()]);
  const team = (teamRes.accounts || []).map((a) => ({ id: a.id, name: a.adminName || a.email, kind: 'staff' }));
  const affiliates = (affiliatesRes.affiliates || []).map((a) => ({ id: a.accountId, name: a.practitionerName || a.practitionerEmail, kind: 'affiliate' }));
  contacts.value = [...team, ...affiliates].filter((c) => c.id !== auth.currentUser?.id);
  contactsLoaded.value = true;
}
const sortedContacts = computed(() => {
  const lastByPeer = new Map(listConversations().map((c) => [c.id, c]));
  return [...contacts.value].sort((a, b) => (lastByPeer.get(b.id)?.lastMessageAt || 0) - (lastByPeer.get(a.id)?.lastMessageAt || 0))
    .map((c) => {
      const convo = lastByPeer.get(c.id);
      const last = convo?.messages?.[convo.messages.length - 1];
      return { ...c, lastMessageText: last?.text || '', lastMessageAt: convo?.lastMessageAt || null };
    });
});

// The selected contact, if any — takes over the middle pane (see CuboContactConversation below)
// in place of the regular Threads/Profile/Chat header+body, same way TeamChat.vue's own
// activeContact drove its single conversation pane. Component-local, not store state: only ever
// set from THREE_PANE's own left pane, discarded when this Cübo instance unmounts (leaving /ai-
// engine resets currentLayout too — see forceLayout's onBeforeUnmount — so there's nothing to
// leak onto Cübo's other instances elsewhere).
const activeContact = ref(null);
function openContact(contact) {
  activeContact.value = contact;
}
// Real bug found live: with a growing message list, the composer ended up ~3000px down the page
// instead of pinned at the bottom — App.vue's shared shell is `min-h-screen` (correct for normal
// scrolling pages like Index.vue, but no hard ceiling for THIS page to clip against), so a plain
// `flex-1` here had nothing to clamp against and just grew with its content instead of scrolling
// internally. `/ai-engine` (THREE_PANE's only real entry point — see forceLayout/switchToThreePane)
// always shows App.vue's 56px (h-14) nav, so an explicit `calc(100vh-56px)` gives this branch a
// real ceiling regardless of the ancestor chain — `min-h-0` alongside it is the standard flexbox
// fix so nested flex children (Body/Chat/chat-history-container below, all unchanged markup)
// actually respect that ceiling instead of defaulting to `min-height: auto`. Designer.vue's own
// narrow Cübo pane likely has this same latent issue (identical `flex-1 flex overflow-hidden`
// root under the same shell) — not fixed here, out of scope for this pass.
const wrapperOuterClass = computed(() => {
  if (isDock.value) return 'fixed inset-0 z-[99999] bg-slate-900/40 backdrop-blur-sm flex justify-end';
  if (isThreePane.value) return `cubo-3pane-shell mode-${threePaneMobileView.value} flex flex-col md:flex-row h-[calc(100vh-56px)] min-h-0 overflow-hidden bg-white dark:bg-slate-950`;
  return 'cubo-wrapper cubo-expanded-panel';
});
const wrapperCardClass = computed(() => {
  if (isDock.value) return 'cubo-side-pane transform transition-transform duration-300 flex flex-col h-full bg-white dark:bg-slate-950 border-l border-gray-200 dark:border-slate-800 w-full max-w-md';
  if (isThreePane.value) return 'cubo-3pane-chat-col flex-1 min-w-0 min-h-0 flex flex-col h-full border-x border-gray-200 dark:border-slate-800';
  return 'w-full bg-blue-50/95 dark:bg-slate-900/95 rounded-xl border border-blue-100 dark:border-slate-800 shadow-2xl backdrop-blur-md overflow-hidden flex flex-col h-[500px]';
});
</script>

<template>
  <div v-if="cubo.currentLayout === 'FAB'" class="cubo-wrapper cubo-fab-container">
    <button @click="cubo.currentLayout = 'EXPANDED'" class="cubo-fab-trigger group">
      <span class="absolute inline-flex h-full w-full rounded bg-[var(--color-primary)] opacity-25 animate-ping group-hover:hidden"></span>
      Cü
    </button>
  </div>

  <div
    v-else
    :class="wrapperOuterClass"
    @click.self="isDock && (cubo.currentLayout = 'FAB')"
  >
    <!-- Mobile pane switcher — THREE_PANE only, hidden above the 768px breakpoint (see cubo.css's
         .cubo-3pane-shell rules), visible below it in place of the 3 side-by-side columns. -->
    <div v-if="isThreePane" class="cubo-3pane-mobile-tabs shrink-0 border-b border-gray-200 dark:border-slate-800">
      <button @click="threePaneMobileView = 'threads'" :class="threePaneMobileView === 'threads' ? 'active' : ''"><i class="fas fa-list"></i>Threads</button>
      <button @click="threePaneMobileView = 'chat'" :class="threePaneMobileView === 'chat' ? 'active' : ''"><i class="fas fa-comments"></i>Chat</button>
      <button @click="threePaneMobileView = 'content'" :class="threePaneMobileView === 'content' ? 'active' : ''"><i class="fas fa-window-maximize"></i>Content</button>
    </div>

    <!-- ═══ LEFT PANE: Contacts / Contact Groups / Threads / Notebooks accordion — THREE_PANE
         only. "The left pane will have contacts, contact groups, threads and notebooks (as
         accordion)" (explicit instruction). Contacts and Threads are real, wired to real data;
         Contact Groups and Notebooks are shown (the design is real) but honestly labeled — no
         data model exists for either yet (Notebooks needs the same Task/PlanDefinition
         persistence SPEC-22 decision #1 named as the biggest open piece; Contact Groups has no
         backing concept anywhere in this codebase). ═══ -->
    <div v-if="isThreePane" class="cubo-3pane-threads-col w-full md:w-64 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/30 flex flex-col overflow-y-auto custom-scrollbar">
      <!-- Contacts -->
      <div class="border-b border-gray-100 dark:border-slate-800">
        <button @click="leftPaneOpenSections.contacts = !leftPaneOpenSections.contacts" class="w-full flex items-center justify-between p-3 text-xs font-bold text-gray-400 uppercase tracking-wider">
          <span><i class="fas fa-address-book mr-1.5"></i>Contacts</span>
          <i class="fas text-[10px]" :class="leftPaneOpenSections.contacts ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
        </button>
        <div v-show="leftPaneOpenSections.contacts" class="pb-2 px-2 space-y-1">
          <p v-if="!contactsLoaded" class="text-[11px] text-gray-400 px-1 py-1">Loading contacts…</p>
          <p v-else-if="!sortedContacts.length" class="text-[11px] text-gray-400 px-1 py-1">No colleagues or linked affiliates yet.</p>
          <button v-for="c in sortedContacts" :key="c.id" @click="openContact(c)"
                  class="w-full flex items-center gap-2 p-2 rounded-lg border transition text-left"
                  :class="activeContact?.id === c.id ? 'bg-blue-500/10 border-blue-500/30' : 'bg-white dark:bg-slate-900/50 border-transparent hover:border-gray-200 dark:hover:border-slate-700'">
            <div class="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white" style="background:var(--color-primary)">{{ (c.name || '?').charAt(0).toUpperCase() }}</div>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-semibold text-gray-800 dark:text-slate-200 truncate">{{ c.name }}</div>
              <div class="text-[10px] text-gray-400 truncate">{{ c.lastMessageText || c.kind }}</div>
            </div>
          </button>
        </div>
      </div>

      <!-- Contact Groups — design only, no data model yet -->
      <div class="border-b border-gray-100 dark:border-slate-800">
        <button @click="leftPaneOpenSections.contactGroups = !leftPaneOpenSections.contactGroups" class="w-full flex items-center justify-between p-3 text-xs font-bold text-gray-400 uppercase tracking-wider">
          <span><i class="fas fa-users mr-1.5"></i>Contact Groups</span>
          <i class="fas text-[10px]" :class="leftPaneOpenSections.contactGroups ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
        </button>
        <p v-show="leftPaneOpenSections.contactGroups" class="text-[11px] text-gray-400 px-4 pb-3">Coming soon.</p>
      </div>

      <!-- Threads -->
      <div class="border-b border-gray-100 dark:border-slate-800">
        <button @click="leftPaneOpenSections.threads = !leftPaneOpenSections.threads" class="w-full flex items-center justify-between p-3 text-xs font-bold text-gray-400 uppercase tracking-wider">
          <span><i class="fas fa-comments mr-1.5"></i>Threads</span>
          <div class="flex items-center gap-2">
            <button @click.stop="cubo.createNewThread('general')" class="text-[11px] bg-[var(--color-primary)]/10 text-[var(--color-primary)] px-2 py-0.5 rounded font-semibold hover:bg-[var(--color-primary)]/20 transition normal-case">+ New</button>
            <i class="fas text-[10px]" :class="leftPaneOpenSections.threads ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
          </div>
        </button>
        <div v-show="leftPaneOpenSections.threads" class="pb-2 px-2 space-y-1.5">
          <div v-for="thread in threads" :key="thread.id"
               class="flex items-center justify-between p-2.5 rounded-lg border transition group text-left"
               :class="!activeContact && cubo.activeThreadId === thread.id ? 'bg-blue-500/10 border-blue-500/30 text-blue-900 dark:text-blue-300' : 'bg-white dark:bg-slate-900/50 border-gray-200/60 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'">
            <div @click="activeContact = null; cubo.switchThread(thread.id)" class="flex-1 cursor-pointer min-w-0 pr-2">
              <div class="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-slate-200">
                <i class="fas text-[11px]" :class="cubo.categoryMeta(thread.category).icon + ' ' + cubo.categoryMeta(thread.category).color"></i>
                <span class="truncate">{{ thread.title }}</span>
              </div>
              <div class="text-[10px] text-gray-400 mt-0.5 truncate">{{ thread.messages[thread.messages.length - 1]?.text || 'Empty trail workspace.' }}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button @click.stop="cubo.togglePinThread(thread.id)" class="text-xs transition p-1 hover:bg-gray-200 dark:hover:bg-slate-800 rounded">
                <i class="fas fa-thumbtack text-[10px]" :class="thread.pinned ? 'text-blue-500 rotate-0' : 'text-gray-300 dark:text-slate-600 -rotate-45'"></i>
              </button>
              <button @click.stop="cubo.deleteThread(thread.id)" class="text-xs text-gray-300 hover:text-red-500 transition p-1 rounded">
                <i class="fas fa-trash-alt text-[10px]"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Notebooks — design only, no data model yet -->
      <div>
        <button @click="leftPaneOpenSections.notebooks = !leftPaneOpenSections.notebooks" class="w-full flex items-center justify-between p-3 text-xs font-bold text-gray-400 uppercase tracking-wider">
          <span><i class="fas fa-book mr-1.5"></i>Notebooks</span>
          <i class="fas text-[10px]" :class="leftPaneOpenSections.notebooks ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
        </button>
        <p v-show="leftPaneOpenSections.notebooks" class="text-[11px] text-gray-400 px-4 pb-3">Coming soon — care plans, episodes of care, and PlanDefinition-based protocols spanning multiple encounters will live here once Task/Request persistence is built.</p>
      </div>
    </div>

    <div
      :class="wrapperCardClass"
    >
      <!-- A selected contact (THREE_PANE's left-pane Contacts section) takes over this whole
           middle pane, same way TeamChat.vue's own activeContact drove its one conversation view
           — "It will have contacts with whom the current user can select and send messages
           (using the center pane)" (explicit instruction). Everything below is the pre-existing,
           unchanged Header+Body — only wrapped, not touched. -->
      <CuboContactConversation v-if="activeContact" :contact="activeContact" />
      <template v-else>
      <!-- Header -->
      <div :class="isRoomy
        ? 'flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-800 bg-gray-50/30 dark:bg-slate-900/20'
        : 'flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50'">
        <div class="flex items-center gap-2 min-w-0">
          <h3 class="font-bold text-sm text-blue-900 dark:text-blue-300 flex items-center gap-1.5 min-w-0">
            <i class="fas fa-shield-alt text-[var(--color-primary)]"></i>
            <span class="truncate">{{ isRoomy ? 'Cübo Workspace' : 'Cübo AI Command Center' }}</span>
          </h3>
          <span class="text-[10px] text-gray-400 font-medium whitespace-nowrap">· {{ cubo.resolveActivePersona().label }}</span>
        </div>
        <div class="flex items-center gap-2.5 text-gray-400 text-xs">
          <!-- THREE_PANE has a real, permanent Threads column on the left already — this toggle
               (which swaps the WHOLE body between chat/threads/profile) would be redundant there. -->
          <button v-if="!isThreePane" @click="cubo.toggleThreadView()" class="hover:text-blue-500 transition px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 font-medium flex items-center gap-1">
            <i class="fas" :class="cubo.viewingThreads ? 'fa-comments' : 'fa-list'"></i>
            <span>{{ cubo.viewingThreads ? (isDock ? 'Open Chat' : 'Back to Chat') : (isDock ? 'Thread Directory' : 'Threads') }}</span>
          </button>
          <!-- THREE_PANE has its own right-pane "Profile" tab instead (see CuboProfilePanel) —
               same reasoning as hiding the Threads toggle above. -->
          <button v-if="!isThreePane" @click="cubo.toggleProfileView()" class="hover:text-blue-500 transition px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 font-medium flex items-center gap-1 relative" title="User Profile — pick a speciality/role">
            <i class="fas" :class="cubo.viewingProfile ? 'fa-comments' : 'fa-user-doctor'"></i>
            <span>{{ cubo.viewingProfile ? (isDock ? 'Open Chat' : 'Back to Chat') : 'Profile' }}</span>
            <span v-show="cubo.virtualRoom && !cubo.viewingProfile" class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500"></span>
          </button>
          <!-- Layout switcher — FAB/EXPANDED/MODAL_DOCK can all switch INTO 3-pane mode ("3 pane
               mode is also another option for the user to switch", explicit instruction); THREE_PANE
               itself has nowhere to "maximize" to (already full-page) or float back to (it's reached
               by navigating here, not by minimizing something) — those two buttons just don't apply. -->
          <button v-if="!isThreePane" @click="switchToThreePane()" class="hover:text-blue-500 transition" title="Open Full Workspace (3-pane)"><i class="fas fa-table-columns"></i></button>
          <button v-if="!isDock && !isThreePane" @click="cubo.currentLayout = 'MODAL_DOCK'" class="hover:text-blue-500 transition" title="Maximize Workspace"><i class="fas fa-columns"></i></button>
          <button v-else-if="!isThreePane" @click="cubo.currentLayout = 'EXPANDED'" class="hover:text-blue-500 transition" title="Minimize to Float Window"><i class="fas fa-window-restore text-blue-600"></i></button>
          <button v-if="!isThreePane" @click="cubo.currentLayout = 'FAB'" class="hover:text-red-500 transition" :title="isDock ? 'Minimize to Badge' : 'Minimize'"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <!-- Body: Threads / Profile / Chat -->
      <div class="flex-1 min-h-0 flex overflow-hidden relative">
        <!-- Thread directory overlay — FAB/EXPANDED/MODAL_DOCK only; THREE_PANE has its own
             permanent left-pane version above instead (never toggled, never overlaid). -->
        <div v-show="!isThreePane && cubo.viewingThreads" class="absolute inset-0 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto custom-scrollbar p-3 space-y-2">
          <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-slate-800">
            <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">{{ isDock ? 'Workspace Threads Matrix' : 'Active Workspace Threads' }}</span>
            <button @click="cubo.createNewThread('general')" class="text-[11px] bg-[var(--color-primary)]/10 text-[var(--color-primary)] px-2 py-0.5 rounded font-semibold hover:bg-[var(--color-primary)]/20 transition">+ General Thread</button>
          </div>

          <div v-for="thread in threads" :key="thread.id"
               class="flex items-center justify-between p-2.5 rounded-lg border transition group text-left"
               :class="cubo.activeThreadId === thread.id ? 'bg-blue-500/10 border-blue-500/30 text-blue-900 dark:text-blue-300' : 'bg-gray-50/50 dark:bg-slate-900/50 border-gray-200/60 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'">
            <div @click="cubo.switchThread(thread.id)" class="flex-1 cursor-pointer min-w-0 pr-2">
              <div class="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-slate-200">
                <i class="fas text-[11px]" :class="cubo.categoryMeta(thread.category).icon + ' ' + cubo.categoryMeta(thread.category).color"></i>
                <span class="truncate">{{ thread.title }}</span>
              </div>
              <div class="text-[10px] text-gray-400 mt-0.5 truncate">{{ thread.messages[thread.messages.length - 1]?.text || 'Empty trail workspace.' }}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button @click.stop="cubo.togglePinThread(thread.id)" class="text-xs transition p-1 hover:bg-gray-200 dark:hover:bg-slate-800 rounded">
                <i class="fas fa-thumbtack text-[10px]" :class="thread.pinned ? 'text-blue-500 rotate-0' : 'text-gray-300 dark:text-slate-600 -rotate-45'"></i>
              </button>
              <button @click.stop="cubo.deleteThread(thread.id)" class="text-xs text-gray-300 hover:text-red-500 transition p-1 rounded">
                <i class="fas fa-trash-alt text-[10px]"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- Profile / virtual room picker — FAB/EXPANDED/MODAL_DOCK only; THREE_PANE's right-pane
             "Profile" tab renders the same CuboProfilePanel content instead (never both). -->
        <div v-show="!isThreePane && cubo.viewingProfile" class="absolute inset-0 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto custom-scrollbar p-3">
          <CuboProfilePanel />
        </div>

        <!-- Chat -->
        <div v-show="!cubo.viewingThreads && !cubo.viewingProfile" class="flex-1 min-h-0 flex flex-col justify-between overflow-hidden bg-white dark:bg-slate-950">
          <!-- SPEC-22 §5.7 — the entry-menu nav strip that used to live here moved to the right
               pane's "Next Action" tab (see entryWorkflow.primaryActionIds/secondaryActionIds). Real correction: "the
               Register, Log-In, Forgot Password, Change Passwords appeared as chat message not in
               the next action. The next action should be based on the current xstate machine and
               suggested the next action from the current state" (explicit instruction) — these ARE
               entryWorkflow's own current-state-driven ready actions (same real "menu, not
               pipeline" xstate design as before), they just weren't surfaced in the one place
               state-machine-driven suggestions are supposed to live. The chat pane below now
               narrates only, same as every other thread. -->
          <div ref="chatHistoryEl" class="chat-history-container flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            <div class="text-center pb-2 border-b border-gray-100 dark:border-slate-900/60 flex items-center justify-between text-[11px] text-gray-400">
              <span class="font-medium">Active: <span class="text-gray-700 dark:text-slate-300">{{ activeThread?.title }}</span></span>
              <span>{{ activeThread?.category !== 'general' ? '🔒 Retention Checked (FIFO Limit: 25)' : '⚡ Temporary Session Stream' }}</span>
            </div>

            <div v-for="msg in timelineMessages" :key="msg.id" class="flex flex-col" :class="msg.isAudit ? 'items-center' : (msg.role === 'user' ? 'items-end' : 'items-start')">
              <!-- Audit trail row — "all state transitions and actions taken by user will be
                   created as timestamped audit log" (explicit instruction). Real, already-existing
                   data (workflowRuntime.js's own auditLog, entryWorkflow.js's own comment flagged
                   it as "not surfaced in any UI" until now) synthesized into the SAME timeline as a
                   compact system row, not a full chat bubble — see timelineMessages' own comment
                   for why this is scoped to the 'general' thread only so far. -->
              <div v-if="msg.isAudit" class="flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-slate-500 py-0.5">
                <i class="fas fa-code-branch text-[9px]"></i>
                <span>{{ msg.text }}</span>
                <span class="text-gray-300 dark:text-slate-600">· {{ cubo.formatMsgTime(msg.timestamp) }}</span>
              </div>

              <template v-else>
                <div v-if="msg.text" class="max-w-[85%] rounded-xl p-3 text-xs shadow-sm border leading-relaxed group relative"
                     :class="msg.role === 'user' ? 'bg-blue-600 text-white border-transparent rounded-br-none' : 'bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-slate-200 border-gray-100 dark:border-slate-800 rounded-bl-none'">
                  <span>{{ msg.text }}</span>

                  <div v-if="msg.role === 'assistant'" class="flex items-center gap-2 mt-2 pt-1.5 border-t border-gray-200/40 dark:border-slate-700/40 text-gray-400">
                    <button @click="copyMsg(msg.text)" class="hover:text-blue-500 transition p-0.5" title="Copy response text">
                      <i class="fas fa-copy text-[10px]"></i>
                    </button>
                    <button @click="setFeedback(msg, 'up')" class="transition p-0.5 hover:text-green-500" title="Good response">
                      <i class="fas fa-thumbs-up text-[10px]" :class="msg.feedback === 'up' ? 'text-green-500 font-black' : ''"></i>
                    </button>
                    <button @click="setFeedback(msg, 'down')" class="transition p-0.5 hover:text-red-500" title="Bad response">
                      <i class="fas fa-thumbs-down text-[10px]" :class="msg.feedback === 'down' ? 'text-red-500 font-black' : ''"></i>
                    </button>
                  </div>
                </div>

                <!-- SPEC-21 §5's role-based next-action suggestion — real navigation to one of the
                     3 onboarding journeys' page routes (onboardingJourneys.js), each link built
                     with its own real `route` — plain router.push, no tracked action involved. The
                     only rich-content message kind left here since SPEC-22 §5.1 moved the
                     entry-menu/form rendering out to the nav strip + host page's content pane. -->
                <div v-if="msg.component === 'nav-suggestion'" class="w-full max-w-[90%] mt-1 flex flex-wrap gap-2">
                  <button v-for="link in msg.componentProps?.links || []" :key="link.label" @click="router.push(link.route)"
                          class="cubo-entry-menu-btn">
                    <i class="fas fa-arrow-right"></i>{{ link.label }}
                  </button>
                </div>

                <span class="text-[9px] text-gray-400 dark:text-slate-500 mt-0.5 px-0.5">{{ cubo.formatMsgTime(msg.timestamp) }}</span>
              </template>
            </div>
          </div>

          <!-- Fixed at the bottom of its pane (a flex sibling of the now-properly-scrolling
               chat-history-container above, not part of the scroll flow) with a raised shadow —
               "should be fixed in the bottom viewport and look a bit projected" (explicit
               instruction). shrink-0 stops it from ever being compressed by its flex-col parent. -->
          <div :class="isRoomy ? 'p-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/10' : 'p-3 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/20'" class="shrink-0 z-10 shadow-[0_-6px_16px_-4px_rgba(0,0,0,0.12)] dark:shadow-[0_-6px_16px_-4px_rgba(0,0,0,0.4)]" style="position:relative">
            <!-- /shortcut autocomplete — standard slash-palette pattern, arrow-key navigable -->
            <div v-if="slashOpen && slashMatches.length" class="cubo-slash-dropdown">
              <div v-for="(m, idx) in slashMatches" :key="m.key"
                   class="cubo-slash-option" :class="idx === slashActiveIndex ? 'active' : ''"
                   @mousedown.prevent="pickSlashMatch(m)" @mouseenter="slashActiveIndex = idx">
                <span class="font-mono font-bold">/{{ m.key }}</span>
                <span class="text-gray-400 ml-1.5">{{ m.field.label }}</span>
              </div>
            </div>

            <!-- Progress indicator — no loading state existed here before this. -->
            <div v-if="isProcessing" class="cubo-progress-pill">
              <span class="cubo-progress-dots"><span></span><span></span><span></span></span>
              <span>{{ PROGRESS_STAGES[progressStage] }}…</span>
            </div>

            <textarea v-model="cubo.promptText"
                      @keydown="onTextareaKeydown"
                      class="w-full p-2.5 resize-none rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white mb-2"
                      :rows="isRoomy ? 3 : 2" :placeholder="isRoomy ? 'Enter instructions here... (/ for field shortcuts)' : 'Ask Cübo command center...'"></textarea>
            <div class="flex w-full items-center justify-between">
              <div class="flex items-center gap-2">
                <button @click="cubo.toggleVoiceInput()" class="cubo-mic-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 flex items-center justify-center transition" :class="cubo.isListening ? 'text-red-500 animate-pulse' : 'text-gray-500 dark:text-gray-400'" :title="cubo.isListening ? 'Listening… click to stop' : 'Voice input'"><i class="fas fa-microphone text-xs"></i></button>
                <button class="cubo-camera-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 text-gray-500 dark:text-gray-400 flex items-center justify-center transition"><i class="fas fa-camera text-xs"></i></button>
                <button class="cubo-attach-image-btn w-8 h-8 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 text-gray-500 dark:text-gray-400 flex items-center justify-center transition"><i class="fas fa-image text-xs"></i></button>
              </div>
              <button @click="sendPrompt()" :disabled="isThrottled" class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition shadow-sm">{{ isRoomy ? 'Send Command' : 'Send' }}</button>
            </div>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- ═══ RIGHT PANE: Profile / Next Best Action / dynamic content — THREE_PANE only, a real
         sibling of the middle card above (not nested inside its Body — a genuine third column
         spanning full height). "Profile section, Next Best Action..., other sections as we
         discover later.. all of these features will be in a seperate Tab" (explicit instruction).
         'content' is "shows pages as necessary": for now, the selected entry-journey form; the
         general mechanism (whatever a thread/action needs shown) generalizes from here later. ═══ -->
    <div v-if="isThreePane" class="cubo-3pane-content-col w-full md:w-[420px] shrink-0 flex flex-col overflow-hidden bg-gray-50/30 dark:bg-slate-900/10">
      <div class="flex border-b border-gray-200 dark:border-slate-800 shrink-0">
        <button v-for="tab in RIGHT_PANE_TABS" :key="tab.id" @click="rightPaneTab = tab.id"
                class="flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-semibold transition border-b-2"
                :class="rightPaneTab === tab.id ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-slate-300'">
          <i class="fas" :class="tab.icon"></i>
          <span class="hidden sm:inline">{{ tab.label }}</span>
          <span v-if="tab.id === 'next-best-action' && (journeyLinks.length || entryWorkflow.primaryActionIds.length || entryWorkflow.secondaryActionIds.length)" class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6">
        <template v-if="rightPaneTab === 'content'">
          <!-- Real onboarding-UI rebuild: Hospital/Staff/Patient setup no longer renders here —
               those are plain page-route journeys now (see journeyLinks/activateJourney below),
               real navigation to /onboarding etc., not panel content. Only the small, genuinely
               single-purpose auth forms (register/login/forgot_password/change_password) still
               mount inline in this content tab. -->
          <div v-if="entryWorkflow.activeEntryAction" class="cubo-inline-form-card max-w-md mx-auto">
            <component
              :is="ENTRY_FORM_COMPONENTS[entryWorkflow.activeEntryAction]"
              @success="onEntryFormSuccess"
              @skip="onSecurityQuestionSkip"
              @switch-to-login="entryWorkflow.selectEntryAction('login')"
              @switch-to-register="entryWorkflow.selectEntryAction('register')"
            />
          </div>
          <div v-else class="text-center mt-16 text-gray-400 dark:text-slate-500 text-sm">
            <i class="fas fa-hand-point-left text-2xl mb-3 block" style="color:var(--color-primary)"></i>
            Pick an option from Next Action to get started.
          </div>
        </template>

        <template v-else-if="rightPaneTab === 'next-best-action'">
          <!-- SPEC-22 §5.8 — real replacement: no more pre-auth/post-auth template fork. Two real
               sources, rendered side by side: journeyLinks (Facility/Provider/Patient — plain,
               untracked page-route journeys, see onboardingJourneys.js) is the real "suggested for
               you" section now (role-targeted, same as facility_registration/staff_registration
               used to be); entryWorkflow.secondaryActionIds (register/login/forgot_password/
               change_password/logout) is the universal auth menu, still plan-derived state. -->
          <p v-if="!auth.currentUser" class="text-sm text-gray-600 dark:text-slate-300 mb-2">{{ ENTRY_INTRO_TEXT }}</p>

          <div v-if="journeyLinks.length" class="space-y-1.5">
            <p class="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Suggested for you</p>
            <button v-for="journey in journeyLinks" :key="journey.id" @click="activateJourney(journey)" class="cubo-entry-menu-btn w-full">
              <i class="fas" :class="journey.icon"></i>{{ journey.title }}
            </button>
          </div>

          <div v-if="entryWorkflow.secondaryActionIds.length" :class="journeyLinks.length ? 'mt-6 pt-4 border-t border-gray-100 dark:border-slate-800' : ''">
            <p v-if="journeyLinks.length" class="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Also available</p>
            <div class="space-y-1.5">
              <button v-for="id in entryWorkflow.secondaryActionIds" :key="id" @click="activateAccountAction(id)"
                      class="cubo-entry-menu-btn w-full" :class="entryWorkflow.activeEntryAction === id ? 'cubo-entry-menu-btn-active' : ''">
                <i class="fas" :class="entryActionMeta(id).icon"></i>{{ entryActionMeta(id).label }}
              </button>
            </div>
          </div>

          <div v-if="!journeyLinks.length && !entryWorkflow.secondaryActionIds.length" class="text-center mt-16 text-gray-400 dark:text-slate-500 text-sm">
            <i class="fas fa-lightbulb text-2xl mb-3 block" style="color:var(--color-primary)"></i>
            No suggested next action right now.
          </div>
        </template>

        <CuboProfilePanel v-else-if="rightPaneTab === 'profile'" />
      </div>
    </div>
  </div>
</template>

<style>
@import './cubo.css';
</style>
