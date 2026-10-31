import type { Prisma } from '@nexus/factory-db'
import { companyDomainOf, knownSender, replyTokensOf, type SortFacts, type Verdicts } from '@nexus/factory-domain/email-in/rules'
import type { CommandTx } from '../../core/command'
import { resolveRecord } from '../threads/records'
import { complaintOfMail } from './matchers/complaint'

/**
 * What the sorting needs to know about one received mail (plan A1 §3.7 "Matching"; COL-020, COL-022, COL-023), read in
 * its tenant inside the sorting command (row-level security: a reply token or a Message-ID of another tenant finds
 * nothing). factory-domain's `sortMail` decides from these facts:
 *   - the thread: a recipient `r-<token>@<reply domain>` (the tenant's identities' reply domains), else In-Reply-To and
 *     References against the Message-IDs of the mail we SENT (OUTBOUND messages: `<outboundId@identity domain>`);
 *   - whether the thread knows the sender: an ACTIVE contact of its party, a recipient of its mail, or an address at a
 *     contact's company domain;
 *   - without a thread: the one party the sender is a contact of, and that party's own thread (record type `Party`,
 *     its resolver in threads/records.ts; a party it cannot resolve leaves the mail in triage with the party);
 *   - whether its Message-ID is already a thread message (our own mail come back, or the same mail again).
 * Plus the suggestion kept on the row for a person: the sender's party and contact, else the one party a contact's
 * company domain points at.
 */

/** The party record type whose thread a known sender's mail joins (the parties module's thread resolver). */
export const PARTY_RECORD = 'Party'

export const MAIL_FACTS = {
  id: true,
  status: true,
  companyId: true,
  envelopeTo: true,
  to: true,
  cc: true,
  fromAddress: true,
  emailMessageId: true,
  inReplyTo: true,
  referenceIds: true,
  spfVerdict: true,
  dkimVerdict: true,
  dmarcVerdict: true,
  spamVerdict: true,
  virusVerdict: true,
} as const satisfies Prisma.InboundEmailSelect
export type MailFacts = Prisma.InboundEmailGetPayload<{ select: typeof MAIL_FACTS }>

export const verdictsOf = (row: MailFacts): Verdicts => ({ spf: row.spfVerdict, dkim: row.dkimVerdict, dmarc: row.dmarcVerdict, spam: row.spamVerdict, virus: row.virusVerdict })

const THREAD = { id: true, status: true, partyId: true } as const satisfies Prisma.ThreadSelect

export interface Suggestion {
  readonly senderPartyId: string | null
  readonly senderContactId: string | null
}

/** The thread the mail names: by reply token first, then by the newest of our own mails it answers. */
async function namedThread(tx: CommandTx, row: MailFacts): Promise<SortFacts['thread']> {
  const domains = (await tx.emailIdentity.findMany({ select: { replyDomain: true }, distinct: ['replyDomain'] })).map((identity) => identity.replyDomain)
  for (const token of replyTokensOf([...row.envelopeTo, ...row.to, ...row.cc], domains)) {
    const thread = await tx.thread.findFirst({ where: { replyToken: token }, select: THREAD })
    if (thread) return { ...thread, by: 'TOKEN' }
  }
  const answered = [...new Set([...(row.inReplyTo ? [row.inReplyTo] : []), ...[...row.referenceIds].reverse()])]
  if (answered.length === 0) return null
  const ours = await tx.message.findMany({ where: { emailMessageId: { in: answered }, direction: 'OUTBOUND' }, select: { threadId: true, emailMessageId: true } })
  for (const messageId of answered) {
    const found = ours.find((message) => message.emailMessageId === messageId)
    if (!found) continue
    const thread = await tx.thread.findUnique({ where: { id: found.threadId }, select: THREAD })
    if (thread) return { ...thread, by: 'HEADERS' }
  }
  return null
}

/**
 * The facts of one mail, and the suggestion for a person. B-W2b-17: `record` is the record whose thread a known sender's
 * mail joins when that is not the party's own (a complaint its subject names, ./matchers/complaint.ts); null: the party's.
 */
export async function sortFactsOf(tx: CommandTx, row: MailFacts & { readonly subject?: string | null }): Promise<{ facts: SortFacts; suggestion: Suggestion; record: { readonly type: string; readonly id: string } | null }> {
  const sender = row.fromAddress
  const duplicate = row.emailMessageId !== null && (await tx.message.findFirst({ where: { emailMessageId: row.emailMessageId }, select: { id: true } })) !== null
  const thread = await namedThread(tx, row)
  const senderContacts = sender ? await tx.partyContact.findMany({ where: { email: sender, status: 'ACTIVE' }, select: { id: true, partyId: true }, orderBy: { id: 'asc' } }) : []

  let senderKnown: SortFacts['senderKnown'] = null
  let senderParty: SortFacts['senderParty'] = null
  let suggestion: Suggestion = { senderPartyId: null, senderContactId: null }
  let record: { readonly type: string; readonly id: string } | null = null
  if (thread) {
    const contact = senderContacts.find((entry) => entry.partyId === thread.partyId)
    if (contact) suggestion = { senderPartyId: contact.partyId, senderContactId: contact.id }
    if (thread.partyId !== null && sender !== null) {
      const contacts = (await tx.partyContact.findMany({ where: { partyId: thread.partyId, status: 'ACTIVE', email: { not: null } }, select: { email: true } })).map((entry) => entry.email!)
      const recipient = await tx.emailOutbound.findFirst({ where: { threadId: thread.id, OR: [{ to: { has: sender } }, { cc: { has: sender } }] }, select: { id: true } })
      senderKnown = knownSender(sender, { contacts, participants: recipient ? [sender] : [] })
    }
  } else {
    const parties = [...new Set(senderContacts.map((entry) => entry.partyId))]
    if (parties.length === 1) {
      const partyId = parties[0]!
      suggestion = { senderPartyId: partyId, senderContactId: senderContacts.find((entry) => entry.partyId === partyId)!.id }
      const existing = await tx.thread.findFirst({ where: { recordType: PARTY_RECORD, recordId: partyId }, select: THREAD })
      const resolvable = existing !== null || (await resolveRecord(tx, PARTY_RECORD, partyId)) !== null
      senderParty = { partyId, thread: resolvable ? { id: existing?.id ?? null, status: existing?.status ?? 'OPEN' } : null }
      // B-W2b-17: an open complaint of this customer that the subject names takes the mail instead of the party's thread.
      const complaint = await complaintOfMail(tx, { subject: row.subject ?? null, partyId })
      if (complaint) {
        record = complaint.record
        senderParty = { partyId, thread: { id: complaint.thread?.id ?? null, status: complaint.thread?.status ?? 'OPEN' } }
      }
    }
  }
  if (suggestion.senderPartyId === null && sender !== null && senderContacts.length === 0) {
    // Nobody with this address: the one party whose contacts share its company domain is suggested.
    const domain = companyDomainOf(sender)
    if (domain !== null) {
      const parties = await tx.partyContact.findMany({ where: { email: { endsWith: `@${domain}` }, status: 'ACTIVE' }, select: { partyId: true }, distinct: ['partyId'], take: 2 })
      if (parties.length === 1) suggestion = { senderPartyId: parties[0]!.partyId, senderContactId: null }
    }
  }
  return { facts: { verdicts: verdictsOf(row), duplicate, thread, senderKnown, senderParty }, suggestion, record }
}
