import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The record threads' synthetic seed, per tenant of seed/_core.ts: the thread of company A (one internal note, with the
 * files seed's office-only file of that company attached) and the thread of a made-up quote of company A for party P1
 * (the audit seed's party): an internal note, a message sent to the party and its reply, both shared with it. `Quote`
 * stands in for the sales module's quotes (no Quote table yet), so that thread exists only as rows: the API opens
 * threads only on the record types it knows. Written in the tenant's office scope. Made up and harmless; a second run
 * adds nothing (INSERT … ON CONFLICT DO NOTHING; messages are append-only).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T09:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

/** A reply token like the API's (26 lower-case base32 characters), derived from the namespace instead of random. */
function replyToken(namespace: string, key: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = createHash('sha256').update(`seed reply token ${namespace} ${key}`).digest()
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let token = ''
  for (let index = 0; index < 26; index++) token += alphabet[parseInt(bits.slice(index * 5, index * 5 + 5), 2)]
  return token
}

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const partyId = id('party:P1')
  const companyThread = id('threads:company:A')
  const quoteThread = id('threads:quote:Q1')

  const threads: Prisma.ThreadCreateManyInput[] = [
    {
      id: companyThread,
      companyId: companyA,
      recordType: 'Company',
      recordId: companyA,
      replyToken: replyToken(namespace, 'company:A'),
      lastMessageAt: minutes(0),
      createdAt: minutes(0),
      updatedAt: minutes(0),
      createdById: actorId,
    },
    {
      id: quoteThread,
      companyId: companyA,
      partyId,
      recordType: 'Quote',
      recordId: id('quote:Q1'),
      replyToken: replyToken(namespace, 'quote:Q1'),
      lastMessageAt: minutes(30),
      createdAt: minutes(10),
      updatedAt: minutes(30),
      createdById: actorId,
    },
  ]
  const staff = { authorKind: 'USER', authorId: actorId, authorName: 'Seed Office User' } as const
  const messages: Prisma.MessageCreateManyInput[] = [
    {
      id: id('threads:message:company-note'),
      threadId: companyThread,
      direction: 'INTERNAL_NOTE',
      audience: 'OFFICE',
      channel: 'APP',
      ...staff,
      bodyText: 'Seed note: the cost sheet for the new season is attached.',
      attachmentFileIds: [id('files:office')],
      at: minutes(0),
      createdAt: minutes(0),
    },
    {
      id: id('threads:message:quote-note'),
      threadId: quoteThread,
      direction: 'INTERNAL_NOTE',
      audience: 'OFFICE',
      channel: 'APP',
      ...staff,
      bodyText: 'Seed note: check the leather availability before sending.',
      at: minutes(10),
      createdAt: minutes(10),
    },
    {
      id: id('threads:message:quote-out'),
      threadId: quoteThread,
      partyId,
      direction: 'OUTBOUND',
      audience: 'PARTNER',
      channel: 'EMAIL',
      ...staff,
      bodyText: 'Seed message: here is the quote for the sample jackets.',
      emailMessageId: `<seed-${namespace}-quote-out@example.com>`,
      at: minutes(20),
      createdAt: minutes(20),
    },
    {
      id: id('threads:message:quote-in'),
      threadId: quoteThread,
      partyId,
      direction: 'INBOUND',
      audience: 'PARTNER',
      channel: 'EMAIL',
      authorKind: 'PARTY',
      authorName: 'Seed Buyer',
      bodyText: 'Seed reply: thank you, we will confirm next week.',
      emailMessageId: `<seed-${namespace}-quote-in@example.com>`,
      at: minutes(30),
      createdAt: minutes(30),
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.thread.createMany({ data: threads, skipDuplicates: true })
      await tx.message.createMany({ data: messages, skipDuplicates: true })
    }),
  )
}
