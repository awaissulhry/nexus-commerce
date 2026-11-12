import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PARTIES_ERASE, PARTIES_PRIVACY } from '@nexus/factory-domain/parties/contact-privacy/permissions'
import { basisProblems, BASIS_WORDS, ERASED_WORDS, KEPT_WHY, privacyWordsProblem, type KeptKind, type LawfulBasis } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMayWrite, bumpVersion, contextOf, lockParty, readParty, type PartyRowData } from '../store'

/**
 * Personal-data controls on a party's contacts (B-W2b-290; SAL-022; GDPR arts. 6, 7, 15, 17, 21; design sales.customers
 * record › Addresses & contacts › Contacts "Consent and lawful basis", "Personal-data actions: access copy, erasure (keeps
 * what law requires)"; rules factory-domain parties/contact-privacy). parties.view reads the basis of every contact;
 * parties.privacy records a basis with its consent and an objection, and gives the access copy (recorded in the audit);
 * parties.erase, with a fresh code, erases a contact. Each write locks the party first, then compare-and-sets the
 * contact's version (W1's order: modules/parties children.ts).
 *
 * Erasure (art. 17) is ONE update of the contact (name '', no e-mail, no phone, ARCHIVED, erasedAt, erasedById; the
 * database keeps it blank for good) and its audit row records no personal data (the words say what was asked, not who).
 * It is refused while a portal user of the party signs in with the contact's e-mail (end that access first: the person
 * would still be known by it). What it cannot blank (immutable for every login today) is counted in the answer's `kept`
 * with why: the mail received from the person, the messages of the threads, the audit rows, the links sent; the
 * documents that name the contact keep their own copies (art. 17(3)(b)).
 */

const PRIVACY_COLUMNS = {
  id: true,
  partyId: true,
  name: true,
  email: true,
  phone: true,
  roles: true,
  language: true,
  status: true,
  lawfulBasis: true,
  consentAt: true,
  consentSource: true,
  objectedAt: true,
  erasedAt: true,
  erasedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartyContactSelect
type ContactRow = Prisma.PartyContactGetPayload<{ select: typeof PRIVACY_COLUMNS }>

type Reader = FactoryClient | CommandTx

function contactPrivacyViewOf(row: ContactRow, names: ReadonlyMap<string, string>) {
  const basis = row.lawfulBasis as LawfulBasis | null
  return {
    id: row.id,
    name: row.erasedAt ? ERASED_WORDS.en : row.name,
    erased: row.erasedAt !== null,
    status: row.status,
    lawfulBasis: basis,
    basisWords: basis ? BASIS_WORDS[basis] : null,
    consentAt: row.consentAt ? toUtcIso(row.consentAt) : null,
    consentSource: row.consentSource,
    objectedAt: row.objectedAt ? toUtcIso(row.objectedAt) : null,
    erasedAt: row.erasedAt ? toUtcIso(row.erasedAt) : null,
    erasedBy: row.erasedById ? (names.get(row.erasedById) ?? null) : null,
    version: row.version,
  }
}
export type ContactPrivacyView = ReturnType<typeof contactPrivacyViewOf>

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** Every contact of the party with its basis, consent, objection and erasure (the Contacts grid's W2b column). */
export async function contactsPrivacyOf(db: Reader, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, code: true } })
  const rows = await db.partyContact.findMany({ where: { partyId }, select: PRIVACY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const names = await namesOf(db, rows.map((row) => row.erasedById))
  const contacts = rows.map((row) => contactPrivacyViewOf(row, names))
  return {
    partyId: party.id,
    code: party.code,
    contacts,
    notRecorded: contacts.filter((contact) => !contact.erased && contact.lawfulBasis === null).length,
    bases: Object.entries(BASIS_WORDS).map(([basis, words]) => ({ basis: basis as LawfulBasis, ...words })),
  }
}
export type PartyContactsPrivacyView = Awaited<ReturnType<typeof contactsPrivacyOf>>

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** GET /parties/:partyId/contacts/privacy (parties.view). */
export async function getContactsPrivacy(caller: CommandCaller, partyId: string): Promise<{ privacy: PartyContactsPrivacyView }> {
  officeOf(caller)
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ privacy: await contactsPrivacyOf(client, partyId) }))
}

