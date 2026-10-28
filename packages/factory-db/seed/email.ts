import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * Email out's synthetic seed, per tenant of seed/_core.ts: a FAKE SES account of its own (no network; seed/integration.ts
 * runs after this file, so its account cannot be named here), company A's two verified sending identities on a made-up
 * domain (conversation mail and notification mail), two sign-in mails the auth seed's people got (one SENT and
 * DELIVERED, one FAILED because its address is suppressed: rows only, no body, no link — sign-in mail bodies are
 * never stored), and two suppressed addresses (a bounce, one stopped by hand). Mail on record threads is not seeded:
 * its row names its thread message, and seed/threads.ts runs later. Written in the tenant's office scope. Made up and
 * harmless; a second run adds nothing (INSERT … ON CONFLICT DO NOTHING).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T07:00:00.000Z')
const seconds = (n: number): Date => new Date(AT.getTime() + n * 1_000)

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const account = id('email:account:ses')
  const conversation = id('email:identity:A:conversation')
  const notification = id('email:identity:A:notification')
  const domain = `company-a.${namespace}.example.com`

  const identity = {
    companyId: companyA,
    displayName: 'Seed A',
    displayNamePolicy: 'PERSON_VIA_COMPANY',
    replyDomain: `reply.${domain}`,
    accountId: account,
    verificationStatus: 'SUCCESS',
    dkimStatus: 'SUCCESS',
    dkimTokens: ['seedtokenone', 'seedtokentwo', 'seedtokenthree'],
    lastCheckedAt: AT,
    isDefault: true,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
  } as const
  const identities: Prisma.EmailIdentityCreateManyInput[] = [
    { id: conversation, ...identity, kind: 'CONVERSATION', domain, fromAddress: `noreply@${domain}`, dkimTokens: [...identity.dkimTokens] },
    { id: notification, ...identity, kind: 'NOTIFICATION', domain: `mail.${domain}`, fromAddress: `noreply@mail.${domain}`, dkimTokens: [...identity.dkimTokens] },
  ]
  const invitation = id('email:outbound:invitation')
  const suppressed = id('email:outbound:suppressed')
  const mail = {
    companyId: companyA,
    identityId: notification,
    recordType: 'User',
    templateKey: 'auth.invitation',
    locale: 'it',
    fromAddress: `noreply@mail.${domain}`,
    fromName: 'Seed A',
    subject: 'Invito a Nexus Factory',
    createdById: null,
  } as const
  const outbound: Prisma.EmailOutboundCreateManyInput[] = [
    {
      id: invitation,
      ...mail,
      recordId: id('user:invited'),
      to: [`invited.${namespace}@example.com`],
      emailMessageId: `<${invitation}@mail.${domain}>`,
      sesMessageId: `fake-${namespace}-invitation`,
      status: 'DELIVERED',
      attempts: 1,
      queuedAt: AT,
      sentAt: seconds(1),
      deliveredAt: seconds(5),
      createdAt: AT,
      updatedAt: seconds(5),
    },
    {
      id: suppressed,
      ...mail,
      templateKey: 'auth.password_reset',
      subject: 'Nuova password per Nexus Factory',
      recordId: id('user:member'),
      to: [`bounced.${namespace}@example.com`],
      emailMessageId: `<${suppressed}@mail.${domain}>`,
      status: 'FAILED',
      attempts: 0,
      lastError: 'suppressed: every recipient is on the suppression list',
      queuedAt: seconds(60),
      failedAt: seconds(60),
      createdAt: seconds(60),
      updatedAt: seconds(60),
    },
  ]
  const suppressions: Prisma.SuppressionCreateManyInput[] = [
    { id: id('email:suppression:bounce'), address: `bounced.${namespace}@example.com`, reason: 'BOUNCE', at: seconds(30), detail: 'Permanent/General', createdAt: seconds(30), updatedAt: seconds(30) },
    { id: id('email:suppression:manual'), address: `stopped.${namespace}@example.com`, reason: 'MANUAL', at: seconds(40), detail: 'Asked not to be mailed', createdAt: seconds(40), updatedAt: seconds(40), createdById: actorId },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.integrationAccount.createMany({
        data: [{ id: account, companyId: null, provider: 'SES', code: 'ses-mail', label: 'Email out (fake)', mode: 'FAKE', createdById: actorId }],
        skipDuplicates: true,
      })
      await tx.emailIdentity.createMany({ data: identities, skipDuplicates: true })
      await tx.emailOutbound.createMany({ data: outbound, skipDuplicates: true })
      await tx.suppression.createMany({ data: suppressions, skipDuplicates: true })
    }),
  )
}
