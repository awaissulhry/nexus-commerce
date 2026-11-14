import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { recipientLanguageOf, TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { PARTY_SCOPE } from '../../modules/parties/store'
import { officeOf } from './store'

/**
 * The partner contact's language (B-W2b-422; PLT-131; design admin.languages "per partner contact", shell.preview "the
 * partner contact's language is preselected"): quotes, confirmations, mails and the portal follow the language of the
 * person they go to, whatever the sender's — the contact's own, else the party's, else the company's (factory-domain
 * templates/language.ts recipientLanguageOf).
 *
 *   GET /templates/language?partyId&contactId   what a send panel preselects for a recipient, and where it comes from
 *   GET /templates/languages/contacts?q&cursor   Admin › Languages per partner contact: the active contacts of the parties
 *                                                the person sees, their own language, the party's and what goes out
 *
 * Both read only (parties.view over the party). A contact's language is changed where the contact is kept
 * (PATCH /parties/:partyId/contacts/:contactId, parties.manage).
 */

/** GET /templates/language */
export async function recipientLanguage(caller: CommandCaller, query: { readonly partyId: string; readonly contactId?: string | undefined }) {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => {
    const party = isUuid(query.partyId) ? await db.party.findUnique({ where: { id: query.partyId }, select: { id: true, companyId: true, language: true } }) : null
    if (!party || !can(actor, PARTIES_VIEW, { companyId: party.companyId, partyId: party.id })) throw new NotFoundError('Party not found.')
    const contact = query.contactId ? await db.partyContact.findFirst({ where: { id: query.contactId, partyId: party.id }, select: { id: true, language: true } }) : null
    if (query.contactId && !contact) throw new ValidationError('Pick a contact of this customer or supplier.', [{ path: 'querystring/contactId', message: 'Pick a contact of this customer or supplier.' }])
    const company = party.companyId ? await db.company.findUnique({ where: { id: party.companyId }, select: { locale: true } }) : null
    return { partyId: party.id, contactId: contact?.id ?? null, ...recipientLanguageOf({ contact: contact?.language, party: party.language, company: company?.locale }) }
  })
}

const encode = (name: string, id: string): string => Buffer.from(JSON.stringify([name, id]), 'utf8').toString('base64url')

function decode(value: string | undefined): { name: string; id: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && isUuid(parsed[1])) return { name: parsed[0], id: parsed[1] }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** GET /templates/languages/contacts */
export async function contactLanguages(caller: CommandCaller, query: { readonly q?: string | undefined; readonly cursor?: string | undefined; readonly limit: number }) {
  const actor = actorOf(officeOf(caller))
  const after = decode(query.cursor)
  const search = query.q?.trim()
  return caller.withClient(async (db) => {
    const where: Prisma.PartyContactWhereInput = {
      status: 'ACTIVE',
      party: { AND: [scopeWhere(actor, PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput, { status: { in: ['PROSPECT', 'ACTIVE'] } }] },
      ...(search
        ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }, { party: { OR: [{ legalName: { contains: search, mode: 'insensitive' } }, { tradeName: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] } }] }
        : {}),
      ...(after ? { AND: [{ OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] }] } : {}),
    }
    const rows = await db.partyContact.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: { id: true, name: true, email: true, language: true, version: true, party: { select: { id: true, code: true, legalName: true, tradeName: true, language: true, companyId: true } } },
    })
    const page = rows.slice(0, query.limit)
    const companies = [...new Set(page.flatMap((row) => (row.party.companyId ? [row.party.companyId] : [])))]
    const locales = new Map((companies.length > 0 ? await db.company.findMany({ where: { id: { in: companies } }, select: { id: true, locale: true } }) : []).map((row) => [row.id, row.locale]))
    const last = page[page.length - 1]
    return {
      contacts: page.map((row) => ({
        contactId: row.id,
        name: row.name,
        email: row.email,
        own: row.language,
        party: { id: row.party.id, code: row.party.code, name: row.party.tradeName?.trim() || row.party.legalName, language: row.party.language },
        ...recipientLanguageOf({ contact: row.language, party: row.party.language, company: row.party.companyId ? locales.get(row.party.companyId) : null }),
        version: row.version,
      })),
      nextCursor: rows.length > query.limit && last ? encode(last.name, last.id) : null,
      languages: [...TEMPLATE_LANGUAGES],
    }
  })
}