async function readContact(caller: CommandCaller, partyId: string, contactId: string): Promise<ContactRow> {
  const row = isUuid(contactId) ? await caller.withClient((client) => client.partyContact.findUnique({ where: { id: contactId }, select: PRIVACY_COLUMNS })) : null
  if (!row || row.partyId !== partyId) throw new NotFoundError('Contact not found.')
  return row
}

const erasedRefusal = () =>
  new DomainError('conflict', 'This contact was erased on request: its name, e-mail and phone stay blank and it stays archived. Add a new contact for new details.', [{ path: 'privacy/CONTACT_ERASED', message: 'Erased.' }])

async function writable(caller: CommandCaller, partyId: string, contactId: string, permission: typeof PARTIES_PRIVACY | typeof PARTIES_ERASE): Promise<{ context: OfficeContext; party: PartyRowData; contact: ContactRow }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const contact = await readContact(caller, partyId, contactId)
  assertMayWrite(context, permission, party)
  if (contact.erasedAt !== null) throw erasedRefusal()
  return { context, party, contact }
}

const answer = async (caller: CommandCaller, partyId: string) => getContactsPrivacy(caller, partyId)

export interface BasisBody {
  readonly version: number
  readonly lawfulBasis: LawfulBasis
  readonly consentAt?: string | null | undefined
  readonly consentSource?: string | null | undefined
}

