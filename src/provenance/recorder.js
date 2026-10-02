// Records provenance for the workspace's writes, on this device, and publishes it on the paid plan.
//   - every saved form record (formData.saveDataRecord -> setRecordSavedListener, see main.js)
//   - every registry journey outcome (journeys/index.js's journal hook)
// Never throws and never blocks the write it describes.
import { useAuthStore } from '../stores/auth.js';
import { accountRecords } from '../journeys/accountRecords.js';
import { buildProvenance, HFR_SYSTEM, HPR_SYSTEM } from './provenance.js';
import { provenanceLog } from './store.js';

export async function recordProvenance({ targets, activity, source, reason }) {
  try {
    const account = useAuthStore().currentUser;
    if (!account?.id) return null;
    const records = accountRecords(account.id);
    const hpr = await records.get('abdm:hpr');
    const hfr = await records.get('abdm:hfr');
    const resource = buildProvenance({
      targets, activity, source, reason, account,
      hprId: hpr?.hprIdNumber || hpr?.hprId, hfrFacilityId: hfr?.facilityId,
    });
    const log = provenanceLog(account.id);
    await log.add(resource);
    // Paid plan: send what isn't on the server yet (fire-and-forget). Free plan: stays here.
    log.publishPending({ paid: account.tier === 'paid' });
    return resource;
  } catch (e) {
    console.warn('[provenance] not recorded:', e.message);
    return null;
  }
}

/** A saved form record -> its provenance (target: the captured QuestionnaireResponse). */
export const onRecordSaved = ({ id, formId, created }) =>
  recordProvenance({ targets: [`QuestionnaireResponse/${id}`], activity: created ? 'create' : 'update', reason: `Captured with form ${formId}` });

/** A registry journey's audit action (data/operations.js journalToAudit) -> its provenance, or null. */
export function provenanceForAudit(audit) {
  if (!audit) return null;
  const { action, objectId, metadata = {} } = audit;
  if (action === 'hpr.linked' || action === 'hpr.registered') {
    return { targets: [{ system: HPR_SYSTEM, value: metadata.hprId || objectId }], activity: action === 'hpr.registered' ? 'create' : 'update', reason: action === 'hpr.registered' ? 'HPR ID registered with ABDM' : 'HPR ID linked' };
  }
  if (action === 'hfr.submitted' && metadata.facilityId) {
    return { targets: [{ system: HFR_SYSTEM, value: metadata.facilityId }], activity: 'create', reason: 'Facility submitted to HFR' };
  }
  if ((action === 'abha.recorded' || action === 'abha.patient_created') && objectId) {
    return { targets: [`QuestionnaireResponse/${objectId}`], activity: action === 'abha.patient_created' ? 'create' : 'update', reason: 'ABHA verified with ABDM and recorded' };
  }
  return null;
}
