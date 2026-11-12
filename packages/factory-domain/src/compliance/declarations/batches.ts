import type { BusinessDate } from '../../core/time'

/**
 * Which revision went with which batch (B-W2b-257; PRD-295; Reg. (EU) 2016/425 art. 8(8), art. 15(2): the DoC goes with the
 * goods; QHS-110 kept ten years), pure. The table is B-W2b-218's ComplianceDocumentBatch: one row per issued document (a
 * signed DoC or leaflet: generated ones are never issued before GATE-PPE-TEXTS), batch and shipment (or the batch as made,
 * without a shipment), written once, kept until at least ten years after it was recorded.
 *
 * B-W2b-288 (FU2:04): a SUPERSEDED document is recorded too, for a batch made while it was in force (`madeWhileInForce`).
 *
 * A work order's batch takes the document of the revision the work order froze — exactly, so the public DoC page (which
 * reads the frozen revision) and the customer documents (the copies on the shipment) always name the same revision as the
 * record. A batch number typed (made before Nexus, or by a workshop) may name any issued revision of the style.
 */

export const BATCH_NUMBER_MAX = 60
export const KEPT_YEARS = 10

export interface RecordFacts {
  readonly document: { readonly styleId: string; readonly kind: string; readonly revision: number; readonly status: string; readonly language: string }
  readonly workOrder: { readonly styleId: string; readonly batchNumber: string | null; readonly frozenRevision: number | null; readonly number: string } | null
  readonly batchNumber: string | null
  /** The shipment, when one is named: whether it carries the work order's garments (null: no work order to check). */
  readonly shipment: { readonly number: string; readonly status: string; readonly carriesWorkOrder: boolean | null } | null
  /**
   * B-W2b-288 (FU2:04): this batch number is recorded with this document already (recorded while it was in force). Left out:
   * not known (false).
   */
  readonly recordedBefore?: boolean | undefined
}

/**
 * B-W2b-288 (FU2:04; the redefined batch guard of B-W2b-275): a batch made while an older document was in force keeps that
 * document when it ships late. A SUPERSEDED document goes with a batch made while it was in force: a work order's batch made
 * to the document's revision (the revision it froze), or a batch recorded with this document before (a batch number typed has
 * no other trace of when it was made). Any other batch goes with the declaration in force.
 */
export function madeWhileInForce(facts: Pick<RecordFacts, 'document' | 'workOrder' | 'recordedBefore'>): boolean {
  if (facts.document.status === 'ISSUED') return true
  if (facts.document.status !== 'SUPERSEDED') return false
  return facts.recordedBefore === true || (facts.workOrder !== null && facts.workOrder.frozenRevision === facts.document.revision)
}

/** Why a batch record is refused, in words (null: fine). */
export function recordRefusal(facts: RecordFacts): { code: string; message: string } | null {
  const { document, workOrder } = facts
  // B-W2b-288 (FU2:04): a SUPERSEDED document keeps the batches made while it was in force (a late shipment of an older batch).
  if (document.status === 'SUPERSEDED' && !madeWhileInForce(facts)) {
    return {
      code: 'NOT_IN_FORCE',
      message: `This document was superseded: only a batch made while it was in force ships with it (a work order made to its revision ${document.revision}, or a batch recorded with it before). Record this batch with the declaration in force.`,
    }
  }
  if (document.status !== 'ISSUED' && document.status !== 'SUPERSEDED') {
    return { code: 'NOT_ISSUED', message: `This document is ${document.status}: a batch is recorded only with an issued (signed) document, the one in force.` }
  }
  if (workOrder && facts.batchNumber !== null) return { code: 'BOTH', message: 'Name the work order or type a batch number, not both.' }
  if (!workOrder && facts.batchNumber === null) return { code: 'NO_BATCH', message: 'Name the work order that made the batch, or type its batch number.' }
  if (workOrder) {
    if (workOrder.styleId !== document.styleId) return { code: 'OTHER_STYLE', message: `Work order ${workOrder.number} makes another style.` }
    if (!workOrder.batchNumber) return { code: 'NOT_RELEASED', message: `Work order ${workOrder.number} has no batch number yet: it is given at release.` }
    if (workOrder.frozenRevision !== document.revision) {
      return {
        code: 'OTHER_REVISION',
        message: `Work order ${workOrder.number} made revision ${workOrder.frozenRevision ?? '(none)'}; this document is of revision ${document.revision}: record the batch with its own revision's document.`,
      }
    }
  } else {
    const typed = facts.batchNumber!.trim()
    if (typed === '' || typed.length > BATCH_NUMBER_MAX) return { code: 'BATCH_NUMBER', message: `The batch number: 1 to ${BATCH_NUMBER_MAX} characters.` }
  }
  if (facts.shipment) {
    if (facts.shipment.status === 'CANCELLED') return { code: 'SHIPMENT_CANCELLED', message: `Shipment ${facts.shipment.number} is cancelled.` }
    if (facts.shipment.carriesWorkOrder === false) return { code: 'NOT_ON_SHIPMENT', message: `Shipment ${facts.shipment.number} carries no garment of work order ${workOrder?.number ?? ''}.`.replace(/ \.$/, '.') }
  }
  return null
}

