import type { FastifyInstance, FastifyRequest } from 'fastify'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { portalSessionOf } from './authenticator'
import { portalOf } from './service'

/**
 * The portal Account page's own facts (B-W2b-196; design portal.customer.account › My profile, Company data, Sign-in and
 * sessions; SAL-066), beside the person's own routes of account.ts:
 *
 *   POST /portal/me/profile             the person's own name and language, ONE command (the profile card's Save), audited
 *                                       before → after; the same values again change nothing (an `unchanged` audit row).
 *                                       The e-mail is the sign-in name: only the organisation's admin or the office
 *                                       changes it (an invitation to the new address).
 *   GET  /portal/sessions               the person's own live portal sessions: when each started, when it was last used,
 *                                       the browser it said it was (the User-Agent kept at sign-in), which one is this one.
 *                                       Never the network: the stored address is a hash of a shortened address.
 *   POST /portal/sessions/end-others    signs out every other live portal session of the person (reason ENDED_BY_USER, B-W2b-404), at
 *                                       once: their next request answers 401. This one stays.
 *   GET  /portal/company                what the factory holds for invoicing the person's organisation, read-only: the legal
 *                                       and trade name, the tax identity in force today (VAT number, tax code, SDI
 *                                       recipient code, PEC), the default invoice address, the payment terms, the
 *                                       currency. No amount.
 *
 * Writes run in the tenant's office scope as the person (the partner role neither updates its User row nor any Session:
 * B-W2b-152); reads of the party's own rows too (the partner role reads no tax identity or payment terms). A preview never
 * writes (the authenticator's read-only rule) and has no sessions of its own to list (an office person's preview is one).
 */

const contextOf = (app: FastifyInstance, request: FastifyRequest) => {
  const session = portalSessionOf(request)
  return portalOf(app).auth.contextFor(request, session.tenantId, session.userId)
}

export interface ProfileBody {
  readonly displayName?: string | undefined
  readonly locale?: 'it' | 'en' | undefined
}

export async function changeProfile(app: FastifyInstance, request: FastifyRequest, body: ProfileBody, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const { result } = await p.auth.command(contextOf(app, request), { name: 'portal.changeProfile', idempotencyKey, input: { ...body, sessionId: session.id } }, async ({ tx, audit }) => {
    const person = await tx.user.findUniqueOrThrow({ where: { id: session.userId }, select: { displayName: true, locale: true } })
    const changes: { displayName?: string; locale?: string } = {}
    const name = body.displayName?.trim()
    if (name && name !== person.displayName) changes.displayName = name
    if (body.locale && body.locale !== person.locale) changes.locale = body.locale
    const keys = Object.keys(changes) as (keyof typeof changes)[]
    if (keys.length === 0) {
      audit({ recordType: 'User', recordId: session.userId, companyId: session.company.id, after: { unchanged: true } })
      return { displayName: person.displayName, locale: person.locale, changed: false }
    }
    await tx.user.update({ where: { id: session.userId }, data: changes, select: { id: true } })
    audit({ recordType: 'User', recordId: session.userId, companyId: session.company.id, before: Object.fromEntries(keys.map((key) => [key, person[key]])), after: changes })
    return { displayName: changes.displayName ?? person.displayName, locale: changes.locale ?? person.locale, changed: true }
  })
  return result
}

/** The person's own live portal sessions (never a preview: those are an office person's). */
const liveOf = (userId: string, partyId: string, now: Date) => ({ userId, partyId, audience: 'PARTNER' as const, previewOfPartyId: null, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } })

export async function listSessions(app: FastifyInstance, request: FastifyRequest) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  if (session.preview) return { sessions: [] }
  const now = p.auth.clock.now()
  const rows = await p.auth.inTenant(session.tenantId, session.userId, (client) =>
    client.session.findMany({
      where: liveOf(session.userId, session.partyId, now),
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, createdAt: true, lastSeenAt: true, idleExpiresAt: true, absoluteExpiresAt: true, userAgent: true },
    }),
  )
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      current: row.id === session.id,
      createdAt: toUtcIso(row.createdAt),
      lastSeenAt: toUtcIso(row.lastSeenAt),
      idleExpiresAt: toUtcIso(row.idleExpiresAt),
      absoluteExpiresAt: toUtcIso(row.absoluteExpiresAt),
      userAgent: row.userAgent,
    })),
  }
}

