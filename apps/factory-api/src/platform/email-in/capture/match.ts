import type { Prisma } from '@nexus/factory-db'
import { companyDomainOf } from '@nexus/factory-domain/email-in/rules'
import { addressDomain, isAddress, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { captureTokensOf, forwardedOf, forwardedTextOf, recordNumbersIn, type CaptureKind } from '@nexus/factory-domain/mail-depth/rules'
import { uniqueIds } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller } from '../../../core/command'
import { resolveRecord } from '../../threads/records'
import { ensureThread, writeMessage } from '../../threads/threads'
import { recordFiles } from '../files'
import { PARTY_RECORD } from '../match'
import type { EmailInRuntime } from '../service'
import { emitSorted, MAIL_SORT } from '../sort'
import { replyDomainsOf, type Reader } from '../team-inbox/store'
import { copyMailFiles } from './copy'

/**
 * The capture address's matching (B-W2b-394; COL-021; design admin.connections "Capture address: forward or BCC any mail to
 * it", home.mail "Copy capture address"): the worker's step after the sorting left a mail in Mail to sort (TRIAGE), when one
 * of its recipients is a live capture address `c-<token>@<reply domain>` of the tenant. The factory reads no staff mailbox
 * (Statuto dei Lavoratori art. 4): only what a person chose to forward or copy here.
 *
 *   who      the mail's From is an ACTIVE office person of the tenant and SES's DMARC verdict passed (the address is theirs);
 *            any other sender's mail to the address stays in Mail to sort like any unknown mail;
 *   whose    FORWARDED (the capture address in To or Cc): the customer or supplier who wrote the forwarded mail (its "From:"
 *            line); COPIED (only in the envelope: a BCC): the people the person's own mail went to (To, Cc). Their party is the
 *            one whose ACTIVE contact has that address, else the one party whose contacts share its company domain;
 *   where    the record of that party whose number the subject names (an order, a quote, an inquiry, a purchase order, a
 *            complaint, a service case, a return, a repair, a supplier claim; a closed thread leaves the mail to a person), else
 *            the party's own thread;
 *   how      ONE command: the mail's files copied onto the record (read and put before it), the mail an INBOUND message of the
 *            thread shared with the party — FORWARDED: the forwarded part only, as the partner wrote it (the person's own words
 *            above it stay on the mail, office only); COPIED: the person's mail as they sent it, by them — and the mail
 *            MATCHED (MANUAL, sorted by the person who forwarded it), email.inbound_sorted.
 * A mail it cannot place stays in Mail to sort; the capture address's default team inbox takes it (./route.ts).
 */

