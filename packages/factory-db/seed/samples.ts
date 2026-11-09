import type { Prisma } from '../src/generated/prisma/client'
import {
  ApprovalKind,
  GateKind,
  SampleDecision,
  SampleDecisionVia,
  SampleKind,
  SampleShipmentDirection,
  SampleStage,
  SampleTestResult,
  SwatchKind,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedCompliance } from './compliance'
import { seed as seedProduction } from './production'

/**
 * The samples seed (W2b-4, schema wave 29/33, B-W2b-212), per tenant of seed/_core.ts, written in the tenant's office scope as
 * the app does. The CLI runs the seed files in name order; this one runs the production seed (→ inventory, product, parties,
 * sales), the compliance seed (the certificate) and the auth seed (the office users) first, all idempotent. Every name, number
 * and value is made up.
 *
 *   rounds       SEED-SR-0001: a FIT round of SEED-JKT-01 (its draft revision) for the brand P1, REQUESTED, black 52 ×1;
 *                SEED-SR-0002: an internal PROTO round of SEED-JKT-01, decided by an office user (approved with comments,
 *                black and red 52); SEED-SR-0003: a PRE_PRODUCTION round of SEED-JKT-02 (released revision 1) for P1, UNDER
 *                REVIEW, charged 150.00 EUR, with an OPEN approval request (kind SAMPLE) the brand answers by link or
 *                portal; SEED-SR-0004: an internal CERTIFICATION round of SEED-JKT-02, SENT, passed, with SEED-CERT-0001.
 *   fit          on SEED-SR-0001: chest width not measured yet, sleeve length out of tolerance, back length within it; a
 *                comment on the sleeve (open) and one on the left shoulder (resolved).
 *   swatches     for P1 on SEED-JKT-01: a red leather colour swatch not sent yet; the black leather lot SEED-LOT-LEA-01 sent
 *                and approved by an office user.
 *   shipments    SEED-SR-0001 to P1's workshop, not sent yet; SEED-SR-0003 sent to P1 by courier with tracking, and P1's
 *                return of it received.
 *   gates        on SEED-SO-0002 (P1): an OTHER gate (the brand's artwork), PP_SAMPLE waiting for SEED-SR-0003, LEATHER_APPROVED
 *                passed, TRIMS_IN overridden by a second person with a reason.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first round is the plain REQUESTED one, the first measurement and comment are on it (it is open), the first swatch
 * and shipment are not sent, and the first gate is the OTHER one (one gate per other kind and order). Rows are written once:
 * a decided round's fit and a sent swatch never change again.
 */

/** Fixed instants and days, so the seed never depends on the clock. */
const T = {
  asked: new Date('2026-11-02T08:00:00.000Z'),
  decided: new Date('2026-11-04T10:00:00.000Z'),
  sent: new Date('2026-11-05T09:00:00.000Z'),
  measured: new Date('2026-11-05T14:00:00.000Z'),
  received: new Date('2026-11-07T11:00:00.000Z'),
  due: new Date('2026-11-20T17:00:00.000Z'),
} as const
const DAY = { due: new Date('2026-11-16T00:00:00.000Z'), gate: new Date('2026-11-25T00:00:00.000Z') } as const

export interface SamplesSeed {
  readonly roundIds: { readonly fit: string; readonly proto: string; readonly pp: string; readonly cert: string }
  readonly approvalRequestId: string
  readonly swatchIds: { readonly colour: string; readonly leather: string }
  readonly shipmentIds: { readonly fit: string; readonly ppOut: string; readonly ppBack: string }
  readonly gateIds: { readonly other: string; readonly pp: string; readonly leather: string; readonly trims: string }
}

