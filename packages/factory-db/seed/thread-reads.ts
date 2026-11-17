import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedThreads } from './threads'

/**
 * The read marks' synthetic seed (TH-2, threads schema wave 4/9, B-TH-023), per tenant of seed/_core.ts, on the threads seed's
 * threads: the office owner has read the quote thread up to the buyer's reply and the company thread's note; P1's portal buyer
 * has read the quote thread up to the message sent to P1 (their party's mark, on a message shared with it). No floor worker has
 * a mark: there is none (Statuto dei Lavoratori art. 4). The CLI runs the seeds in name order and this file sorts before
 * threads.ts, so it runs the threads and portal sign-in seeds it builds on first (both idempotent). Written in the tenant's
 * office scope; made up and harmless; a second run adds nothing (INSERT … ON CONFLICT DO NOTHING).
 */

const AT = new Date('2026-10-28T09:40:00.000Z')

export interface ThreadReadsSeed {
  readonly ownerQuote: string
  readonly buyerQuote: string
  readonly ownerCompany: string
}

export async function seed(context: SeedContext): Promise<ThreadReadsSeed> {
  const { db, namespace } = context
  await seedThreads(context)
  const portal = await seedPortalAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const quoteThread = id('threads:quote:Q1')
  const companyThread = id('threads:company:A')
  const made: ThreadReadsSeed = { ownerQuote: id('thread-reads:owner:quote'), buyerQuote: id('thread-reads:buyer:quote'), ownerCompany: id('thread-reads:owner:company') }
  const stamp = { readAt: AT, createdAt: AT, updatedAt: AT }
  const rows: Prisma.ThreadReadCreateManyInput[] = [
    { id: made.ownerQuote, threadId: quoteThread, userId: ownerId, key: `read:${quoteThread}:${ownerId}`, lastReadMessageId: id('threads:message:quote-in'), ...stamp },
    {
      id: made.buyerQuote,
      threadId: quoteThread,
      userId: portal.userIds.p1Buyer,
      partyId: id('party:P1'),
      key: `read:${quoteThread}:${portal.userIds.p1Buyer}`,
      lastReadMessageId: id('threads:message:quote-out'),
      ...stamp,
    },
    { id: made.ownerCompany, threadId: companyThread, userId: ownerId, key: `read:${companyThread}:${ownerId}`, lastReadMessageId: id('threads:message:company-note'), ...stamp },
  ]
  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) => client.threadRead.createMany({ data: rows, skipDuplicates: true }))
  return made
}
