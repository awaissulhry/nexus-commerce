import type { Prisma } from '@nexus/factory-db'
import { KIND_SHORT, KIND_WORDS, overdueDays, reminderDue, shownStatus, type DeclarationChannel, type DeclarationStatus } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import type { DeclarationKind, SubstanceUnit } from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { namesFor } from '../register-of-rules/common'
import type { Reader } from '../substances/store'

/**
 * Declarations asked of suppliers (B-W2b-256): the columns each part names and the views the routes answer. Office reads
 * (the office scope reads every column, the internal note too). One query after another; nothing written here. No money.
 */

export const REQUEST_SELECT = {
  id: true,
  companyId: true,
  number: true,
  partyId: true,
  kind: true,
  svhcListVersionId: true,
  channel: true,
  partnerTaskId: true,
  linkId: true,
  message: true,
  sentAt: true,
  dueOn: true,
  reminderEveryDays: true,
  remindersSent: true,
  lastRemindedAt: true,
  status: true,
  answeredAt: true,
  uploadId: true,
  answerFileId: true,
  answeredListVersionId: true,
  validTo: true,
  decidedAt: true,
  decidedById: true,
  decidedByName: true,
  refuseReason: true,
  cancelledAt: true,
  cancelReason: true,
  supersedesId: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SupplierDeclarationRequestSelect
export type RequestRow = Prisma.SupplierDeclarationRequestGetPayload<{ select: typeof REQUEST_SELECT }>

export const LINE_SELECT = {
  id: true,
  partyId: true,
  requestId: true,
  seq: true,
  itemId: true,
  articleLabel: true,
  contains: true,
  aboveThreshold: true,
  substanceId: true,
  substanceName: true,
  concentration: true,
  concentrationUnit: true,
  note: true,
  version: true,
} as const satisfies Prisma.SupplierDeclarationLineSelect
export type LineRow = Prisma.SupplierDeclarationLineGetPayload<{ select: typeof LINE_SELECT }>

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The newest Candidate List version (null: none recorded). */
export async function newestListVersion(db: Reader): Promise<{ readonly id: string; readonly publishedOn: BusinessDate; readonly entryCount: number } | null> {
  const row = await db.svhcListVersion.findFirst({ orderBy: { publishedOn: 'desc' }, select: { id: true, publishedOn: true, entryCount: true } })
  return row ? { id: row.id, publishedOn: dayOf(row.publishedOn), entryCount: row.entryCount } : null
}

export async function linesOf(db: Reader, requestIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const out = new Map<string, LineRow[]>(requestIds.map((id) => [id, []]))
  if (requestIds.length === 0) return out
  for (const line of await db.supplierDeclarationLine.findMany({ where: { requestId: { in: [...requestIds] } }, select: LINE_SELECT, orderBy: [{ seq: 'asc' }] })) out.get(line.requestId)?.push(line)
  return out
}

/** The list's rows (design ts-decl): request, supplier, materials, type with its Candidate List version, requested, due, reminders, status, valid to, file. */
export async function requestViews(db: Reader, rows: readonly RequestRow[], now: Date) {
  const today = businessDate(now)
  const lines = await linesOf(db, rows.map((row) => row.id))
  const partyIds = [...new Set(rows.map((row) => row.partyId))]
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const itemIds = [...new Set([...lines.values()].flat().map((line) => line.itemId))]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true } })).map((row) => [row.id, row]))
  const versionIds = [...new Set(rows.flatMap((row) => [row.svhcListVersionId, row.answeredListVersionId]).filter((id): id is string => id !== null))]
  const versions = new Map((versionIds.length === 0 ? [] : await db.svhcListVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, publishedOn: true } })).map((row) => [row.id, dayOf(row.publishedOn)]))
  const uploadIds = rows.flatMap((row) => (row.uploadId ? [row.uploadId] : []))
  const uploads = new Map((uploadIds.length === 0 ? [] : await db.supplierDocumentUpload.findMany({ where: { id: { in: uploadIds } }, select: { id: true, fileId: true, status: true } })).map((row) => [row.id, row]))
  const later = new Map(
    (rows.length === 0 ? [] : await db.supplierDeclarationRequest.findMany({ where: { supersedesId: { in: rows.map((row) => row.id) } }, select: { id: true, number: true, supersedesId: true } })).map((row) => [row.supersedesId!, row]),
  )
  const newest = await newestListVersion(db)
  return rows.map((row) => {
    const mine = lines.get(row.id) ?? []
    const party = parties.get(row.partyId)
    const upload = row.uploadId ? uploads.get(row.uploadId) : undefined
    const validTo = row.validTo ? dayOf(row.validTo) : null
    const dueOn = dayOf(row.dueOn)
    const status = row.status as DeclarationStatus
    const materials = [...new Map(mine.map((line) => [line.itemId, line])).values()].map((line) => {
      const item = items.get(line.itemId)
      return { itemId: line.itemId, code: item?.code ?? '?', name: item?.name ?? '?', kind: item?.kind ?? '?', articleLabel: line.articleLabel }
    })
    const next = later.get(row.id)
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      party: { id: row.partyId, code: party?.code ?? '?', name: party?.legalName ?? '?' },
      kind: row.kind as DeclarationKind,
      kindShort: KIND_SHORT[row.kind as DeclarationKind],
      kindWords: KIND_WORDS[row.kind as DeclarationKind],
      svhcListVersion: row.svhcListVersionId ? { id: row.svhcListVersionId, publishedOn: versions.get(row.svhcListVersionId) ?? '?' } : null,
      answeredListVersion: row.answeredListVersionId ? { id: row.answeredListVersionId, publishedOn: versions.get(row.answeredListVersionId) ?? '?' } : null,
      channel: row.channel as DeclarationChannel,
      sentAt: toUtcIso(row.sentAt),
      dueOn,
      overdueDays: status === 'SENT' || status === 'OVERDUE' ? overdueDays(dueOn, today) : 0,
      reminderEveryDays: row.reminderEveryDays,
      remindersSent: row.remindersSent,
      lastRemindedAt: iso(row.lastRemindedAt),
      reminderDue: reminderDue(row, now),
      status,
      shown: shownStatus({ status, kind: row.kind, validTo, svhcListVersionId: row.svhcListVersionId, answeredListVersionId: row.answeredListVersionId }, newest?.id ?? null, today),
      answeredAt: iso(row.answeredAt),
      validTo,
      /** The answer's file: the supplier's portal upload (its file) or the file the office recorded. */
      file: row.uploadId ? { source: 'UPLOAD' as const, uploadId: row.uploadId, fileId: upload?.fileId ?? null, uploadStatus: upload?.status ?? null } : row.answerFileId ? { source: 'FILE' as const, uploadId: null, fileId: row.answerFileId, uploadStatus: null } : null,
      materials,
      lines: mine.length,
      answeredLines: mine.filter((line) => line.contains !== null).length,
      supersedesId: row.supersedesId,
      supersededBy: next ? { id: next.id, number: next.number } : null,
      version: row.version,
    }
  })
}
export type RequestView = Awaited<ReturnType<typeof requestViews>>[number]