export async function seed(context: SeedContext): Promise<SamplesSeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  await seedCompliance(context)
  await seedAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const roundIds = { fit: firstId('samples:round:JKT-01:FIT:1'), proto: id('samples:round:JKT-01:PROTO:1'), pp: id('samples:round:JKT-02:PP:1'), cert: id('samples:round:JKT-02:CERT:1') }
  const approvalRequestId = id('samples:approval:JKT-02:PP:1')
  const swatchIds = { colour: firstId('samples:swatch:JKT-01:RED'), leather: id('samples:swatch:JKT-01:lot') }
  const shipmentIds = { fit: firstId('samples:shipment:FIT:1'), ppOut: id('samples:shipment:PP:out'), ppBack: id('samples:shipment:PP:back') }
  const gateIds = { other: firstId('samples:gate:SO-0002:artwork'), pp: id('samples:gate:SO-0002:PP'), leather: id('samples:gate:SO-0002:LEATHER'), trims: id('samples:gate:SO-0002:TRIMS') }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.sampleRound.findUnique({ where: { id: roundIds.fit }, select: { id: true } })) return

      const jkt01 = await tx.style.findFirstOrThrow({ where: { code: 'SEED-JKT-01' }, select: { id: true } })
      const rev01 = await tx.styleRevision.findFirstOrThrow({ where: { styleId: jkt01.id, revision: 1 }, select: { id: true } })
      const colourways01 = await tx.colourway.findMany({ where: { styleId: jkt01.id }, select: { id: true, code: true } })
      const colourway01 = (code: string): string => colourways01.find((row) => row.code === code)!.id
      const colourways02 = await tx.colourway.findMany({ where: { styleId: production.styleId }, select: { id: true, code: true } })
      const colourway02 = (code: string): string => colourways02.find((row) => row.code === code)!.id
      const leather = await tx.item.findFirstOrThrow({ where: { code: 'SEED-LEA-100' }, select: { id: true } })
      const red = await tx.itemColour.findFirstOrThrow({ where: { itemId: leather.id, code: 'RED' }, select: { id: true } })
      const lot = await tx.lot.findFirstOrThrow({ where: { code: 'SEED-LOT-LEA-01' }, select: { id: true, siteId: true } })
      const certificate = await tx.certificate.findFirstOrThrow({ where: { number: 'SEED-CERT-0001' }, select: { id: true } })
      const workshop = id('party-address:P1:workshop')

      // Rounds (SAL-311): each written open first; the proto is decided after its cells (below).
      const rounds: (Prisma.SampleRoundCreateManyInput & { id: string })[] = [
        {
          id: roundIds.fit,
          companyId: companyA,
          number: 'SEED-SR-0001',
          styleId: jkt01.id,
          revisionId: rev01.id,
          kind: SampleKind.FIT,
          roundNo: 1,
          partyId: P1,
          cells: [{ colourwayId: colourway01('BLK'), size: '52', quantity: 1 }],
          dueDate: DAY.due,
          instructions: 'Fit on the brand\'s 52 rider; mark the sleeve length (made-up).',
          ...stamp(T.asked),
        },
        {
          id: roundIds.proto,
          companyId: companyA,
          number: 'SEED-SR-0002',
          styleId: jkt01.id,
          revisionId: rev01.id,
          kind: SampleKind.PROTO,
          roundNo: 1,
          cells: [
            { colourwayId: colourway01('BLK'), size: '52', quantity: 1 },
            { colourwayId: colourway01('RED'), size: '52', quantity: 1 },
          ],
          stage: SampleStage.UNDER_REVIEW,
          ...stamp(T.asked),
        },
        {
          id: roundIds.pp,
          companyId: companyA,
          number: 'SEED-SR-0003',
          styleId: production.styleId,
          revisionId: production.revisionId,
          kind: SampleKind.PRE_PRODUCTION,
          roundNo: 1,
          partyId: P1,
          cells: [{ colourwayId: colourway02('BLK'), size: '52', quantity: 2 }],
          dueDate: DAY.due,
          stage: SampleStage.UNDER_REVIEW,
          chargeAmountMinor: 15000,
          chargeCurrency: 'EUR',
          ...stamp(T.asked),
        },
        {
          id: roundIds.cert,
          companyId: companyA,
          number: 'SEED-SR-0004',
          styleId: production.styleId,
          revisionId: production.revisionId,
          kind: SampleKind.CERTIFICATION,
          roundNo: 1,
          cells: [
            { colourwayId: colourway02('BLK'), size: '50', quantity: 1 },
            { colourwayId: colourway02('BLK'), size: '54', quantity: 1 },
          ],
          stage: SampleStage.SENT,
          testZones: 'Shoulders and elbows, sizes 50 and 54 (made-up).',
          testResult: SampleTestResult.PASSED,
          certificateId: certificate.id,
          ...stamp(T.asked),
        },
      ]
      await tx.sampleRound.createMany({ data: rounds })

      // The brand's approval request of the pre-production round (kind SAMPLE): open until P1 answers.
      await tx.approvalRequest.create({
        data: {
          id: approvalRequestId,
          companyId: companyA,
          recordType: 'SampleRound',
          recordId: roundIds.pp,
          partyId: P1,
          kind: ApprovalKind.SAMPLE,
          question: 'Approve the pre-production sample SEED-SR-0003 (black 52, two pieces) before the order starts (made-up).',
          dueAt: T.due,
          ...stamp(T.sent),
        },
        select: { id: true },
      })
      await tx.sampleRound.update({ where: { id: roundIds.pp }, data: { approvalRequestId, updatedAt: T.sent }, select: { id: true } })

      // The fit of the FIT round (PRD-070, PRD-152): the spec values frozen as the spec said.
      const measurements: Prisma.SampleMeasurementCreateManyInput[] = [
        { id: firstId('samples:measure:FIT:CHEST_W:52'), roundId: roundIds.fit, seq: 1, pomCode: 'CHEST_W', pomName: 'Chest width', size: '52', nominal: '56.00', toleranceMinus: '1.00', tolerancePlus: '1.00', uom: Uom.CM, ...stamp(T.asked) },
        {
          id: id('samples:measure:FIT:SLEEVE_L:52'),
          roundId: roundIds.fit,
          seq: 2,
          pomCode: 'SLEEVE_L',
          pomName: 'Sleeve length',
          size: '52',
          nominal: '64.50',
          toleranceMinus: '0.50',
          tolerancePlus: '1.00',
          uom: Uom.CM,
          measured: '65.80',
          measuredAt: T.measured,
          pass: false,
          note: 'Measured on the brand\'s rider, arm bent (made-up).',
          ...stamp(T.measured),
        },
        { id: id('samples:measure:FIT:BACK_LEN:52'), roundId: roundIds.fit, seq: 3, pomCode: 'BACK_LEN', pomName: 'Back length', size: '52', nominal: '72.00', toleranceMinus: '1.00', tolerancePlus: '1.00', uom: Uom.CM, measured: '72.40', measuredAt: T.measured, pass: true, ...stamp(T.measured) },
      ]
      await tx.sampleMeasurement.createMany({ data: measurements })
      const comments: Prisma.SampleCommentCreateManyInput[] = [
        { id: firstId('samples:comment:FIT:sleeve'), roundId: roundIds.fit, pomCode: 'SLEEVE_L', text: 'Sleeve 1.3 cm too long at 52: shorten for the next round (made-up).', ...stamp(T.measured) },
        { id: id('samples:comment:FIT:shoulder'), roundId: roundIds.fit, bodyArea: 'left shoulder', text: 'Protector pocket sits 1 cm high (made-up).', resolved: true, resolvedAt: T.received, resolvedById: memberId, ...stamp(T.measured) },
      ]
      await tx.sampleComment.createMany({ data: comments })

      // The proto, decided by an office user (SAL-312).
      await tx.sampleRound.update({
        where: { id: roundIds.proto },
        data: {
          stage: SampleStage.DECIDED,
          decision: SampleDecision.APPROVED_WITH_COMMENTS,
          decisionComments: 'Good base; move the shoulder pocket up 1 cm (made-up).',
          decidedAt: T.decided,
          decidedVia: SampleDecisionVia.OFFICE,
          decidedById: memberId,
          updatedAt: T.decided,
        },
        select: { id: true },
      })

      // Swatches (SAL-314): a red colour swatch not sent yet; the black leather lot sent and approved in the office.
      const swatches: (Prisma.SampleSwatchCreateManyInput & { id: string })[] = [
        { id: swatchIds.colour, styleId: jkt01.id, roundId: roundIds.fit, partyId: P1, kind: SwatchKind.COLOUR, itemId: leather.id, itemColourId: red.id, note: 'Red leather, the brand\'s 2027 red (made-up).', ...stamp(T.asked) },
        {
          id: swatchIds.leather,
          styleId: jkt01.id,
          partyId: P1,
          kind: SwatchKind.LEATHER,
          itemId: leather.id,
          lotSiteId: lot.siteId,
          lotId: lot.id,
          note: 'Black lot 01, hand and grain (made-up).',
          sentAt: T.sent,
          decision: SampleDecision.APPROVED,
          decidedAt: T.decided,
          decidedVia: SampleDecisionVia.OFFICE,
          decidedById: memberId,
          ...stamp(T.asked),
          updatedAt: T.decided,
        },
      ]
      await tx.sampleSwatch.createMany({ data: swatches })

      // Shipments (SAL-316).
      const shipments: (Prisma.SampleShipmentCreateManyInput & { id: string })[] = [
        { id: shipmentIds.fit, roundId: roundIds.fit, partyId: P1, direction: SampleShipmentDirection.OUTBOUND, shipToAddressId: workshop, ...stamp(T.asked) },
        {
          id: shipmentIds.ppOut,
          roundId: roundIds.pp,
          partyId: P1,
          direction: SampleShipmentDirection.OUTBOUND,
          shipToAddressId: workshop,
          carrierName: 'Seed Express',
          trackingNumber: 'SEED-TRK-000123',
          trackingUrl: 'https://tracking.example.com/SEED-TRK-000123',
          sentAt: T.sent,
          receivedAt: T.received,
          ...stamp(T.sent),
          updatedAt: T.received,
        },
        { id: shipmentIds.ppBack, roundId: roundIds.pp, partyId: P1, direction: SampleShipmentDirection.RETURN, carrierName: 'Seed Express', trackingNumber: 'SEED-TRK-000456', sentAt: T.received, note: 'The brand sends one piece back with its marks (made-up).', ...stamp(T.received) },
      ]
      await tx.sampleShipment.createMany({ data: shipments })

      // Pre-production gates of P1's order SEED-SO-0002 (PLN-186): the planner (the seed's actor) owns them.
      const gates: (Prisma.OrderGateCreateManyInput & { id: string })[] = [
        { id: gateIds.other, companyId: companyA, partyId: P1, salesOrderId: production.salesOrderId, kind: GateKind.OTHER, label: 'Brand artwork for the hang tag confirmed (made-up)', targetDate: DAY.gate, ownerId: actorId, ...stamp(T.asked) },
        { id: gateIds.pp, companyId: companyA, partyId: P1, salesOrderId: production.salesOrderId, kind: GateKind.PP_SAMPLE, targetDate: DAY.gate, sampleRoundId: roundIds.pp, ownerId: actorId, ...stamp(T.asked) },
        { id: gateIds.leather, companyId: companyA, partyId: P1, salesOrderId: production.salesOrderId, kind: GateKind.LEATHER_APPROVED, targetDate: DAY.gate, ownerId: actorId, passedAt: T.decided, passedById: actorId, ...stamp(T.asked), updatedAt: T.decided },
        {
          id: gateIds.trims,
          companyId: companyA,
          partyId: P1,
          salesOrderId: production.salesOrderId,
          kind: GateKind.TRIMS_IN,
          targetDate: DAY.gate,
          ownerId: actorId,
          overriddenAt: T.decided,
          overriddenById: memberId,
          overrideReason: 'Zips arrive on the 18th; cutting may start, sewing waits (made-up).',
          ...stamp(T.asked),
          updatedAt: T.decided,
        },
      ]
      await tx.orderGate.createMany({ data: gates })
    }),
  )

  return { roundIds, approvalRequestId, swatchIds, shipmentIds, gateIds }
}
