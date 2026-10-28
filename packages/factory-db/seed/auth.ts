import { PasswordResetKind, SessionEndReason, UserStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The office sign-in seed: made-up people of each seeded tenant (an owner, a member, an invited person) with one
 * invitation, one session and one password reset, written in the tenant's office scope as the app writes them. Runs
 * after seed/_core.ts and uses its tenant and actor (the owner IS the seed's actor, so the other seeds' rows name a
 * real user).
 *
 * Nothing seeded can open anything: no user has a password, and every token hash is a marker that no token hashes to
 * (a real one is 64 hex characters); the session is revoked and expired, the invitation expired, the reset used. Local
 * sign-in starts with an invitation or a reset made through the API. Emails use example.com.
 */

export interface AuthSeed {
  readonly ownerId: string
  readonly memberId: string
  readonly invitedId: string
}

const SEEDED_AT = new Date('2026-10-28T08:00:00.000Z')
const EXPIRED_AT = new Date('2026-10-28T09:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<AuthSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const memberId = id('user:member')
  const invitedId = id('user:invited')
  const notAToken = (key: string): string => `seed-not-a-token:${id(key)}`

  const users = [
    { id: ownerId, email: `owner.${namespace}@example.com`, displayName: 'Seed Owner', status: UserStatus.ACTIVE, requireMfa: true },
    { id: memberId, email: `member.${namespace}@example.com`, displayName: 'Seed Member', status: UserStatus.ACTIVE, requireMfa: false },
    { id: invitedId, email: `invited.${namespace}@example.com`, displayName: 'Seed Invited', status: UserStatus.INVITED, requireMfa: false },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: userId, ...data } of users) {
        await tx.user.upsert({ where: { id: userId }, create: { id: userId, ...data, createdAt: SEEDED_AT }, update: data })
      }

      const sessionId = id('session:owner')
      const session = {
        userId: ownerId,
        tokenHash: notAToken('session:owner'),
        lastSeenAt: SEEDED_AT,
        idleExpiresAt: EXPIRED_AT,
        absoluteExpiresAt: EXPIRED_AT,
        revokedAt: SEEDED_AT,
        revokedReason: SessionEndReason.SIGNED_OUT,
      }
      await tx.session.upsert({ where: { id: sessionId }, create: { id: sessionId, ...session, createdAt: SEEDED_AT }, update: session })

      const invitationId = id('invitation:invited')
      const invitation = {
        userId: invitedId,
        email: users[2]!.email,
        tokenHash: notAToken('invitation:invited'),
        invitedById: ownerId,
        expiresAt: EXPIRED_AT,
      }
      await tx.invitation.upsert({ where: { id: invitationId }, create: { id: invitationId, ...invitation, createdAt: SEEDED_AT }, update: invitation })

      const resetId = id('reset:member')
      const reset = { userId: memberId, tokenHash: notAToken('reset:member'), kind: PasswordResetKind.REQUESTED, expiresAt: EXPIRED_AT, usedAt: SEEDED_AT }
      await tx.passwordReset.upsert({ where: { id: resetId }, create: { id: resetId, ...reset, createdAt: SEEDED_AT }, update: reset })
    }),
  )

  return { ownerId, memberId, invitedId }
}
