// The journey runner the workspace uses: every journey is JSON (specs/*.journey.json) plus named
// handlers, run by the XState engine (engine.js). This module used to be clinux-cubo's LangGraph
// runtime (copied from there); the workspace moved to XState as its deterministic layer, and the
// same engine is meant for cubo-diary and clinux-cubo's surfaces. Kept as the import path
// journeys/sessions.js and the tests already use.
export { createXStateRunner as createRunner } from './engine.js';
