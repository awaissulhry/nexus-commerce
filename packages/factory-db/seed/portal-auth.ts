import { createHash } from 'node:crypto'
import { PartnerKind, PortalSignInCodePurpose, PrivacyNoticeKind, PrivacyNoticeStatus, SessionEndReason, UserAudience, UserStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedParties } from './parties'

/**
 * The portal identity seed (W2b schema wave 17/22, B-W2b-152), per tenant of seed/_core.ts, written as the app does: in
 * the tenant's office scope (the portal's sign-in and the partner's admin write in the system scope; no partner grant
 * writes any of it). It runs the parties and auth seeds first (idempotent): P1 is the customer and brand, P2 the supplier
 * and workshop of company A.
 *
 *   people       P1: a buyer (ACTIVE, customer portal) and a viewer (INVITED by the office, its invitation expired); P2: an
 *                order desk (ACTIVE, supplier portal). None has a password (a partner signs in by e-mail code only).
 *   sessions     the buyer's and the order desk's portal sessions (30 minutes idle, 12 hours at most) and the owner's
 *                office preview of P1's portal, all signed out long ago.
 *   codes        the buyer's sign-in code (used, with its link) and step-up code (replaced by a newer one), the order
 *                desk's sign-in code (five wrong tries): every code is dead.
 *   settings     P1 and P2 have portal settings, both with the portal OFF and production progress OFF (Owner answer C1;
 *                every party ships OFF); P1 may have 5 people (buyer and viewer roles), P2 3 (any supplier role).
 *   branding     company A: an accent, a sender name and a portal label, no logo; company B keeps the DS colours.
 *   terms        company A's PORTAL_TERMS version 2026-11 PUBLISHED (Italian and English), and the buyer's acknowledgement
 *                of it at the first visit.
 *
 * Nothing seeded can open anything: every token, link and code hash is a marker no token or code hashes to, the sessions
 * are revoked and past their end, the invitation expired, every code used, replaced or tried out. The role keys are
 * made-up placeholders until B-W2b-162's partner role templates exist. EVERY TEXT HERE IS A MADE-UP SAMPLE: the real terms
 * come from the company's privacy consultant (GATE-PRIVACY). Emails use example.com.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the buyer's used sign-in code (a copy of a live one would be a second live code of the person) gets an id that
 * starts with eight zeros; every other row here may be copied as it is. Idempotent: people, sessions, the invitation,
 * codes, settings and branding are upserted; the terms and the acknowledgement (append-only) are written once and skipped
 * when they exist.
 */

export interface PortalAuthSeed {
  /** P1's buyer (ACTIVE) and viewer (INVITED), P2's order desk (ACTIVE): partner users. */
  readonly userIds: { readonly p1Buyer: string; readonly p1Viewer: string; readonly p2Orders: string }
  readonly sessionIds: { readonly p1Buyer: string; readonly p2Orders: string; readonly p1Preview: string }
  readonly invitationId: string
  /** The buyer's used sign-in code (sorts first), the buyer's replaced step-up code, the order desk's tried-out code. */
  readonly codeIds: { readonly p1SignIn: string; readonly p1StepUp: string; readonly p2SignIn: string }
  /** The portal settings' ids: each party's own id. */
  readonly settingsIds: { readonly p1: string; readonly p2: string }
  readonly brandingId: string
  readonly termsNoticeId: string
  readonly termsAckId: string
}

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  invited: new Date('2026-11-02T08:00:00.000Z'),
  signedIn: new Date('2026-11-02T09:00:00.000Z'),
  published: new Date('2026-11-01T07:00:00.000Z'),
} as const
const MINUTE = 60_000
const later = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * MINUTE)

