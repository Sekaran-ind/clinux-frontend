// ABDM health information exchange, through clinuxflow-abdm-gateway's /hie/* routes and the
// facility settings on /abha/scan-share (src/routes/hip.js, hiu.js, scanPay.js, scanShare.js there):
//   M2 (HIP)   share a visit to the patient's ABHA; consents and transfers; patient link requests
//   M3 (HIU)   ask a patient for their records elsewhere; read what arrives
//   Scan & Pay bills for the patient's ABHA app; orders and payments
//   Running Token   call the next token at a counter
import { gateway } from '../journeys/gateway.js';

const q = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

// Facility settings (HIU role, Scan & Pay, UPI id).
export const updateFacilitySettings = (facilityId, body) => gateway(`/abha/scan-share/facilities/${encodeURIComponent(facilityId)}`, { method: 'PATCH', body });

// M2: HIP
export const shareCareContext = (body) => gateway('/hie/hip/care-contexts', { method: 'POST', body });
export const listCareContexts = (params = {}) => gateway(`/hie/hip/care-contexts${q(params)}`);
export const relinkCareContext = (id) => gateway(`/hie/hip/care-contexts/${encodeURIComponent(id)}/link`, { method: 'POST', body: {} });
export const smsNotify = (facilityId, phoneNo) => gateway('/hie/hip/sms-notify', { method: 'POST', body: { facilityId, phoneNo } });
export const listLinkRequests = () => gateway('/hie/hip/link-requests');
export const listHipConsents = () => gateway('/hie/hip/consents');

// M3: HIU
export const listConsentRequests = (abhaAddress) => gateway(`/hie/hiu/consent-requests${q({ abhaAddress })}`);
export const requestConsent = (body) => gateway('/hie/hiu/consent-requests', { method: 'POST', body });
export const refreshConsentStatus = (id) => gateway(`/hie/hiu/consent-requests/${encodeURIComponent(id)}/status`, { method: 'POST', body: {} });
export const fetchConsentData = (consentId) => gateway(`/hie/hiu/artefacts/${encodeURIComponent(consentId)}/fetch-data`, { method: 'POST', body: {} });
export const listReceivedRecords = (abhaAddress) => gateway(`/hie/hiu/records${q({ abhaAddress })}`);

// Scan & Pay
export const publishBill = (body) => gateway('/hie/scan-pay/bills', { method: 'POST', body });
export const listBills = (encounterReference) => gateway(`/hie/scan-pay/bills${q({ encounterReference })}`);
export const listOrders = () => gateway('/hie/scan-pay/orders');
export const billOrder = (id, procedures) => gateway(`/hie/scan-pay/orders/${encodeURIComponent(id)}/bill`, { method: 'POST', body: { procedures } });
export const recordPayment = (id, body) => gateway(`/hie/scan-pay/orders/${encodeURIComponent(id)}/payment`, { method: 'POST', body });

// Running Token
export const callNextToken = (facilityId, context) => gateway('/abha/scan-share/counters/call-next', { method: 'POST', body: { facilityId, context } });

export const HI_TYPE_LABELS = {
  OPConsultation: 'OP consultation',
  Prescription: 'Prescription',
  DiagnosticReport: 'Diagnostic report',
  DischargeSummary: 'Discharge summary',
  ImmunizationRecord: 'Immunization',
  HealthDocumentRecord: 'Health document',
  WellnessRecord: 'Wellness record',
};

export const LINK_STATUS = {
  unlinked: 'Waiting for the patient to find it',
  awaiting_token: 'Linking…',
  linking: 'Linking…',
  linked: 'Linked to ABHA',
  failed: 'Not linked',
};

/** What a received FHIR document says, for reading: title, date, author, and its sections' entries as text. */
export function readDocument(bundle) {
  const all = new Map((bundle?.entry || []).map((e) => [e.fullUrl, e.resource]));
  const comp = (bundle?.entry || []).find((e) => e.resource?.resourceType === 'Composition')?.resource;
  const text = (r) => {
    if (!r) return '';
    switch (r.resourceType) {
      case 'Observation':
        if (r.component) return `${r.code?.text || r.code?.coding?.[0]?.display}: ${r.component.map((c) => c.valueQuantity?.value).join('/')} ${r.component[0]?.valueQuantity?.unit || ''}`;
        return `${r.code?.text || r.code?.coding?.[0]?.display || 'Observation'}: ${r.valueString ?? (r.valueQuantity ? `${r.valueQuantity.value} ${r.valueQuantity.unit || ''}` : r.valueCodeableConcept?.text || '')}`;
      case 'MedicationRequest':
      case 'MedicationStatement':
        return [r.medicationCodeableConcept?.text || r.medicationCodeableConcept?.coding?.[0]?.display, r.dosageInstruction?.[0]?.text || r.dosage?.[0]?.text].filter(Boolean).join(' — ');
      case 'Condition': return r.code?.text || r.code?.coding?.[0]?.display || 'Condition';
      case 'DiagnosticReport': return r.code?.text || r.code?.coding?.[0]?.display || 'Report';
      case 'Immunization': return r.vaccineCode?.text || r.vaccineCode?.coding?.[0]?.display || 'Immunization';
      case 'DocumentReference': return r.description || r.content?.[0]?.attachment?.title || 'Document';
      default: return r.code?.text || r.title || r.resourceType;
    }
  };
  const author = comp?.author?.map((a) => a.display || all.get(a.reference)?.name?.[0]?.text).filter(Boolean).join(', ');
  return {
    title: comp?.title || comp?.type?.text || 'Health record',
    date: comp?.date || bundle?.timestamp,
    author: author || '',
    custodian: comp?.custodian?.display || all.get(comp?.custodian?.reference)?.name || '',
    sections: (comp?.section || []).map((s) => ({ title: s.title || s.code?.coding?.[0]?.display || 'Section', lines: (s.entry || []).map((e) => text(all.get(e.reference))).filter(Boolean) })),
  };
}