/** PUT /parties/:partyId/contacts/:contactId/lawful-basis (parties.privacy): why we keep the person's data, with its consent. */
export async function setLawfulBasis(caller: CommandCaller, partyId: string, contactId: string, body: BasisBody, idempotencyKey?: string): Promise<{ privacy: PartyContactsPrivacyView }> {
  const { party, contact } = await writable(caller, partyId, contactId, PARTIES_PRIVACY)
  const consentAt = body.consentAt ? parseInstant(body.consentAt) : null
  const consentSource = (body.consentSource ?? '').trim() || null
  const problems = basisProblems({ lawfulBasis: body.lawfulBasis, consentAt, consentSource }, serverClock.now()).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await command(caller, { name: 'parties.setLawfulBasis', idempotencyKey, input: { partyId, contactId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, partyId)
    await bumpVersion(tx, 'contact', contactId, body.version)
    await tx.partyContact.update({ where: { id: contactId }, data: { lawfulBasis: body.lawfulBasis, consentAt, consentSource, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'parties.setLawfulBasis',
      recordType: 'PartyContact',
      recordId: contactId,
      companyId: party.companyId,
      before: { lawfulBasis: contact.lawfulBasis, consentAt: contact.consentAt ? toUtcIso(contact.consentAt) : null, consentSource: contact.consentSource },
      after: { lawfulBasis: body.lawfulBasis, consentAt: consentAt ? toUtcIso(consentAt) : null, consentSource },
    })
    tools.emit({ type: 'party.contact_privacy_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactId, change: 'BASIS' } })
    return { id: contactId }
  })
  return answer(caller, partyId)
}

/**
 * POST /parties/:partyId/contacts/:contactId/objection (parties.privacy): the person objected (art. 21) or withdrew their
 * consent (art. 7(3)), at a time (default now), with words; recorded once.
 */
export async function recordObjection(caller: CommandCaller, partyId: string, contactId: string, body: { readonly version: number; readonly at?: string | null | undefined; readonly words: string }, idempotencyKey?: string): Promise<{ privacy: PartyContactsPrivacyView }> {
  const { party, contact } = await writable(caller, partyId, contactId, PARTIES_PRIVACY)
  if (contact.objectedAt !== null) throw new InvalidStateError(`The objection was recorded on ${toUtcIso(contact.objectedAt).slice(0, 10)} already: it stays as recorded.`)
  const problem = privacyWordsProblem(body.words, 'what the person asked and how (a mail, a call), without their details')
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  const at = body.at ? parseInstant(body.at) : null
  if (at && at.getTime() > serverClock.now().getTime()) throw new ValidationError('An objection is recorded when it was made: today or before.', [{ path: 'body/at', message: 'Not in the future.' }])
  await command(caller, { name: 'parties.recordObjection', idempotencyKey, input: { partyId, contactId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, partyId)
    await bumpVersion(tx, 'contact', contactId, body.version)
    await tx.partyContact.update({ where: { id: contactId }, data: { objectedAt: at ?? now, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'parties.recordObjection', recordType: 'PartyContact', recordId: contactId, companyId: party.companyId, before: { objectedAt: null }, after: { objectedAt: toUtcIso(at ?? now), lawfulBasis: contact.lawfulBasis }, reason: body.words.trim() })
    tools.emit({ type: 'party.contact_privacy_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactId, change: 'OBJECTED' } })
    return { id: contactId }
  })
  return answer(caller, partyId)
}

// ---- the access copy (art. 15) -----------------------------------------------------------------------------------------

const LIMIT = 200
const excerpt = (text: string | null | undefined, length = 500): string | null => (text ? (text.length > length ? `${text.slice(0, length)}…` : text) : null)

/** What we hold about the person, read in one client (the copy's content). */
async function copyOf(db: Reader, contact: ContactRow, party: PartyRowData) {
  const email = contact.email
  const quotes = await db.quote.findMany({ where: { contactId: contact.id }, select: { id: true, number: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const inquiries = await db.inquiry.findMany({ where: { contactId: contact.id }, select: { id: true, number: true, status: true, receivedAt: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const mailsIn = await db.inboundEmail.findMany({
    where: { OR: [{ senderContactId: contact.id }, ...(email ? [{ fromAddress: email }] : [])] },
    select: { id: true, receivedAt: true, fromAddress: true, fromName: true, subject: true, bodyText: true, status: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: LIMIT,
  })
  const mailsOut = email
    ? await db.emailOutbound.findMany({ where: { OR: [{ to: { has: email } }, { cc: { has: email } }] }, select: { id: true, queuedAt: true, subject: true, status: true, recordType: true, recordId: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: LIMIT })
    : []
  const messages = await db.message.findMany({ where: { authorKind: 'PARTY', authorId: contact.id }, select: { id: true, threadId: true, at: true, authorName: true, bodyText: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: LIMIT })
  const links = await db.oneOffLink.findMany({ where: { contactId: contact.id }, select: { id: true, purpose: true, recordType: true, email: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const profiles = await db.measurementProfile.findMany({ where: { contactId: contact.id }, select: { id: true, riderName: true, garmentType: true, revision: true, measurements: true, baseSize: true, fitNotes: true, takenAt: true }, orderBy: [{ takenAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const returns = await db.returnAuthorisation.findMany({ where: { contactId: contact.id }, select: { id: true, number: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const complaints = await db.complaint.findMany({ where: { contactId: contact.id }, select: { id: true, number: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LIMIT })
  const portalUsers = email ? await db.user.findMany({ where: { partyId: party.id, email }, select: { id: true, email: true, displayName: true, status: true }, orderBy: [{ id: 'asc' }] }) : []
  const audit = await db.auditLog.findMany({ where: { recordType: 'PartyContact', recordId: contact.id }, select: { at: true, action: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: LIMIT })
  const basis = contact.lawfulBasis as LawfulBasis | null
  return {
    person: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      roles: [...contact.roles],
      language: contact.language,
      status: contact.status,
      createdAt: toUtcIso(contact.createdAt),
      updatedAt: toUtcIso(contact.updatedAt),
    },
    /** Who keeps the data and why (GDPR art. 15(1)(a)-(c)). */
    processing: {
      controller: { partyCode: party.code, note: "The company of the group that deals with the person's organisation (its privacy notice: /privacy/<company>)." },
      organisation: { code: party.code, legalName: party.legalName },
      lawfulBasis: basis,
      basisWords: basis ? BASIS_WORDS[basis] : null,
      consentAt: contact.consentAt ? toUtcIso(contact.consentAt) : null,
      consentSource: contact.consentSource,
      objectedAt: contact.objectedAt ? toUtcIso(contact.objectedAt) : null,
    },
    records: {
      quotes: quotes.map((row) => ({ id: row.id, number: row.number, status: row.status, at: toUtcIso(row.createdAt) })),
      inquiries: inquiries.map((row) => ({ id: row.id, number: row.number, status: row.status, at: toUtcIso(row.receivedAt) })),
      returns: returns.map((row) => ({ id: row.id, number: row.number, status: row.status, at: toUtcIso(row.createdAt) })),
      complaints: complaints.map((row) => ({ id: row.id, number: row.number, status: row.status, at: toUtcIso(row.createdAt) })),
    },
    mailsReceived: mailsIn.map((row) => ({ id: row.id, at: toUtcIso(row.receivedAt), from: row.fromAddress, fromName: row.fromName, subject: row.subject, excerpt: excerpt(row.bodyText), status: row.status })),
    mailsSent: mailsOut.map((row) => ({ id: row.id, at: toUtcIso(row.queuedAt), subject: row.subject, status: row.status, record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null })),
    messages: messages.map((row) => ({ id: row.id, threadId: row.threadId, at: toUtcIso(row.at), authorName: row.authorName, excerpt: excerpt(row.bodyText) })),
    links: links.map((row) => ({ id: row.id, purpose: row.purpose, recordType: row.recordType, email: row.email, at: toUtcIso(row.createdAt) })),
    measurementProfiles: profiles.map((row) => ({ id: row.id, riderName: row.riderName, garmentType: row.garmentType, revision: row.revision, measurements: row.measurements, baseSize: row.baseSize, fitNotes: row.fitNotes, takenAt: toUtcIso(row.takenAt) })),
    portalUsers: portalUsers.map((row) => ({ id: row.id, email: row.email, displayName: row.displayName, status: row.status })),
    changes: audit.map((row) => ({ at: toUtcIso(row.at), action: row.action })),
    /** Each list holds at most 200 rows, oldest first; a longer list says so. */
    truncated: [quotes, inquiries, mailsIn, mailsOut, messages, links, profiles, returns, complaints, audit].some((list) => list.length >= LIMIT),
  }
}
export type AccessCopy = Awaited<ReturnType<typeof copyOf>>

/**
 * POST /parties/:partyId/contacts/:contactId/access-copy (parties.privacy): everything we hold about the person (art. 15),
 * in one answer; the copy is recorded (who, when, the words of the request) in the audit, never its content.
 */
export async function accessCopy(caller: CommandCaller, partyId: string, contactId: string, body: { readonly words: string }, idempotencyKey?: string): Promise<{ copy: AccessCopy; madeAt: string }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const contact = await readContact(caller, partyId, contactId)
  assertMayWrite(context, PARTIES_PRIVACY, party)
  if (contact.erasedAt !== null) throw new InvalidStateError('This contact was erased: we hold no name, e-mail or phone for it any more, so there is no copy to give.')
  const problem = privacyWordsProblem(body.words, 'who asked for the copy and how (a mail, a letter), without their details')
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  const { result } = await command(caller, { name: 'parties.accessCopy', idempotencyKey, input: { partyId, contactId, ...body } }, async (tools) => {
    tools.audit({ action: 'parties.accessCopy', recordType: 'PartyContact', recordId: contactId, companyId: party.companyId, after: { madeAt: toUtcIso(tools.now) }, reason: body.words.trim() })
    return { copy: await copyOf(tools.tx, contact, party), madeAt: toUtcIso(tools.now) }
  })
  return result
}

// ---- erasure (art. 17) ---------------------------------------------------------------------------------------------------

async function keptOf(db: Reader, contact: ContactRow) {
  const email = contact.email
  const count = {
    documents: (await db.quote.count({ where: { contactId: contact.id } })) + (await db.inquiry.count({ where: { contactId: contact.id } })) + (await db.returnAuthorisation.count({ where: { contactId: contact.id } })) + (await db.complaint.count({ where: { contactId: contact.id } })),
    inboundMails: await db.inboundEmail.count({ where: { OR: [{ senderContactId: contact.id }, ...(email ? [{ fromAddress: email }] : [])] } }),
    messages: await db.message.count({ where: { authorKind: 'PARTY', authorId: contact.id } }),
    auditRows: await db.auditLog.count({ where: { recordType: 'PartyContact', recordId: contact.id } }),
    links: await db.oneOffLink.count({ where: { contactId: contact.id } }),
    measurementProfiles: await db.measurementProfile.count({ where: { contactId: contact.id } }),
  } satisfies Record<KeptKind, number>
  return (Object.keys(count) as KeptKind[]).filter((kind) => count[kind] > 0).map((kind) => ({ kind, count: count[kind], why: KEPT_WHY[kind] }))
}

/**
 * POST /parties/:partyId/contacts/:contactId/erase (parties.erase, a fresh code: the route asks it): the contact erased on
 * request, for good. Answers the contacts and what stays, with why.
 */
export async function eraseContact(caller: CommandCaller, partyId: string, contactId: string, body: { readonly version: number; readonly words: string }, idempotencyKey?: string): Promise<{ privacy: PartyContactsPrivacyView; kept: Awaited<ReturnType<typeof keptOf>> }> {
  const { context, party, contact } = await writable(caller, partyId, contactId, PARTIES_ERASE)
  const problem = privacyWordsProblem(body.words, 'what the person asked and how (a mail, a letter), without their details')
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  if (contact.email) {
    const portal = await caller.withClient((client) => client.user.findFirst({ where: { partyId, email: contact.email!, status: { in: ['INVITED', 'ACTIVE', 'SUSPENDED'] } }, select: { id: true } }))
    if (portal) {
      throw new DomainError('conflict', "This person still signs in to the portal with the contact's e-mail: end their portal access first (Portal access › End access), then erase the contact.", [{ path: 'privacy/PORTAL_USER', message: 'A portal user has this e-mail.' }])
    }
  }
  const { result } = await command(caller, { name: 'parties.eraseContact', idempotencyKey, input: { partyId, contactId, version: body.version, words: body.words } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, partyId)
    await bumpVersion(tx, 'contact', contactId, body.version)
    const kept = await keptOf(tx, contact)
    await tx.partyContact.update({ where: { id: contactId }, data: { name: '', email: null, phone: null, status: 'ARCHIVED', erasedAt: now, erasedById: context.actorId, updatedAt: now }, select: { id: true } })
    // No personal data in the audit: what was asked (the words), when, by whom, and what stays.
    tools.audit({ action: 'parties.eraseContact', recordType: 'PartyContact', recordId: contactId, companyId: party.companyId, before: { erased: false, status: contact.status }, after: { erasedAt: toUtcIso(now), status: 'ARCHIVED', kept: kept.map((entry) => ({ kind: entry.kind, count: entry.count })) }, reason: body.words.trim() })
    tools.emit({ type: 'party.contact_erased', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactId } })
    tools.emit({ type: 'party.contacts_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactIds: [contactId] } })
    return { kept }
  })
  return { ...(await answer(caller, partyId)), kept: result.kept }
}
