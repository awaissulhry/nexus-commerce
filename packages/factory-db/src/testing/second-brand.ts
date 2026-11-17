import { createHash } from 'node:crypto'
import { seedFile } from '../seed-files'
import { seedUuid, type SeedContext } from '../seeding'

/**
 * B-TH-001 (threads plan TH-0, WALL-G17; the brand wall, Owner rule 2026-11-16: "one brand must not be able to see anything
 * related to any other brand"): a SECOND brand in the same factory. The base seeds give each tenant one customer with
 * partner rows (P1), so the generated isolation test found "rows of another party" only in tenant B; that brand B of the
 * SAME tenant stays out was proven by the shared policy text, never by data. This fixture writes, in tenant A, a second
 * customer and brand party with its own partner rows of the five kinds a portal reads most:
 *
 *   Party         `SEED-C2B` "Seed Brand Two S.r.l." (made up), tenant-wide, customer and brand
 *   User          its portal buyer (PARTNER, ACTIVE), the person its notification is for
 *   SalesOrder    `SEED-SO-B001`, typed by the office (no quote), CONFIRMED
 *   Thread        the order's thread, shared with the party
 *   Message       the office's message to the party and the party's answer (PARTNER audience)
 *   StoredFile    a file of the order shared with the party's portal (its seeded bytes: seed-files.ts)
 *   Notification  the portal buyer's notice of the order
 *   ThreadRead    the portal buyer's read mark on the order's thread, at the office's message (B-TH-023)
 *
 * Written in tenant A's office scope, as the app does; ids start with `ffffffff` so no generated test takes one of them as
 * "the first row" it copies. Every name, address and number is invented (`example.com`). Idempotent: a second run adds
 * nothing (INSERT … ON CONFLICT DO NOTHING). Needs the core, parties and files seeds of the same namespace first.
 */

