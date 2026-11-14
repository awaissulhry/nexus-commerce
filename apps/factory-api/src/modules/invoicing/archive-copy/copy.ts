import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { copyKeyOf, copyStateOf, providerNameOf, receiptDocument, receiptFileName, swapReadiness, type CopyState } from '@nexus/factory-domain/invoicing/archive-copy/archive-copy'
import { isTestRef } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import type { SdiNotificationType } from '@nexus/factory-domain/ports/sdi'
import { command, type CommandCaller } from '../../../core/command'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { lockInvoice } from '../sdi/store'
import type { Reader } from '../store'

/**
 * Our own copy of every send to SDI (B-W2b-401; FIN-097; factory-db tax.prisma SdiArchiveCopy, one per send, key
 * `sdi:<send>`): the XML sent (the send's own file, a FISCAL_ARCHIVE file of the invoice) and each of SDI's notifications as
 * our own FISCAL_ARCHIVE file (recordType SdiNotification, the notification's id; factory-domain invoicing/archive-copy's XML
 * record of it), ten years, so the intermediary can change without losing a file. The worker's handler
 * `invoicing.sdiArchiveCopy` makes or completes a send's copy whenever its send moved past SENDING or a notification came;
 * POST /invoicing/e-invoicing/copies/:companyId/make completes what is missing (older sends, a lost handler). The files go to
 * the store first (outside any transaction), then ONE command names them on the copy under the invoice's row lock (a
 * notification that got its file meanwhile is not named twice; the loser's object stays unnamed in the store, as any failed
 * generated file). A send simulated in test mode, or one that never reached the intermediary, has no copy.
 */

interface NotificationFacts {
  readonly id: string
  readonly type: SdiNotificationType
  readonly sdiMessageId: string | null
  readonly receivedAt: Date
  readonly recordedAt: Date
  readonly payload: unknown
}

interface SendFacts {
  readonly id: string
  readonly invoiceId: string
  readonly partyId: string
  readonly companyId: string
  readonly fileName: string
  readonly xmlFileId: string
  readonly status: string
  readonly providerRef: string | null
  readonly provider: string
  readonly notifications: readonly NotificationFacts[]
  readonly copy: { readonly id: string; readonly receiptFileIds: readonly string[] } | null
  /** Notification id → its receipt file named on the copy. */
  readonly kept: ReadonlyMap<string, string>
}

async function sendFacts(db: Reader, submissionId: string): Promise<SendFacts | null> {
  const send = await db.sdiSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, invoiceId: true, partyId: true, fileName: true, xmlFileId: true, status: true, providerRef: true, invoice: { select: { companyId: true } }, integrationAccount: { select: { label: true, mode: true } } },
  })
  if (!send) return null
  const notifications = await db.sdiNotification.findMany({ where: { submissionId }, select: { id: true, type: true, sdiMessageId: true, receivedAt: true, recordedAt: true, payload: true }, orderBy: [{ recordedAt: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }] })
  const copy = await db.sdiArchiveCopy.findFirst({ where: { key: copyKeyOf(submissionId) }, select: { id: true, receiptFileIds: true } })
  const files = copy && copy.receiptFileIds.length > 0 ? await db.storedFile.findMany({ where: { id: { in: copy.receiptFileIds } }, select: { id: true, recordType: true, recordId: true } }) : []
  const kept = new Map(files.filter((file) => file.recordType === 'SdiNotification').map((file) => [file.recordId, file.id] as const))
  return {
    id: send.id,
    invoiceId: send.invoiceId,
    partyId: send.partyId,
    companyId: send.invoice.companyId,
    fileName: send.fileName,
    xmlFileId: send.xmlFileId,
    status: send.status,
    providerRef: send.providerRef,
    provider: providerNameOf(send.integrationAccount),
    notifications: notifications.map((row) => ({ ...row, type: row.type as SdiNotificationType })),
    copy,
    kept,
  }
}

/** Whether a send needs a copy at all: the intermediary took it, and it was not simulated in test mode. */
const needsCopy = (send: Pick<SendFacts, 'status' | 'providerRef'>): boolean => !isTestRef(send.providerRef) && (send.providerRef !== null || (send.status !== 'SENDING' && send.status !== 'FAILED'))

/** Thrown inside the copy's command when a racing run already kept every receipt: the command writes nothing (and so has no audit row) and the send's copy is complete. */
class AlreadyCopied extends Error {}

