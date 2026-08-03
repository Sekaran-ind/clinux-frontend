import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cubo_chat_history localStorage key (the cubo.threads array). One row
// per thread: { id, category, title, pinned, timestamp, messages: [{id, role, text, timestamp}] }
export const chatThreads = createLocalCollection('cubo_chat_history_v2');
