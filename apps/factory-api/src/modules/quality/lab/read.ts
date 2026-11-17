import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { lotStateWords } from '@nexus/factory-domain/inventory/receipts/rules'
import {
  crViVerdict,
  EVIDENCE_RULE_WORDS,
  releaseChecklist,
  ruleInForce,
  type ChecklistMode,
  type Checklist,
  type EvidenceRule,
  type IncomingReleaseFacts,
  type ReleaseFacts,
  type SettingSource,
} from '@nexus/factory-domain/quality/lab/rules'
// B-W2b-GF5 (G369): the lot's incoming inspection in the release checklist.
import { nextStepOf } from '@nexus/factory-domain/quality/incoming/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { notAcceptedHidesOf } from '../incoming/hold'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { processLotDocuments, type LotDocumentRow } from './documents-store'
import { processLabResults, type LabCost, type LabResultRow } from './results-store'
import { asMoney, type Money } from '@nexus/factory-domain/money/marked'
import { processQualitySettings } from './settings-store'
import { certificateCovering, factsOf, holdNoteOf, lotFor, officeOf, receiptOf, type LotRow, type Reader } from './store'

/**
 * The lab step's reads (B-W1-34; A2 SCR-054 Tests & substances › Lot tests, SCR-075 Lot release; design lt-release,
 * lt-docs, lt-tests, ts-rule): a lot's quality record (facts, Cr VI result, results with their reports, supplier
 * documents, the release checklist for the viewer), and the Cr VI evidence rule in force. quality.lots.view over the
 * lot's company and site. Every read runs one query after another on its client.
 */

export const today = (): BusinessDate => businessDate(serverClock.now())

/** The rule in force for a company (its own, the tenant's, else the default) and where it comes from. */
export async function ruleFor(client: Reader, tenantId: string, companyId: string | null): Promise<{ rule: EvidenceRule; source: SettingSource }> {
  const rows = await processQualitySettings().rows(client, tenantId, companyId)
  return ruleInForce(companyId, rows.map((row) => ({ companyId: row.companyId, rule: row.crViEvidenceRule })))
}

export interface DocumentView extends LotDocumentRow {
  readonly file: { readonly id: string; readonly originalName: string; readonly status: string } | null
  /** Counts for the checklist: ACTIVE, its file available, not expired. */
  readonly inForce: boolean
}

/** The lot's supplier documents with their files (a deleted or quarantined file no longer counts). */
export async function documentsOf(client: Reader, lotId: string, day: BusinessDate): Promise<DocumentView[]> {
  const rows = await processLotDocuments().list(client, lotId)
  const files = rows.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, originalName: true, status: true } })
  const byId = new Map(files.map((file) => [file.id, file]))
  return rows.map((row) => {
    const file = byId.get(row.fileId) ?? null
    return { ...row, file, inForce: row.status === 'ACTIVE' && file?.status === 'AVAILABLE' && (row.validTo === null || row.validTo >= day) }
  })
}

export interface ResultView extends Omit<LabResultRow, 'cost'> {
  /** B-W2b-288 (FU2:03): the lab's price (the cost grain). */
  readonly cost: Money<'cost', LabCost | null>
  readonly words: string
  readonly file: { readonly id: string; readonly originalName: string; readonly status: string } | null
  /** A later result superseded it. */
  readonly superseded: boolean
}

export async function resultsOf(client: Reader, lotId: string): Promise<ResultView[]> {
  const rows = await processLabResults().list(client, lotId)
  // B-W2b-288 (FU2:03): the lab's price of each result (office reads; the grain filter keeps it for the cost grain only).
  const costs = new Map((await processLabResults().costs(client, [lotId])).map((cost) => [cost.resultId, { cents: cost.cents, currency: cost.currency }]))
  const files = rows.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.fileId))] } }, select: { id: true, originalName: true, status: true } })
  const byId = new Map(files.map((file) => [file.id, file]))
  const superseded = new Set(rows.map((row) => row.supersedesId).filter((id): id is string => id !== null))
  return rows.map((row) => ({ ...row, cost: asMoney('cost', costs.get(row.id) ?? null), words: resultWords(row), file: byId.get(row.fileId) ?? null, superseded: superseded.has(row.id) }))
}

const resultWords = (row: LabResultRow): string =>
  crViVerdict(row.belowDetectionLimit ? { belowDetectionLimit: true, detectionLimitMgKg: row.detectionLimitMgKg } : { valueMgKg: row.valueMgKg }, row.limitMgKg).verdict?.words ?? `${row.verdict}.`

