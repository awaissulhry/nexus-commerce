import type { Prisma } from '../src/generated/prisma/client'
import { MessageAudience } from '../src/generated/prisma/enums'
import { seedDay } from '../src/seed-calendar' // B-W2b-F53: the seeds' future follows the calendar
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedThreads } from './threads'

/**
 * The later depth of threads' synthetic seed (TH-9, threads plan schema wave 9/9, B-TH-090), per tenant of seed/_core.ts, on
 * the threads seed's quote thread (P1's quote SEED-QT-0001):
 *
 *   pins    the owner pinned the message sent to P1 (shared: P1 reads the pin) and the office's internal note (the office's
 *           alone: its pin names no party);
 *   drafts  the owner's unsent office note on the quote; P1's portal buyer's unsent reply in P1's account conversation (the
 *           Party thread) and their unsent New order (no record yet: a subject and a wanted date in its fields).
 *
 * The first pin and the owner's draft start with eight zeros, the plain rows the generated isolation tests copy (an office
 * person's pin of a message that is not held; an office person's draft); the others with eight f's. The CLI runs the seeds in
 * name order and this file sorts before threads.ts, so it runs the threads and portal sign-in seeds it builds on first (both
 * idempotent), as the read marks' seed does. Written in the tenant's office scope (the drafts too: the office writes rows of
 * any person of the tenant, a portal session only its own party's); made up and harmless; a second run adds nothing
 * (INSERT … ON CONFLICT DO NOTHING).
 */

const AT = new Date('2026-10-28T10:15:00.000Z')

export interface ThreadsLaterSeed {
  readonly sharedPin: string
  readonly notePin: string
  readonly ownerDraft: string
  readonly buyerReply: string
  readonly buyerNewRequest: string
}

export async function seed(context: SeedContext): Promise<ThreadsLaterSeed> {
  const { db, namespace } = context
  await seedThreads(context)
  const portal = await seedPortalAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const zeros = (key: string): string => `00000000${id(key).slice(8)}`
  const effs = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const p1 = id('party:P1')
  const quoteId = id('quote:Q1')
  const quoteThread = id('threads:quote:Q1')
  const sentToP1 = id('threads:message:quote-out')
  const officeNote = id('threads:message:quote-note')
  const buyer = portal.userIds.p1Buyer
  const made: ThreadsLaterSeed = {
    sharedPin: zeros('threads-later:pin:quote-out'),
    notePin: effs('threads-later:pin:quote-note'),
    ownerDraft: zeros('threads-later:draft:owner:quote'),
    buyerReply: effs('threads-later:draft:buyer:party'),
    buyerNewRequest: effs('threads-later:draft:buyer:new-request'),
  }
  // The party is the message's, copied by the database (the app never writes it).
  const pins: Prisma.ThreadPinCreateManyInput[] = [
    { id: made.sharedPin, threadId: quoteThread, messageId: sentToP1, key: `pin:${quoteThread}:${sentToP1}`, pinnedById: ownerId, pinnedAt: AT, createdAt: AT },
    { id: made.notePin, threadId: quoteThread, messageId: officeNote, key: `pin:${quoteThread}:${officeNote}`, pinnedById: ownerId, pinnedAt: AT, createdAt: AT },
  ]
  const stamp = { createdAt: AT, updatedAt: AT }
  const drafts: Prisma.ComposerDraftCreateManyInput[] = [
    {
      id: made.ownerDraft,
      userId: ownerId,
      recordType: 'Quote',
      recordId: quoteId,
      key: `draft:Quote:${quoteId}:${ownerId}`,
      audience: MessageAudience.OFFICE,
      bodyText: 'Seed: check the lining price with the supplier before we answer.',
      ...stamp,
    },
    {
      id: made.buyerReply,
      userId: buyer,
      partyId: p1,
      recordType: 'Party',
      recordId: p1,
      key: `draft:Party:${p1}:${buyer}`,
      audience: MessageAudience.PARTNER,
      bodyText: 'Seed: could you send us the new size chart?',
      ...stamp,
    },
    {
      id: made.buyerNewRequest,
      userId: buyer,
      partyId: p1,
      key: `draft:new-request:${buyer}`,
      bodyText: 'Seed: forty spring jackets in black, sizes 48 to 56.',
      fields: { subject: 'Seed spring jackets', wantedDate: seedDay('2027-02-26') },
      ...stamp,
    },
  ]
  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, async (client) => {
    await client.threadPin.createMany({ data: pins, skipDuplicates: true })
    await client.composerDraft.createMany({ data: drafts, skipDuplicates: true })
  })
  return made
}
