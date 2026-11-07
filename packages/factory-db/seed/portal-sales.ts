import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedLinks } from './links'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedPricing } from './pricing'
import { seed as seedPrivacy } from './privacy'

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
 *   changes      P1 asks SEED-SO-0002 for one more BLK 52 and no BLK 54 (OPEN); asked SEED-SO-0003's cancel (REFUSED in
 *                words: the leather was cut); and the date move SEED-SO-0001's amendment 1 made (ACCEPTED, naming it).
 *   payments     company A's FAKE card payment account; P1's card payment of FT-2026-00001's open 410.00 (CREATED) and
 *                an earlier try that the bank declined (FAILED).
 *   measurements P1's team rider sends revision 2 of the JACKET profile through a MEASUREMENTS link: the public notice
 *                shown before the first field, three body photos; the link counts the use (evidence SUBMITTED).
 *   settings     the tenant-wide sales settings' cut-off rules: no cancel from IN_PRODUCTION on nor within 14 days of the
 *                promise date, no change from READY on (made up; the Owner sets them).
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
  // After company A's public notice came into force (2026-11-14, seed/privacy.ts).
  linkMade: new Date('2026-11-17T08:00:00.000Z'),
  noticeShown: new Date('2026-11-18T09:40:00.000Z'),
  measured: new Date('2026-11-18T09:45:00.000Z'),
  submitted: new Date('2026-11-18T10:00:00.000Z'),
} as const
const DAY_MS = 86_400_000

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
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
    return { so1: await order('SEED-SO-0001'), so2: await order('SEED-SO-0002'), so3: await order('SEED-SO-0003'), jkt02: await style('SEED-JKT-02'), jkt03: await style('SEED-JKT-03'), shipToId: shipTo.id }
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
  const line = (lineId: string, requestId: string, seq: number, styleId: string, colourwayId: string, price: string | null, more: Partial<Prisma.PortalOrderRequestLineCreateManyInput> = {}): Prisma.PortalOrderRequestLineCreateManyInput => ({
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
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      await tx.portalOrderRequest.createMany({
        data: [
          draft(requests.draft, { source: 'PICKER', customerRef: 'PO-SEED-7004', note: 'Seed: the spring restock, as a first draft.' }),
          draft(requests.sent, { source: 'REORDER', customerRef: 'PO-SEED-7001', shipToAddressId: known.shipToId, requestedDate: new Date('2026-12-18T00:00:00.000Z') }),
          draft(requests.accepted, { source: 'PICKER', customerRef: 'PO-SEED-7002', requestedDate: new Date('2026-12-04T00:00:00.000Z') }),
          draft(requests.refused, { source: 'UPLOAD', customerRef: 'PO-SEED-7003' }),
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
        ],
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

  // --- Change and cancel requests: P1 asks in the portal, the office answers ---------------------------------------------
  const so2Size = (code: string) => so2Blk.sizes.find((entry) => entry.size === code)!
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      const ask = { companyId: companyA, partyId: P1, createdById: buyerId }
      await tx.orderChangeRequest.createMany({
        data: [
          { id: changes.open, ...ask, orderId: known.so2.id, kind: 'CHANGE', reason: 'Seed: one more black 52 instead of the 54.', createdAt: T.asked, updatedAt: T.asked },
          { id: changes.refusedCancel, ...ask, orderId: known.so3.id, kind: 'CANCEL', reasonCode: 'LEAD_TIME', reason: 'Seed: the season starts earlier for us.', createdAt: T.asked, updatedAt: T.asked },
          { id: changes.acceptedDate, ...ask, orderId: known.so1.id, kind: 'CHANGE', requestedDate: new Date('2026-12-15T00:00:00.000Z'), reason: 'Seed: please deliver from 15 December.', createdAt: T.askedDate, updatedAt: T.askedDate },
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
  const photo = (fileId: string, view: string): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType: 'MeasurementProfile',
    recordId: profileId,
    kind: 'PHOTO',
    category: 'BODY_PHOTO',
    originalName: `Seed team rider ${view}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 4096,
    sha256: hex(`photo ${view}`),
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
  }
}
