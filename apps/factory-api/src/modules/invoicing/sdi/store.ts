import type { Prisma } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { Reader } from '../store'

/**
 * The SDI part of the invoicing module's reads and writes (factory-db money.prisma SdiSubmission, SdiNotification): the
 * columns every read names, the company's SDI account, the row lock every SDI command takes first, and the legal
 * archive's record (ONE reader and ONE writer: today an audit row of the invoice, until SdiSubmission gets its archive
 * columns; swapping them changes these two functions only).
 */

export const SEND_COLUMNS = {
  id: true,
  partyId: true,
  invoiceId: true,
  attempt: true,
  integrationAccountId: true,
  fileName: true,
  xmlFileId: true,
  status: true,
  providerRef: true,
  sdiIdentifier: true,
  sentAt: true,
  outcomeAt: true,
  failureReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SdiSubmissionSelect
export type SendRow = Prisma.SdiSubmissionGetPayload<{ select: typeof SEND_COLUMNS }>

export const NOTIFICATION_COLUMNS = {
  id: true,
  submissionId: true,
  type: true,
  sdiMessageId: true,
  receivedAt: true,
  recordedAt: true,
  payload: true,
  inboundWebhookId: true,
} as const satisfies Prisma.SdiNotificationSelect
export type NotificationRow = Prisma.SdiNotificationGetPayload<{ select: typeof NOTIFICATION_COLUMNS }>

/** The invoice's sends, first attempt first. */
export const readSends = (db: Reader, invoiceId: string): Promise<SendRow[]> => db.sdiSubmission.findMany({ where: { invoiceId }, select: SEND_COLUMNS, orderBy: { attempt: 'asc' } })

export const readSend = (db: Reader, submissionId: string): Promise<SendRow | null> => db.sdiSubmission.findUnique({ where: { id: submissionId }, select: SEND_COLUMNS })

/** The invoice's notifications, oldest first. */
export const readNotifications = (db: Reader, invoiceId: string): Promise<NotificationRow[]> =>
  db.sdiNotification.findMany({ where: { invoiceId }, select: NOTIFICATION_COLUMNS, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })

/**
 * The company's SDI account (one per legal company, A1 §4): an ACTIVE account of provider SDI. None, or a paused one, is
 * a set-up problem for a person (409), said before anything is written.
 */
export async function sdiAccountOf(db: Reader, companyId: string): Promise<{ id: string; mode: string }> {
  const accounts = await db.integrationAccount.findMany({ where: { provider: 'SDI', companyId, status: { not: 'DISABLED' } }, select: { id: true, mode: true, status: true }, orderBy: { id: 'asc' } })
  if (accounts.length === 0) throw new ConflictError('E-invoicing is not set up for this company: it has no SDI connection (Finance settings › E-invoicing).')
  if (accounts.length > 1) throw new ConflictError('This company has more than one SDI connection; disable the ones not in use.')
  if (accounts[0]!.status === 'PAUSED') throw new ConflictError('The SDI connection of this company is paused: nothing is sent until an admin switches it on again.')
  return { id: accounts[0]!.id, mode: accounts[0]!.mode }
}

/**
 * Locks the invoice's row for the rest of the transaction (every SDI command takes it first: the send, its result, a
 * notification, a poll, a correction), so the invoice and its sends move together and in one order.
 */
export async function lockInvoice(tx: CommandTx, invoiceId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`
}

// ---- the legal archive's record (FIN-092; DM 17.6.2014) ---------------------------------------------------------------

export const ARCHIVE_ACTION = 'invoices.sdiArchive'

export interface ArchiveRecord {
  readonly submissionId: string
  readonly archiveRef: string
  readonly archivedAt: string
}

/** Where the invoice's sent file is archived for legal keeping, or null. */
export async function readArchive(db: Reader, invoiceId: string): Promise<ArchiveRecord | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'Invoice', recordId: invoiceId, action: ARCHIVE_ACTION }, select: { after: true }, orderBy: { at: 'desc' } })
  const after = row?.after as Partial<ArchiveRecord> | null | undefined
  return after && typeof after.submissionId === 'string' && typeof after.archiveRef === 'string' && typeof after.archivedAt === 'string'
    ? { submissionId: after.submissionId, archiveRef: after.archiveRef, archivedAt: after.archivedAt }
    : null
}

/** Records the archive of a sent file (inside the caller's command), with the event invoice.sdi_archived. */
export function writeArchive(tools: Pick<CommandTools, 'audit' | 'emit'>, invoice: { id: string; companyId: string }, record: ArchiveRecord): void {
  tools.audit({ action: ARCHIVE_ACTION, recordType: 'Invoice', recordId: invoice.id, companyId: invoice.companyId, after: { ...record } })
  tools.emit({ type: 'invoice.sdi_archived', subject: invoice.id, companyId: invoice.companyId, payload: { invoiceId: invoice.id, submissionId: record.submissionId } })
}