const TERMS = {
  it: "ESEMPIO - termini del portale e informativa per i partner, testo inventato per lo sviluppo. Il testo vero lo scrive il consulente privacy dell'azienda.",
  en: "SAMPLE - portal terms and partner notice, made-up text for development. The real text comes from the company's privacy consultant.",
} as const
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export async function seed(context: SeedContext): Promise<PortalAuthSeed> {
  const { db, namespace } = context
  const { customerId: p1, supplierId: p2 } = await seedParties(context)
  const { ownerId } = await seedAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** An id that sorts first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const marker = (kind: string, key: string): string => `seed-not-a-${kind}:${id(key)}`

  const userIds = { p1Buyer: id('portal:user:P1:buyer'), p1Viewer: id('portal:user:P1:viewer'), p2Orders: id('portal:user:P2:orders') }
  const sessionIds = { p1Buyer: id('portal:session:P1:buyer'), p2Orders: id('portal:session:P2:orders'), p1Preview: id('portal:session:P1:preview') }
  const invitationId = id('portal:invitation:P1:viewer')
  const codeIds = { p1SignIn: firstId('portal:code:P1:buyer:sign-in'), p1StepUp: id('portal:code:P1:buyer:step-up'), p2SignIn: id('portal:code:P2:orders:sign-in') }
  const settingsIds = { p1, p2 }
  const brandingId = companyA
  const termsNoticeId = id('privacy:notice:A:PORTAL_TERMS:1')
  const termsAckId = id('portal:terms-ack:A:P1:buyer:2026-11')

  const people = [
    { id: userIds.p1Buyer, email: `buyer.portal.${namespace}@example.com`, displayName: 'Seed Portal Buyer', status: UserStatus.ACTIVE, partyId: p1, partnerKind: PartnerKind.CUSTOMER, locale: 'it', lastSignInAt: T.signedIn },
    { id: userIds.p1Viewer, email: `viewer.portal.${namespace}@example.com`, displayName: 'Seed Portal Viewer', status: UserStatus.INVITED, partyId: p1, partnerKind: PartnerKind.CUSTOMER, locale: 'en', lastSignInAt: null },
    { id: userIds.p2Orders, email: `orders.portal.${namespace}@example.com`, displayName: 'Seed Portal Order Desk', status: UserStatus.ACTIVE, partyId: p2, partnerKind: PartnerKind.SUPPLIER, locale: 'it', lastSignInAt: T.signedIn },
  ]
  /** A portal session signed out after 20 minutes: 30 minutes idle and 12 hours at most from sign-in. */
  const portalSession = (userId: string, partyId: string, key: string) => ({
    userId,
    tokenHash: marker('token', key),
    companyId: companyA,
    lastSeenAt: T.signedIn,
    idleExpiresAt: later(T.signedIn, 30),
    absoluteExpiresAt: later(T.signedIn, 12 * 60),
    revokedAt: later(T.signedIn, 20),
    revokedReason: SessionEndReason.SIGNED_OUT,
    audience: UserAudience.PARTNER,
    partyId,
  })
  const sessions = [
    { id: sessionIds.p1Buyer, ...portalSession(userIds.p1Buyer, p1, 'portal:session:P1:buyer') },
    { id: sessionIds.p2Orders, ...portalSession(userIds.p2Orders, p2, 'portal:session:P2:orders') },
    // The owner previewed P1's portal (read-only; the audit row is the API's).
    { id: sessionIds.p1Preview, ...portalSession(ownerId, p1, 'portal:session:P1:preview'), previewOfPartyId: p1, previewById: ownerId },
  ]
  const codes = [
    {
      id: codeIds.p1SignIn,
      userId: userIds.p1Buyer,
      purpose: PortalSignInCodePurpose.SIGN_IN,
      codeHash: marker('code', 'portal:code:P1:buyer:sign-in'),
      linkTokenHash: marker('token', 'portal:code:P1:buyer:sign-in:link'),
      createdAt: later(T.signedIn, -3),
      expiresAt: later(T.signedIn, 12),
      tries: 1,
      usedAt: T.signedIn,
      revokedAt: null,
      ipHash: marker('address', 'portal:code:P1:buyer:sign-in:ip'),
    },
    {
      id: codeIds.p1StepUp,
      userId: userIds.p1Buyer,
      purpose: PortalSignInCodePurpose.STEP_UP,
      codeHash: marker('code', 'portal:code:P1:buyer:step-up'),
      linkTokenHash: null,
      createdAt: later(T.signedIn, 5),
      expiresAt: later(T.signedIn, 20),
      tries: 0,
      usedAt: null,
      revokedAt: later(T.signedIn, 7),
      ipHash: marker('address', 'portal:code:P1:buyer:step-up:ip'),
    },
    {
      id: codeIds.p2SignIn,
      userId: userIds.p2Orders,
      purpose: PortalSignInCodePurpose.SIGN_IN,
      codeHash: marker('code', 'portal:code:P2:orders:sign-in'),
      linkTokenHash: marker('token', 'portal:code:P2:orders:sign-in:link'),
      createdAt: later(T.signedIn, -10),
      expiresAt: later(T.signedIn, 5),
      tries: 5,
      usedAt: null,
      revokedAt: null,
      ipHash: null,
    },
  ]
  const settings = [
    { id: settingsIds.p1, partyId: p1, portalOn: false, progressShared: false, maxUsers: 5, allowedRoleKeys: ['customer-buyer', 'customer-viewer'] },
    { id: settingsIds.p2, partyId: p2, portalOn: false, progressShared: false, maxUsers: 3, allowedRoleKeys: [] as string[] },
  ]
  const branding = { companyId: companyA, accentColour: '#1f5fa8', senderDisplayName: 'Seed Factory A', portalLabel: 'Seed Factory A portal' }

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: userId, ...data } of people) {
        const row = { ...data, audience: UserAudience.PARTNER }
        await tx.user.upsert({ where: { id: userId }, create: { id: userId, ...row, createdAt: T.invited, createdById: ownerId }, update: row, select: { id: true } })
      }
      for (const { id: sessionId, ...data } of sessions) {
        await tx.session.upsert({ where: { id: sessionId }, create: { id: sessionId, ...data, createdAt: T.signedIn }, update: data, select: { id: true } })
      }
      const invitation = {
        userId: userIds.p1Viewer,
        email: people[1]!.email,
        tokenHash: marker('token', 'portal:invitation:P1:viewer'),
        invitedById: ownerId,
        expiresAt: later(T.invited, 7 * 24 * 60),
        audience: UserAudience.PARTNER,
        partyId: p1,
        partnerRoleKeys: ['customer-viewer'],
      }
      await tx.invitation.upsert({ where: { id: invitationId }, create: { id: invitationId, ...invitation, createdAt: T.invited }, update: invitation, select: { id: true } })
      for (const { id: codeId, ...data } of codes) {
        await tx.portalSignInCode.upsert({ where: { id: codeId }, create: { id: codeId, ...data }, update: {}, select: { id: true } })
      }
      for (const { id: settingsId, ...data } of settings) {
        await tx.portalSettings.upsert({
          where: { id: settingsId },
          create: { id: settingsId, ...data, createdAt: T.invited, updatedAt: T.invited, createdById: ownerId },
          update: {},
          select: { id: true },
        })
      }
      await tx.companyBranding.upsert({
        where: { id: brandingId },
        create: { id: brandingId, ...branding, createdAt: T.invited, updatedAt: T.invited, createdById: ownerId },
        update: {},
        select: { id: true },
      })

      // The portal terms: written as a DRAFT with its languages, then published (the privacy guards); once.
      if (!(await tx.privacyNotice.findUnique({ where: { id: termsNoticeId }, select: { id: true } }))) {
        const stamp = { createdAt: T.published, updatedAt: T.published, createdById: ownerId }
        await tx.privacyNotice.create({ data: { id: termsNoticeId, companyId: companyA, kind: PrivacyNoticeKind.PORTAL_TERMS, versionNo: 1, label: '2026-11', ...stamp }, select: { id: true } })
        for (const [locale, body] of Object.entries(TERMS)) {
          await tx.privacyNoticeText.create({ data: { id: id(`privacy:text:${termsNoticeId}:${locale}`), noticeId: termsNoticeId, locale, body, sha256: sha256(body), ...stamp }, select: { id: true } })
        }
        await tx.privacyNotice.update({
          where: { id: termsNoticeId },
          data: { status: PrivacyNoticeStatus.PUBLISHED, publishedAt: T.published, publishedById: ownerId, version: 2, updatedAt: T.published },
          select: { id: true },
        })
      }
      // The buyer's acknowledgement at the first visit (append-only: written once).
      if (!(await tx.partnerNoticeAck.findUnique({ where: { id: termsAckId }, select: { id: true } }))) {
        await tx.partnerNoticeAck.create({
          data: {
            id: termsAckId,
            companyId: companyA,
            noticeId: termsNoticeId,
            userId: userIds.p1Buyer,
            partyId: p1,
            noticeVersion: '2026-11',
            locale: 'it',
            noticeSha256: sha256(TERMS.it),
            sessionId: sessionIds.p1Buyer,
            serverTime: later(T.signedIn, 1),
            createdById: userIds.p1Buyer,
          },
          select: { id: true },
        })
      }
    }),
  )

  return { userIds, sessionIds, invitationId, codeIds, settingsIds, brandingId, termsNoticeId, termsAckId }
}
