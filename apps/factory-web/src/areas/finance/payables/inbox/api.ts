import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { downloadLink } from '../../../../record-panels/api'

/**
 * B-W2b-GB02 — the SDI inbox (B-W2b-21's routes; factory-db SdiInboxItem): the deliveries SDI handed the company that the
 * pickup could not record, why, how often they were tried and how they ended; dismiss one with a reason, reopen it; open the
 * file SDI handed over when it was kept (G088). No money here.
 */

export const INBOX_STATUSES = ['OPEN', 'RECORDED', 'DISMISSED'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]
export const INBOX_PROBLEMS = ['UNREADABLE', 'SUPPLIER_UNKNOWN', 'OTHER_ADDRESSEE', 'DUPLICATE_NUMBER', 'PERIOD_LOCKED', 'FILE_UNAVAILABLE', 'OTHER'] as const
export type InboxProblem = (typeof INBOX_PROBLEMS)[number]

export const inboxItemSchema = z.object({
  id: z.string(),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  sdiIdentifier: z.string(),
  fileName: z.string(),
  receivedAt: z.string(),
  problem: z.enum(INBOX_PROBLEMS),
  attempts: z.number(),
  lastTriedAt: z.string(),
  status: z.enum(INBOX_STATUSES),
  xmlFileId: z.string().nullable(),
  recorded: z.object({ at: z.string(), supplierInvoiceId: z.string().nullable(), supplierInvoiceFileId: z.string().nullable() }).nullable(),
  dismissed: z.object({ at: z.string(), by: z.object({ id: z.string(), name: z.string().nullable() }).nullable(), reason: z.string() }).nullable(),
  version: z.number(),
})
export type InboxItem = z.infer<typeof inboxItemSchema>

const listSchema = z.object({ items: z.array(inboxItemSchema), nextCursor: z.string().nullable(), counts: z.object({ open: z.number(), dismissed: z.number() }) })
export type InboxList = z.infer<typeof listSchema>

const enc = encodeURIComponent

/** The company's deliveries in the inbox, newest first (payables.view); status left out: every one. */
export async function listInbox(api: ApiClient, companyId: string, status: InboxStatus | null, signal?: AbortSignal): Promise<InboxList> {
  return api.get('/payables/sdi/inbox', { query: { companyId, ...(status ? { status } : {}), limit: '200' }, schema: listSchema, signal })
}

/** Dismisses a waiting delivery with the reason (payables.manage); it is not tried again. */
export async function dismissInboxItem(api: ApiClient, item: Pick<InboxItem, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<InboxItem> {
  return (await api.post(`/payables/sdi/inbox/${enc(item.id)}/dismiss`, { body: { version: item.version, reason }, schema: z.object({ item: inboxItemSchema }), idempotencyKey })).item
}

/** Opens a dismissed delivery again (payables.manage): the next pickup tries it. */
export async function reopenInboxItem(api: ApiClient, item: Pick<InboxItem, 'id' | 'version'>, idempotencyKey: string): Promise<InboxItem> {
  return (await api.post(`/payables/sdi/inbox/${enc(item.id)}/reopen`, { body: { version: item.version }, schema: z.object({ item: inboxItemSchema }), idempotencyKey })).item
}

/** A presigned link to the file SDI handed over (files.read). */
export async function inboxFileLink(api: ApiClient, fileId: string): Promise<string> {
  return (await downloadLink(api, fileId)).download.url
}

/** A live event after which the inbox is read again. */
export const inboxTouched = (change: { type: string }): boolean => change.type.startsWith('sdi_inbox_item.') || change.type === 'supplier_invoice.sdi_picked_up' || change.type === 'supplier_invoice.received'
