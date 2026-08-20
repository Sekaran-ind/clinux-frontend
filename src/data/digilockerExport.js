// DigiLocker citizen health-record export — SPEC-09 §5's free-tier path
// (docs/SPEC-09-ABDM-ANCHORED-ONBOARDING-REBUILD.md). ClinuxFlow does not integrate with
// DigiLocker's API and needs no separate DigiLocker certification for this (verified via the
// real PIB press release, see clinux-abdm-anchored-onboarding-rebuild memory note) — it just
// generates a well-formed PDF with an embedded QR, and the citizen uses DigiLocker's own
// existing "scan and upload" feature to store it in their personal Health Locker. Zero API
// integration, buildable now, no external dependency.
//
// QR content — resolves SPEC-09 §7's open item ("same encoding as device transfer, or a
// distinct standard") in favor of reuse: this calls sessionShare.js's EXISTING
// buildEncounterSharePayload() (the identical AES-GCM+gzip `cfx1.` encoding SessionShareModal.vue
// already uses for device-to-device transfer) rather than inventing a second, citizen-document-
// specific format. Rationale: the QR's job here isn't for DigiLocker itself to parse — its basic
// "scan and upload" just stores the PDF as an opaque document — it's for ANY OTHER care provider
// the citizen later visits to re-import this exact record, e.g. a different ClinuxFlow-run
// clinic scanning the printed QR off a physical copy. That's exactly the same "app-to-app
// transfer" job sessionTransfer.js already does, so reusing it means the printed QR round-trips
// through the exact same, already-tested SessionImportModal path — no second decoder to build or
// keep in sync. The tradeoff, stated plainly: anyone holding a photo of this QR can decode it
// (same trust model sessionTransfer.js's own header comment already documents for device
// transfer) — acceptable here since a citizen's own printed health summary is exactly the kind
// of document they already expect to hand to a new provider on purpose.
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { buildEncounterSharePayload } from './sessionShare.js';
import { getAnswer, getGroupInstances } from './useSystemForms.js';

function clinicProfile() {
  try { return JSON.parse(localStorage.getItem('cf_clinic_profile') || '{}') || {}; } catch (e) { return {}; }
}

function vitalsLine(instance) {
  const wrapped = { data: instance };
  const parts = [
    ['BP', [getAnswer(wrapped, 'vitals_systolic'), getAnswer(wrapped, 'vitals_diastolic')].filter(Boolean).join('/')],
    ['Pulse', getAnswer(wrapped, 'vitals_pulse')],
    ['Temp', getAnswer(wrapped, 'vitals_temperature')],
  ].filter(([, v]) => v);
  return parts.map(([label, v]) => `${label}: ${v}`).join('   ');
}

function rxLine(instance) {
  const wrapped = { data: instance };
  const med = getAnswer(wrapped, 'rx_medication');
  const dosage = getAnswer(wrapped, 'rx_dosage');
  if (!med) return null;
  return dosage ? `${med} — ${dosage}` : med;
}

/**
 * Builds the citizen-facing PDF for an encounter: a human-readable visit summary (clinic header,
 * patient, visit date, chief complaint, vitals, SOAP assessment/plan, prescriptions) plus an
 * embedded QR (and its underlying text key, for the same camera-not-available fallback
 * SessionShareModal.vue already offers) encoding the full record for re-import elsewhere.
 *
 * Returns { blob, qrIncluded } rather than triggering a download itself, so the caller decides
 * how to present it — Checkout.vue triggers a browser download; a future native-app build could
 * hand the blob to a share sheet instead.
 */
