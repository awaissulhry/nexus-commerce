import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { ReadAction, RoleAudience, SecurityEventKind, SecuritySurface, SessionEndReason, StepUpResult } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'

/**
 * The security and audit seed (W2b schema wave 52/57, B-W2b-373), per tenant of seed/_core.ts, written as the API writes
 * these rows: in the tenant's office scope, a floor device's site scope for the floor's events and the portal party's scope
 * for its event. The CLI runs the seed files in name order and this one sorts after auth, roles, floor-auth, compliance and
 * portal-auth, whose rows it names (it runs the auth seed itself: its sessions need the people). Every name, address and
 * code is made up; nothing seeded opens anything (the sessions are ended and their token hashes are markers no token hashes
 * to; a code's fingerprint is a hash of a made-up text).
 *
 *   settings      the tenant's security settings with the defaults (office 8 hours idle, 7 days at most; portal 30
 *                 minutes, 12 hours; every risky action asks a fresh code; step-up locks after 5 failures for 15 minutes).
 *   role          a custom role nobody held any more, archived by the owner ("Old quality desk").
 *   sessions      the owner's laptop (Mac, Chrome, Italy, Seedville), ended by the owner from another browser; the member's
 *                 PC (Windows, Firefox, Italy), ended by the owner as an administrator.
 *   step-up       the owner: a wrong code (the first row), then the code that worked; the member: five wrong codes in a row,
 *                 so step-up locked, then a try while locked.
 *   events        a failed sign-in with an address nobody has (the first row), the owner's sign-in and two-factor change,
 *                 the member's step-up lock and a refusal, the role archived, an export, an API key's use; on the floor of
 *                 A1 a wrong PIN and the lock it set, of B1 an unknown badge; in P1's portal a wrong sign-in code.
 *   reads         the owner viewed worker A1-1 (the first row), downloaded the jacket's certificate and viewed the member's
 *                 account.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy: so the first step-up try is a plain wrong code, the first event a failed sign-in of nobody
 * known. Fixed instants, so nothing depends on the clock. Idempotent: rows are written once (skipDuplicates, or made only
 * when missing); an archived role changes no more.
 */