/** The record types a subject may name, read by number among the party's records (each with its thread resolver). */
const NUMBERED: ReadonlyArray<{ readonly type: string; readonly find: (db: Reader, numbers: string[], partyId: string) => Promise<{ id: string } | null> }> = [
  { type: 'SalesOrder', find: (db, number, partyId) => db.salesOrder.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'Quote', find: (db, number, partyId) => db.quote.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'Inquiry', find: (db, number, partyId) => db.inquiry.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'PurchaseOrder', find: (db, number, partyId) => db.purchaseOrder.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'Complaint', find: (db, number, partyId) => db.complaint.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'ServiceCase', find: (db, number, partyId) => db.serviceCase.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'ReturnAuthorisation', find: (db, number, partyId) => db.returnAuthorisation.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'RepairOrder', find: (db, number, partyId) => db.repairOrder.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
  { type: 'SupplierClaim', find: (db, number, partyId) => db.supplierClaim.findFirst({ where: { number: { in: number }, partyId }, select: { id: true } }) },
]

const CAPTURE_MAIL = { ...MAIL_SORT, version: true } as const satisfies Prisma.InboundEmailSelect
type CaptureMail = Prisma.InboundEmailGetPayload<{ select: typeof CAPTURE_MAIL }>

/** The live capture address a mail was sent to (the first among its recipients), or null. */
export async function captureOfMail(db: Reader, mail: Pick<CaptureMail, 'companyId' | 'envelopeTo' | 'to' | 'cc'>) {
  const tokens = captureTokensOf([...mail.envelopeTo, ...mail.to, ...mail.cc], await replyDomainsOf(db, mail.companyId))
  if (tokens.length === 0) return null
  const live = await db.captureAddress.findMany({ where: { token: { in: tokens }, revokedAt: null, ...(mail.companyId ? { companyId: mail.companyId } : {}) }, select: { id: true, companyId: true, token: true, defaultTeamInboxId: true } })
  const capture = tokens.map((token) => live.find((row) => row.token === token)).find((row) => row !== undefined) ?? null
  if (!capture) return null
  const inHeaders = captureTokensOf([...mail.to, ...mail.cc], await replyDomainsOf(db, capture.companyId)).includes(capture.token)
  return { ...capture, kind: (inHeaders ? 'FORWARDED' : 'COPIED') as CaptureKind }
}

/** The party (and contact) of some addresses: an ACTIVE contact's, else the one party a company domain points at; null when none or several. */
async function partyOf(db: Reader, addresses: readonly string[], companyId: string): Promise<{ partyId: string; contactId: string | null } | null> {
  if (addresses.length === 0) return null
  const contacts = await db.partyContact.findMany({ where: { email: { in: [...addresses] }, status: 'ACTIVE', party: { status: { not: 'ARCHIVED' }, OR: [{ companyId: null }, { companyId }] } }, select: { id: true, partyId: true, email: true }, orderBy: { id: 'asc' } })
  const parties = [...new Set(contacts.map((contact) => contact.partyId))]
  if (parties.length === 1) {
    const partyId = parties[0]!
    const first = addresses.map((address) => contacts.find((contact) => contact.partyId === partyId && contact.email === address)).find((contact) => contact !== undefined)
    return { partyId, contactId: first?.id ?? null }
  }
  if (parties.length > 1) return null
  const domains = [...new Set(addresses.map((address) => companyDomainOf(address)).filter((domain): domain is string => domain !== null))]
  if (domains.length !== 1) return null
  const byDomain = await db.partyContact.findMany({ where: { email: { endsWith: `@${domains[0]}` }, status: 'ACTIVE', party: { status: { not: 'ARCHIVED' }, OR: [{ companyId: null }, { companyId }] } }, select: { partyId: true }, distinct: ['partyId'], take: 2 })
  return byDomain.length === 1 ? { partyId: byDomain[0]!.partyId, contactId: null } : null
}

/** The record of the party the subject names by number, else the party's own thread. */
async function recordOf(db: Reader, subject: string | null, partyId: string): Promise<{ readonly type: string; readonly id: string }> {
  const numbers = recordNumbersIn(subject)
  if (numbers.length > 0) {
    for (const entry of NUMBERED) {
      const found = await entry.find(db, numbers, partyId)
      if (found) return { type: entry.type, id: found.id }
    }
  }
  return { type: PARTY_RECORD, id: partyId }
}

export type CaptureOutcome =
  | { readonly status: 'NOT_CAPTURE' }
  | { readonly status: 'MATCHED'; readonly threadId: string; readonly messageId: string }
  | { readonly status: 'UNPLACED'; readonly defaultTeamInboxId: string | null }

/** The plan of a captured mail, read before the command (the files are copied before it too). */
async function planOf(db: Reader, mail: CaptureMail) {
  const capture = await captureOfMail(db, mail)
  if (!capture) return null
  const sender = mail.fromAddress ? normalizeAddress(mail.fromAddress) : null
  const staff = sender && mail.dmarcVerdict === 'PASS' ? await db.user.findFirst({ where: { email: { equals: sender, mode: 'insensitive' }, audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true, displayName: true } }) : null
  if (!staff) return { capture, place: null }
  let addresses: string[] = []
  let forwarded: ReturnType<typeof forwardedOf> = null
  if (capture.kind === 'FORWARDED') {
    forwarded = forwardedOf(mail.bodyText)
    if (forwarded) addresses = [forwarded.address]
  } else {
    // Our own addresses are never the partner: the tenant's reply domains and its office people.
    const own = new Set(await replyDomainsOf(db, null))
    const people = new Set((await db.user.findMany({ where: { email: { in: [...mail.to, ...mail.cc] }, audience: 'OFFICE' }, select: { email: true } })).map((user) => normalizeAddress(user.email)))
    addresses = [...new Set([...mail.to, ...mail.cc].map(normalizeAddress))].filter((address) => isAddress(address) && !own.has(addressDomain(address)) && !people.has(address))
  }
  const party = await partyOf(db, addresses, capture.companyId)
  if (!party) return { capture, place: null }
  const record = await recordOf(db, mail.subject, party.partyId)
  const thread = await db.thread.findFirst({ where: { recordType: record.type, recordId: record.id }, select: { id: true, status: true } })
  if (thread?.status === 'CLOSED') return { capture, place: null }
  if (mail.emailMessageId && (await db.message.findFirst({ where: { emailMessageId: mail.emailMessageId }, select: { id: true } }))) return { capture, place: null }
  return { capture, place: { staff, party, record, forwarded } }
}

/**
 * The worker's capture step for one mail (see the module comment). Answers NOT_CAPTURE (no capture address among its
 * recipients, or it no longer waits in Mail to sort), MATCHED, or UNPLACED with the capture address's default team inbox.
 */
export async function captureMail(runtime: EmailInRuntime, caller: CommandCaller, inboundEmailId: string, options: { readonly causationId?: string } = {}): Promise<CaptureOutcome> {
  const read = await caller.withClient(async (db) => {
    const mail = await db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: CAPTURE_MAIL })
    return mail && mail.status === 'TRIAGE' ? { mail, plan: await planOf(db, mail) } : null
  })
  if (!read?.plan) return { status: 'NOT_CAPTURE' }
  const { mail, plan } = read
  if (!plan.place) return { status: 'UNPLACED', defaultTeamInboxId: plan.capture.defaultTeamInboxId }
  const { staff, party, record, forwarded } = plan.place
  // The copies are keyed under the record's company, as the thread's files are (W0's assign does the same).
  const scope = await caller.withClient((db) => resolveRecord(db, record.type, record.id))
  const copies = await copyMailFiles(runtime, caller, mail, scope?.companyId ?? null)
  const kind = plan.capture.kind
  const { result } = await command(caller, { name: 'emailIn.capture', input: { inboundEmailId, captureAddressId: plan.capture.id, kind }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { tx, now } = tools
    // The lock: the mail must still wait, at the version read (a person may have sorted it meanwhile).
    const { count } = await tx.inboundEmail.updateMany({ where: { id: mail.id, status: 'TRIAGE', version: mail.version }, data: { version: { increment: 1 } } })
    if (count !== 1) {
      tools.audit({ action: 'emailIn.captureSkipped', recordType: 'InboundEmail', recordId: mail.id, companyId: mail.companyId })
      return { status: 'NOT_CAPTURE' as const }
    }
    const { thread } = await ensureThread(tools, record, null)
    const fileIds = await recordFiles(tools, { recordType: thread.recordType, recordId: thread.recordId, companyId: thread.companyId, partyId: thread.partyId }, copies)
    const text = forwarded && mail.bodyText ? forwardedTextOf(mail.bodyText, forwarded.start) : (mail.bodyText ?? '')
    const message = await writeMessage(tools, thread, {
      direction: 'INBOUND',
      channel: 'EMAIL',
      author: kind === 'FORWARDED' ? { kind: 'PARTY', id: party.contactId, name: forwarded?.name ?? forwarded?.address ?? null } : { kind: 'USER', id: staff.id, name: staff.displayName },
      bodyText: text.trim() !== '' ? text : (mail.subject ?? '—'),
      // The forwarded part has no HTML of its own (the HTML holds the person's words too): its text only.
      bodyHtml: kind === 'COPIED' ? mail.bodyHtml : null,
      attachments: uniqueIds(fileIds),
      emailMessageId: mail.emailMessageId,
      at: mail.receivedAt,
    })
    await tx.inboundEmail.update({
      where: { id: mail.id },
      data: { status: 'MATCHED', threadId: thread.id, messageId: message.id, matchedBy: 'MANUAL', senderPartyId: party.partyId, senderContactId: party.contactId, sortedAt: now, sortedById: staff.id },
      select: { id: true },
    })
    tools.audit({
      action: 'emailIn.capture',
      recordType: 'InboundEmail',
      recordId: mail.id,
      companyId: mail.companyId,
      before: { status: 'TRIAGE' },
      after: { status: 'MATCHED', matchedBy: 'MANUAL', kind, captureAddressId: plan.capture.id, threadId: thread.id, recordType: thread.recordType, recordId: thread.recordId, messageId: message.id, partyId: party.partyId, files: fileIds.length, by: staff.id },
    })
    emitSorted(tools, mail, 'MATCHED', thread.id, message.id)
    return { status: 'MATCHED' as const, threadId: thread.id, messageId: message.id }
  })
  return result
}
