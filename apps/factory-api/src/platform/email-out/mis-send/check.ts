import type { FactoryClient } from '@nexus/factory-db'
import { EMAIL_SEND, FILES_READ, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { addressDomain, isAddress, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { companyDomainOf } from '@nexus/factory-domain/email-in/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOnThread } from '../../threads/records'
import { contextOf, officeRecord, type RecordRef } from '../../threads/threads'
import type { MisSendBody, MisSendView } from './contract'
import { costWordsIn, firstItems, mentionedIn, MIS_SEND_LIMITS, MIS_SEND_WARNINGS, partiesNamedIn, recipientOf, type MisSendWarning, type RecipientFacts } from './rules'

/**
 * POST /threads/:recordType/:recordId/emails/check (B-W2b-397; COL-004; design shell.panels pop:mis-send): what a person is
 * about to send from a record's thread, checked before it goes — email.send over the record, as the send itself, and the
 * thread readable. Read only: nothing is written, nothing is sent.
 *
 *   recipients   each address: a contact or portal person of the record's party (PARTY), of another organisation
 *                (OTHER_PARTY), one of ours (a colleague, or at a domain we send from or receive replies at), or a company
 *                domain only one party's contacts use; else UNKNOWN.
 *   text         the subject and the message: cost words, another customer of the company named (legal or trade name, the
 *                legal form left out; customers of the record's company or tenant-wide), a colleague @mentioned.
 *   attachments  each file of this record the person may read, shared with the party or the office's only (the send refuses
 *                the latter); a file the person cannot read is left out, never named.
 *
 * Every warning carries what it found, in the person's own words, so the screen can say "Mentions cost: margine".
 */
export async function checkMisSend(caller: CommandCaller, record: RecordRef, body: MisSendBody): Promise<MisSendView> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const { scope } = await officeRecord(client, record)
    if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    if (!can(actor, EMAIL_SEND, scope)) throw new ForbiddenError()
    const partyId = scope.partyId ?? null

    const addresses = [...new Set(body.to.map((address) => normalizeAddress(address)).filter((address) => address !== ''))]
    const facts = await recipientFacts(client, addresses.filter(isAddress))
    const findings = addresses.map((address) => ({ address, ...recipientOf(facts.get(address) ?? NOBODY, partyId) }))

    const text = [body.subject ?? '', body.body].join('\n')
    const others = await otherCustomers(client, text, partyId, scope.companyId ?? null)
    const colleagues = text.includes('@') ? await client.user.findMany({ where: { audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: MIS_SEND_LIMITS.colleagues }) : []

    const partyIds = [...new Set([partyId, ...findings.map((finding) => finding.partyId)].filter((id): id is string => id !== null))]
    const names = new Map((partyIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, legalName: true, tradeName: true } })).map((party) => [party.id, nameOf(party)]))

    const files = body.attachments.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: body.attachments } }, select: { id: true, originalName: true, sizeBytes: true, visibility: true, partyId: true, companyId: true, recordType: true, recordId: true } })
    const attachments = body.attachments.flatMap((fileId) => {
      const file = files.find((row) => row.id === fileId)
      if (!file || file.recordType !== record.type || file.recordId !== record.id || !can(actor, FILES_READ, { companyId: file.companyId })) return []
      const shared = partyId !== null && file.partyId === partyId && file.visibility.includes('PARTNER')
      return [{ id: file.id, name: file.originalName, sizeBytes: file.sizeBytes, audience: shared ? ('PARTY' as const) : ('OFFICE' as const) }]
    })

    const found: Record<MisSendWarning, string[]> = {
      OTHER_ORGANISATION: findings.filter((finding) => finding.kind === 'OTHER_PARTY' && finding.partyId !== null).map((finding) => names.get(finding.partyId!) ?? finding.address),
      UNKNOWN_RECIPIENT: findings.filter((finding) => finding.kind === 'UNKNOWN').map((finding) => finding.address),
      MENTIONS_COST: costWordsIn(text),
      NAMES_OTHER_CUSTOMER: others.map(nameOf),
      INTERNAL_MENTION: mentionedIn(body.body, colleagues).map((person) => person.displayName),
      OFFICE_FILE: attachments.filter((file) => file.audience === 'OFFICE').map((file) => file.name),
    }

    return {
      party: partyId !== null && names.has(partyId) ? { id: partyId, name: names.get(partyId)! } : null,
      recipients: findings.map((finding) => ({
        address: finding.address,
        kind: finding.kind,
        source: finding.source,
        organisation: finding.partyId !== null && names.has(finding.partyId) ? { id: finding.partyId, name: names.get(finding.partyId)! } : null,
        personName: finding.personName,
      })),
      warnings: MIS_SEND_WARNINGS.filter((code) => found[code].length > 0).map((code) => ({ code, items: firstItems(found[code]) })),
      attachments,
    }
  })
}

