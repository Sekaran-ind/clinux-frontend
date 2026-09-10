// SPEC-24 §7 step 6 (Patient) — request-body builders for clinuxflow-abdm-gateway's /abha/*
// routes, the ABHA (Ayushman Bharat Health Account) counterpart to abdmAdapter.js's own HPR/HFR
// builders. Unlike abdmAdapter.js, these never read a FHIR record via getAnswer() — ABHA
// enrolment/login/search are all transient, patient-in-front-of-you flows (aadhaar/mobile/OTP
// typed in the moment), not derived from an already-saved record. Every shape here matches
// exactly what clinuxflow-abdm-gateway/src/routes/abha.js's own handlers destructure — the
// gateway does the RSA encryption server-side, so nothing here needs to touch encryption at all
// (same "the gateway is what actually receives these" discipline abdmAdapter.js's own header
// documents).

// ─────────────────────────────── Find (existing ABHA lookup, doc §7.6.1) ──────────────────────

export function buildAbhaFindSearchBody(mobile) {
  return { mobile };
}

// The two OTP steps after a Find match is chosen reuse the SAME generic login endpoints below
// (loginHint:'index', the matched entry's own index as loginId, otpSystem:'abdm') — see
// PatientAbhaPanel.vue's own header for why this needs no separate gateway route.
export function buildAbhaFindVerifyRequestOtpBody(matchIndex) {
  return { scope: ['abha-login', 'search-abha', 'mobile-verify'], loginHint: 'index', loginId: String(matchIndex), otpSystem: 'abdm' };
}

// ─────────────────────────────── Login (doc §7) ────────────────────────────────────────────────

export function buildAbhaLoginRequestOtpBody({ scope, loginHint, loginId, otpSystem }) {
  return { scope, loginHint, loginId, otpSystem };
}

export function buildAbhaLoginVerifyOtpBody(txnId, otp, scope) {
  return { txnId, otp, scope };
}

// ─────────────────────────────── Enrolment via Aadhaar (doc §3) ───────────────────────────────

export function buildAbhaAadhaarOtpBody(aadhaar) {
  return { aadhaar };
}

export function buildAbhaVerifyAadhaarOtpBody(txnId, otp, mobile) {
  return { txnId, otp, mobile };
}

export function buildAbhaMobileOtpBody(txnId, mobile) {
  return { txnId, mobile };
}

export function buildAbhaVerifyMobileOtpBody(txnId, otp) {
  return { txnId, otp };
}

export function buildAbhaAddressBody(txnId, abhaAddress) {
  return { txnId, abhaAddress };
}

// Real gap found while auditing pending onboarding items: buildAbhaAddressBody above already
// existed (prep work), but nothing in PatientAbhaPanel.vue ever called the address-suggestions/
// address routes, or this one — email verification (doc §3 step 5) was flagged as "deliberately
// deferred polish" in that panel's own header comment and stayed unbuilt. Needs the real per-user
// X-ABHA-Token header (see callAbdmGateway's extraHeaders), not a body field — the gateway route
// destructures `requireAbhaToken(c)` from the header, `email` from the body.
export function buildAbhaEmailVerificationLinkBody(email) {
  return { email };
}
