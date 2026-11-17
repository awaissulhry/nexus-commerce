import type { Prisma } from '@nexus/factory-db'
import { isAnswered, KIND_RULES, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { APPROVAL_MAIL_TEMPLATES, receiptMail } from '@nexus/factory-domain/approvals-out/mail'
import { decidedForPartyPageWords, decidedWords } from '@nexus/factory-domain/approvals-out/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import type { Clock } from '../../core/time'
import { ensureThread, writeMessage } from '../threads/threads'
import { deliverMail, queueMail } from './mail'
import { adapterOf } from './records'
import { localeOf, readPartner, RECORD, refOf } from './store'

/**
 * What the office's side does with an answer (B-W2b-184), in the tenant's SYSTEM scope, as ONE command right after the
 * partner's own (the partner role answers the request — and a concession — but writes no order, no thread and no mail):
 *
 *   1. the kind's consequence (its adapter's `settle`): a revised order's wait cleared (SAL-222), the NCR told of its
 *      concession, the DVR version's history told of the outside signature;
 *   2. the answer on the record's thread (the order's for a revision or a proof, the record's own for a sample, colour,
 *      leather or artwork, the NCR's for a concession, the request's own for a signature): the partner's own message signed
 *      with the typed name when the thread is that partner's, else an internal note (an NCR's thread may be its supplier's);
 *   3. the receipt mail QUEUED to whoever answered (the link's address, the portal person's), sent after the commit (FAKE
 *      locally);
 *   4. the audit row `approvalsOut.settle` on the request: the marker that it is settled (the sweep settles any answer whose
 *      inline settle did not commit, ./sweep.ts).
 * Idempotency key `settle:<request>`: a second settle of the same request replays and does nothing.
 *
 * B-PR-30a: a request the office decided FOR the party (./override.ts) settles in the office's own command (`settleInCommand`,
 * the same steps): the consequence by the adapter, the decision on the record's thread as OUR message (the party reads "Decided
 * by us for you: <why>", never who of us; an internal note when the thread is not the party's), no receipt (nobody of theirs
 * answered), the same audit marker.
 */

export const SETTLE_ACTION = 'approvalsOut.settle'

export interface SettleOutcome {
  readonly settled: boolean
  readonly receipt: 'SENT' | 'FAILED' | 'QUEUED' | null
}

/** `locale`: the language the partner answered in (the page's); else theirs on file (the sweep). */
export async function settleRequest(system: CommandCaller, requestId: string, clock: Clock, answeredIn?: ApprovalLocale): Promise<SettleOutcome> {
  const { result, replayed } = await runCommand(system, { name: 'approvalsOut.settle', idempotencyKey: `settle:${requestId}`, input: { requestId } }, (tools) => settleInCommand(tools, requestId, answeredIn), { ...COMMAND_SETTINGS, clock })
  if (replayed || !result.outboundId || !result.body) return { settled: result.settled, receipt: null }
  return { settled: true, receipt: await deliverMail(system, result.outboundId, result.body, null, clock) }
}

/** What a settle did: whether it settled now, and the receipt it queued (delivered after the commit by the caller). */
export interface SettledInCommand {
  readonly settled: boolean
  readonly outboundId: string | null
  readonly body: string | null
}

/**
 * The settle's steps inside a command (the system's after a partner's answer; B-PR-30a: the office's own after a decision for
 * the party): the request locked, the adapter's consequence, the thread, the receipt queued, the audit marker. Nothing when the
 * request is not answered or is settled already.
 */
export async function settleInCommand(tools: CommandTools, requestId: string, answeredIn?: ApprovalLocale): Promise<SettledInCommand> {
  const { tx } = tools
  await tx.$queryRaw`SELECT 1 FROM "ApprovalRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`
  const row = await readPartner(tx, requestId)
  if (!row || !isAnswered(row.status as ApprovalStatus)) return { settled: false, outboundId: null, body: null }
  if (await tx.auditLog.findFirst({ where: { action: SETTLE_ACTION, recordType: RECORD, recordId: requestId }, select: { id: true } })) return { settled: false, outboundId: null, body: null }
  const kind = row.kind as ApprovalKind
  const ref = refOf(row)
  const adapter = adapterOf(kind, row.recordType)
  const done: Prisma.InputJsonObject | null = adapter?.settle ? await adapter.settle(tools, ref) : null

  // The answer on the thread.
  const record = adapter ? await adapter.read(tx, row.recordId, kind, { partyId: row.partyId, now: tools.now }) : null
  const where = record?.thread ?? { type: RECORD, id: requestId }
  const { thread } = await ensureThread(tools, where, null)
  const status = row.status as ApprovalStatus
  const file = row.markupFileId ? await tx.storedFile.findUnique({ where: { id: row.markupFileId }, select: { originalName: true } }) : null
  // B-PR-30a: decided by us for the party — the party's language, our words, never who of us.
  const forParty = row.decidedForPartyReason
  const locale = answeredIn ?? localeOf(forParty !== null ? await partyLocaleOf(tx, row) : await answererLocale(tx, row))
  const text = [
    `${KIND_RULES[kind].name[locale]} · ${record?.label[locale] ?? ''}`,
    forParty !== null ? decidedForPartyPageWords(kind, status, forParty, locale) : decidedWords(kind, status, row.typedName, row.answeredAt, locale),
    ...(row.answer ? ['', row.answer] : []),
    ...(file ? ['', locale === 'it' ? `Segni sulla foto: ${file.originalName}` : `Marked on the photo: ${file.originalName}`] : []),
  ].join('\n')
  const shared = thread.partyId === row.partyId
  if (forParty !== null) {
    const company = shared ? await tx.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } }) : null
    await writeMessage(tools, thread, { direction: shared ? 'OUTBOUND' : 'INTERNAL_NOTE', channel: shared ? 'PORTAL' : 'APP', author: { kind: 'SYSTEM', id: null, name: company ? (company.tradeName ?? company.legalName) : null }, bodyText: cleanBody(text) })
  } else {
    await writeMessage(tools, thread, { direction: shared ? 'INBOUND' : 'INTERNAL_NOTE', channel: shared ? 'PORTAL' : 'APP', author: shared ? { kind: 'PARTY', id: null, name: row.typedName } : { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text) })
  }

  // The receipt (B-PR-30a: none for a decision we took for the party — nobody of theirs answered).
  const to = forParty !== null ? null : await answererAddress(tx, row)
  let outboundId: string | null = null
  let body: string | null = null
  if (to && row.answeredAt && row.typedName) {
    const company = await tx.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } })
    const mail = receiptMail(locale, { companyName: company?.tradeName ?? company?.legalName ?? '', kind, label: record?.label[locale] ?? '', status, typedName: row.typedName, answeredAt: row.answeredAt, answer: row.answer })
    outboundId = await queueMail(tools, { companyId: row.companyId, record: { type: RECORD, id: requestId }, template: APPROVAL_MAIL_TEMPLATES.receipt, to, locale, subject: mail.subject, sender: null })
    body = mail.body
  }
  tools.audit({ action: SETTLE_ACTION, recordType: RECORD, recordId: requestId, companyId: row.companyId, after: { status, thread: { type: where.type, id: where.id }, shared, receipt: outboundId !== null, ...(forParty !== null ? { decidedForParty: true } : {}), ...(done ? { done } : {}) } })
  return { settled: true, outboundId, body }
}