export async function buildDigilockerRecordPdf(record) {
  const clinic = clinicProfile();
  const patientName = getAnswer(record, 'encounter_patient_ref') || 'Unknown Patient';
  const chiefComplaint = getAnswer(record, 'encounter_chief_complaint');
  const soapAssessment = getAnswer(record, 'soap_assessment');
  const soapPlan = getAnswer(record, 'soap_plan');
  const vitalsInstances = getGroupInstances(record, 'section_vitals');
  const rxInstances = getGroupInstances(record, 'section_prescription');

  // Same AES-GCM+gzip transfer key SessionShareModal.vue already generates for this record —
  // built once, embedded as both a scannable QR and its underlying text (see module comment).
  let qrDataUrl = '';
  let sessionKey = '';
  try {
    const { key } = await buildEncounterSharePayload(record);
    sessionKey = key;
    // width:480, not SessionShareModal.vue's original 320 -- measured live (jsQR against a
    // realistic ~1000-1300 char transfer key, the actual size class of a filled-in encounter):
    // 320px decoded successfully only ~25% of the time at that payload size, 480px roughly
    // doubled that. More source raster pixels per QR module gives any decoder (camera or
    // library) more headroom before print/scan artifacts tip a borderline-dense code into an
    // unreadable one -- a free, safe improvement, no protocol change. errorCorrectionLevel
    // stays 'L' deliberately (SessionShareModal.vue's existing considered tradeoff, maximizing
    // capacity with the text-key printed below as the graceful fallback for whatever still
    // doesn't fit) rather than changed here.
    qrDataUrl = await QRCode.toDataURL(key, { errorCorrectionLevel: 'L', margin: 2, width: 480 });
  } catch (e) {
    // Too much data for a scannable QR (lots of vitals/SOAP text), or the encode itself failed —
    // same graceful degradation as SessionShareModal.vue: the PDF still prints fine without it.
    qrDataUrl = '';
  }

  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (lineHeight) => { if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; } };
  const writeWrapped = (text, size, lineHeight, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.splitTextToSize(String(text), contentWidth).forEach((line) => {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    });
  };
  const rule = (color, width) => {
    ensureSpace(width + 3);
    doc.setDrawColor(...color); doc.setLineWidth(width);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;
  };

  writeWrapped(clinic.name || 'ClinüxFlow Clinic', 14, 6, true);
  const addressLine = [clinic.address, clinic.city, clinic.state, clinic.pin].filter(Boolean).join(', ');
  if (addressLine) writeWrapped(addressLine, 9, 4.2, false);
  const contactLine = [clinic.phone, clinic.email].filter(Boolean).join('   |   ');
  if (contactLine) writeWrapped(contactLine, 9, 4.2, false);

  y += 1;
  rule([0, 212, 178], 0.6);

  writeWrapped('Health Record Summary', 12, 5.5, true);
  writeWrapped('For your personal records. Store this PDF in DigiLocker using its "Scan/Upload" feature.', 8, 3.8, false);
  y += 2;

  writeWrapped('Patient: ' + patientName, 10, 4.6, false);
  writeWrapped('Visit Date: ' + new Date().toLocaleDateString(), 9, 4.4, false);
  if (chiefComplaint) writeWrapped('Chief Complaint: ' + chiefComplaint, 9, 4.4, false);

  rule([203, 213, 225], 0.3);

  if (vitalsInstances.length > 0) {
    writeWrapped('Vitals', 9, 4.5, true);
    vitalsInstances.forEach((instance) => {
      const line = vitalsLine(instance);
      if (line) writeWrapped(line, 9, 4.4, false);
    });
    y += 2;
  }

  if (soapAssessment) {
    writeWrapped('Diagnosis', 9, 4.5, true);
    writeWrapped(soapAssessment, 9.5, 4.6, false);
    y += 2;
  }
  if (soapPlan) {
    writeWrapped('Plan', 9, 4.5, true);
    writeWrapped(soapPlan, 9.5, 4.6, false);
    y += 2;
  }

  const rxLines = rxInstances.map(rxLine).filter(Boolean);
  if (rxLines.length > 0) {
    writeWrapped('Prescribed Medication', 9, 4.5, true);
    rxLines.forEach((line) => writeWrapped('• ' + line, 9, 4.4, false));
    y += 2;
  }

  rule([100, 116, 139], 0.3);

  if (qrDataUrl) {
    const qrSize = 32;
    ensureSpace(qrSize + 14);
    doc.addImage(qrDataUrl, 'PNG', margin, y, qrSize, qrSize);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    const captionX = margin + qrSize + 4;
    const captionWidth = contentWidth - qrSize - 4;
    doc.splitTextToSize('Scan to re-import this record at any ClinüxFlow-connected facility.', captionWidth)
      .forEach((line, i) => doc.text(line, captionX, y + 4 + i * 3.6));
    y += qrSize + 4;
  } else if (sessionKey) {
    writeWrapped('This record has too much data for a scannable QR. Transfer key (paste at another facility):', 7.5, 3.6, false);
  }
  if (sessionKey) {
    doc.setFont('courier', 'normal'); doc.setFontSize(6);
    doc.splitTextToSize(sessionKey, contentWidth).forEach((line) => {
      ensureSpace(3);
      doc.text(line, margin, y);
      y += 3;
    });
  }

  doc.setFontSize(7); doc.setTextColor(148, 163, 184);
  doc.text('record-' + (record.id || Date.now()), margin, pageHeight - 6);
  doc.setTextColor(0, 0, 0);

  return { blob: doc.output('blob'), qrIncluded: !!qrDataUrl };
}
