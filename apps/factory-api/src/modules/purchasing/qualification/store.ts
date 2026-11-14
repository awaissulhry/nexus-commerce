import type { Prisma } from '@nexus/factory-db'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { requirementSentence } from '@nexus/factory-domain/files/required/rules'
import { gateOf, type GateAnswer, type GateCertificate, type GateFacts, type GateLine, type GateRule, type OverrideState } from '@nexus/factory-domain/purchasing/qualification/gate'
import { filesOf, type AnswerEntry } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import { questionsOf } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { isVaultCategory, VAULT_CATEGORIES, type VaultCategory, type VaultDocument } from '@nexus/factory-domain/purchasing/qualification/vault'
import type { SupplierKind } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { requiredDocumentsProblems } from '../../../platform/files/required/check'
import type { CommandTx } from '../../../core/command'
import { isOpenLine } from '../views'
import { documentsFor } from '../suppliers/document-types'
import { readLines, type OrderRow, type Reader } from '../store'

/**
 * The facts of the vault, the compliance gate and the qualifications (B-W2b-315), read in the caller's scope: the
 * supplier's documents in force (its Party files tagged with a vault category, with what the supplier said of them when
 * they came from its portal or questionnaire), the register's certificates covering a PPE component, the company's rules
 * before a purchase order is SENT, and the history of an order's requests to be sent without its documents (domain lines of
 * the approval engine on the PurchaseOrder, B-W2b-282's `historyLine`; what each request covers on its audit row).
 */

export const ASK_ACTION = 'purchasing.compliance.overrideAsk'
export const DECIDE_ACTION = 'purchasing.compliance.overrideDecide'
export const WITHDRAW_ACTION = 'purchasing.compliance.overrideWithdraw'

/** A document of the vault as the office reads it. */
export interface VaultFile extends VaultDocument {
  /** B-W2b-377: what document it is (a SUPPLIER_DOCUMENT_TYPE code), null when nobody said. */
  readonly documentTypeCode: string | null
  readonly name: string
  readonly addedAt: Date
  readonly issuer: string | null
  readonly number: string | null
  readonly issuedOn: BusinessDate | null
  readonly source: 'PORTAL' | 'QUESTIONNAIRE' | 'OFFICE'
  readonly uploadId: string | null
  readonly seriesId: string
  /** B-W2b-383 (B-W2b-382's gap): the file's row version, the one "say what it is" (PUT …/documents/:fileId/type) sends. */
  readonly version: number
}

const FILE_SELECT = { id: true, category: true, expiresOn: true, originalName: true, createdAt: true, seriesId: true, documentTypeCode: true, version: true } as const satisfies Prisma.StoredFileSelect

/** The files an accepted questionnaire of the party put in force (by file id), with the question each answered. */
export async function questionnaireFilesOf(db: Reader, partyId: string, companyId?: string | null): Promise<Map<string, { readonly responseId: string; readonly companyId: string; readonly key: string; readonly issuer: string | null; readonly number: string | null; readonly issuedOn: string | null }>> {
  const responses = await db.supplierQuestionnaireResponse.findMany({
    where: { partyId, decision: 'ACCEPTED', ...(companyId ? { companyId } : {}) },
    select: { id: true, companyId: true, answers: true, questionnaire: { select: { questions: true } } },
    orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
    take: 20,
  })
  const out = new Map<string, { responseId: string; companyId: string; key: string; issuer: string | null; number: string | null; issuedOn: string | null }>()
  for (const response of responses) {
    const answers = (response.answers ?? {}) as Readonly<Record<string, AnswerEntry>>
    for (const file of filesOf(questionsOf(response.questionnaire.questions), answers)) if (!out.has(file.fileId)) out.set(file.fileId, { responseId: response.id, companyId: response.companyId, key: file.key, issuer: file.issuer ?? null, number: file.number ?? null, issuedOn: file.issuedOn ?? null })
  }
  return out
}

