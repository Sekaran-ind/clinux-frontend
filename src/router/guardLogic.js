// Pure decision logic for the auth guard, extracted so it's testable without a live
// router/Pinia instance (same reasoning as data/formData.js's pure getAnswer/getAnswers).
export function resolveGuard(meta, currentUser) {
  if (!meta.requiresAuth) return true;
  return currentUser ? true : { name: 'index' };
}
