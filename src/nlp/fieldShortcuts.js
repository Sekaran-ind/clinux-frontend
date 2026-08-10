// Deterministic /shortcut alternative to formSlotEngine.js's probabilistic NLP recognition —
// see clinux-cubo-pacer-progress-slash-shortcuts memory note. Every harvested field gets a
// short, GUARANTEED-UNIQUE key derived from its label's word-initials; typing /key in Cubo maps
// straight to that field, bypassing NLP ambiguity entirely.
import { harvestFieldMetadata } from './formFieldHarvester.js';

let cachedIndex = null; // Map<key, field>

function keyFromLabel(label) {
  const words = (label || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length === 0) return null;
  const initials = words.map((w) => w[0]).join('');
  // Single-word labels ("Status") would collapse to a 1-char key shared by nearly every form —
  // use the first 3 chars of that one word instead so keys stay meaningfully distinct.
  return initials.length >= 2 ? initials : words[0].slice(0, 3);
}

// Builds (and caches) the key -> field map. Collisions get an incrementing numeric suffix
// appended, in harvest order, so no two fields ever silently share one key — deterministic, not
// first-come-first-served ambiguity like formSlotEngine's shared-entity NER lookup.
export function buildShortcutIndex() {
  if (cachedIndex) return cachedIndex;
  cachedIndex = new Map();
  harvestFieldMetadata().forEach((field) => {
    const base = keyFromLabel(field.label);
    if (!base) return;
    let key = base;
    let n = 2;
    while (cachedIndex.has(key)) {
      key = base + n;
      n++;
    }
    cachedIndex.set(key, field);
  });
  return cachedIndex;
}

// For the autocomplete dropdown — every {key, field} whose key starts with the (already
// lowercased) prefix, sorted for stable display order.
export function matchShortcuts(prefix) {
  const index = buildShortcutIndex();
  const p = (prefix || '').toLowerCase();
  return Array.from(index.entries())
    .filter(([key]) => key.startsWith(p))
    .map(([key, field]) => ({ key, field }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Parses "/key rest of the message" into a resolved field+value, an ambiguous-prefix result, or
// null if nothing matches at all. Exact key match always wins over prefix-ambiguity, even if the
// exact key also happens to prefix other longer keys (e.g. "cc" for Chief Complaint vs a
// hypothetical "cc2") — an exact match is never actually ambiguous.
export function resolveShortcutMessage(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const rawKey = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const value = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  if (!rawKey) return null;

  const index = buildShortcutIndex();
  if (index.has(rawKey)) {
    if (!value) return { ambiguous: null, incomplete: true, field: index.get(rawKey) };
    return { field: index.get(rawKey), value };
  }

  const candidates = matchShortcuts(rawKey);
  if (candidates.length > 0) return { ambiguous: candidates };
  return null;
}