/** The supplier's documents in force: its current Party files of a vault category, newest first. */
export async function vaultFilesOf(db: Reader, partyId: string): Promise<VaultFile[]> {
  const files = await db.storedFile.findMany({
    where: { recordType: 'Party', recordId: partyId, status: 'AVAILABLE', supersededAt: null, category: { in: [...VAULT_CATEGORIES] } },
    select: FILE_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 300,
  })
  if (files.length === 0) return []
  const uploads = await db.supplierDocumentUpload.findMany({
    where: { partyId, status: 'ACCEPTED', documentFileId: { in: files.map((file) => file.id) } },
    select: { id: true, documentFileId: true, issuer: true, documentNumber: true, issuedOn: true, articleCodes: true },
  })
  const byFile = new Map(uploads.map((upload) => [upload.documentFileId!, upload]))
  const questionnaire = await questionnaireFilesOf(db, partyId)
  return files.flatMap((file): VaultFile[] => {
    if (!isVaultCategory(file.category)) return []
    const upload = byFile.get(file.id)
    const answered = questionnaire.get(file.id)
    return [
      {
        fileId: file.id,
        category: file.category as VaultCategory,
        documentTypeCode: file.documentTypeCode,
        expiresOn: file.expiresOn ? dayOf(file.expiresOn) : null,
        articleCodes: upload ? [...upload.articleCodes] : [],
        name: file.originalName,
        addedAt: file.createdAt,
        issuer: upload?.issuer ?? answered?.issuer ?? null,
        number: upload?.documentNumber ?? answered?.number ?? null,
        issuedOn: upload?.issuedOn ? dayOf(upload.issuedOn) : (answered?.issuedOn ?? null),
        source: upload ? 'PORTAL' : answered ? 'QUESTIONNAIRE' : 'OFFICE',
        uploadId: upload?.id ?? null,
        seriesId: file.seriesId ?? file.id,
        version: file.version,
      },
    ]
  })
}

/**
 * The certificate of the register that covers each PPE component today (B-W1-12; as quality/lab's certificateCovering,
 * and only a coverage naming no supplier or this one: the certified part is bought from it), the one valid longest.
 */
export async function certificatesFor(db: Reader, itemIds: readonly string[], partyId: string, companyId: string | null, today: BusinessDate): Promise<Map<string, GateCertificate | null>> {
  const out = new Map<string, GateCertificate | null>(itemIds.map((id) => [id, null]))
  if (itemIds.length === 0) return out
  const day = new Date(`${today}T00:00:00.000Z`)
  const rows = await db.certificateCoverage.findMany({
    where: {
      itemId: { in: [...itemIds] },
      status: 'ACTIVE',
      OR: [{ supplierPartyId: null }, { supplierPartyId: partyId }],
      certificate: { status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    },
    select: { itemId: true, certificate: { select: { id: true, number: true, standard: true, validTo: true } } },
  })
  for (const row of rows) {
    const current = out.get(row.itemId!)
    const candidate = { id: row.certificate.id, number: row.certificate.number, standard: row.certificate.standard, validTo: dayOf(row.certificate.validTo) }
    if (!current || candidate.validTo > current.validTo || (candidate.validTo === current.validTo && candidate.id < current.id)) out.set(row.itemId!, candidate)
  }
  return out
}

/** The company's required-document rules for the order before SENT (B-W2b-177), each met or not, in words. */
export async function rulesBeforeSent(db: Reader, orderId: string, today: BusinessDate): Promise<GateRule[]> {
  const answer = await requiredDocumentsProblems(db as Parameters<typeof requiredDocumentsProblems>[0], { recordType: 'PurchaseOrder', recordId: orderId, toStatus: 'SENT', today })
  if (!answer) return []
  return answer.states.map((state) => ({ ruleId: state.ruleId, level: state.level, met: state.reason === 'MET', sentence: requirementSentence(state) }))
}

/** The gate's facts for an order: its open lines with their materials, the supplier's documents, certificates and rules. */
export async function gateFactsOf(db: Reader, order: Pick<OrderRow, 'id' | 'partyId' | 'companyId'>, today: BusinessDate): Promise<GateFacts> {
  const lines = (await readLines(db, order.id)).filter(isOpenLine)
  const items = lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, supplierArticleCode: true, isPpeComponent: true, requiresCrViTest: true } })
  const byItem = new Map(items.map((item) => [item.id, item]))
  const party = await db.party.findUniqueOrThrow({ where: { id: order.partyId }, select: { legalName: true, tradeName: true, supplierKinds: true } })
  const gateLines: GateLine[] = lines.map((line) => {
    const item = byItem.get(line.itemId)!
    return {
      id: line.id,
      seq: line.seq,
      itemId: line.itemId,
      itemCode: item.code,
      articleCodes: [...new Set([line.supplierArticleCode, item.supplierArticleCode, item.code].filter((code): code is string => !!code))],
      needDate: dayOf(line.needDate),
      requiresCrViTest: line.requiresCrViTest || item.requiresCrViTest,
      isPpeComponent: item.isPpeComponent,
    }
  })
  const ppe = [...new Set(gateLines.filter((line) => line.isPpeComponent).map((line) => line.itemId))]
  return {
    orderId: order.id,
    supplierName: party.tradeName ?? party.legalName,
    supplierKinds: [...party.supplierKinds] as SupplierKind[],
    today,
    lines: gateLines,
    // B-W2b-377: a test report typed as the chromium VI one (or untyped, as before the types).
    documents: documentsFor((await vaultFilesOf(db, order.partyId)).filter((doc) => doc.category === 'TEST_REPORT'), ['CR_VI_TEST_REPORT']),
    certificates: await certificatesFor(db, ppe, order.partyId, order.companyId, today),
    rules: await rulesBeforeSent(db, order.id, today),
  }
}

