import { seedUuid, type SeedContext } from '../seeding'

/**
 * B-TH-038 (threads plan, schema wave 5/9; Owner decision 6 "undo send, 10 seconds"): a mail taken back in its undo window, for
 * the tests. On the threads seed's quote thread of company A for party P1, an OUTBOUND mail message, held, and its
 * EmailOutbound row with a 10-second window, queued and then taken back (WITHDRAWN) by the seed's office person 4 seconds
 * later: the message stays held for good, so P1's portal never reads it. The generated isolation test needs a held message
 * inside P1's scope to prove the partner role's value filter (Message.held: onlyValues false).
 *
 * Written in the tenant's office scope in ONE transaction, as the API does (the held message has its mail by commit: the
 * deferred check of …_threads_composer_th_guards); ids start with `ffffffff`, so no generated test takes one of them as "the
 * first row" it copies. Made up and harmless; a second run adds nothing (INSERT … ON CONFLICT DO NOTHING; the take-back moves
 * only a QUEUED mail). Needs the core, threads and email seeds of the same namespace first.
 */

const AT = new Date('2026-10-28T10:00:00.000Z')
const seconds = (n: number): Date => new Date(AT.getTime() + n * 1_000)

export interface HeldMail {
  readonly threadId: string
  readonly partyId: string
  readonly messageId: string
  readonly outboundId: string
}

export async function seedHeldMail({ db, namespace }: SeedContext): Promise<HeldMail> {
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => `ffffffff${base(`held-mail:${key}`).slice(8)}`
  const tenantId = base('tenant')
  const actorId = base('actor')
  const companyA = base('company:A')
  const domain = `company-a.${namespace}.example.com`
  const made: HeldMail = { threadId: base('threads:quote:Q1'), partyId: base('party:P1'), messageId: id('message'), outboundId: id('outbound') }
  const emailMessageId = `<${made.outboundId}@${domain}>`

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.message.createMany({
        data: [
          {
            id: made.messageId,
            threadId: made.threadId,
            partyId: made.partyId,
            direction: 'OUTBOUND',
            audience: 'PARTNER',
            channel: 'EMAIL',
            // Written by the system (no author id), so the generated test's partner copy of it, which cannot name an author id
            // (no grant), meets the partner policy's value filter first, not the shape guard's author rule.
            authorKind: 'SYSTEM',
            authorName: 'Seed A',
            bodyText: 'Seed message: the price list is attached (taken back: the wrong file).',
            emailMessageId,
            held: true,
            at: AT,
            createdAt: AT,
          },
        ],
        skipDuplicates: true,
      })
      await tx.emailOutbound.createMany({
        data: [
          {
            id: made.outboundId,
            companyId: companyA,
            identityId: base('email:identity:A:conversation'),
            threadId: made.threadId,
            messageId: made.messageId,
            recordType: 'Quote',
            recordId: base('quote:Q1'),
            templateKey: 'thread.message',
            locale: 'it',
            fromAddress: `noreply@${domain}`,
            fromName: 'Seed Office User via Seed A',
            to: [`buyer.${namespace}@example.com`],
            subject: 'Listino prezzi',
            emailMessageId,
            status: 'QUEUED',
            queuedAt: AT,
            sendAfter: seconds(10),
            createdAt: AT,
            updatedAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.emailOutbound.updateMany({
        where: { id: made.outboundId, status: 'QUEUED' },
        data: { status: 'WITHDRAWN', withdrawnAt: seconds(4), withdrawnById: actorId, updatedAt: seconds(4) },
      })
    }),
  )
  return made
}
