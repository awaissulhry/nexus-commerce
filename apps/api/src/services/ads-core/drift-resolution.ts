/**
 * S2 (2026-09-26) — when the structural reconcile may close a drift row.
 *
 * A row closes only on evidence from a clean run in its own business profile. All four must hold:
 *   1. the run was clean: every Amazon read succeeded (the caller passes `runOk`);
 *   2. the entity is in the run's results, so it was actually compared. Entities that were uncovered, skipped,
 *      in no batch, or deleted locally keep their rows;
 *   3. the row's field was compared: both sides were read. For `existence`, Amazon returned the entity under
 *      our id (verdict VERIFIED or MISMATCH);
 *   4. no difference was observed for that key in this run, counting the differences that are never recorded
 *      (bids) and those whose row could not be saved.
 *
 * Why: measured on production, no child-entity row had ever closed, because the old pass selected only CAMPAIGN
 * rows; 242 rows that agree again sat open for weeks. The same pass closed CAMPAIGN rows for fields it never
 * compares, and "no delta" also meant "Amazon did not report the field".
 *
 * Pure: no I/O. The reconcile service reads, writes, and calls in here.
 */
import type { LaunchEntityResult } from './launch-verify.js'

/** Local entity kind → the entityType string AdDrift uses. Keywords and targets are both AD_TARGET rows. */
export const DRIFT_ENTITY_TYPE: Record<LaunchEntityResult['entityType'], string> = {
  CAMPAIGN: 'CAMPAIGN', AD_GROUP: 'AD_GROUP',
  KEYWORD: 'AD_TARGET', TARGET: 'AD_TARGET', PRODUCT_AD: 'PRODUCT_AD',
}

/** Bid fields are compared and counted but never recorded: the bid path owns them (see the reconcile service). */
export const BID_FIELDS = new Set(['bid', 'defaultBid'])

/** A difference to record as a drift row. */
export interface DriftFinding {
  entityType: string
  entity: LaunchEntityResult
  field: string
  intended: string | null
  observed: string | null
}

/**
 * What a run has seen so far, across its batches, in one business profile:
 *   compared  entityType → entityId → the fields compared on that entity (with `existence` when Amazon returned it)
 *   observed  every difference seen, keyed like the AdDrift row, whether or not a row was recorded or saved
 */
export interface DriftEvidence {
  compared: Map<string, Map<string, Set<string>>>
  observed: Set<string>
}

export interface OpenDriftRow { id: string; entityType: string; entityId: string; field: string }

export const emptyEvidence = (): DriftEvidence => ({ compared: new Map(), observed: new Set() })

const driftKey = (entityType: string, entityId: string, field: string) => `${entityType}|${entityId}|${field}`

/** Amazon returned the entity under our id, so its existence was compared and agrees. */
const amazonReturnedIt = (e: LaunchEntityResult) => e.verdict === 'VERIFIED' || e.verdict === 'MISMATCH'

/**
 * S3 — archived here and never sent to Amazon: we want nothing live and Amazon holds nothing, so on existence the
 * two agree. Measured on production: 206 SP keywords in this state were re-opened as drift on every run.
 *
 * Applied only here, in the reconcile's closing logic. verifyEntity still says NOT_PUSHED for them, because it also
 * writes launch receipts, and a receipt must never call an entity Amazon never saw verified.
 */
const archivedNeverSent = (e: LaunchEntityResult) => e.verdict === 'NOT_PUSHED' && e.localState === 'archived'

/**
 * S3 — a live entity we never sent is one of our writes that never landed: WRITE_FAILED. Classifying it as an
 * EXTERNAL_CHANGE told the operator somebody edited it on Amazon, which nobody did.
 */
export const neverSent = (d: DriftFinding): boolean => d.field === 'existence' && d.entity.verdict === 'NOT_PUSHED'

/**
 * Fold one batch's results into `evidence`, and return the differences to record.
 *
 * Every difference goes into `evidence.observed` here, before the caller writes anything, so a row whose save
 * throws can never be closed as though it agreed.
 */
export function assessEntities(
  entities: readonly LaunchEntityResult[],
  evidence: DriftEvidence,
): { record: DriftFinding[]; bidDeltas: number; archivedNeverSent: number } {
  const record: DriftFinding[] = []
  let bidDeltas = 0
  let archivedUnsent = 0
  for (const e of entities) {
    const entityType = DRIFT_ENTITY_TYPE[e.entityType]
    const fields = new Set(e.compared)
    if (amazonReturnedIt(e) || archivedNeverSent(e)) fields.add('existence')
    const byId = evidence.compared.get(entityType) ?? new Map<string, Set<string>>()
    evidence.compared.set(entityType, byId)
    const known = byId.get(e.localId) ?? new Set<string>()
    for (const f of fields) known.add(f)
    byId.set(e.localId, known)

    if (e.verdict === 'VERIFIED') continue
    // Agreement, not a finding: counted so the reconcile reports it rather than hiding it.
    if (archivedNeverSent(e)) { archivedUnsent++; continue }
    // A verdict with no per-field delta (NOT_PUSHED / MISSING_ON_AMAZON) is recorded against a synthetic
    // `existence` field so it gets a row of its own rather than being invisible.
    const deltas = e.deltas.length ? e.deltas : [{ field: 'existence', intended: 'on Amazon', observed: e.verdict === 'NOT_PUSHED' ? 'never sent' : 'not returned' }]
    for (const d of deltas) {
      evidence.observed.add(driftKey(entityType, e.localId, d.field))
      if (BID_FIELDS.has(d.field)) { bidDeltas++; continue }
      record.push({ entityType, entity: e, field: d.field, intended: d.intended, observed: d.observed })
    }
  }
  return { record, bidDeltas, archivedNeverSent: archivedUnsent }
}

/** The ids of the open rows this run's evidence closes. Nothing, unless the run was clean. */
export function rowsToClose(runOk: boolean, evidence: DriftEvidence, open: readonly OpenDriftRow[]): string[] {
  if (!runOk) return []
  return open
    .filter((r) => evidence.compared.get(r.entityType)?.get(r.entityId)?.has(r.field) === true
      && !evidence.observed.has(driftKey(r.entityType, r.entityId, r.field)))
    .map((r) => r.id)
}
