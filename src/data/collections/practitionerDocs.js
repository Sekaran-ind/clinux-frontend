import { createLocalCollection } from '../collectionFactory.js';

// A practitioner's own professional documents (degree certificates, council registration,
// experience letters, etc.) — distinct from ABDM/HPR's own document-list retrieval
// (ProviderHprPanel.vue's "My Documents", which reads back whatever ABDM's registry already
// holds). This is the app's own LOCAL store, same local-first-with-optional-LAN-sync shape
// encounterDocs.js's prescriptions/encounterImages already use (createLocalCollection wires that
// in automatically). Uploading one of these TO ABDM itself is now real too (ProviderHprPanel.vue's
// own "Upload Document" action, POST /v4/int/apis/v1/uploads/upload-document via
// clinuxflow-abdm-gateway's /hpr/professional/documents/upload) — a prior session's own comment
// here incorrectly claimed no such API exists at all; confirmed factually wrong against the real
// spec PDF.
//
// { id, accountId, filename, docType, dataUrl, uploadedAt }
export const practitionerDocuments = createLocalCollection('cf_practitioner_documents_v1');

// The real NHPR spec's own 6 document types (Upload Documents API) — each one corresponds to a
// specific qualification/registration entry via the spec's own document_id correlation; a prior
// version of this list ("Degree Certificate, Medical/Nursing Council Registration, Government ID,
// Experience Certificate, Other") was invented, not drawn from the spec — confirmed inconsistent
// and replaced. Human-readable labels for this app's own local upload UI; DOC_TYPE_CODES (same
// order) is the machine `documentType` value the real ABDM API itself expects.
export const DOC_TYPES = [
  'Profile Photo',
  'Degree Certificate',
  'Registration Certificate',
  'Proof of Work Certificate',
  'Proof of Name Change (Registration Certificate)',
  'Proof of Name Change (Qualification Certificate)',
];
export const DOC_TYPE_CODES = [
  'profilePhoto',
  'degreeCertificate',
  'registrationCertificate',
  'proofOfWorkCertificate',
  'proofOfNameChangeRegCertificate',
  'proofOfNameChangeQualCertificate',
];
export function docTypeCode(label) {
  const index = DOC_TYPES.indexOf(label);
  return index === -1 ? '' : DOC_TYPE_CODES[index];
}

export function getMyDocuments(accountId) {
  return practitionerDocuments.toArray
    .filter((d) => d.accountId === accountId)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}
