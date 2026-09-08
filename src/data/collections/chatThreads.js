import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cubo_chat_history localStorage key (the cubo.threads array). One row
// per thread: { id, category, title, pinned, timestamp, encounterId, messages: [{id, role, text, timestamp, component, componentProps}] }
// encounterId is optional/additive — only threads created via an <Cubo :encounter-id> prop have
// it; plain category threads (front-desk, billing, ai-engine, ...) leave it null.
//
// SPEC-20's rich-content messages: `component`/`componentProps` are optional/additive (undefined
// on every message before this session, and on any message that's just plain text) — when set,
// Cubo.vue's render loop renders a rich-content block in place of/alongside the text bubble
// instead of just rendering `text`. As of SPEC-22 §5.1 the only real value is 'nav-suggestion'
// (SPEC-21 §5's role-based next-action links) — the entry-menu/form-rendering messages this
// originally carried moved out to Cubo.vue's own nav strip + entryWorkflow.js's shared
// activeEntryAction (rendered by whichever page hosts the content pane), so a message no longer
// needs to carry a live, submittable form.
export const chatThreads = createLocalCollection('cubo_chat_history_v2');