const NOBODY: RecipientFacts = { parties: [], colleague: false, ourDomain: false, domainParty: null }

/** The name people use: the trade name, else the registered one. */
const nameOf = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName?.trim() || party.legalName

/** What we know of each address: whose contact or portal person it is, a colleague's, at our own domain, a party's domain. */
async function recipientFacts(client: FactoryClient, addresses: readonly string[]): Promise<Map<string, RecipientFacts>> {
  const facts = new Map<string, RecipientFacts>()
  if (addresses.length === 0) return facts
  const [contacts, users, identities] = await Promise.all([
    client.partyContact.findMany({ where: { email: { in: [...addresses] }, status: 'ACTIVE' }, select: { email: true, name: true, partyId: true }, orderBy: { id: 'asc' } }),
    client.user.findMany({ where: { email: { in: [...addresses] }, status: { not: 'DEACTIVATED' } }, select: { email: true, audience: true, partyId: true, displayName: true } }),
    client.emailIdentity.findMany({ select: { domain: true, replyDomain: true } }),
  ])
  const ours = new Set(identities.flatMap((identity) => [identity.domain, identity.replyDomain]).filter((domain): domain is string => !!domain).map((domain) => domain.toLowerCase()))
  for (const address of addresses) {
    const parties = [
      ...contacts.filter((contact) => contact.email === address).map((contact) => ({ partyId: contact.partyId, source: 'CONTACT' as const, name: contact.name || null })),
      ...users.filter((user) => user.email === address && user.audience === 'PARTNER' && user.partyId !== null).map((user) => ({ partyId: user.partyId!, source: 'PORTAL_PERSON' as const, name: user.displayName || null })),
    ]
    const colleague = users.some((user) => user.email === address && user.audience === 'OFFICE')
    facts.set(address, { parties, colleague, ourDomain: ours.has(addressDomain(address)), domainParty: null })
  }
  // Nobody with the address: the one party whose contacts share its company domain (never a shared mail domain).
  for (const address of addresses) {
    const known = facts.get(address)!
    if (known.parties.length > 0 || known.colleague || known.ourDomain) continue
    const domain = companyDomainOf(address)
    if (domain === null) continue
    const parties = await client.partyContact.findMany({ where: { email: { endsWith: `@${domain}` }, status: 'ACTIVE' }, select: { partyId: true }, distinct: ['partyId'], take: 2 })
    if (parties.length === 1) facts.set(address, { ...known, domainParty: parties[0]!.partyId })
  }
  return facts
}

/** The other customers of the record's company (or tenant-wide) a text names; the record's party and its namesakes never. */
async function otherCustomers(client: FactoryClient, text: string, partyId: string | null, companyId: string | null) {
  if (text.trim() === '') return []
  const parties = await client.party.findMany({
    where: { roles: { has: 'CUSTOMER' }, status: { not: 'ARCHIVED' }, ...(partyId ? { id: { not: partyId } } : {}), OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { id: true, legalName: true, tradeName: true },
    orderBy: { id: 'asc' },
    take: MIS_SEND_LIMITS.parties,
  })
  const own = partyId ? await client.party.findUnique({ where: { id: partyId }, select: { legalName: true, tradeName: true } }) : null
  const ownNames = new Set([own?.legalName, own?.tradeName].filter((name): name is string => !!name).map((name) => name.trim().toLowerCase()))
  return partiesNamedIn(text, parties).filter((party) => !ownNames.has(party.legalName.trim().toLowerCase()) && !(party.tradeName && ownNames.has(party.tradeName.trim().toLowerCase())))
}