/** Fixed instants, so the fixture never depends on the clock. */
const AT = new Date('2026-10-29T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

/** A reply token like the API's (26 lower-case base32 characters), derived from the namespace instead of random. */
function replyToken(namespace: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = createHash('sha256').update(`second brand reply token ${namespace}`).digest()
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let token = ''
  for (let index = 0; index < 26; index++) token += alphabet[parseInt(bits.slice(index * 5, index * 5 + 5), 2)]
  return token
}

export interface SecondBrand {
  readonly tenantId: string
  readonly partyId: string
  readonly userId: string
  readonly salesOrderId: string
  readonly threadId: string
  readonly messageIds: readonly string[]
  readonly fileId: string
  readonly notificationId: string
  readonly threadReadId: string
}

/** The tables the fixture writes a partner row of, each with its party column (the partner policy key). */
export const SECOND_BRAND_TABLES = ['Thread', 'Message', 'SalesOrder', 'StoredFile', 'Notification', 'ThreadRead'] as const

export async function seedSecondBrand({ db, namespace }: SeedContext): Promise<SecondBrand> {
  const id = (key: string): string => `ffffffff${seedUuid(namespace, `second-brand:${key}`).slice(8)}`
  const base = (key: string): string => seedUuid(namespace, key)
  const tenantId = base('tenant')
  const actorId = base('actor')
  const companyA = base('company:A')
  const store = base('files:account:r2')
  const made: SecondBrand = {
    tenantId,
    partyId: id('party'),
    userId: id('user:buyer'),
    salesOrderId: id('sales-order'),
    threadId: id('thread:sales-order'),
    messageIds: [id('message:out'), id('message:in')],
    fileId: id('file:partner'),
    notificationId: id('notification:order'),
    threadReadId: id('thread-read:buyer'),
  }
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }
  const address = { name: 'Seed Brand Two S.r.l.', street: 'Via Seconda 2', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.party.createMany({
        data: [
          {
            id: made.partyId,
            companyId: null,
            code: 'SEED-C2B',
            kind: 'ORGANISATION',
            legalName: 'Seed Brand Two S.r.l.',
            tradeName: 'Seed Brand Two',
            roles: ['CUSTOMER', 'BRAND'],
            status: 'ACTIVE',
            country: 'IT',
            currency: 'EUR',
            language: 'it',
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
      await tx.user.createMany({
        data: [
          {
            id: made.userId,
            email: `buyer.second-brand.${namespace}@example.com`,
            displayName: 'Seed Second Brand Buyer',
            status: 'ACTIVE',
            audience: 'PARTNER',
            partyId: made.partyId,
            partnerKind: 'CUSTOMER',
            locale: 'it',
            createdAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.salesOrder.createMany({
        data: [
          {
            id: made.salesOrderId,
            companyId: companyA,
            partyId: made.partyId,
            number: 'SEED-SO-B001',
            customerRef: 'SEED-B-PO-1',
            status: 'CONFIRMED',
            orderDate: new Date('2026-10-29T00:00:00.000Z'),
            currency: 'EUR',
            language: 'it',
            taxMode: 'IT_B2B',
            billTo: address,
            shipTo: address,
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
      await tx.thread.createMany({
        data: [
          {
            id: made.threadId,
            companyId: companyA,
            partyId: made.partyId,
            recordType: 'SalesOrder',
            recordId: made.salesOrderId,
            replyToken: replyToken(namespace),
            lastMessageAt: minutes(20),
            createdAt: minutes(0),
            updatedAt: minutes(20),
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.message.createMany({
        data: [
          {
            id: made.messageIds[0]!,
            threadId: made.threadId,
            partyId: made.partyId,
            direction: 'OUTBOUND',
            audience: 'PARTNER',
            channel: 'APP',
            authorKind: 'USER',
            authorId: actorId,
            authorName: 'Seed Office User',
            bodyText: 'Second brand: your order SEED-SO-B001 is confirmed.',
            at: minutes(10),
            createdAt: minutes(10),
          },
          {
            id: made.messageIds[1]!,
            threadId: made.threadId,
            partyId: made.partyId,
            direction: 'INBOUND',
            audience: 'PARTNER',
            channel: 'APP',
            authorKind: 'PARTY',
            authorName: 'Seed Second Brand Buyer',
            bodyText: 'Second brand: thank you, the label artwork follows.',
            at: minutes(20),
            createdAt: minutes(20),
          },
        ],
        skipDuplicates: true,
      })
      await tx.storedFile.createMany({
        data: [
          seedFile(tenantId, {
            id: made.fileId,
            companyId: companyA,
            recordType: 'SalesOrder',
            recordId: made.salesOrderId,
            kind: 'DOCUMENT',
            originalName: 'Seed second brand label artwork.pdf',
            contentType: 'application/pdf',
            sizeBytes: 2048,
            storageKey: `t/${tenantId}/c/${companyA}/2026/${id('file:key')}`,
            visibility: ['OFFICE', 'PARTNER'],
            partyId: made.partyId,
            status: 'AVAILABLE',
            availableAt: AT,
            storeAccountId: store,
            ...stamp,
          }),
        ],
        skipDuplicates: true,
      })
      await tx.notification.createMany({
        data: [
          {
            id: made.notificationId,
            userId: made.userId,
            partyId: made.partyId,
            companyId: companyA,
            category: 'FOLLOWING',
            eventType: 'sales_order.created',
            eventId: id('event:order-created'),
            recordType: 'SalesOrder',
            recordId: made.salesOrderId,
            recordLabel: 'SEED-SO-B001',
            messageKey: 'portal.notifications.orderConfirmed',
            params: {},
            actorId,
            createdAt: minutes(10),
            updatedAt: minutes(10),
          },
        ],
        skipDuplicates: true,
      })
      // B-TH-023: the buyer's read mark on the order's thread (their party's, at the message shared with it).
      await tx.threadRead.createMany({
        data: [
          {
            id: made.threadReadId,
            threadId: made.threadId,
            userId: made.userId,
            partyId: made.partyId,
            key: `read:${made.threadId}:${made.userId}`,
            lastReadMessageId: made.messageIds[0]!,
            readAt: minutes(15),
            createdAt: minutes(15),
            updatedAt: minutes(15),
          },
        ],
        skipDuplicates: true,
      })
    }),
  )
  return made
}
