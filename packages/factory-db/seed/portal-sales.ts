import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedLinks } from './links'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedPricing } from './pricing'
import { seed as seedPrivacy } from './privacy'
import { seedAt, seedToday } from '../src/seed-calendar' // B-W2b-F53: the seeds' future follows the calendar
import { seedFile } from '../src/seed-files' // B-W2b-F59: seeded files with their bytes

/**
 * The customer portal seed (W2b schema wave 21/22, B-W2b-157), per tenant of seed/_core.ts. The customer's own acts (a
 * draft, its lines and sizes, a change or cancel request, the rider's measurements through a link) are written in the
 * partner scope of party P1 (its buyer, or the MEASUREMENTS link), as the portal and the link pages will; the office's
 * acts (sending a draft with the number it allocated, decisions, answers, payment intents, files) in the tenant's office
 * scope, as the API's system context will. The CLI runs the seed files in name order and this one sorts before pricing,
 * privacy and the seeds that make SEED-SO-0002 and SEED-SO-0003, so it runs the pricing (which runs money, shipping, the
 * quality and production seeds and sales), privacy, portal identity, links and files seeds first (each idempotent).
 * Every name, number and amount is made up; files are rows only (no object in any store).
 *
 *   requests     P1's DRAFT (two styles picked from the catalogue, the prices it was shown), its SENT reorder of
 *                SEED-SO-0001's BLK line (SEED-RQ-0001, waiting for the office), an ACCEPTED request the office made
 *                SEED-SO-0002 from (SEED-RQ-0002) and a REFUSED one (SEED-RQ-0003: a size run below the minimum).
 *                OD t.4 (order start; addendum R1-R3: a draft is a mail and ONE products table, nothing required): P1's
 *                DRAFT "Race team kit for 2027", its buyer's (a subject, a message, three rows: a custom race suit made to
 *                measure for six riders, five by size and one later, its leather and protection class not decided yet;
 *                a SEED-JKT-02 BLK jacket by size; team gloves in words only), and a DRAFT the office's Sales person
 *                (seed/auth.ts "Seed Member", sales in seed/roles.ts) started for P1 ("Winter jackets reorder": one row in
 *                words, standard sizes, 20 pieces). The office names SEED-JKT-05 (P1's own label, tenant-wide: seed/options.ts) as
 *                the style draft it made for the race kit, when that seed ran first, as the CLI runs it (name order); a
 *                world seeded without it keeps the race kit's list empty.
 *   changes      P1 asks SEED-SO-0002 for one more BLK 52 and no BLK 54 (OPEN); asked SEED-SO-0003's cancel (REFUSED in
 *                words: the leather was cut); and the date move SEED-SO-0001's amendment 1 made (ACCEPTED, naming it).
 *   payments     company A's FAKE card payment account; P1's card payment of FT-2026-00001's open 410.00 (CREATED) and
 *                an earlier try that the bank declined (FAILED).
 *   measurements P1's team rider sends revision 2 of the JACKET profile through a MEASUREMENTS link: the public notice
 *                shown before the first field, three body photos; the link counts the use (evidence SUBMITTED).
 *   settings     the tenant-wide sales settings' cut-off rules: no cancel from IN_PRODUCTION on nor within 14 days of the
 *                promise date, no change from READY on (made up; the Owner sets them).
 *   status       B-OO-016: last, SEED-SO-0002 follows its facts as the system does: IN_PRODUCTION (SEED-WO-0001 released), then
 *                PARTLY_SHIPPED (SEED-SH-0001 left; dated at the write, never ahead of today), each move with its audit row.
 *                Seeded only up to shipping, it stays CONFIRMED.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy as the office and as P1: so the DRAFT, its first line and size, the OPEN change request and its first cell, the
 * CREATED payment intent and the link-sent profile get ids that start with eight zeros. Rows in tables other seeds also
 * fill (files, the link, its evidence, the account) get ids that start with eight f's. Idempotent: rows are inserted once
 * (skipped when they exist) and every move is made only from the state before it.
 */

