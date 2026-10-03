// Scan & Share (ABDM M1 "Scan Health Facility QR"), through clinuxflow-abdm-gateway's
// /abha/scan-share routes (src/routes/scanShare.js there). The facility's QR is ABDM's PHR URL
// with the facility's HFR id and a counter id; ABDM sends the patient's profile to the gateway,
// which gives them a token and queues the share here for the front desk.
import { gateway } from '../journeys/gateway.js';

export const SANDBOX_PHR = 'https://phrsbx.abdm.gov.in';

/** The QR a patient scans at a counter (Scan & Share doc §4.1). */
export const shareQrUrl = (phrBaseUrl, facilityId, counterId) =>
  `${phrBaseUrl || SANDBOX_PHR}/share-profile?hipid=${encodeURIComponent(facilityId)}&counterid=${encodeURIComponent(counterId)}`;

export const fetchScanShareFacilities = () => gateway('/abha/scan-share/facilities');
export const registerScanShareFacility = (body) => gateway('/abha/scan-share/facilities', { method: 'POST', body });
export const stopScanShareFacility = (facilityId) => gateway(`/abha/scan-share/facilities/${encodeURIComponent(facilityId)}`, { method: 'DELETE' });

export function fetchQueue({ facilityId, context } = {}) {
  const q = new URLSearchParams();
  if (facilityId) q.set('facilityId', facilityId);
  if (context) q.set('context', context);
  return gateway(`/abha/scan-share/queue${q.toString() ? `?${q}` : ''}`);
}
export const dismissShare = (id) => gateway(`/abha/scan-share/queue/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} });

/** A HIP name ABHA apps show: at most 15 letters, digits or spaces (HFR's rule), from the facility name. */
export function suggestHipName(name) {
  return String(name || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 15).trim();
}

/** Age in years from a year of birth, for the queue. */
export const ageFrom = (yearOfBirth, now = new Date()) => (yearOfBirth ? now.getFullYear() - Number(yearOfBirth) : null);