// ---- B-W2b-GF5 (G369): the lot's incoming inspection ------------------------------------------------------------------------

/**
 * How much of a lot not counted by hide is still in it beyond what its inspection accepted, in the inspection's unit (the
 * unit of the lot's receipt moves, or of its opening stock; their base quantities give the factor), or null when nothing
 * beyond it is left.
 */
async function notAcceptedLeftOf(client: Reader, lotId: string, inspection: { readonly lotSize: { toString(): string }; readonly acceptedQuantity: { toString(): string } | null }): Promise<string | null> {
  const [row] = await client.$queryRaw<{ received: string | null; onHand: string | null }[]>`
    SELECT (SELECT sum("baseQuantity") FROM "StockMove" WHERE "lotId" = ${lotId}::uuid AND reason IN ('RECEIPT', 'OPENING') AND "hideId" IS NULL AND "reversalOfId" IS NULL)::text AS "received",
           (SELECT sum(CASE WHEN "toLocationId" IS NOT NULL THEN "baseQuantity" ELSE 0 END) - sum(CASE WHEN "fromLocationId" IS NOT NULL THEN "baseQuantity" ELSE 0 END) FROM "StockMove" WHERE "lotId" = ${lotId}::uuid)::text AS "onHand"`
  const lotSize = new Dec(inspection.lotSize.toString())
  if (!row?.received || lotSize.lessThanOrEqualTo(0)) return null
  const factor = new Dec(row.received).dividedBy(lotSize)
  if (factor.lessThanOrEqualTo(0)) return null
  const left = new Dec(row.onHand ?? '0').dividedBy(factor).minus(inspection.acceptedQuantity?.toString() ?? '0').toDecimalPlaces(4, Dec.ROUND_DOWN)
  return left.greaterThan(0) ? left.toFixed() : null
}

/**
 * The lot's incoming inspection in force for its release (its own, or its parent's for a lot made by a split): the open one,
 * else the newest decided; null when none is (none recorded, or only cancelled ones). What it did not accept is read for the
 * lot it inspected: hides still in the lot neither on hold nor decided since (modules/quality/incoming hold.ts), or the part
 * of a counted lot still in it beyond what was accepted.
 */
