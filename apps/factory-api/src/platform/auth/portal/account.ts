import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { partnerKindsOf } from '@nexus/factory-domain/auth/partners/kinds'
import { portalIdleExpiryAt, portalStepUpUntil } from '@nexus/factory-domain/auth/portal/session'
import { legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ACKNOWLEDGE_MEANS } from '@nexus/factory-domain/privacy/notices'
import { requireContext } from '../../../core/context'
import { noticeTextFor } from '../../privacy/read'
import { portalSessionOf } from './authenticator'
import { portalOf } from './service'
import { portalTermsInForce } from './terms'

/**
 * The signed-in partner's own routes (B-W2b-159; design portal.signin first-visit, portal.frame stay-signed-in):
 *
 *   GET  /portal/me                the person, their organisation, the company whose portal it is, the session's ends and
 *                                  step-up, the portal terms in force and whether they are due, what the session may do;
 *   POST /portal/sessions/refresh  "Stay signed in": the idle end moves now (bookkeeping, not audited; allowed in a preview);
 *   GET  /portal/terms             the company's PORTAL_TERMS notice in force, in the person's language (else Italian, else
 *                                  English), and whether they acknowledged that version;
 *   POST /portal/first-visit       ONE command at the first sign-in: the name and language they confirm, and their
 *                                  acknowledgement of the portal terms in force (PartnerNoticeAck: the version, the language
 *                                  shown and its SHA-256, the session; GDPR arts. 7(1), 13). Acknowledging the same version
 *                                  again changes nothing. Until it is given the session holds no permission (the
 *                                  authenticator's grants), so every partner page waits for it; a newer published version
 *                                  asks again.
 * E-mail summaries (COL-063) join the first visit with B-W2b-167 (no table yet).
 */

const timesOf = (session: { idleExpiresAt: Date; absoluteExpiresAt: Date }) => ({ idleExpiresAt: toUtcIso(session.idleExpiresAt), absoluteExpiresAt: toUtcIso(session.absoluteExpiresAt) })

/** The registered office as the Company row keeps it (`address` JSON; platform/documents reads it the same way). */
const officeAddress = z.object({ line1: z.string(), line2: z.string().nullish(), postalCode: z.string(), city: z.string(), province: z.string().nullish(), country: z.string() })

/**
 * B-W2b-173: what the portal's frame needs beside the session — the party's code (the portal address `/p/<code>`) and partner
 * kinds (an office preview has no person's kind: the frame draws the party's), and the company's legal block (c.c. art.
 * 2250: its foot), each language as the company's documents print it. Read in the tenant's office scope as the person (the
 * partner role reads no Company row); public facts only, never an amount but the paid-in capital the law asks to print.
 */
async function frameFacts(app: FastifyInstance, session: ReturnType<typeof portalSessionOf>) {
  return portalOf(app).auth.inTenant(session.tenantId, session.userId, async (client) => {
    const [party, company] = await Promise.all([
      client.party.findUnique({ where: { id: session.partyId }, select: { code: true, roles: true } }),
      client.company.findUnique({
        where: { id: session.company.id },
        select: { legalName: true, tradeName: true, address: true, vatNumber: true, fiscalCode: true, reaOffice: true, reaNumber: true, shareCapital: true, soleShareholder: true, inLiquidation: true, currency: true, pec: true },
      }),
    ])
    const address = officeAddress.safeParse(company?.address)
    const legal: CompanyLegal | null = company
      ? {
          legalName: company.legalName,
          tradeName: company.tradeName,
          address: address.success ? address.data : null,
          vatNumber: company.vatNumber,
          fiscalCode: company.fiscalCode,
          reaOffice: company.reaOffice,
          reaNumber: company.reaNumber,
          shareCapital: company.shareCapital === null ? null : company.shareCapital.toFixed(2),
          soleShareholder: company.soleShareholder,
          inLiquidation: company.inLiquidation,
          currency: company.currency,
          pec: company.pec,
        }
      : null
    const block = (language: 'it' | 'en') => (legal ? { name: legalName(legal, language), lines: legalLines(legal, language) } : { name: session.company.name, lines: [] })
    return { code: party?.code ?? session.partyId, kinds: partnerKindsOf(party?.roles ?? []), legal: { it: block('it'), en: block('en') } }
  })
}

export async function me(app: FastifyInstance, request: FastifyRequest) {
  const session = portalSessionOf(request)
  const context = requireContext(request)
  const now = portalOf(app).auth.clock.now()
  const stepUpUntil = portalStepUpUntil(session.stepUpAt, now)
  const facts = await frameFacts(app, session)
  return {
    user: {
      id: session.userId,
      email: session.person.email,
      displayName: session.person.displayName,
      locale: session.person.locale,
      partnerKind: session.person.partnerKind,
      accessUntil: session.person.accessUntil ? toUtcIso(session.person.accessUntil) : null,
    },
    party: { ...session.party, code: facts.code, kinds: facts.kinds },
    company: { id: session.company.id, code: session.company.code, name: session.company.name, legal: facts.legal },
    session: { id: session.id, createdAt: toUtcIso(session.createdAt), ...timesOf(session), stepUpUntil: stepUpUntil ? toUtcIso(stepUpUntil) : null },
    preview: session.preview,
    terms: session.terms,
    termsDue: session.terms !== null && !session.terms.acknowledged,
    permissions: [...new Set(context.grants.flatMap((grant) => grant.permissions))].sort(),
  }
}

export async function refresh(app: FastifyInstance, request: FastifyRequest) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const now = p.auth.clock.now()
  const idleExpiresAt = portalIdleExpiryAt(now, session.absoluteExpiresAt)
  await p.auth.inTenant(session.tenantId, session.userId, (client) =>
    client.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } }),
  )
  return timesOf({ idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt })
}