/** Fixed instants, so the rows never depend on the clock (the live link aside). */
const T = {
  // SEED-SO-0001 was made at 08:00 and amended at 10:00 on 30 October (seed/pricing.ts).
  askedDate: new Date('2026-10-30T09:00:00.000Z'),
  answeredDate: new Date('2026-10-30T10:05:00.000Z'),
  drafted: new Date('2026-11-02T09:00:00.000Z'),
  sent: new Date('2026-11-03T09:00:00.000Z'),
  decided: new Date('2026-11-03T15:00:00.000Z'),
  asked: new Date('2026-11-04T09:00:00.000Z'),
  answered: new Date('2026-11-04T16:00:00.000Z'),
  paid: new Date('2026-11-04T10:00:00.000Z'),
  declined: new Date('2026-11-04T10:02:00.000Z'),
  // OD t.4 (order start): the race kit P1's buyer started and saved, the draft the office started and saved for P1.
  raceKit: new Date('2026-11-12T09:00:00.000Z'),
  raceKitSaved: new Date('2026-11-12T09:40:00.000Z'),
  officeDrafted: new Date('2026-11-13T10:00:00.000Z'),
  officeSaved: new Date('2026-11-13T10:20:00.000Z'),
  // After company A's public notice came into force (2026-11-14, seed/privacy.ts).
  linkMade: seedAt('2026-11-17T08:00:00.000Z'),
  noticeShown: seedAt('2026-11-18T09:40:00.000Z'),
  measured: seedAt('2026-11-18T09:45:00.000Z'),
  submitted: seedAt('2026-11-18T10:00:00.000Z'),
} as const
const DAY_MS = 86_400_000
/** B-OO-016: the system's actor, as apps/factory-api's worker writes its audit rows (core/context.ts SYSTEM_ACTOR_ID). */
const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000'

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  return new Date(`${seedToday()}T00:00:00.000Z`) // B-W2b-F53: the seeds' calendar
}

export interface PortalSalesSeed {
  readonly requests: { readonly draft: string; readonly sent: string; readonly accepted: string; readonly refused: string }
  readonly draftLines: readonly [string, string]
  readonly changes: { readonly open: string; readonly refusedCancel: string; readonly acceptedDate: string }
  readonly intents: { readonly created: string; readonly failed: string }
  readonly paymentAccountId: string
  readonly measurementLinkId: string
  readonly profileId: string
  readonly photoIds: readonly [string, string, string]
  readonly partyId: string
  readonly companyId: string
  readonly tenantId: string
  readonly buyerId: string
  readonly orders: { readonly so1: string; readonly so2: string; readonly so3: string }
  readonly amendmentId: string
  readonly invoiceId: string
  readonly depositRequestId: string
  readonly publicNoticeId: string
  /**
   * OD t.4 (order start): P1's DRAFT "Race team kit for 2027" and its three rows (1 the custom race suit with its six riders,
   * 2 the catalogue jacket, 3 the team gloves), the DRAFT the office started for P1 and its row, the office person who started
   * it, and the style draft the office named on the race kit (SEED-JKT-05; null when seed/options.ts did not run first).
   */
  readonly orderStart: {
    readonly raceKit: string
    readonly raceKitLines: readonly [string, string, string]
    readonly riderIds: readonly string[]
    readonly officeDraft: string
    readonly officeDraftLine: string
    readonly officeStartedById: string
    readonly styleDraftId: string | null
  }
}

