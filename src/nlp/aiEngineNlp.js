// nlp.js-backed intent + slot extraction for AiEngine.vue — retrofitted from clinixflow's
// public/ai-engine.html sandbox rewrite (which itself replaced that page's original brittle
// keyword/regex router).
//
// Imports the lower-level @nlpjs/nlp package (its Nlp class) directly rather than the full
// node-nlp umbrella package, even though node-nlp is the one listed as this project's direct
// dependency. Verified directly: a static build succeeds either way, but node-nlp's dependency
// graph includes @nlpjs/request -> https-proxy-agent -> agent-base, whose `class Agent extends
// events_1.EventEmitter` throws "Class extends value undefined is not a constructor or null" the
// moment the module is evaluated in a browser — Vite externalizes Node's `events` built-in for
// browser targets, so `events_1` is undefined there. This exercises the exact fragility
// nlp/intents.js's own comment already flags for this pinned 5.0.0-alpha.5 version; @nlpjs/nlp
// alone (core/nlu/ner/nlg/sentiment/slot, no @nlpjs/request in its graph) doesn't pull in that
// chain and loads cleanly. @nlpjs/nlp is already present in node_modules as node-nlp's own
// transitive dependency, so this doesn't add a new package.
//
// Loaded via a dynamic import, not a static top-level one, for the same defensive reason
// intents.js uses one. Unlike intents.js (where nlp.js is optional — a failure there just means
// Cübo skips its command shortcut and falls through to normal chat), nlp.js IS the actual
// tool-selection mechanism for this page, so a training failure here is surfaced to the caller
// (AiEngine.vue logs it and leaves `ready` false) rather than failed-soft into some fallback
// parser — there isn't one anymore.
let managerPromise = null;

function ensureTrained() {
  if (!managerPromise) {
    managerPromise = import('@nlpjs/nlp').then(({ Nlp }) => {
      // autoSave: false — Nlp defaults to writing a trained-model file to disk after train(),
      // which throws ("File cannot be written in web") with no filesystem to write to.
      const nlp = new Nlp({ languages: ['en'], forceNER: true, autoSave: false, nlu: { log: false } });

      // Enum-valued fields (gender/staffRole/encStatus/priority) are trained as NER rule
      // entities via the lower-level addNerRuleOptionTexts (the Nlp class's own method — the
      // NlpManager wrapper's more familiar addNamedEntityText name isn't available here since
      // that convenience wrapper lives in node-nlp/@nlpjs/basic, not in @nlpjs/nlp alone).
      nlp.addNerRuleOptionTexts('en', 'gender', 'male', ['male', 'man']);
      nlp.addNerRuleOptionTexts('en', 'gender', 'female', ['female', 'woman']);
      nlp.addNerRuleOptionTexts('en', 'gender', 'other', ['other', 'non-binary', 'nonbinary']);

      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Chief of Medicine', ['chief of medicine', 'chief physician']);
      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Doctor', ['doctor', 'physician']);
      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Nurse', ['nurse']);
      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Administrator', ['administrator', 'admin']);
      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Receptionist', ['receptionist', 'front desk']);
      nlp.addNerRuleOptionTexts('en', 'staffRole', 'Radiologist', ['radiologist', 'radiology']);

      nlp.addNerRuleOptionTexts('en', 'encStatus', 'arrived', ['arrived', 'checked in', 'check in']);
      nlp.addNerRuleOptionTexts('en', 'encStatus', 'in-progress', ['in progress', 'ongoing', 'started']);
      nlp.addNerRuleOptionTexts('en', 'encStatus', 'finished', ['finished', 'completed', 'done']);
      nlp.addNerRuleOptionTexts('en', 'encStatus', 'cancelled', ['cancelled', 'canceled']);

      nlp.addNerRuleOptionTexts('en', 'priority', 'Emergency', ['emergency', 'urgent', 'critical']);
      nlp.addNerRuleOptionTexts('en', 'priority', 'Normal', ['normal', 'routine']);

      const intents = {
        add_patient: ['add patient', 'register patient', 'add a new patient', 'create patient record', 'new patient', 'add inpatient', 'add outpatient patient'],
        update_patient: ['update patient', 'change patient', 'edit patient record', 'update patient record'],
        delete_patient: ['delete patient', 'remove patient'],
        add_staff: ['add staff', 'register staff', 'add a new staff member', 'add doctor', 'add nurse', 'onboard staff', 'hire staff'],
        update_staff: ['update staff', 'change staff', 'edit staff record'],
        delete_staff: ['delete staff', 'remove staff'],
        add_encounter: ['log encounter', 'add encounter', 'create encounter', 'log a visit', 'log a consultation', 'log consultation for'],
        update_encounter: ['update encounter', 'change encounter status', 'mark encounter'],
        delete_encounter: ['delete encounter', 'remove encounter', 'cancel encounter'],
      };
      Object.entries(intents).forEach(([intent, examples]) => {
        examples.forEach((ex) => nlp.addDocument('en', ex, intent));
      });

      return nlp.train().then(() => nlp);
    });
  }
  return managerPromise;
}