/** The day a record made on `today` (Rome) is kept until: ten years later. */
export function keptUntil(today: BusinessDate): BusinessDate {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year + KEPT_YEARS, month - 1, day))
  // 29 February ten years on falls on 1 March: never earlier than ten years.
  return date.toISOString().slice(0, 10)
}

export interface BatchRow {
  readonly id: string
  readonly documentId: string
  readonly batchNumber: string
  readonly workOrderId: string | null
  readonly shipmentId: string | null
  readonly createdAt: string
}

export interface DocumentRef {
  readonly id: string
  readonly kind: string
  readonly language: string
  readonly revision: number
  readonly number: string | null
  readonly status: string
}

/** A plain JSON answer (mutable arrays: the route contracts' shape). */
export interface RevisionGroup {
  revision: number
  documents: DocumentRef[]
  batches: { batchNumber: string; workOrderId: string | null; shipmentIds: string[]; documentIds: string[]; firstRecordedAt: string }[]
}

/** The versions-by-batch timeline: per revision (newest first), its documents and the batches (and shipments) that carried them. */
export function versionsByBatch(rows: readonly BatchRow[], documents: readonly DocumentRef[]): RevisionGroup[] {
  const documentOf = new Map(documents.map((document) => [document.id, document]))
  const revisions = new Map<number, { documents: Map<string, DocumentRef>; batches: Map<string, { batchNumber: string; workOrderId: string | null; shipments: Set<string>; documents: Set<string>; first: string }> }>()
  for (const row of rows) {
    const document = documentOf.get(row.documentId)
    if (!document) continue
    const group = revisions.get(document.revision) ?? { documents: new Map(), batches: new Map() }
    group.documents.set(document.id, document)
    const key = `${row.workOrderId ?? ''}|${row.batchNumber}`
    const batch = group.batches.get(key) ?? { batchNumber: row.batchNumber, workOrderId: row.workOrderId, shipments: new Set<string>(), documents: new Set<string>(), first: row.createdAt }
    if (row.shipmentId) batch.shipments.add(row.shipmentId)
    batch.documents.add(row.documentId)
    if (row.createdAt < batch.first) batch.first = row.createdAt
    group.batches.set(key, batch)
    revisions.set(document.revision, group)
  }
  // Documents of a revision with no batch yet still show under it.
  for (const document of documents) {
    const group = revisions.get(document.revision) ?? { documents: new Map(), batches: new Map() }
    group.documents.set(document.id, document)
    revisions.set(document.revision, group)
  }
  return [...revisions.entries()]
    .sort(([a], [b]) => b - a)
    .map(([revision, group]) => ({
      revision,
      documents: [...group.documents.values()].map((document) => ({ ...document })).sort((a, b) => a.kind.localeCompare(b.kind) || a.language.localeCompare(b.language)),
      batches: [...group.batches.values()]
        .sort((a, b) => a.first.localeCompare(b.first) || a.batchNumber.localeCompare(b.batchNumber))
        .map((batch) => ({ batchNumber: batch.batchNumber, workOrderId: batch.workOrderId, shipmentIds: [...batch.shipments].sort(), documentIds: [...batch.documents].sort(), firstRecordedAt: batch.first })),
    }))
}

export interface TravelledFacts {
  readonly shipmentId: string
  readonly batches: readonly { readonly workOrderId: string; readonly batchNumber: string | null; readonly styleId: string; readonly frozenRevision: number | null }[]
  /** The documents that travel with the shipment (shipping's choice per style and revision: DoC and leaflet, one language). */
  readonly documents: readonly { readonly documentId: string; readonly styleId: string; readonly revision: number }[]
  /** The records the shipment has already: `${documentId}|${batchNumber}`. */
  readonly recorded: ReadonlySet<string>
}

/** The records a shipment still needs: every travelling document × each batch of its style and revision on the shipment. */
export function recordsToMake(facts: TravelledFacts): { documentId: string; workOrderId: string; batchNumber: string }[] {
  const out: { documentId: string; workOrderId: string; batchNumber: string }[] = []
  const seen = new Set<string>()
  for (const batch of facts.batches) {
    if (!batch.batchNumber || batch.frozenRevision === null) continue
    for (const document of facts.documents) {
      if (document.styleId !== batch.styleId || document.revision !== batch.frozenRevision) continue
      const key = `${document.documentId}|${batch.batchNumber}`
      if (facts.recorded.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push({ documentId: document.documentId, workOrderId: batch.workOrderId, batchNumber: batch.batchNumber })
    }
  }
  return out
}
