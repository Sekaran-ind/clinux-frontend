import { createLocalCollection } from '../collectionFactory.js';
import { apiFetch } from '../../config.js';

// SPEC-22 decision #2's real loader, frontend half — mirrors formsLibrary.js exactly (same
// collection shape, same seed-once convention), but for compiled/extracted PlanDefinitions
// instead of Questionnaires. One record per flowId:
//   { flowId, isSystem, archived, activeVersion, versions: [{version, status, yaml, planDefinition, savedAt}] }
export const flowsLibrary = createLocalCollection('cf_flows_library_v1', {
  getKey: (r) => r.flowId,
});

// Fetches clinuxflow-api's pre-compiled-and-extracted system-flows catalog and inserts any flowId
// not already present — same "seed once, never overwrite a locally-edited copy" behavior
// formsLibrary.js's seedSystemForms() already established. Returns true if anything was added.
export async function seedSystemFlows(apiBase) {
  const res = await apiFetch(`${apiBase}/api/workflow/system-flows`).then((r) => r.json());
  if (!res.success) {
    console.warn('Could not load system flows catalog:', res.error);
    return false;
  }

  let changed = false;
  Object.entries(res.systemFlows).forEach(([flowId, entry]) => {
    if (!flowsLibrary.has(flowId)) {
      flowsLibrary.insert({ flowId, ...entry });
      changed = true;
    }
  });
  return changed;
}

export function activeFlowVersionNumber(flowId) {
  const entry = flowsLibrary.get(flowId);
  if (!entry) return null;
  return entry.activeVersion || entry.versions[entry.versions.length - 1]?.version;
}

// The real thing this whole loader exists for: a compiled-from-YAML, extracted PlanDefinition —
// the SAME shape workflowRuntime.js's registerPlan() already accepts, sourced from the real
// SPEC-18 pipeline instead of a hand-authored JS object. Returns null if the flow hasn't been
// seeded yet (e.g. seedSystemFlows() hasn't resolved) — callers (Designer.vue's own Room-Architect
// view, today) decide what "not loaded yet" means for them; a graceful null, not a hard dependency,
// is the safe contract here.
export function activePlanDefinition(flowId) {
  const entry = flowsLibrary.get(flowId);
  if (!entry) return null;
  const version = activeFlowVersionNumber(flowId);
  const v = entry.versions.find((v) => v.version === version);
  return v ? v.planDefinition : null;
}
