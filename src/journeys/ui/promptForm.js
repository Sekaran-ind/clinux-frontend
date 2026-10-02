// The prompt contract's form logic, shared by the journey's form pane (JourneyPanel.vue), Cübo's
// chat (an answer typed into the journey's thread) and the session store (sessions.js). A prompt
// is { text, detail?, list?, map?, link?, choices? | fields?, resend?, warning?, image?, error? }
// (see engine.js); a field is { name, label, type?, options?, required?, pattern?, secret?, mask?,
// readonly?, value?, near? }.

const emptyValue = (f) =>
  f.type === 'checkbox' ? false
    : f.type === 'multiselect' ? []
      : f.type === 'geo' || f.type === 'image' ? null
        : f.type === 'consent' ? { agreed: false, language: 'en' }
          : '';

/**
 * The form's starting values. `kept` is what was entered last time this same step was asked: on
 * a re-ask after an error it is kept (never a secret like an OTP or password) so only the wrong
 * part needs fixing.
 */
export function initialValues(prompt, kept = {}) {
  const values = {};
  for (const f of prompt?.fields || []) {
    const v = !f.secret && Object.hasOwn(kept, f.name) ? kept[f.name] : undefined;
    values[f.name] = v ?? f.value ?? emptyValue(f);
  }
  return values;
}

export const optionLabel = (f, v) => f.options?.find((o) => o.value === v)?.label ?? v;

const isEmpty = (f, v) =>
  v === '' || v === false || v == null || (Array.isArray(v) && !v.length) || (f.type === 'consent' && !v.agreed);

/** The first problem with the form's values, or '' when it can be sent. */
export function check(prompt, values) {
  for (const f of prompt?.fields || []) {
    const v = values[f.name];
    const empty = isEmpty(f, v);
    if (f.type === 'consent' && f.required && empty) return 'Please read and agree to the consent to continue.';
    if (f.required && empty) return `${f.label} is required.`;
    if (!empty && f.pattern && !new RegExp(f.pattern).test(String(v).trim())) return `${f.label} doesn't look right${f.hint ? ` (${f.hint})` : ''}.`;
    if (f.type === 'geo' && !empty && !(Number.isFinite(v.lat) && Number.isFinite(v.lng))) return 'Pin the location on the map.';
  }
  return '';
}

/** What the person answered, as the chat shows it — secrets masked, read-only fields left out. */
export function summarise(prompt, answer) {
  if (answer.resend) return 'Resend OTP';
  if (answer.action) return prompt.actions?.find((a) => a.value === answer.action)?.label ?? String(answer.action);
  if (answer.qr) return `Saved: ${prompt.form?.title || 'the form'}`;
  if (answer.choice !== undefined) return prompt.choices?.find((c) => c.value === answer.choice)?.label ?? String(answer.choice);
  return (prompt.fields || [])
    .filter((f) => !isEmpty(f, answer[f.name]))
    .map((f) => {
      const v = answer[f.name];
      if (f.secret) return `${f.label}: ••••••`;
      if (f.mask === 'last4') return `${f.label}: ••••••${String(v).slice(-4)}`;
      if (f.type === 'checkbox') return `✓ ${f.label}`;
      if (f.type === 'multiselect') return `${f.label}: ${v.map((x) => optionLabel(f, x)).join(', ')}`;
      if (f.type === 'geo') return `📍 ${v.lat}, ${v.lng}`;
      if (f.type === 'image') return `📎 ${f.label}: ${v.name}`;
      if (f.type === 'consent') return `✓ Agreed to NHA's Aadhaar consent (${f.texts[v.language].label})`;
      if (f.readonly) return null;
      return `${f.label}: ${f.type === 'select' ? optionLabel(f, v) : v}`;
    })
    .filter(Boolean)
    .join('\n');
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// Field kinds a single chat message can answer. Secrets and masked numbers (OTP, password,
// Aadhaar) are form-only: whatever is typed into the chat is kept in the thread as typed.
const CHAT_TYPES = new Set([undefined, 'text', 'email', 'tel', 'number', 'select']);

/**
 * Turns a message typed into the journey's Cübo thread into an answer for the current prompt:
 * a choice (by its label, its value, or its number in the list), or the one field of a one-field
 * form. Returns { value } to send, or { reason } when the form pane is needed instead.
 */
export function chatAnswer(prompt, text) {
  const t = norm(text);
  if (!prompt) return { reason: 'This journey is not waiting for an answer right now.' };
  if (!t) return { reason: 'Type an answer.' };
  if (prompt.choices?.length) {
    const byNumber = /^\d+$/.test(t) ? prompt.choices[Number(t) - 1] : null;
    const exact = prompt.choices.find((c) => norm(c.label) === t || norm(c.value) === t);
    // Part of a label counts only when it picks out exactly one choice.
    const partial = t.length >= 3 ? prompt.choices.filter((c) => norm(c.label).includes(t)) : [];
    const hit = byNumber || exact || (partial.length === 1 ? partial[0] : null);
    if (hit) return { value: { choice: hit.value } };
    return { reason: `Pick one of: ${prompt.choices.map((c, i) => `${i + 1}. ${c.label}`).join(' · ')}` };
  }
  const editable = (prompt.fields || []).filter((f) => !f.readonly);
  if (editable.length !== 1 || !CHAT_TYPES.has(editable[0].type) || editable[0].secret || editable[0].mask) {
    return { reason: 'This step needs the form — switch to Form to fill it in.' };
  }
  const f = editable[0];
  let v = String(text).trim();
  if (f.type === 'select') {
    const o = f.options?.find((x) => norm(x.label) === t || norm(x.value) === t);
    if (!o) return { reason: `${f.label}: choose one of ${f.options?.slice(0, 8).map((x) => x.label).join(', ')}${f.options?.length > 8 ? '…' : ''}` };
    v = o.value;
  }
  const values = { ...initialValues(prompt), [f.name]: v };
  const problem = check(prompt, values);
  return problem ? { reason: problem } : { value: values };
}

/**
 * The address a geo field can be found from (its `near: { fields, context }`): the named fields'
 * current values (select fields by their label) followed by fixed context such as the district
 * and state already chosen. Empty when nothing has been entered yet.
 */
export function addressFor(prompt, field, values) {
  const near = field?.near;
  if (!near) return { parts: {}, text: '' };
  const byName = Object.fromEntries((prompt?.fields || []).map((f) => [f.name, f]));
  const parts = {};
  for (const name of near.fields || []) {
    const f = byName[name];
    const v = values[name];
    if (f && v !== '' && v != null) parts[name] = String(f.type === 'select' ? optionLabel(f, v) : v).trim();
  }
  const entered = Object.values(parts).filter(Boolean);
  const text = entered.length ? [...entered, ...(near.context || [])].filter(Boolean).join(', ') : '';
  return { parts, context: near.context || [], text };
}
