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
  type ReleaseFacts,
  type SettingSource,
} from '@nexus/factory-domain/quality/lab/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { processLotDocuments, type LotDocumentRow } from './documents-store'
import { processLabResults, type LabResultRow } from './results-store'
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

export interface ResultView extends LabResultRow {
  readonly words: string
  readonly file: { readonly id: string; readonly originalName: string; readonly status: string } | null
  /** A later result superseded it. */
  readonly superseded: boolean
}

export async function resultsOf(client: Reader, lotId: string): Promise<ResultView[]> {
  const rows = await processLabResults().list(client, lotId)
  const files = rows.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.fileId))] } }, select: { id: true, originalName: true, status: true } })
  const byId = new Map(files.map((file) => [file.id, file]))
  const superseded = new Set(rows.map((row) => row.supersedesId).filter((id): id is string => id !== null))
  return rows.map((row) => ({ ...row, words: resultWords(row), file: byId.get(row.fileId) ?? null, superseded: superseded.has(row.id) }))
}

const resultWords = (row: LabResultRow): string =>
  crViVerdict(row.belowDetectionLimit ? { belowDetectionLimit: true, detectionLimitMgKg: row.detectionLimitMgKg } : { valueMgKg: row.valueMgKg }, row.limitMgKg).verdict?.words ?? `${row.verdict}.`

/** The facts the checklist needs, read on this client (inside a command: its transaction). */
export async function checklistFactsOf(client: Reader, tenantId: string, lot: LotRow, day: BusinessDate, releaserId: string | null): Promise<ReleaseFacts> {
  const receipt = await receiptOf(client, lot)
  const { rule } = await ruleFor(client, tenantId, lot.companyId)
  const ppeCertificate = lot.item.isPpeComponent ? await certificateCovering(client, lot, day) : null
  const documents = (await documentsOf(client, lot.id, day)).filter((document) => document.inForce).map((document) => ({ kind: document.kind, validTo: document.validTo }))
  return { lot: factsOf(lot), receipt: receipt && { number: receipt.number, status: receipt.status }, rule, ppeCertificate, documents, today: day, releaserId }
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
  }
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
