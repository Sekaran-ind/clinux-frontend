import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cubo_chat_history localStorage key (the cubo.threads array). One row
// per thread: { id, category, title, pinned, timestamp, encounterId, messages: [{id, role, text, timestamp}] }
// encounterId is optional/additive — only threads created via an <Cubo :encounter-id> prop have
// it; plain category threads (front-desk, billing, ai-engine, ...) leave it null.
export const chatThreads = createLocalCollection('cubo_chat_history_v2');