/** One request to send the order without its documents, with its decision (null: none yet). */
export interface OverrideRequest {
  /** The request's line (an engine request: its task's id). */
  readonly lineId: string
  /** B-W2b-377: the PURCHASE_ORDER_COMPLIANCE request of the approval engine (null: a domain line written before it). */
  readonly taskId: string | null
  readonly askedById: string
  readonly askedAt: Date
  readonly reason: string
  readonly fingerprint: string | null
  readonly decision: { readonly action: 'APPROVED' | 'REJECTED' | 'WITHDRAWN'; readonly byId: string | null; readonly at: Date; readonly words: string | null } | null
}

/** The order's requests, newest first (the engine's domain lines on the PurchaseOrder; what each covers on its audit row). */
export async function overrideRequestsOf(db: Reader, orderId: string): Promise<OverrideRequest[]> {
  const lines = await db.approvalEvent.findMany({
    where: { recordType: 'PurchaseOrder', recordId: orderId, taskId: null, action: { in: ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] } },
    select: { id: true, action: true, byId: true, at: true, words: true },
    orderBy: [{ at: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  const asks = await db.auditLog.findMany({ where: { recordType: 'PurchaseOrder', recordId: orderId, action: ASK_ACTION }, select: { after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 200 })
  const fingerprints = new Map<string, string>()
  for (const row of asks) {
    const after = (row.after ?? {}) as { requestLineId?: unknown; fingerprint?: unknown }
    if (typeof after.requestLineId === 'string' && typeof after.fingerprint === 'string') fingerprints.set(after.requestLineId, after.fingerprint)
  }
  const out: OverrideRequest[] = []
  let current: { lineId: string; askedById: string; askedAt: Date; reason: string; decision: OverrideRequest['decision'] } | null = null
  const close = () => {
    if (current) out.push({ ...current, taskId: null, fingerprint: fingerprints.get(current.lineId) ?? null })
  }
  for (const line of lines) {
    if (line.action === 'REQUESTED') {
      close()
      current = { lineId: line.id, askedById: line.byId ?? '', askedAt: line.at, reason: line.words ?? '', decision: null }
    } else if (current && current.decision === null) {
      current.decision = { action: line.action as 'APPROVED' | 'REJECTED' | 'WITHDRAWN', byId: line.byId, at: line.at, words: line.words }
    }
  }
  close()
  // B-W2b-377: the engine's PURCHASE_ORDER_COMPLIANCE requests (the ask's audit row names its task), newest first with the lines.
  return [...out, ...(await taskRequestsOf(db, orderId, asks))].sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime() || (a.lineId < b.lineId ? 1 : -1))
}

/** The order's requests asked of the approval engine (B-W2b-377), each with the reason and fingerprint of its ask. */
async function taskRequestsOf(db: Reader, orderId: string, asks: readonly { readonly after: unknown }[]): Promise<OverrideRequest[]> {
  const tasks = await db.approvalTask.findMany({
    where: { kind: 'PURCHASE_ORDER_COMPLIANCE', recordType: 'PurchaseOrder', recordId: orderId },
    select: { id: true, status: true, requestedById: true, requestedAt: true, decidedById: true, decidedAt: true, comment: true, rejectReason: true, withdrawnAt: true, withdrawnById: true, staleAt: true },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  if (tasks.length === 0) return []
  const byTask = new Map<string, { fingerprint: string | null; reason: string }>()
  for (const row of asks) {
    const after = (row.after ?? {}) as { taskId?: unknown; fingerprint?: unknown; reason?: unknown }
    if (typeof after.taskId === 'string' && !byTask.has(after.taskId)) byTask.set(after.taskId, { fingerprint: typeof after.fingerprint === 'string' ? after.fingerprint : null, reason: typeof after.reason === 'string' ? after.reason : '' })
  }
  return tasks.map((task): OverrideRequest => {
    const ask = byTask.get(task.id)
    const decision: OverrideRequest['decision'] =
      task.status === 'APPROVED' || task.status === 'REJECTED'
        ? { action: task.status, byId: task.decidedById, at: task.decidedAt!, words: task.status === 'APPROVED' ? task.comment : task.rejectReason }
        : task.status === 'WITHDRAWN'
          ? { action: 'WITHDRAWN', byId: task.withdrawnById, at: task.withdrawnAt!, words: null }
          : task.status === 'STALE'
            ? // Found changed before its yes: taken back by the system (what holds the order now needs a new request).
              { action: 'WITHDRAWN', byId: null, at: task.staleAt!, words: null }
            : null
    return { lineId: task.id, taskId: task.id, askedById: task.requestedById ?? '', askedAt: task.requestedAt, reason: ask?.reason ?? '', fingerprint: ask?.fingerprint ?? null, decision }
  })
}

/** The newest request as the gate reads it (a newer one supersedes an older one still waiting). */
export function overrideStateOf(request: OverrideRequest | undefined, names: ReadonlyMap<string, string>): OverrideState | null {
  if (!request || request.fingerprint === null) return null
  const state = request.decision === null ? 'WAITING' : request.decision.action
  return {
    state,
    fingerprint: request.fingerprint,
    reason: request.reason,
    askedById: request.askedById,
    askedByName: names.get(request.askedById) ?? null,
    askedAt: toUtcIso(request.askedAt),
    decidedByName: request.decision?.byId ? (names.get(request.decision.byId) ?? null) : null,
    decidedAt: request.decision ? toUtcIso(request.decision.at) : null,
    words: request.decision?.words ?? null,
  }
}

/** The people the requests name. */
export async function namesOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** The gate's answer for an order now, with its newest request (the send's check, the order's compliance read). */
export async function gateAnswerOf(db: Reader, order: Pick<OrderRow, 'id' | 'partyId' | 'companyId'>, today: BusinessDate): Promise<{ readonly answer: GateAnswer; readonly requests: OverrideRequest[]; readonly names: Map<string, string> }> {
  const facts = await gateFactsOf(db, order, today)
  const requests = await overrideRequestsOf(db, order.id)
  const names = await namesOf(db, requests.flatMap((request) => [request.askedById, request.decision?.byId]))
  return { answer: gateOf(facts, overrideStateOf(requests[0], names)), requests, names }
}

/** The order's row held for this command, without moving its version (a pending purchase-order approval stays current). */
export async function lockOrder(tx: CommandTx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "PurchaseOrder" WHERE id = ${orderId}::uuid FOR UPDATE`
}

export const todayOf = (now: Date): BusinessDate => businessDate(now)