const AT = new Date('2026-11-12T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

export interface SecuritySeed {
  readonly settingsId: string
  readonly archivedRoleId: string
  readonly sessionIds: { readonly ownerLaptop: string; readonly memberPc: string }
  readonly attemptIds: readonly string[]
  readonly eventIds: readonly string[]
  readonly readIds: readonly string[]
}

export async function seed(context: SeedContext): Promise<SecuritySeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const hex = (text: string): string => createHash('sha256').update(`seed security ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const siteA1 = id('site:A1')
  const siteB1 = id('site:B1')
  const partyP1 = id('party:P1')
  const workerA1 = id('worker:A1:operator')
  const p1Buyer = id('portal:user:P1:buyer')
  const jacketCertificate = id('compliance:certificate:JKT-01')
  const office = { audience: 'office' as const, tenantId, actorId: ownerId }

  // --- settings, the archived role, the sessions ------------------------------------------------------------------------
  const settingsId = tenantId
  const archivedRoleId = id('security:role:old-quality-desk')
  const sessionIds = { ownerLaptop: id('security:session:owner:laptop'), memberPc: id('security:session:member:pc') }
  const sessions: Prisma.SessionCreateManyInput[] = [
    {
      id: sessionIds.ownerLaptop,
      userId: ownerId,
      tokenHash: `seed-not-a-token:${sessionIds.ownerLaptop}`,
      createdAt: minutes(-120),
      lastSeenAt: minutes(30),
      idleExpiresAt: minutes(60),
      absoluteExpiresAt: minutes(60),
      mfaAt: minutes(-120),
      stepUpAt: minutes(11),
      ipHash: hex('owner laptop address'),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36',
      deviceLabel: 'Mac',
      browser: 'Chrome 130',
      ipCountry: 'IT',
      ipCity: 'Seedville',
      revokedAt: minutes(60),
      revokedReason: SessionEndReason.ENDED_BY_USER,
    },
    {
      id: sessionIds.memberPc,
      userId: memberId,
      tokenHash: `seed-not-a-token:${sessionIds.memberPc}`,
      createdAt: minutes(100),
      lastSeenAt: minutes(130),
      idleExpiresAt: minutes(180),
      absoluteExpiresAt: minutes(180),
      ipHash: hex('member pc address'),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/132.0',
      deviceLabel: 'Windows PC',
      browser: 'Firefox 132',
      ipCountry: 'IT',
      revokedAt: minutes(180),
      revokedReason: SessionEndReason.ENDED_BY_ADMIN,
    },
  ]
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.securitySettings.findUnique({ where: { id: settingsId }, select: { id: true } }))) {
        await tx.securitySettings.create({ data: { id: settingsId, createdAt: minutes(-30 * 24 * 60), updatedAt: minutes(-30 * 24 * 60), createdById: ownerId } })
      }
      // Written archived once: an archived role changes no more, so a second run leaves it as it is.
      if (!(await tx.role.findUnique({ where: { id: archivedRoleId }, select: { id: true } }))) {
        await tx.role.create({
          data: {
            id: archivedRoleId,
            key: 'custom.old_quality_desk',
            name: 'Old quality desk',
            description: 'A copy of the quality template, no longer used.',
            system: false,
            basedOn: 'quality',
            audience: RoleAudience.OFFICE,
            permissions: ['audit.read'],
            grains: [],
            createdAt: minutes(-60 * 24 * 60),
            updatedAt: minutes(210),
            createdById: ownerId,
            archivedAt: minutes(210),
            archivedById: ownerId,
          },
        })
      }
      await tx.session.createMany({ data: sessions, skipDuplicates: true })
    }),
  )

  // --- step-up tries ------------------------------------------------------------------------------------------------------
  const attempt = (key: string, userId: string, sessionId: string, at: Date, result: StepUpResult, action: string | null, first = false) =>
    ({
      id: first ? firstId(key) : id(key),
      userId,
      sessionId,
      at,
      result,
      action,
      codeFingerprint: result === StepUpResult.SUCCESS ? hex(`${key} code`) : null,
    }) satisfies Prisma.StepUpAttemptCreateManyInput
  const attempts = [
    attempt('security:step-up:owner:1', ownerId, sessionIds.ownerLaptop, minutes(10), StepUpResult.WRONG_CODE, 'parties.bank.change', true),
    attempt('security:step-up:owner:2', ownerId, sessionIds.ownerLaptop, minutes(11), StepUpResult.SUCCESS, 'parties.bank.change'),
    ...[0, 1, 2, 3, 4].map((n) => attempt(`security:step-up:member:${n + 1}`, memberId, sessionIds.memberPc, minutes(120 + n), StepUpResult.WRONG_CODE, null)),
    attempt('security:step-up:member:6', memberId, sessionIds.memberPc, minutes(125), StepUpResult.LOCKED, null),
  ]

  // --- security events ------------------------------------------------------------------------------------------------------
  type Event = Prisma.SecurityEventCreateManyInput
  const event = (key: string, kind: SecurityEventKind, surface: SecuritySurface, at: Date, actorId: string | null, details: Prisma.InputJsonObject, extra: Partial<Event> = {}, first = false): Event => ({
    id: first ? firstId(key) : id(key),
    kind,
    surface,
    at,
    actorId,
    details,
    ...extra,
  })
  const officeEvents: Event[] = [
    event('security:event:unknown-sign-in', SecurityEventKind.SIGN_IN_FAILED, SecuritySurface.OFFICE, minutes(-125), null, { reason: 'UNKNOWN_ACCOUNT' }, { ipHash: hex('unknown address'), ipCountry: 'NL' }, true),
    event('security:event:owner-sign-in', SecurityEventKind.SIGN_IN, SecuritySurface.OFFICE, minutes(-120), ownerId, { secondFactor: true }, { ipHash: hex('owner laptop address'), ipCountry: 'IT' }),
    event('security:event:owner-mfa', SecurityEventKind.MFA_CHANGED, SecuritySurface.OFFICE, minutes(5), ownerId, { change: 'RECOVERY_CODES_RENEWED' }, { recordType: 'User', recordId: ownerId }),
    event('security:event:member-step-up-locked', SecurityEventKind.STEP_UP_LOCKED, SecuritySurface.OFFICE, minutes(124), memberId, { failures: 5, lockMinutes: 15 }),
    event('security:event:member-denied', SecurityEventKind.PERMISSION_DENIED, SecuritySurface.OFFICE, minutes(130), memberId, { permission: 'costing.view' }),
    event('security:event:role-archived', SecurityEventKind.ROLE_CHANGED, SecuritySurface.OFFICE, minutes(210), ownerId, { change: 'ARCHIVED' }, { recordType: 'Role', recordId: archivedRoleId }),
    event('security:event:owner-export', SecurityEventKind.EXPORT, SecuritySurface.OFFICE, minutes(240), ownerId, { format: 'XLSX', rows: 120 }),
    event('security:event:api-key', SecurityEventKind.API_KEY_USED, SecuritySurface.API, minutes(300), null, { key: 'seed-integration' }, { ipHash: hex('integration address') }),
  ]
  const floorEventsA1: Event[] = [
    event('security:event:floor:A1:wrong-pin', SecurityEventKind.SIGN_IN_FAILED, SecuritySurface.FLOOR, minutes(60), workerA1, { reason: 'WRONG_PIN' }, { siteId: siteA1 }),
    event('security:event:floor:A1:pin-locked', SecurityEventKind.LOCKOUT, SecuritySurface.FLOOR, minutes(62), workerA1, { what: 'PIN', minutes: 1 }, { siteId: siteA1 }),
  ]
  const floorEventsB1: Event[] = [event('security:event:floor:B1:unknown-badge', SecurityEventKind.SIGN_IN_FAILED, SecuritySurface.FLOOR, minutes(70), null, { reason: 'UNKNOWN_BADGE' }, { siteId: siteB1 })]
  const portalEvents: Event[] = [
    event('security:event:portal:P1:wrong-code', SecurityEventKind.SIGN_IN_FAILED, SecuritySurface.PORTAL, minutes(90), p1Buyer, { reason: 'WRONG_CODE' }, { partyId: partyP1, ipHash: hex('buyer address'), ipCountry: 'IT' }),
  ]

  // --- reads of sensitive records -----------------------------------------------------------------------------------------
  const read = (key: string, userId: string, recordType: string, recordId: string, action: ReadAction, at: Date, first = false) =>
    ({ id: first ? firstId(key) : id(key), userId, recordType, recordId, action, surface: SecuritySurface.OFFICE, at }) satisfies Prisma.ReadLogCreateManyInput
  const reads = [
    read('security:read:owner:worker', ownerId, 'Worker', workerA1, ReadAction.VIEW, minutes(20), true),
    read('security:read:owner:certificate', ownerId, 'Certificate', jacketCertificate, ReadAction.DOWNLOAD, minutes(25)),
    read('security:read:owner:member', ownerId, 'User', memberId, ReadAction.VIEW, minutes(170)),
  ]

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.stepUpAttempt.createMany({ data: attempts, skipDuplicates: true })
      await tx.securityEvent.createMany({ data: officeEvents, skipDuplicates: true })
      await tx.readLog.createMany({ data: reads, skipDuplicates: true })
    }),
  )
  await db.withScope({ audience: 'floor', tenantId, actorId: ownerId, siteId: siteA1 }, (client) => client.securityEvent.createMany({ data: floorEventsA1, skipDuplicates: true }))
  await db.withScope({ audience: 'floor', tenantId, actorId: ownerId, siteId: siteB1 }, (client) => client.securityEvent.createMany({ data: floorEventsB1, skipDuplicates: true }))
  await db.withScope({ audience: 'partner', tenantId, actorId: ownerId, partyId: partyP1 }, (client) => client.securityEvent.createMany({ data: portalEvents, skipDuplicates: true }))

  return {
    settingsId,
    archivedRoleId,
    sessionIds,
    attemptIds: attempts.map((row) => row.id),
    eventIds: [...officeEvents, ...floorEventsA1, ...floorEventsB1, ...portalEvents].map((row) => row.id as string),
    readIds: reads.map((row) => row.id),
  }
}
