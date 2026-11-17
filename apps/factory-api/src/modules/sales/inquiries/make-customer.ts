import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { companyDomainOf } from '@nexus/factory-domain/email-in/rules'
import { checkContact } from '@nexus/factory-domain/parties/contacts'
import { basisProblems } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { newParty } from '@nexus/factory-domain/parties/rules'
import type { MakeCustomerBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import {
  CANDIDATES_MAX,
  carriedConsent,
  codeTakenRefusal,
  makeCustomerRefusal,
  makeRefusal,
  MATCH_RANK,
  matchRefusal,
  suggestedCode,
  type CustomerMatch,
  type InquirySource,
  type InquiryStatus,
  type LawfulBasis,
} from '@nexus/factory-domain/sales/inquiries/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { ensureThread } from '../../../platform/threads/threads'
import { PARTY_SCOPE as PARTIES_SCOPE, insertContact, insertParty, lockParty, mayWrite } from '../../parties/store'
import { assertContact, assertCustomer, emitChanged, lockForChange, prospectColumns, viewInCommand, writeInquiry } from './inquiries'
import { joinMailInCommand } from './join'
import { badBody, databaseRefusal, factsOf, InquiryRefusedError, officeInquiry, refuse, type InquiryData, type Reader } from './store'

/**
 * Answer a new customer (B-TH-042; threads plan G5; O-SAL-INQ-LIST.pane-actions-F08, O-SAL-INQ-REC.side, T5-F03; wall W20, W23):
 * a prospect's request gets its customer, so replies to it become possible.
 *
 *   GET  /sales/inquiries/:inquiryId/customer   the check: the customers the prospect may already be — by the address of one of
 *                                               their active contacts, their contacts' (or portal people's) company e-mail domain
 *                                               (never a shared provider's), their legal or trade name or code — only among the
 *                                               customers the reader may make a request for at the request's company (the New
 *                                               request picker's rule: sales.inquiries.manage AND parties.view), so it never names
 *                                               a customer the reader may not see; and what a new customer would be called
 *   POST /sales/inquiries/:inquiryId/customer   ONE command: `match` an existing customer, or `make` one from the prospect (parties.
 *                                               manage over the request's company): the customer and its contact with the
 *                                               prospect's name, address and phone, its lawful basis carried (a consent with when
 *                                               and how: the request); the request names the customer and that contact, its
 *                                               prospect columns cleared (the data lives in the contact now), the customer's own
 *                                               running number given by the database; the mail the request came from, while it
 *                                               waits in Mail to sort, joins the request's thread — shared with the matched
 *                                               customer only (W23)
 *
 * "Asks first" (W23): a match goes on alone only when the check found that very customer by one of ITS contacts' addresses and
 * no other customer as strongly; any other match, and a new customer while the check found one, waits for `confirmed` (409
 * refusal/CONFIRM_MATCH, refusal/MATCH_FOUND, in words). The New request's simple name match (web, B-TH-221) is the same idea; this
 * one adds the contacts and the e-mail domain.
 */

const partyName = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName
const fold = (value: string): string => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

interface Candidate {
  readonly party: { readonly id: string; readonly code: string; readonly name: string }
  readonly contact: { readonly id: string; readonly name: string } | null
  readonly matchedBy: CustomerMatch
}

/** The customers the reader may make a request for at a company: the New request picker's rule (customers.ts). */
function reachable(context: OfficeContext, companyId: string): Prisma.PartyWhereInput | null {
  const actor = actorOf(context)
  const grants = grantsFor(actor, SALES_INQUIRIES_MANAGE).filter((grant) => grant.companies === 'all' || grant.companies.includes(companyId))
  if (grants.length === 0) return null
  const every = grants.some((grant) => grant.parties === 'all')
  const named = every ? null : [...new Set(grants.flatMap((grant) => (grant.parties === 'all' ? [] : grant.parties)))]
  return {
    AND: [
      scopeWhere(actor, PARTIES_VIEW, PARTIES_SCOPE) as Prisma.PartyWhereInput,
      named ? { id: { in: named } } : {},
      { roles: { hasSome: ['CUSTOMER', 'BRAND'] } },
      { status: { not: 'ARCHIVED' } },
      { OR: [{ companyId }, { companyId: null }] },
    ],
  }
}

/** The check: the customers the prospect may already be, strongest first, and whether the same evidence names more than one. */
async function candidatesOf(db: Reader, context: OfficeContext, inquiry: InquiryData): Promise<{ readonly candidates: Candidate[]; readonly ambiguous: boolean }> {
  const where = reachable(context, inquiry.companyId)
  if (where === null || inquiry.partyId !== null) return { candidates: [], ambiguous: false }
  const found = new Map<string, { matchedBy: CustomerMatch; contact: { id: string; name: string } | null }>()
  const add = (partyId: string, matchedBy: CustomerMatch, contact: { id: string; name: string } | null = null) => {
    const seen = found.get(partyId)
    if (!seen || MATCH_RANK[matchedBy] < MATCH_RANK[seen.matchedBy]) found.set(partyId, { matchedBy, contact })
  }
  const email = inquiry.prospectEmail?.trim().toLowerCase() || null
  if (email) {
    const contacts = await db.partyContact.findMany({ where: { email, status: 'ACTIVE', erasedAt: null, party: where }, select: { id: true, name: true, partyId: true }, orderBy: { id: 'asc' }, take: CANDIDATES_MAX })
    for (const contact of contacts) add(contact.partyId, 'CONTACT', { id: contact.id, name: contact.name })
    const domain = companyDomainOf(email)
    if (domain) {
      const at = { endsWith: `@${domain}`, mode: 'insensitive' as const }
      const byContact = await db.partyContact.findMany({ where: { email: at, status: 'ACTIVE', party: where }, select: { partyId: true }, distinct: ['partyId'], take: CANDIDATES_MAX })
      for (const row of byContact) add(row.partyId, 'DOMAIN')
      // The customer's portal people at the domain too (B-TH-033's rule: they answer our mail as the customer).
      const people = await db.user.findMany({ where: { email: at, audience: 'PARTNER', status: 'ACTIVE', partyId: { not: null } }, select: { partyId: true }, distinct: ['partyId'], take: CANDIDATES_MAX })
      const visible = people.length === 0 ? [] : await db.party.findMany({ where: { AND: [where, { id: { in: people.map((person) => person.partyId!) } }] }, select: { id: true } })
      for (const row of visible) add(row.id, 'DOMAIN')
    }
  }
  const names = [inquiry.prospectCompany, inquiry.prospectName].filter((value): value is string => value !== null && fold(value).length >= 3)
  if (names.length > 0) {
    const named = await db.party.findMany({
      where: { AND: [where, { OR: names.flatMap((name) => [{ legalName: { equals: name.trim(), mode: 'insensitive' as const } }, { tradeName: { equals: name.trim(), mode: 'insensitive' as const } }, { code: { equals: name.trim().toUpperCase() } }]) }] },
      select: { id: true },
      take: CANDIDATES_MAX,
    })
    for (const row of named) add(row.id, 'NAME')
  }
  if (found.size === 0) return { candidates: [], ambiguous: false }
  const actor = actorOf(context)
  const parties = await db.party.findMany({ where: { AND: [where, { id: { in: [...found.keys()] } }] }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const candidates = parties
    // The create's own check, once more per row: what the check names is what the match takes.
    .filter((party) => can(actor, SALES_INQUIRIES_MANAGE, { companyId: inquiry.companyId, partyId: party.id }))
    .map((party) => ({ party: { id: party.id, code: party.code, name: partyName(party) }, ...found.get(party.id)! }))
    .sort((a, b) => MATCH_RANK[a.matchedBy] - MATCH_RANK[b.matchedBy] || a.party.code.localeCompare(b.party.code))
    .slice(0, CANDIDATES_MAX)
  const contactMatches = candidates.filter((candidate) => candidate.matchedBy === 'CONTACT').length
  const domainMatches = candidates.filter((candidate) => candidate.matchedBy === 'DOMAIN').length
  return { candidates, ambiguous: contactMatches > 1 || (contactMatches === 0 && domainMatches > 1) }
}

const prospectOfRow = (row: InquiryData) => ({ name: row.prospectName, company: row.prospectCompany, email: row.prospectEmail, phone: row.prospectPhone })

/** Whether the reader may make a customer of the request's company (or of every company). */
const mayMake = (context: OfficeContext, companyId: string | null) => mayWrite(actorOf(context), PARTIES_MANAGE, { id: newId(), companyId })

/** GET /sales/inquiries/:inquiryId/customer: the check. */
export async function customerCheck(caller: CommandCaller, inquiryId: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  const { candidates, ambiguous } = await caller.withClient((db) => candidatesOf(db, context, inquiry))
  const facts = { ...factsOf(inquiry), prospectErased: inquiry.prospectErasedAt !== null }
  const prospect = prospectOfRow(inquiry)
  const making = makeCustomerRefusal(facts, true)
  const matching = makeCustomerRefusal(facts, false)
  const allowedToMake = mayMake(context, inquiry.companyId)
  return {
    prospect: { ...prospect, lawfulBasis: (inquiry.prospectLawfulBasis as LawfulBasis | null) ?? null, erased: inquiry.prospectErasedAt !== null },
    candidates,
    ambiguous,
    suggestion: { code: suggestedCode(prospect), legalName: prospect.company ?? prospect.name ?? prospect.email ?? '', kind: prospect.company ? ('ORGANISATION' as const) : ('PERSON' as const) },
    make: { allowed: allowedToMake && making === null, refusal: making },
    match: { allowed: matching === null, refusal: matching },
  }
}

// ---- the command -------------------------------------------------------------------------------------------------------

const prefixed = (issues: readonly Issue[], at: string): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))

interface Making {
  readonly companyId: string | null
  readonly status: 'PROSPECT' | 'ACTIVE'
  readonly fields: Extract<ReturnType<typeof newParty>, { ok: true }>['party']
}

/** POST /sales/inquiries/:inquiryId/customer */
export async function makeCustomer(caller: CommandCaller, inquiryId: string, body: MakeCustomerBody, idempotencyKey?: string) {
  if ((body.match === undefined) === (body.make === undefined)) throw new ValidationError('Say whether to match a customer or make one.', [{ path: 'body', message: 'Either match or make.' }])
  const { context, inquiry: seen } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  const facts = { ...factsOf(seen), prospectErased: seen.prospectErasedAt !== null }
  refuse(makeCustomerRefusal(facts, body.make !== undefined))
  const confirmed = body.confirmed === true
  const { candidates } = await caller.withClient((db) => candidatesOf(db, context, seen))
  const prospect = prospectOfRow(seen)
  const consent = carriedConsent((seen.prospectLawfulBasis as LawfulBasis | null) ?? null, { number: seen.number, receivedAt: seen.receivedAt, source: seen.source as InquirySource })
  const consentProblems = basisProblems(consent, serverClock.now())
  if (consentProblems.length > 0) throw new ValidationError(consentProblems[0]!.message, prefixed(consentProblems, 'body'))

  // The contact a customer gets from the prospect (a new customer's, or an existing one's with addContact).
  const contactFromProspect = (language: string | null) => {
    const name = prospect.name ?? prospect.company ?? prospect.email
    if (!name) return null
    const outcome = checkContact({ name, email: prospect.email, phone: prospect.phone, roles: prospect.email ? ['ORDERS'] : [], language })
    if (!outcome.ok) throw new ValidationError('The prospect cannot be the contact as it is: correct it on the request first.', prefixed(outcome.issues, 'prospect'))
    return outcome.contact
  }

  let partyId: string
  let contactId: string | null = null
  let making: Making | null = null
  let newContact: ReturnType<typeof contactFromProspect> = null
  if (body.match) {
    const match = body.match
    partyId = match.partyId
    await caller.withClient(async (db) => {
      await assertCustomer(db, context, match.partyId, seen.companyId, 'match/partyId')
      if (!can(actorOf(context), SALES_INQUIRIES_MANAGE, { companyId: seen.companyId, partyId: match.partyId })) badBody('match/partyId', 'Your role does not keep requests for this customer.')
      if (match.contactId) await assertContact(db, match.partyId, match.contactId, 'match/contactId')
    })
    const candidate = candidates.find((entry) => entry.party.id === match.partyId) ?? null
    const party = await caller.withClient((db) => db.party.findUniqueOrThrow({ where: { id: match.partyId }, select: { code: true, legalName: true, tradeName: true, language: true, companyId: true, status: true } }))
    refuse(matchRefusal({ number: seen.number, customer: partyName(party), found: candidate?.matchedBy ?? null, contactMatches: candidates.filter((entry) => entry.matchedBy === 'CONTACT').length, confirmed }))
    contactId = match.contactId ?? (candidate?.matchedBy === 'CONTACT' ? (candidate.contact?.id ?? null) : null)
    if (match.addContact) {
      if (contactId !== null) badBody('match/addContact', 'The customer already has the contact named: no new contact is made.')
      if (!mayWrite(actorOf(context), PARTIES_MANAGE, { id: match.partyId, companyId: party.companyId })) throw new ForbiddenError('Your role does not change this customer’s contacts.')
      newContact = contactFromProspect(party.language)
      if (newContact === null) badBody('match/addContact', 'The prospect has no name, company or e-mail address to make a contact of.')
      if (newContact.email && (await caller.withClient((db) => db.partyContact.findFirst({ where: { partyId: match.partyId, email: newContact!.email, status: 'ACTIVE' }, select: { id: true } })))) badBody('match/addContact', 'A contact of this customer has the prospect’s address already: name that contact instead.')
    }
  } else {
    const make = body.make!
    const companyId = make.everyCompany ? null : seen.companyId
    if (!mayMake(context, companyId)) throw new ForbiddenError(companyId ? 'Your role does not make customers for this company.' : 'Your role does not make customers of every company.')
    refuse(makeRefusal({ number: seen.number, candidates: candidates.map((entry) => entry.party.code), confirmed }))
    const outcome = newParty({
      code: make.code ?? suggestedCode(prospect),
      kind: make.kind ?? (prospect.company ? 'ORGANISATION' : 'PERSON'),
      legalName: make.legalName ?? prospect.company ?? prospect.name ?? prospect.email ?? '',
      roles: ['CUSTOMER'],
      ...(make.country ? { country: make.country.toUpperCase() } : {}),
      ...(make.language ? { language: make.language.toLowerCase() } : {}),
    })
    if (!outcome.ok) throw new ValidationError('The customer is not valid.', prefixed(outcome.issues, 'body/make'))
    making = { companyId, status: make.status ?? 'PROSPECT', fields: outcome.party }
    newContact = contactFromProspect(outcome.party.language)
    partyId = ''
  }

  const { result } = await command(caller, { name: 'sales.inquiries.customer', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(makeCustomerRefusal({ ...factsOf(row), prospectErased: row.prospectErasedAt !== null }, making !== null))
    let made: 'CUSTOMER' | 'CONTACT' | null = null
    if (making) {
      if (await tools.tx.party.findFirst({ where: { code: making.fields.code }, select: { id: true } })) throw new InquiryRefusedError(codeTakenRefusal(making.fields.code))
      partyId = await insertParty(tools, { companyId: making.companyId, status: making.status, fields: making.fields, identity: null, addresses: [], contacts: [] }, PARTIES_MANAGE)
      made = 'CUSTOMER'
    }
    if (newContact) {
      // An existing customer's lock (its contacts change); a new one is this command's own.
      const owner = making ? { companyId: making.companyId, code: making.fields.code } : await lockParty(tools.tx, partyId)
      const party = { id: partyId, companyId: owner.companyId }
      contactId = await insertContact(tools, party, newContact, PARTIES_MANAGE)
      await carryBasis(tools, party, contactId, consent)
      if (!made) made = 'CONTACT'
      tools.emit({ type: 'party.contacts_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: owner.code, contactIds: [contactId] } })
    }
    await writeInquiry(tools, row, { partyId, contactId, ...prospectColumns(null) })
    // No personal data in the audit row: the prospect's words now live in the contact (its own audit row).
    tools.audit({ action: 'sales.inquiries.customer', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { partyId: null, contactId: null, prospect: true }, after: { partyId, contactId, made, confirmed } })
    // The thread, if the office already wrote on it, takes its customer now (its notes stay notes).
    if (await tools.tx.thread.findFirst({ where: { recordType: 'Inquiry', recordId: row.id }, select: { id: true } })) await ensureThread(tools, { type: 'Inquiry', id: row.id }, context.actorId)
    const mailJoined = await joinMailInCommand(tools, context, { ...row, partyId, contactId })
    emitChanged(tools, row, row.status as InquiryStatus, 'MATCHED', partyId, row.assigneeId)
    const party = await tools.tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    return { inquiry: await viewInCommand(tools, row.id), party: { id: party.id, code: party.code, name: partyName(party) }, contactId, made, mailJoined }
  }).catch(databaseRefusal)
  return result
}

/** The prospect's lawful basis on its new contact (and a consent with when and how), as parties.setLawfulBasis records it. */
async function carryBasis(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, contactId: string, consent: ReturnType<typeof carriedConsent>): Promise<void> {
  await tools.tx.partyContact.update({ where: { id: contactId }, data: { lawfulBasis: consent.lawfulBasis, consentAt: consent.consentAt, consentSource: consent.consentSource, updatedAt: tools.now }, select: { id: true } })
  tools.audit({
    action: 'parties.setLawfulBasis',
    recordType: 'PartyContact',
    recordId: contactId,
    companyId: party.companyId,
    before: { lawfulBasis: null, consentAt: null, consentSource: null },
    after: { lawfulBasis: consent.lawfulBasis, consentAt: consent.consentAt ? toUtcIso(consent.consentAt) : null, consentSource: consent.consentSource },
  })
}
