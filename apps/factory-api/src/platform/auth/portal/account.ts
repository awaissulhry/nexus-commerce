import type { FastifyInstance, FastifyRequest } from 'fastify'
import { portalIdleExpiryAt, portalStepUpUntil } from '@nexus/factory-domain/auth/portal/session'
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

export function me(app: FastifyInstance, request: FastifyRequest) {
  const session = portalSessionOf(request)
  const context = requireContext(request)
  const now = portalOf(app).auth.clock.now()
  const stepUpUntil = portalStepUpUntil(session.stepUpAt, now)
  return {
    user: {
      id: session.userId,
      email: session.person.email,
      displayName: session.person.displayName,
      locale: session.person.locale,
      partnerKind: session.person.partnerKind,
      accessUntil: session.person.accessUntil ? toUtcIso(session.person.accessUntil) : null,
    },
    party: session.party,
    company: { id: session.company.id, code: session.company.code, name: session.company.name },
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