/** B-PR-30a: the party's own language (its contact's, else the party's): the words of what we decided for it. */
export async function partyLocaleOf(tx: CommandTx, row: { readonly contactId: string | null; readonly partyId: string }): Promise<string | null> {
  if (row.contactId) {
    const contact = await tx.partyContact.findFirst({ where: { id: row.contactId }, select: { language: true } })
    if (contact?.language) return contact.language
  }
  return (await tx.party.findUnique({ where: { id: row.partyId }, select: { language: true } }))?.language ?? null
}

/** Where the receipt goes: the link's address, or the portal person's. */
async function answererAddress(tx: CommandTx, row: { readonly answeredViaLinkId: string | null; readonly answeredByUserId: string | null }): Promise<string | null> {
  if (row.answeredViaLinkId) return (await tx.oneOffLink.findUnique({ where: { id: row.answeredViaLinkId }, select: { email: true } }))?.email ?? null
  if (row.answeredByUserId) return (await tx.user.findUnique({ where: { id: row.answeredByUserId }, select: { email: true } }))?.email ?? null
  return null
}

/** The answerer's language: the portal person's, else the contact's, else the party's. */
async function answererLocale(tx: CommandTx, row: { readonly answeredByUserId: string | null; readonly contactId: string | null; readonly partyId: string }): Promise<string | null> {
  if (row.answeredByUserId) return (await tx.user.findUnique({ where: { id: row.answeredByUserId }, select: { locale: true } }))?.locale ?? null
  if (row.contactId) {
    const contact = await tx.partyContact.findFirst({ where: { id: row.contactId }, select: { language: true } })
    if (contact?.language) return contact.language
  }
  return (await tx.party.findUnique({ where: { id: row.partyId }, select: { language: true } }))?.language ?? null
}