const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed())

/** One request with its lines, its answer and its decision (design: the Supplier declaration record's Request, Answer, Decision). */
export async function requestDetail(db: Reader, row: RequestRow, now: Date) {
  const [view] = await requestViews(db, [row], now)
  const lines = (await linesOf(db, [row.id])).get(row.id) ?? []
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, kind: true } })).map((item) => [item.id, item]))
  const substanceIds = [...new Set(lines.flatMap((line) => (line.substanceId ? [line.substanceId] : [])))]
  const substances = new Map((substanceIds.length === 0 ? [] : await db.restrictedSubstance.findMany({ where: { id: { in: substanceIds } }, select: { id: true, casNumber: true, name: true } })).map((substance) => [substance.id, substance]))
  const upload = row.uploadId
    ? await db.supplierDocumentUpload.findUnique({
        where: { id: row.uploadId },
        select: { id: true, fileId: true, status: true, category: true, issuer: true, documentNumber: true, issuedOn: true, expiresOn: true, receivedAt: true, uploadedByName: true, decidedAt: true, documentFileId: true },
      })
    : null
  const task = row.partnerTaskId ? await db.partnerTask.findUnique({ where: { id: row.partnerTaskId }, select: { id: true, status: true, dueAt: true, remindedAt: true, closedAt: true } }) : null
  const name = await namesFor(db, [row.decidedById])
  const supersedes = row.supersedesId ? await db.supplierDeclarationRequest.findUnique({ where: { id: row.supersedesId }, select: { id: true, number: true, status: true } }) : null
  return {
    ...view!,
    message: row.message,
    internalNote: row.internalNote,
    lineRows: lines.map((line) => {
      const item = items.get(line.itemId)
      const substance = line.substanceId ? substances.get(line.substanceId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        item: { id: line.itemId, code: item?.code ?? '?', name: item?.name ?? '?', kind: item?.kind ?? '?' },
        articleLabel: line.articleLabel,
        contains: line.contains,
        aboveThreshold: line.aboveThreshold,
        substance: substance ? { id: substance.id, casNumber: substance.casNumber, name: substance.name } : null,
        substanceName: line.substanceName,
        concentration: decimal(line.concentration),
        concentrationUnit: line.concentrationUnit as SubstanceUnit | null,
        note: line.note,
        version: line.version,
      }
    }),
    upload: upload
      ? {
          id: upload.id,
          fileId: upload.fileId,
          status: upload.status,
          category: upload.category,
          issuer: upload.issuer,
          documentNumber: upload.documentNumber,
          issuedOn: upload.issuedOn ? dayOf(upload.issuedOn) : null,
          expiresOn: upload.expiresOn ? dayOf(upload.expiresOn) : null,
          receivedAt: iso(upload.receivedAt),
          uploadedByName: upload.uploadedByName,
          documentFileId: upload.documentFileId,
        }
      : null,
    partnerTask: task ? { id: task.id, status: task.status, dueAt: iso(task.dueAt), remindedAt: iso(task.remindedAt), closedAt: iso(task.closedAt) } : null,
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedByName ? { id: name(row.decidedById)?.id ?? null, name: row.decidedByName } : null,
    refuseReason: row.refuseReason,
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    supersedes: supersedes ? { id: supersedes.id, number: supersedes.number, status: supersedes.status } : null,
    newestListVersion: await newestListVersion(db),
  }
}
