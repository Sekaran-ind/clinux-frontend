// The prescription PDF (A5): clinic header, patient, diagnosis (SOAP assessment) and Rx / plan
// (SOAP plan), with a signature line. Same layout as ConsultationDesk.vue's generatePrescriptionPdf,
// as a function the Consultation journey can call. Resolves to { id, dataUrl }.
import { jsPDF } from 'jspdf';

function clinicProfile() {
  try { return JSON.parse(localStorage.getItem('cf_clinic_profile') || '{}') || {}; } catch { return {}; }
}

export function buildPrescriptionPdf({ patientName, chiefComplaint, assessment, plan }) {
  const clinic = clinicProfile();
  const id = 'rx-' + Date.now();
  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const ensureSpace = (h) => { if (y + h > pageHeight - margin) { doc.addPage(); y = margin; } };
  const write = (text, size, lineHeight, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.splitTextToSize(String(text), contentWidth).forEach((line) => { ensureSpace(lineHeight); doc.text(line, margin, y); y += lineHeight; });
  };

  write(clinic.name || 'ClinixFlow Clinic', 14, 6, true);
  const address = [clinic.address, clinic.city, clinic.state, clinic.pin].filter(Boolean).join(', ');
  if (address) write(address, 9, 4.2, false);
  const contact = [clinic.phone, clinic.email].filter(Boolean).join('   |   ');
  if (contact) write(contact, 9, 4.2, false);
  y += 2;
  doc.setDrawColor(0, 212, 178); doc.setLineWidth(0.6); doc.line(margin, y, pageWidth - margin, y);
  y += 6;
  write('Patient: ' + (patientName || 'Unknown'), 10, 4.6, false);
  if (chiefComplaint) write('Chief Complaint: ' + chiefComplaint, 9, 4.4, false);
  write('Date: ' + new Date().toLocaleDateString(), 9, 4.4, false);
  y += 2;
  doc.setDrawColor(203, 213, 225); doc.setLineWidth(0.3); doc.line(margin, y, pageWidth - margin, y);
  y += 6;
  write('Diagnosis', 9, 4.5, true);
  write(assessment?.trim() ? assessment : '—', 9.5, 4.6, false);
  y += 3;
  write('Rx / Plan (Treatment)', 9, 4.5, true);
  write(plan, 10, 5, false);
  y += 8;
  ensureSpace(10);
  doc.setDrawColor(100, 116, 139); doc.setLineWidth(0.3);
  doc.line(pageWidth - margin - 45, y, pageWidth - margin, y);
  y += 4;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text("Doctor's Signature", pageWidth - margin - 45, y);
  doc.setFontSize(7); doc.setTextColor(148, 163, 184);
  doc.text(id, margin, pageHeight - 6);
  doc.setTextColor(0, 0, 0);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id, dataUrl: reader.result });
    reader.onerror = () => reject(new Error('Could not generate the prescription PDF.'));
    reader.readAsDataURL(doc.output('blob'));
  });
}