export async function endOtherSessions(app: FastifyInstance, request: FastifyRequest, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const { result } = await p.auth.command(contextOf(app, request), { name: 'portal.endOtherSessions', idempotencyKey, input: { sessionId: session.id } }, async ({ tx, now, audit }) => {
    const others = await tx.session.findMany({ where: { ...liveOf(session.userId, session.partyId, now), id: { not: session.id } }, select: { id: true } })
    const ids = others.map((row) => row.id)
    const { count } = ids.length === 0 ? { count: 0 } : await tx.session.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now, revokedReason: 'ENDED_BY_USER' } })
    audit({ recordType: 'User', recordId: session.userId, companyId: session.company.id, after: { revokedReason: 'ENDED_BY_USER', sessionsEnded: count, sessionIds: ids, kept: session.id } })
    return { ended: count }
  })
  return result
}

/** The registered office or an invoice address, as the portal shows it. */
const ADDRESS_SELECT = { name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true } as const

export async function companyData(app: FastifyInstance, request: FastifyRequest) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const today = businessDate(p.auth.clock.now())
  return p.auth.inTenant(session.tenantId, session.userId, async (client) => {
    const party = await client.party.findUniqueOrThrow({ where: { id: session.partyId }, select: { legalName: true, tradeName: true, kind: true, country: true, currency: true, language: true, paymentTerms: true, paymentTermsId: true } })
    // One query after the other (one connection).
    const identities = await client.partyTaxIdentity.findMany({ where: { partyId: session.partyId }, select: { country: true, taxMode: true, vatNumber: true, fiscalCode: true, sdiRecipientCode: true, pec: true, validFrom: true } })
    const identity = identityAt(identities.map((row) => ({ ...row, validFrom: row.validFrom.toISOString().slice(0, 10) })), today)
    const addresses = await client.partyAddress.findMany({ where: { partyId: session.partyId, status: 'ACTIVE', kinds: { hasSome: ['BILL_TO', 'REGISTERED'] } }, select: { ...ADDRESS_SELECT, kinds: true, isDefaultBillTo: true }, orderBy: [{ isDefaultBillTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] })
    const invoice = addresses.find((row) => row.isDefaultBillTo) ?? addresses.find((row) => row.kinds.includes('BILL_TO')) ?? null
    const registered = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? null
    const terms = party.paymentTermsId ? await client.paymentTerms.findUnique({ where: { id: party.paymentTermsId }, select: { code: true, name: true, nameI18n: true } }) : null
    const termsIn = (language: 'it' | 'en'): string | null => {
      if (terms) {
        const i18n = (terms.nameI18n ?? {}) as Record<string, unknown>
        const text = i18n[language]
        return typeof text === 'string' && text.trim() !== '' ? text : terms.name
      }
      return party.paymentTerms
    }
    const address = (row: typeof invoice) => (row ? { name: row.name, line1: row.line1, line2: row.line2, postalCode: row.postalCode, city: row.city, province: row.province, country: row.country } : null)
    return {
      company: {
        legalName: party.legalName,
        tradeName: party.tradeName,
        kind: party.kind,
        country: party.country,
        currency: party.currency,
        language: party.language,
        taxIdentity: identity ? { country: identity.country, taxMode: identity.taxMode, vatNumber: identity.vatNumber, fiscalCode: identity.fiscalCode, sdiRecipientCode: identity.sdiRecipientCode, pec: identity.pec, validFrom: identity.validFrom } : null,
        invoiceAddress: address(invoice),
        registeredOffice: registered && registered !== invoice ? address(registered) : null,
        paymentTerms: termsIn('it') === null ? null : { it: termsIn('it')!, en: termsIn('en')! },
      },
    }
  })
}
