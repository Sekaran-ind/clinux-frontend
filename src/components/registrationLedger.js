// RegistrationLedger.vue's own pure click-handling logic, split out for the same reason
// adaptiveSectionNav.js is — this repo has no @vue/test-utils, nothing mounts a .vue component in
// its own tests (see adaptiveSectionNav.js's own header); components get verified by running the
// app (live-verified), plain logic like this by a real test.

// Clicking a 'blocked' stage never navigates — it only toggles that stage's own locked-reason
// reveal (clicking it again, or picking a different blocked stage, closes/switches it). Clicking
// any other state ('done'/'active'/'pending') navigates there and closes any open reveal.
export function selectStage(stage, { revealedBlockedId } = {}) {
  if (stage.state === 'blocked') {
    return { nextActiveId: undefined, nextRevealedBlockedId: revealedBlockedId === stage.id ? null : stage.id };
  }
  return { nextActiveId: stage.id, nextRevealedBlockedId: null };
}