/** Makes or completes one send's copy. Returns what changed. */
export async function copySend(files: FilesRuntime, caller: CommandCaller, submissionId: string, causationId?: string): Promise<'made' | 'receipts' | 'complete' | 'nothing'> {
  const facts = await caller.withClient((client) => sendFacts(client, submissionId))
  if (!facts || !needsCopy(facts)) return 'nothing'
  const missing = facts.notifications.filter((row) => !facts.kept.has(row.id))
  if (facts.copy && missing.length === 0) return 'complete'
  const prepared: { notificationId: string; file: PreparedGeneratedFile }[] = []
  for (const row of missing) {
    const ordinal = facts.notifications.findIndex((entry) => entry.id === row.id) + 1
    const body = receiptDocument({ type: row.type, sdiMessageId: row.sdiMessageId, receivedAt: toUtcIso(row.receivedAt), payload: row.payload }, facts.provider)
    const file = await putGeneratedFile(files, caller, { companyId: facts.companyId, recordType: 'SdiNotification', recordId: row.id, kind: 'FISCAL_ARCHIVE', originalName: receiptFileName(facts.fileName, row.type, ordinal), contentType: 'application/xml', body: Buffer.from(body, 'utf8') })
    prepared.push({ notificationId: row.id, file })
  }
  let result: { changed: 'made' | 'receipts' }
  try {
    ;({ result } = await command(caller, { name: 'invoices.sdiArchiveCopy', input: { submissionId, receipts: prepared.length }, ...(causationId ? { causationId } : {}) }, async (tools) => {
      await lockInvoice(tools.tx, facts.invoiceId)
      const now = (await sendFacts(tools.tx, submissionId))!
      const fresh = prepared.filter((entry) => !now.kept.has(entry.notificationId))
      const named: string[] = []
      for (const entry of fresh) named.push((await recordGeneratedFile(tools, entry.file, { details: { file: 'SDI notification (our copy)', submissionId } })).id)
      let copyId: string
      let action: 'MADE' | 'RECEIPTS_ADDED'
      if (now.copy === null) {
        copyId = newId()
        action = 'MADE'
        await tools.tx.sdiArchiveCopy.create({
          data: { id: copyId, companyId: now.companyId, partyId: now.partyId, invoiceId: now.invoiceId, submissionId, key: copyKeyOf(submissionId), providerName: now.provider, xmlFileId: now.xmlFileId, receiptFileIds: named, copiedAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
          select: { id: true },
        })
      } else {
        // Two events can race (a status change and a notification): the first run kept the receipts, this one has none.
        if (named.length === 0) throw new AlreadyCopied()
        copyId = now.copy.id
        action = 'RECEIPTS_ADDED'
        await tools.tx.sdiArchiveCopy.update({ where: { id: copyId }, data: { receiptFileIds: [...now.copy.receiptFileIds, ...named], copiedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
      }
      const receipts = (now.copy?.receiptFileIds.length ?? 0) + named.length
      tools.audit({ action: 'invoices.sdiArchiveCopy', recordType: 'SdiArchiveCopy', recordId: copyId, companyId: now.companyId, after: { submissionId, provider: now.provider, xmlFileId: now.xmlFileId, receiptsAdded: named.length, receipts } })
      tools.emit({ type: 'sdi_archive_copy.changed', subject: copyId, companyId: now.companyId, payload: { copyId, invoiceId: now.invoiceId, submissionId, action, receipts } })
      return { changed: action === 'MADE' ? ('made' as const) : ('receipts' as const) }
    }))
  } catch (error) {
    if (error instanceof AlreadyCopied) return 'complete'
    throw error
  }
  return result.changed
}

/** The worker's handler: a send that moved past SENDING, or a notification recorded. Listed in background.ts. */
export function sdiArchiveCopyHandler(options: { readonly files?: () => FilesRuntime } = {}): EventHandler {
  return defineHandler({
    name: 'invoicing.sdiArchiveCopy',
    events: ['invoice.sdi_status_changed', 'invoice.sdi_notification_received'],
    attempts: 10,
    async handle(event, { caller }) {
      const payload = event.payload as { submissionId: string; sendStatus?: string }
      if (payload.sendStatus === 'SENDING' || payload.sendStatus === 'FAILED') return
      await copySend((options.files ?? processFiles)(), caller, payload.submissionId, event.eventId)
    },
  })
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

export interface SendCopyView {
  readonly submissionId: string
  readonly invoiceId: string
  readonly attempt: number
  readonly fileName: string
  readonly status: string
  readonly copy: { readonly state: CopyState; readonly words: string }
  readonly providerName: string | null
  readonly xmlFileId: string | null
  readonly receipts: { readonly fileId: string; readonly notificationId: string; readonly type: string }[]
  readonly notifications: number
  readonly copiedAt: string | null
}

/** Each send's copy, from the sends' rows (one read per kind of row). */
export async function copiesOfSends(db: Reader, where: { invoiceId?: string; invoice?: Prisma.InvoiceWhereInput }, take = 500): Promise<SendCopyView[]> {
  const sends = await db.sdiSubmission.findMany({
    where: { ...(where.invoiceId ? { invoiceId: where.invoiceId } : {}), ...(where.invoice ? { invoice: where.invoice } : {}) },
    select: { id: true, invoiceId: true, attempt: true, fileName: true, status: true, providerRef: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  if (sends.length === 0) return []
  const ids = sends.map((send) => send.id)
  const copies = await db.sdiArchiveCopy.findMany({ where: { submissionId: { in: ids } }, select: { submissionId: true, providerName: true, xmlFileId: true, receiptFileIds: true, copiedAt: true } })
  const notifications = await db.sdiNotification.findMany({ where: { submissionId: { in: ids } }, select: { id: true, submissionId: true, type: true } })
  const fileIds = copies.flatMap((copy) => copy.receiptFileIds)
  const files = fileIds.length > 0 ? await db.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, recordType: true, recordId: true } }) : []
  return sends.map((send) => {
    const copy = copies.find((entry) => entry.submissionId === send.id) ?? null
    const own = notifications.filter((row) => row.submissionId === send.id)
    const receipts = (copy?.receiptFileIds ?? []).flatMap((fileId) => {
      const file = files.find((entry) => entry.id === fileId)
      const notification = file && file.recordType === 'SdiNotification' ? own.find((row) => row.id === file.recordId) : undefined
      return notification ? [{ fileId, notificationId: notification.id, type: notification.type }] : []
    })
    return {
      submissionId: send.id,
      invoiceId: send.invoiceId,
      attempt: send.attempt,
      fileName: send.fileName,
      status: send.status,
      copy: copyStateOf(send, copy ? { notificationsKept: receipts.length } : null, own.length),
      providerName: copy?.providerName ?? null,
      xmlFileId: copy?.xmlFileId ?? null,
      receipts,
      notifications: own.length,
      copiedAt: copy ? toUtcIso(copy.copiedAt) : null,
    }
  })
}

/**
 * Every send of a company in one light row (its state, its notifications counted, the notification files its copy names
 * counted), oldest first, so a company with years of sends is read at once.
 */
export async function sendStates(db: Reader, companyId: string): Promise<{ id: string; status: string; copy: CopyState; providerName: string | null }[]> {
  const rows = await db.$queryRaw<{ id: string; status: string; providerRef: string | null; notes: bigint; hasCopy: boolean; kept: bigint; providerName: string | null }[]>`
    SELECT s.id, s.status::text AS status, s."providerRef",
           (SELECT count(*) FROM "SdiNotification" n WHERE n."submissionId" = s.id) AS notes,
           (c.id IS NOT NULL) AS "hasCopy",
           (SELECT count(*) FROM "StoredFile" f WHERE c.id IS NOT NULL AND f.id = ANY(c."receiptFileIds") AND f."recordType" = 'SdiNotification') AS kept,
           c."providerName"
      FROM "SdiSubmission" s
      JOIN "Invoice" i ON i."tenantId" = s."tenantId" AND i.id = s."invoiceId"
      LEFT JOIN "SdiArchiveCopy" c ON c."tenantId" = s."tenantId" AND c."submissionId" = s.id
     WHERE i."companyId" = ${companyId}::uuid
     ORDER BY s."createdAt", s.id`
  return rows.map((row) => ({ id: row.id, status: row.status, copy: copyStateOf(row, row.hasCopy ? { notificationsKept: Number(row.kept) } : null, Number(row.notes)).state, providerName: row.providerName }))
}

/** Whether the company may swap its intermediary now (FIN-097), over every send of it, and the intermediaries its copies name. */
export async function readinessOf(db: Reader, companyId: string) {
  const sends = await sendStates(db, companyId)
  return { ...swapReadiness(sends), providers: [...new Set(sends.flatMap((send) => (send.providerName ? [send.providerName] : [])))].sort() }
}