// Called once from AiEngine.vue's onMounted so training failures surface there (as a trace-log
// error, ready staying false) instead of on the first user message.
export function warmUp() {
  return ensureTrained();
}

function nlpEntity(result, entityName) {
  const found = (result.entities || []).find((e) => e.entity === entityName);
  return found ? found.option : '';
}

// ─── Free-text slot extraction (regex/heuristics) — enum-valued fields (gender/staffRole/
// encStatus/priority) are pulled from nlp.js's trained entities above; free-text fields (name,
// email, phone, chief complaint) have no fixed value set to train against, so nlp.js NER doesn't
// help here — same reasoning as the sandbox HTML port. NAME_STOP is deliberately wider than a
// plain name-stop list would need: every enum-entity synonym trained above also needs excluding,
// or e.g. "Doctor" in "as a doctor" gets mistaken for part of a proper name. ───
const NAME_STOP = ['add', 'register', 'new', 'patient', 'staff', 'doctor', 'nurse', 'a', 'an', 'the', 'as',
  'update', 'change', 'edit', 'delete', 'remove', 'cancel', 'log', 'encounter', 'visit', 'consultation', 'for', 'with', 'record', 'of',
  'chief', 'medicine', 'administrator', 'receptionist', 'radiologist', 'physician', 'nonbinary',
  'male', 'female', 'other', 'man', 'woman', 'emergency', 'normal', 'routine', 'urgent', 'critical',
  'arrived', 'finished', 'completed', 'done', 'progress', 'ongoing', 'started', 'checked', 'cancelled', 'canceled'];

function extractName(text, skip) {
  const words = text.split(/\s+/);
  const candidates = words
    .filter((w) => {
      const c = w.replace(/[^a-zA-Z]/g, '');
      return c.length > 0 && !NAME_STOP.includes(c.toLowerCase()) && c[0] === c[0].toUpperCase() && c[0] !== c[0].toLowerCase();
    })
    .map((w) => w.replace(/[,.;:]+$/, ''));
  if (candidates.length === 0) return '';
  if (candidates.length === 1) return candidates[0];
  return candidates.slice(skip || 0, (skip || 0) + 2).join(' ') || candidates[0];
}
function extractEmail(text) {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  return m ? m[0] : '';
}
function extractPhone(text) {
  const m = text.match(/(\+?\d[\d\s-]{7,}\d)/);
  return m ? m[0].trim() : '';
}
function extractBirthdate(text) {
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : '';
}
const SPECIALTIES = ['cardiology', 'cardiologist', 'radiology', 'radiologist', 'orthopaedics', 'orthopedics', 'orthopaed', 'neurology', 'neurologist', 'oncology', 'oncologist', 'pediatrics', 'paediatrics', 'general medicine'];
function extractSpecialty(text) {
  const t = text.toLowerCase();
  for (const sp of SPECIALTIES) { if (t.includes(sp)) return sp.charAt(0).toUpperCase() + sp.slice(1); }
  return '';
}
const CC_KEYWORDS = ['chest pain', 'fever', 'shortness of breath', 'headache', 'nausea', 'vomiting', 'cough', 'dizziness', 'fatigue', 'abdominal pain', 'back pain'];
function extractChiefComplaint(text) {
  const t = text.toLowerCase();
  for (const kw of CC_KEYWORDS) { if (t.includes(kw)) return kw.charAt(0).toUpperCase() + kw.slice(1); }
  return '';
}

// Single entry point AiEngine.vue calls per message — combines nlp.js's intent+entity
// classification with the regex slot extractors above into one flat, ready-to-use result, so the
// component's own executeIntent() switch doesn't need to know anything about nlp.js internals.
export async function classify(prompt) {
  const nlp = await ensureTrained();
  const result = await nlp.process('en', prompt);
  return {
    intent: result.intent,
    score: result.score || 0,
    name: extractName(prompt),
    physicianName: extractName(prompt, 1),
    gender: nlpEntity(result, 'gender'),
    staffRole: nlpEntity(result, 'staffRole'),
    encStatus: nlpEntity(result, 'encStatus'),
    priority: nlpEntity(result, 'priority'),
    email: extractEmail(prompt),
    phone: extractPhone(prompt),
    birthdate: extractBirthdate(prompt),
    specialty: extractSpecialty(prompt),
    chiefComplaint: extractChiefComplaint(prompt),
  };
}