export async function seed(context: SeedContext): Promise<PortalSalesSeed> {
  const { db, namespace } = context
  const pricing = await seedPricing(context)
  const privacy = await seedPrivacy(context)
  const portalAuth = await seedPortalAuth(context)
  await seedLinks(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const hex = (text: string): string => createHash('sha256').update(`seed portal-sales ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const buyerId = portalAuth.userIds.p1Buyer
  const store = id('files:account:r2')
  const today = romeToday()
  const office = { audience: 'office', tenantId, actorId } as const
  // The portal runs in its party's scope, as the person; a link session's actor is the link (platform/links).
  const asBuyer = { audience: 'partner', tenantId, actorId: buyerId, partyId: P1 } as const
  const asLink = (linkId: string) => ({ audience: 'partner', tenantId, actorId: linkId, partyId: P1 }) as const
  const select = { id: true } as const

  const requests = {
    draft: firstId('portal-sales:request:draft'),
    sent: id('portal-sales:request:sent'),
    accepted: id('portal-sales:request:accepted'),
    refused: id('portal-sales:request:refused'),
  }
  const draftLines = [firstId('portal-sales:request:draft:line:1'), id('portal-sales:request:draft:line:2')] as const
  const changes = { open: firstId('portal-sales:change:open'), refusedCancel: id('portal-sales:change:cancel'), acceptedDate: id('portal-sales:change:date') }
  const intents = { created: firstId('portal-sales:intent:created'), failed: id('portal-sales:intent:failed') }
  const paymentAccountId = lateId('portal-sales:account:payments-fake')
  const measurementLinkId = lateId('portal-sales:link:measurements')
  const profileId = firstId('portal-sales:measurement:P1:rider:JACKET:2')
  const photoIds = [lateId('portal-sales:photo:front'), lateId('portal-sales:photo:side'), lateId('portal-sales:photo:back')] as const

  // What the other seeds made, read by number and code (their keys are theirs).
  const known = await db.withScope(office, async (client) => {
    const order = (number: string) => client.salesOrder.findFirstOrThrow({ where: { companyId: companyA, number }, select: { id: true, lines: { select: { id: true, seq: true, styleId: true, colourwayId: true, sizes: { select: { size: true, quantity: true }, orderBy: { size: 'asc' } } }, orderBy: { seq: 'asc' } } } })
    const style = (code: string) => client.style.findFirstOrThrow({ where: { code }, select: { id: true, colourways: { select: { id: true, code: true }, orderBy: { code: 'asc' } } } })
    const shipTo = await client.partyAddress.findFirstOrThrow({ where: { partyId: P1, kinds: { has: 'SHIP_TO' }, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })
    // OD t.4: seed/options.ts's configurable jacket, when that seed ran first (the CLI runs it first, by name).
    const jkt05 = await client.style.findFirst({ where: { code: 'SEED-JKT-05' }, select: { id: true } })
    return { so1: await order('SEED-SO-0001'), so2: await order('SEED-SO-0002'), so3: await order('SEED-SO-0003'), jkt02: await style('SEED-JKT-02'), jkt03: await style('SEED-JKT-03'), jkt05, shipToId: shipTo.id }
  })
  const colourway = (style: { colourways: { id: string; code: string }[] }, code: string): string => style.colourways.find((entry) => entry.code === code)!.id
  const so1Blk = known.so1.lines[0]!
  const so2Blk = known.so2.lines[0]!

  // --- Order requests: P1 builds its drafts in the portal; the office sends them for it (the number) and decides ---------
  const draft = (requestId: string, data: Partial<Prisma.PortalOrderRequestCreateManyInput>): Prisma.PortalOrderRequestCreateManyInput => ({
    id: requestId,
    companyId: companyA,
    partyId: P1,
    currency: 'EUR',
    createdAt: T.drafted,
    updatedAt: T.drafted,
    createdById: buyerId,
    ...data,
  })
  // OD t.4: a row of the products table may name no style (made to measure, or in the customer's words).
  const line = (lineId: string, requestId: string, seq: number, styleId: string | null, colourwayId: string | null, price: string | null, more: Partial<Prisma.PortalOrderRequestLineCreateManyInput> = {}): Prisma.PortalOrderRequestLineCreateManyInput => ({
    id: lineId,
    partyId: P1,
    requestId,
    seq,
    styleId,
    colourwayId,
    unitPriceShown: price,
    createdAt: T.drafted,
    updatedAt: T.drafted,
    createdById: buyerId,
    ...more,
  })
  const size = (sizeId: string, lineId: string, code: string, quantity: number): Prisma.PortalOrderRequestSizeCreateManyInput => ({
    id: sizeId,
    partyId: P1,
    lineId,
    size: code,
    quantity,
    createdAt: T.drafted,
    updatedAt: T.drafted,
    createdById: buyerId,
  })
  const lineIds = {
    sent: id('portal-sales:request:sent:line:1'),
    accepted: id('portal-sales:request:accepted:line:1'),
    refused: id('portal-sales:request:refused:line:1'),
  }
  // OD t.4 (order start): the race kit P1's buyer starts like a mail, and the draft the office's Sales person starts for P1.
  const salesPersonId = id('user:member') // seed/auth.ts "Seed Member": sales over company A (seed/roles.ts)
  const orderStart = {
    raceKit: id('portal-sales:request:race-kit'),
    raceKitLines: [id('portal-sales:request:race-kit:line:1'), id('portal-sales:request:race-kit:line:2'), id('portal-sales:request:race-kit:line:3')] as const,
    officeDraft: id('portal-sales:request:office-draft'),
    officeDraftLine: id('portal-sales:request:office-draft:line:1'),
  }
  /** The race suit's riders (made-up names and numbers): five by a size of the jacket range, one sends later. */
  const riders: readonly { readonly name: string; readonly number: string; readonly size: string | null; readonly note?: string }[] = [
    { name: 'Bea Esempio', number: '3', size: '50' },
    { name: 'Carlo Prova', number: '14', size: '52' },
    { name: 'Dora Bozza', number: '22', size: '54' },
    { name: 'Enzo Modulo', number: '35', size: '52' },
    { name: 'Fina Fittizio', number: '41', size: '50' },
    { name: 'Gino Collaudo', number: '68', size: null, note: 'Seed: sends his measurements after the test day.' },
  ]
  const riderIds = riders.map((_, index) => id(`portal-sales:request:race-kit:line:1:person:${index + 1}`))
  const raceKitStamp = { createdAt: T.raceKit, updatedAt: T.raceKit } as const
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      await tx.portalOrderRequest.createMany({
        data: [
          draft(requests.draft, { source: 'PICKER', customerRef: 'PO-SEED-7004', note: 'Seed: the spring restock, as a first draft.' }),
          draft(requests.sent, { source: 'REORDER', customerRef: 'PO-SEED-7001', shipToAddressId: known.shipToId, requestedDate: seedAt('2026-12-18T00:00:00.000Z') }),
          draft(requests.accepted, { source: 'PICKER', customerRef: 'PO-SEED-7002', requestedDate: seedAt('2026-12-04T00:00:00.000Z') }),
          draft(requests.refused, { source: 'UPLOAD', customerRef: 'PO-SEED-7003' }),
          // OD t.4: started like a mail, a subject and a message; nothing else is needed to keep it or send it.
          draft(orderStart.raceKit, {
            source: 'PICKER',
            subject: 'Race team kit for 2027',
            note: 'Seed: the kit for our six riders next season; we have not chosen the leather yet.',
            laterParts: [],
            createdAt: T.raceKit,
            updatedAt: T.raceKitSaved,
            lastEditedById: buyerId,
            lastEditedAt: T.raceKitSaved,
          }),
        ],
        skipDuplicates: true,
      })
      await tx.portalOrderRequestLine.createMany({
        data: [
          line(draftLines[0], requests.draft, 1, known.jkt02.id, colourway(known.jkt02, 'BLK'), '410.000000'),
          line(draftLines[1], requests.draft, 2, known.jkt03.id, colourway(known.jkt03, 'BLK'), '395.000000', { note: 'Our code R-300' }),
          line(lineIds.sent, requests.sent, 1, so1Blk.styleId, so1Blk.colourwayId, '420.000000', { sourceOrderLineId: so1Blk.id }),
          line(lineIds.accepted, requests.accepted, 1, so2Blk.styleId, so2Blk.colourwayId, '410.000000'),
          line(lineIds.refused, requests.refused, 1, known.jkt02.id, colourway(known.jkt02, 'RED'), '410.000000'),
          // OD t.4: the race kit's products table, one row of each sizing (addendum R3; every cell optional): a custom race
          // suit made to measure (by person, no garment type yet, two choices not decided yet), a catalogue jacket by size,
          // team gloves in the customer's words only (sizing not decided yet, no pieces yet).
          line(orderStart.raceKitLines[0], orderStart.raceKit, 1, null, null, null, {
            kind: 'MADE_TO_MEASURE',
            sizing: 'MADE_TO_MEASURE',
            byPerson: true,
            description: 'Custom race suit',
            choices: [
              { topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null },
              { topic: 'Protection class', options: ['AA', 'AAA'], picked: null },
            ],
            ...raceKitStamp,
          }),
          line(orderStart.raceKitLines[1], orderStart.raceKit, 2, known.jkt02.id, colourway(known.jkt02, 'BLK'), '410.000000', { kind: 'CATALOGUE', sizing: 'STANDARD', ...raceKitStamp }),
          line(orderStart.raceKitLines[2], orderStart.raceKit, 3, null, null, null, { kind: 'DESCRIBED', description: 'Team gloves', ...raceKitStamp }),
        ],
        skipDuplicates: true,
      })
      await tx.portalOrderRequestSize.createMany({
        data: [
          size(firstId('portal-sales:request:draft:line:1:50'), draftLines[0], '50', 2),
          size(id('portal-sales:request:draft:line:1:52'), draftLines[0], '52', 3),
          size(id('portal-sales:request:draft:line:2:52'), draftLines[1], '52', 4),
          ...so1Blk.sizes.map((entry) => size(id(`portal-sales:request:sent:line:1:${entry.size}`), lineIds.sent, entry.size, entry.quantity)),
          ...so2Blk.sizes.map((entry) => size(id(`portal-sales:request:accepted:line:1:${entry.size}`), lineIds.accepted, entry.size, entry.quantity)),
          size(id('portal-sales:request:refused:line:1:54'), lineIds.refused, '54', 1),
          // OD t.4: the race kit's catalogue jacket, a small size run.
          { ...size(id('portal-sales:request:race-kit:line:2:50'), orderStart.raceKitLines[1], '50', 1), ...raceKitStamp },
          { ...size(id('portal-sales:request:race-kit:line:2:52'), orderStart.raceKitLines[1], '52', 2), ...raceKitStamp },
          { ...size(id('portal-sales:request:race-kit:line:2:54'), orderStart.raceKitLines[1], '54', 1), ...raceKitStamp },
        ],
        skipDuplicates: true,
      })
      // OD t.4: the race suit's riders (its pieces are its people).
      await tx.portalOrderRequestPerson.createMany({
        data: riders.map((rider, index): Prisma.PortalOrderRequestPersonCreateManyInput => ({
          id: riderIds[index]!,
          partyId: P1,
          requestId: orderStart.raceKit,
          lineId: orderStart.raceKitLines[0],
          seq: index + 1,
          name: rider.name,
          number: rider.number,
          measureBy: rider.size === null ? 'LATER' : 'SIZE',
          size: rider.size,
          note: rider.note ?? null,
          createdById: buyerId,
          ...raceKitStamp,
        })),
        skipDuplicates: true,
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // The office sends each draft with the number it allocated for the portal (seed numbers, no allocation).
      const sent = [
        [requests.sent, 'SEED-RQ-0001'],
        [requests.accepted, 'SEED-RQ-0002'],
        [requests.refused, 'SEED-RQ-0003'],
      ] as const
      for (const [requestId, number] of sent) {
        await tx.portalOrderRequest.updateMany({ where: { id: requestId, status: 'DRAFT' }, data: { status: 'SENT', number, sentAt: T.sent, sentById: buyerId, version: 2, updatedAt: T.sent } })
      }
      await tx.portalOrderRequest.updateMany({
        where: { id: requests.accepted, status: 'SENT' },
        data: { status: 'ACCEPTED', salesOrderId: known.so2.id, decidedAt: T.decided, decidedById: actorId, version: 3, updatedAt: T.decided },
      })
      await tx.portalOrderRequest.updateMany({
        where: { id: requests.refused, status: 'SENT' },
        data: { status: 'REFUSED', refuseReason: 'Seed: the RED colourway is made from 10 pieces per size; we can offer it with the next batch.', decidedAt: T.decided, decidedById: actorId, version: 3, updatedAt: T.decided },
      })
    }),
  )

  // --- OD t.4: a draft the office starts for P1 (Owner's yes 1a: one draft, both doors), and the race kit's style draft -----
  // The seed's Sales person starts and saves it in the office scope: a subject and one row in words, standard sizes, 20 pieces.
  const asSales = { audience: 'office', tenantId, actorId: salesPersonId } as const
  await db.withScope(asSales, (client) =>
    client.$transaction(async (tx) => {
      await tx.portalOrderRequest.createMany({
        data: [draft(orderStart.officeDraft, { subject: 'Winter jackets reorder', createdAt: T.officeDrafted, updatedAt: T.officeSaved, createdById: salesPersonId, lastEditedById: salesPersonId, lastEditedAt: T.officeSaved })],
        skipDuplicates: true,
      })
      await tx.portalOrderRequestLine.createMany({
        data: [
          line(orderStart.officeDraftLine, orderStart.officeDraft, 1, null, null, null, {
            kind: 'DESCRIBED',
            sizing: 'STANDARD',
            description: 'Winter jackets, black, as last season',
            quantity: 20,
            createdAt: T.officeDrafted,
            updatedAt: T.officeDrafted,
            createdById: salesPersonId,
          }),
        ],
        skipDuplicates: true,
      })
    }),
  )
  // The style draft the office made for the race kit (Make style draft), named in the office scope only (the partner role has
  // no grant on styleIds): after the insert (a new request names none), while it is a DRAFT, once. Dated at the write, as the
  // follow at the end of this seed (never ahead of today).
  const styleDraftId = known.jkt05?.id ?? null
  if (styleDraftId) {
    await db.withScope(office, (client) =>
      client.portalOrderRequest.updateMany({
        where: { id: orderStart.raceKit, status: 'DRAFT', styleIds: { isEmpty: true } },
        data: { styleIds: [styleDraftId], version: { increment: 1 }, updatedAt: new Date() },
      }),
    )
  }

  // --- Change and cancel requests: P1 asks in the portal, the office answers ---------------------------------------------
  const so2Size = (code: string) => so2Blk.sizes.find((entry) => entry.size === code)!
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      const ask = { companyId: companyA, partyId: P1, createdById: buyerId }
      await tx.orderChangeRequest.createMany({
        data: [
          { id: changes.open, ...ask, orderId: known.so2.id, kind: 'CHANGE', reason: 'Seed: one more black 52 instead of the 54.', createdAt: T.asked, updatedAt: T.asked },
          { id: changes.refusedCancel, ...ask, orderId: known.so3.id, kind: 'CANCEL', reasonCode: 'LEAD_TIME', reason: 'Seed: the season starts earlier for us.', createdAt: T.asked, updatedAt: T.asked },
          { id: changes.acceptedDate, ...ask, orderId: known.so1.id, kind: 'CHANGE', requestedDate: seedAt('2026-12-15T00:00:00.000Z'), reason: 'Seed: please deliver from 15 December.', createdAt: T.askedDate, updatedAt: T.askedDate },
        ],
        skipDuplicates: true,
      })
      const open = await tx.orderChangeRequest.findUnique({ where: { id: changes.open }, select: { status: true } })
      if (open?.status === 'OPEN') {
        await tx.orderChangeRequestLine.createMany({
          data: [
            { id: firstId('portal-sales:change:open:52'), partyId: P1, requestId: changes.open, orderLineId: so2Blk.id, size: '52', quantityBefore: so2Size('52').quantity, quantity: so2Size('52').quantity + 1, createdAt: T.asked, createdById: buyerId },
            { id: id('portal-sales:change:open:54'), partyId: P1, requestId: changes.open, orderLineId: so2Blk.id, size: '54', quantityBefore: so2Size('54').quantity, quantity: 0, createdAt: T.asked, createdById: buyerId },
          ],
          skipDuplicates: true,
        })
      }
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.orderChangeRequest.updateMany({
        where: { id: changes.refusedCancel, status: 'OPEN' },
        data: { status: 'REFUSED', answer: 'Seed: the leather for this order was cut on 3 November; we cannot cancel it any more.', answeredAt: T.answered, answeredById: actorId, version: 2, updatedAt: T.answered },
      })
      await tx.orderChangeRequest.updateMany({
        where: { id: changes.acceptedDate, status: 'OPEN' },
        data: { status: 'ACCEPTED', answer: 'Seed: done, see revision 1 of the order.', answeredAt: T.answeredDate, answeredById: actorId, amendmentId: pricing.amendmentId, version: 2, updatedAt: T.answeredDate },
      })
    }),
  )

  // --- Payment intents: the FAKE provider account; a card payment of FT-2026-00001's open part, a declined try ----------
  const invoice = await db.withScope(office, (client) =>
    client.invoice.findUniqueOrThrow({ where: { id: pricing.money.sampleInvoiceId }, select: { grossTotal: true, allocations: { select: { amount: true } } } }),
  )
  const open = invoice.grossTotal - invoice.allocations.reduce((sum, row) => sum + row.amount, 0)
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.integrationAccount.createMany({
        data: [{ id: paymentAccountId, companyId: companyA, provider: 'PAYMENT_FAKE', code: 'payments-fake-a', label: 'Card payments company A (fake)', mode: 'FAKE', createdById: actorId }],
        skipDuplicates: true,
      })
      const intent = { companyId: companyA, partyId: P1, invoiceId: pricing.money.sampleInvoiceId, method: 'CARD', amount: open, currency: 'EUR', providerAccountId: paymentAccountId, createdById: buyerId } as const
      await tx.paymentIntent.createMany({
        data: [
          { id: intents.failed, ...intent, createdAt: T.paid, updatedAt: T.paid },
          { id: intents.created, ...intent, createdAt: T.declined, updatedAt: T.declined },
        ],
        skipDuplicates: true,
      })
      await tx.paymentIntent.updateMany({
        where: { id: intents.failed, status: 'CREATED' },
        data: { status: 'FAILED', providerRef: 'pi_fake_seed_declined_try', failureCode: 'card_declined', finishedAt: T.declined, version: 2, updatedAt: T.declined },
      })
    }),
  )

  // --- Measurements by link: the office's MEASUREMENTS link and the photos the rider uploaded through it ----------------
  const linkExpires = new Date(Math.max(today.getTime() + 21 * DAY_MS, T.submitted.getTime() + 7 * DAY_MS))
  const photo = (fileId: string, view: string): Prisma.StoredFileCreateManyInput => seedFile(tenantId, {
    id: fileId,
    companyId: companyA,
    recordType: 'MeasurementProfile',
    recordId: profileId,
    kind: 'PHOTO',
    category: 'BODY_PHOTO',
    originalName: `Seed team rider ${view}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 4096,
    storeAccountId: store,
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`portal-sales:key:${view}`)}`,
    status: 'AVAILABLE',
    availableAt: T.measured,
    visibility: ['OFFICE', 'LINK'],
    partyId: P1,
    createdAt: T.measured,
    updatedAt: T.measured,
    createdById: actorId,
  })
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.oneOffLink.createMany({
        data: [
          {
            id: measurementLinkId,
            companyId: companyA,
            partyId: P1,
            purpose: 'MEASUREMENTS',
            recordType: 'MeasurementProfile',
            recordId: id('measurement:P1:rider:JACKET:1'),
            tokenHash: createHash('sha256').update(`seed link ${measurementLinkId}: no token opens it`).digest('hex'),
            email: null,
            contactId: id('party-contact:P1:rider'),
            maxUses: 3,
            expiresAt: linkExpires,
            createdAt: T.linkMade,
            updatedAt: T.linkMade,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.storedFile.createMany({ data: [photo(photoIds[0], 'front'), photo(photoIds[1], 'side'), photo(photoIds[2], 'back')], skipDuplicates: true })
    }),
  )
  const submitted = await db.withScope(office, (client) => client.measurementProfile.findUnique({ where: { id: profileId }, select }))
  if (!submitted) {
    await db.withScope(asLink(measurementLinkId), (client) =>
      client.$transaction(async (tx) => {
        await tx.measurementProfile.createMany({
          data: [
            {
              id: profileId,
              partyId: P1,
              contactId: id('party-contact:P1:rider'),
              riderName: 'Seed Team Rider',
              garmentType: 'JACKET',
              revision: 2,
              supersedesId: id('measurement:P1:rider:JACKET:1'),
              measurements: { chest: { value: '101.0', unit: 'cm' }, waist: { value: '85.0', unit: 'cm' }, sleeve: { value: '65.0', unit: 'cm' } },
              baseSize: '50',
              fitNotes: 'Racing position; the left arm a little longer (seed).',
              takenAt: T.measured,
              takenBy: 'Seed Team Rider, with a helper',
              privacyNoticeRef: '2026-10',
              privacyNoticeAt: T.noticeShown,
              submittedViaLinkId: measurementLinkId,
              submittedAt: T.submitted,
              noticeVersionId: privacy.publicNoticeId,
              photoFrontFileId: photoIds[0],
              photoSideFileId: photoIds[1],
              photoBackFileId: photoIds[2],
              createdAt: T.submitted,
            },
          ],
          skipDuplicates: true,
        })
        await tx.oneOffLink.updateMany({ where: { id: measurementLinkId, uses: 0 }, data: { uses: 1, lastUsedAt: T.submitted } })
        await tx.linkEvidence.createMany({
          data: [
            {
              id: lateId('portal-sales:evidence:submitted'),
              partyId: P1,
              linkId: measurementLinkId,
              action: 'SUBMITTED',
              useNumber: 1,
              typedName: null,
              emailCheck: 'NOT_ASKED',
              ipHash: hex('client address'),
              userAgent: 'Seed browser',
              at: T.submitted,
              requestId: 'seed-portal-sales-measurements-submitted',
            },
          ],
          skipDuplicates: true,
        })
      }),
    )
  }

  // --- The cut-off rules of the tenant-wide sales settings (made up; the Owner sets them) --------------------------------
  await db.withScope(office, (client) =>
    client.salesSettings.updateMany({
      where: { id: tenantId, cancelCutoffStatus: null, cancelCutoffDays: null, changeCutoffStatus: null },
      data: { cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 14, changeCutoffStatus: 'READY', version: { increment: 1 } },
    }),
  )

  // B-OO-016 (order overview lane, Owner D9 + his pick A): SEED-SO-0002 carries the status its facts give, PARTLY_SHIPPED.
  // SEED-WO-0001 of its lines was released (seed/production.ts) and SEED-SH-0001 left with its BLK 50 and RED 52
  // (seed/shipping.ts), the rest still to make. The two moves are written as the system's follow writes them (apps/factory-api
  // sales/orders/moves.ts followOrder): one at a time, from the state before it, each with its audit row (orders.follow, by the
  // system, "Followed: …"). The IN_PRODUCTION row is dated at SEED-WO-0001's release (history); the PARTLY_SHIPPED row and the
  // order's updatedAt at the write's time, as the follow's are the time it followed: SH-0001 leaves in the seeds' future, and no
  // status change is dated ahead of today. Written HERE, last: P1's open CHANGE request above is asked only before anything left
  // (the change-request trigger), so a world seeded only up to shipping keeps CONFIRMED.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: known.so2.id }, select: { status: true, companyId: true } })
      if (order.status !== 'CONFIRMED') return
      const released = await tx.workOrder.findFirst({ where: { companyId: companyA, number: 'SEED-WO-0001', releasedAt: { not: null } }, select: { number: true, releasedAt: true } })
      const left = await tx.shipment.findFirst({ where: { companyId: companyA, number: 'SEED-SH-0001', salesOrderId: known.so2.id, shippedAt: { not: null } }, select: { number: true, shippedAt: true } })
      if (!released?.releasedAt || !left?.shippedAt) return
      const writtenAt = new Date()
      const moves = [
        { to: 'IN_PRODUCTION', from: 'CONFIRMED', at: released.releasedAt, why: `work order ${released.number} released` },
        { to: 'PARTLY_SHIPPED', from: 'IN_PRODUCTION', at: writtenAt, why: `shipment ${left.number} shipped` },
      ] as const
      for (const move of moves) {
        await tx.salesOrder.update({ where: { id: known.so2.id }, data: { status: move.to, version: { increment: 1 }, updatedAt: writtenAt }, select })
        await tx.auditLog.createMany({
          data: [
            {
              id: lateId(`portal-sales:SO-0002:follow:${move.to}`),
              companyId: order.companyId,
              at: move.at,
              audience: 'SYSTEM',
              actorId: SYSTEM_ACTOR_ID,
              action: 'orders.follow',
              recordType: 'SalesOrder',
              recordId: known.so2.id,
              before: { status: move.from },
              after: { status: move.to },
              reason: `Followed: ${move.why}.`,
              requestId: `seed-portal-sales-${namespace}-so2-follow-${move.to}`,
            },
          ],
          skipDuplicates: true,
        })
      }
    }),
  )

  return {
    requests,
    draftLines,
    changes,
    intents,
    paymentAccountId,
    measurementLinkId,
    profileId,
    photoIds,
    partyId: P1,
    companyId: companyA,
    tenantId,
    buyerId,
    orders: { so1: known.so1.id, so2: known.so2.id, so3: known.so3.id },
    amendmentId: pricing.amendmentId,
    invoiceId: pricing.money.sampleInvoiceId,
    depositRequestId: pricing.money.sales.depositRequestId,
    publicNoticeId: privacy.publicNoticeId,
    orderStart: { ...orderStart, riderIds, officeStartedById: salesPersonId, styleDraftId },
  }
}