export async function incomingFactsOf(client: Reader, lot: Pick<LotRow, 'id' | 'parentLotId'>): Promise<IncomingReleaseFacts | null> {
  const rows = await client.incomingInspection.findMany({
    where: { lotId: { in: lot.parentLotId ? [lot.id, lot.parentLotId] : [lot.id] }, status: { in: ['OPEN', 'DECIDED'] } },
    select: { id: true, number: true, lotId: true, status: true, uom: true, lotSize: true, acceptedQuantity: true, rejectedQuantity: true, toSortQuantity: true, overrideReason: true, decidedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const open = rows.find((row) => row.status === 'OPEN')
  if (open) return { number: open.number, status: 'OPEN', step: null, accepted: null, rejected: null, toSort: null, uom: open.uom, overrideReason: null, unheldHides: [], notAcceptedLeft: null }
  const decided = rows.filter((row) => row.status === 'DECIDED').sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0]
  if (!decided) return null
  const quantities = { accepted: decided.acceptedQuantity?.toString() ?? '0', rejected: decided.rejectedQuantity?.toString() ?? '0', toSort: decided.toSortQuantity?.toString() ?? '0' }
  const step = nextStepOf(quantities, decided.lotSize.toString())
  const partly = (step === 'SORT' || step === 'RELEASE_PART') && decided.lotId === lot.id
  const unheldHides = partly && decided.uom === 'HIDE' ? (await notAcceptedHidesOf(client, decided)).unheld.map((hide) => hide.code) : []
  const notAcceptedLeft = partly && decided.uom !== 'HIDE' ? await notAcceptedLeftOf(client, lot.id, decided) : null
  return { number: decided.number, status: 'DECIDED', step, ...quantities, uom: decided.uom, overrideReason: decided.overrideReason, unheldHides, notAcceptedLeft }
}

/** The facts the checklist needs, read on this client (inside a command: its transaction). */
export async function checklistFactsOf(client: Reader, tenantId: string, lot: LotRow, day: BusinessDate, releaserId: string | null): Promise<ReleaseFacts> {
  const receipt = await receiptOf(client, lot)
  const { rule } = await ruleFor(client, tenantId, lot.companyId)
  const ppeCertificate = lot.item.isPpeComponent ? await certificateCovering(client, lot, day) : null
  const documents = (await documentsOf(client, lot.id, day)).filter((document) => document.inForce).map((document) => ({ kind: document.kind, validTo: document.validTo }))
  // B-W2b-GF5 (G369): quality releases only what passed its incoming inspection.
  const incoming = await incomingFactsOf(client, lot)
  return { lot: factsOf(lot), receipt: receipt && { number: receipt.number, status: receipt.status }, rule, ppeCertificate, documents, today: day, releaserId, incoming }
}

export async function checklistOf(client: Reader, tenantId: string, lot: LotRow, day: BusinessDate, releaserId: string | null, mode?: ChecklistMode): Promise<Checklist> {
  const facts = await checklistFactsOf(client, tenantId, lot, day, releaserId)
  return releaseChecklist(facts, mode ?? (lot.qualityStatus === 'BLOCKED' ? 'UNBLOCK' : 'RELEASE'))
}

/** The lot as the quality screens show it. */
export async function lotView(client: Reader, lot: LotRow) {
  const receipt = await receiptOf(client, lot)
  const hold = holdNoteOf(lot)
  return {
    id: lot.id,
    code: lot.code,
    companyId: lot.companyId,
    siteId: lot.siteId,
    item: lot.item,
    itemColourId: lot.itemColourId,
    supplierId: lot.supplierId,
    supplierLotRef: lot.supplierLotRef,
    dyeBatch: lot.dyeBatch,
    shade: lot.shade,
    receivedAt: lot.receivedAt ? toUtcIso(lot.receivedAt) : null,
    receivedById: lot.createdById,
    receipt,
    qualityStatus: lot.qualityStatus,
    qualityNote: lot.qualityNote,
    qualityDecidedAt: lot.qualityDecidedAt ? toUtcIso(lot.qualityDecidedAt) : null,
    qualityDecidedById: lot.qualityDecidedById,
    hold,
    crVi: {
      required: lot.requiresCrViTest,
      status: lot.crViStatus,
      limitMgKg: factsOf(lot).crViLimitMgKg,
      valueMgKg: factsOf(lot).crViMgKg,
      evidence: lot.crViEvidence ?? null,
      testedOn: lot.crViTestedAt ? lot.crViTestedAt.toISOString().slice(0, 10) : null,
    },
    words: lotStateWords({
      qualityStatus: lot.qualityStatus,
      requiresCrViTest: lot.requiresCrViTest,
      crViStatus: lot.crViStatus,
      crViLimitMgKg: factsOf(lot).crViLimitMgKg,
      holdNote: hold,
      isPpeComponent: lot.item.isPpeComponent,
    }),
    version: lot.version,
  }
}

/** The whole quality record of a lot, for the viewer. */
export async function lotRecord(client: Reader, tenantId: string, lot: LotRow, viewerId: string | null) {
  const day = today()
  const { rule, source } = await ruleFor(client, tenantId, lot.companyId)
  return {
    lot: await lotView(client, lot),
    rule: { crViEvidenceRule: rule, source, words: EVIDENCE_RULE_WORDS[rule] },
    results: await resultsOf(client, lot.id),
    documents: await documentsOf(client, lot.id, day),
    checklist: await checklistOf(client, tenantId, lot, day, viewerId),
    supplier: await supplierOf(client, lot.supplierId), // TH-6 part B: the Lot thread's party
  }
}

/** TH-6 part B (B-TH-267): the lot's supplier, its legal name; null when the lot names none. */
async function supplierOf(client: Reader, partyId: string | null): Promise<{ id: string; name: string } | null> {
  if (!partyId) return null
  const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, legalName: true } })
  return party ? { id: party.id, name: party.legalName } : null
}

/** GET /quality/lots/:lotId. */
export async function getLot(caller: CommandCaller, lotId: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId)
  return caller.withClient((client) => lotRecord(client, context.tenantId, lot, context.actorId))
}

/** GET /quality/lots/:lotId/release-check: the held state with each open check in words (for the viewer). */
export async function releaseCheck(caller: CommandCaller, lotId: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId)
  return caller.withClient(async (client) => ({ lot: { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, version: lot.version }, checklist: await checklistOf(client, context.tenantId, lot, today(), context.actorId) }))
}

/** GET /quality/lots/:lotId/results. */
export async function listResults(caller: CommandCaller, lotId: string) {
  const lot = await lotFor(caller, lotId)
  return caller.withClient(async (client) => ({ results: await resultsOf(client, lot.id) }))
}

/** GET /quality/lots/:lotId/documents. */
export async function listDocuments(caller: CommandCaller, lotId: string) {
  const lot = await lotFor(caller, lotId)
  return caller.withClient(async (client) => ({ documents: await documentsOf(client, lot.id, today()) }))
}