/**
 * B-W2b-173 (SCM-101): the person's own language, chosen in the portal's person menu — the pages, the notifications and the
 * e-mails speak it. ONE command in the tenant's office scope as the person (the partner role cannot update its User row),
 * audited with the language before and after; the same language again changes nothing (its audit row says unchanged). A
 * preview never gets here (the authenticator: read-only).
 */
export async function changeLocale(app: FastifyInstance, request: FastifyRequest, body: { readonly locale: 'it' | 'en' }, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const { result } = await p.auth.command(
    p.auth.contextFor(request, session.tenantId, session.userId),
    { name: 'portal.changeLocale', idempotencyKey, input: body },
    async ({ tx, audit }) => {
      const person = await tx.user.findUniqueOrThrow({ where: { id: session.userId }, select: { locale: true } })
      if (person.locale === body.locale) {
        audit({ recordType: 'User', recordId: session.userId, companyId: session.company.id, after: { locale: body.locale, unchanged: true } })
        return { locale: body.locale, changed: false }
      }
      await tx.user.update({ where: { id: session.userId }, data: { locale: body.locale }, select: { id: true } })
      audit({ recordType: 'User', recordId: session.userId, companyId: session.company.id, before: { locale: person.locale }, after: { locale: body.locale } })
      return { locale: body.locale, changed: true }
    },
  )
  return result
}

export async function terms(app: FastifyInstance, request: FastifyRequest, query: { readonly locale?: string | undefined }) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  return p.auth.inTenant(session.tenantId, session.userId, async (client) => {
    const inForce = await portalTermsInForce(client, session.company.id)
    if (!inForce) return { notice: null, acknowledged: false, means: ACKNOWLEDGE_MEANS }
    const text = await noticeTextFor(client, inForce.id, query.locale ?? session.person.locale)
    const ack = session.preview ? null : await client.partnerNoticeAck.findFirst({ where: { companyId: session.company.id, noticeId: inForce.id, userId: session.userId }, select: { id: true } })
    return {
      notice: text.text
        ? {
            id: inForce.id,
            kind: 'PORTAL_TERMS' as const,
            label: inForce.label,
            versionNo: inForce.versionNo,
            publishedAt: inForce.publishedAt ? toUtcIso(inForce.publishedAt) : null,
            locale: text.text.locale,
            body: text.text.body,
            sha256: text.text.sha256,
            languages: text.languages,
            languageReady: text.languageReady,
          }
        : null,
      acknowledged: ack !== null && ack !== undefined,
      means: ACKNOWLEDGE_MEANS,
    }
  })
}

export interface FirstVisitBody {
  readonly displayName?: string | undefined
  readonly locale?: 'it' | 'en' | undefined
  /** The version shown (its id), the language it was shown in and that text's SHA-256 (from GET /portal/terms). */
  readonly noticeId: string
  readonly noticeLocale: string
  readonly sha256: string
}

export async function firstVisit(app: FastifyInstance, request: FastifyRequest, body: FirstVisitBody, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const companyId = session.company.id
  const { result } = await p.auth.command(
    p.auth.contextFor(request, session.tenantId, session.userId),
    { name: 'portal.firstVisit', idempotencyKey, input: { ...body, sessionId: session.id } },
    async ({ tx, now, audit }) => {
      const inForce = await portalTermsInForce(tx, companyId)
      if (!inForce) throw new ConflictError('No portal terms are in force to acknowledge.')
      if (inForce.id !== body.noticeId) throw new ConflictError(`A newer version (${inForce.label}) of the portal terms is in force: read it first.`)
      const text = await tx.privacyNoticeText.findFirst({ where: { noticeId: inForce.id, locale: body.noticeLocale }, select: { sha256: true } })
      if (!text || text.sha256 !== body.sha256) throw new ConflictError(`The text shown is not version ${inForce.label} in that language: reload it and read it again.`)

      const person = await tx.user.findUniqueOrThrow({ where: { id: session.userId }, select: { displayName: true, locale: true } })
      const changes: Record<string, string> = {}
      const name = body.displayName?.trim()
      if (name && name !== person.displayName) changes.displayName = name
      if (body.locale && body.locale !== person.locale) changes.locale = body.locale
      if (Object.keys(changes).length > 0) {
        await tx.user.update({ where: { id: session.userId }, data: changes, select: { id: true } })
        audit({ recordType: 'User', recordId: session.userId, companyId, before: Object.fromEntries(Object.keys(changes).map((key) => [key, person[key as 'displayName' | 'locale']])), after: changes })
      }

      const existing = await tx.partnerNoticeAck.findFirst({ where: { companyId, noticeId: inForce.id, userId: session.userId }, select: { id: true } })
      if (existing) {
        if (Object.keys(changes).length === 0) audit({ recordType: 'PartnerNoticeAck', recordId: existing.id, companyId, after: { unchanged: true } })
        return { acknowledged: true as const, changed: Object.keys(changes).length > 0, label: inForce.label }
      }
      const id = newId()
      await tx.partnerNoticeAck.create({
        data: {
          id,
          companyId,
          noticeId: inForce.id,
          userId: session.userId,
          partyId: session.partyId,
          noticeVersion: inForce.label,
          locale: body.noticeLocale,
          noticeSha256: body.sha256,
          sessionId: session.id,
          serverTime: now,
          createdById: session.userId,
        },
        select: { id: true },
      })
      audit({ recordType: 'PartnerNoticeAck', recordId: id, companyId, after: { noticeId: inForce.id, label: inForce.label, locale: body.noticeLocale, sha256: body.sha256, partyId: session.partyId } })
      return { acknowledged: true as const, changed: true, label: inForce.label }
    },
  )
  return result
}
