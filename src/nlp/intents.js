// Lightweight, client-side intent classification for what the user types into Cübo — additive,
// NOT a replacement for the LLM-based scribe call clinuxflow-api's /api/workflow/test-scribe
// makes. This runs first/alongside so Cübo can recognize a handful of explicit commands (e.g.
// "generate the SOAP note") before falling back to free-form chat. The starter intent set below
// is intentionally minimal — training a real command vocabulary is future work once the chat's
// actual command surface is decided; this proves the integration point works end-to-end.
//
// node-nlp is loaded via a dynamic import, not a static top-level one, and every call is
// wrapped in try/catch: at the pinned 5.0.0-alpha.5 version, its CJS dependency graph
// (@nlpjs/core-loader's class-extends chain) breaks under Vite's automatic CJS->ESM interop
// hard enough to throw at module-evaluation time — with a static import that took the entire
// app down (nothing could mount) because Cubo.vue is on every page's critical path. Deferring
// the import to first actual use, and failing soft, means a regression in this alpha dependency
// degrades to "no local intent classification" instead of "nothing loads."
let managerPromise = null;

async function ensureTrained() {
  if (!managerPromise) {
    managerPromise = import('node-nlp').then(({ NlpManager }) => {
      const m = new NlpManager({ languages: ['en'], forceNER: false });

      m.addDocument('en', 'generate the soap note', 'generate_soap');
      m.addDocument('en', 'generate soap draft', 'generate_soap');
      m.addDocument('en', 'create the soap note from the chat', 'generate_soap');
      m.addDocument('en', 'write up the note', 'generate_soap');

      m.addDocument('en', 'switch to cardiology', 'switch_room');
      m.addDocument('en', 'change my speciality', 'switch_room');
      m.addDocument('en', 'switch virtual room', 'switch_room');
      m.addDocument('en', 'change role to nurse', 'switch_room');

      m.addAnswer('en', 'generate_soap', 'Generating the SOAP note from the current chat.');
      m.addAnswer('en', 'switch_room', 'Open the Profile panel to pick a new speciality/role.');

      return m.train().then(() => m);
    });
  }
  return managerPromise;
}

// Returns { intent, score } for the best-matching intent, or { intent: 'general_chat', score: 0 }
// if nothing scored above threshold, or if node-nlp itself failed to load/train — callers decide
// what to do with a low-confidence result (Cubo.vue currently just falls through to normal chat).
export async function classifyIntent(text, threshold = 0.6) {
  try {
    const m = await ensureTrained();
    const result = await m.process('en', text);
    if (result.intent && result.score >= threshold) {
      return { intent: result.intent, score: result.score };
    }
    return { intent: 'general_chat', score: result.score ?? 0 };
  } catch (err) {
    console.warn('nlp.js intent classification unavailable, falling back to general_chat:', err.message);
    managerPromise = null; // allow a retry on the next call rather than caching the failure forever
    return { intent: 'general_chat', score: 0 };
  }
}
