import { LocationKind, PurchaseOrderStatus, ShipNoticeStatus, SubcontractOrderStatus, SubcontractReturnNoticeStatus, SupplierQuestionnaireDecision, Uom } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedInventory } from './inventory'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedSubcontractReceipts } from './subcontract-receipts'

/**
 * The supplier portal seed (W2b schema wave 22/22, B-W2b-158), per tenant of seed/_core.ts. The office's rows are written
 * in the tenant's office scope, the supplier's and the workshop's own acts in the partner scope of party P2 (the parties
 * seed's supplier and subcontractor of company A) as its order desk, the portal user of seed/portal-auth.ts, as the app
 * does. The CLI runs the seed files in name order and this one sorts before subcontract-receipts.ts, so it runs the
 * inventory (PO1 PARTLY_RECEIVED), portal-auth and subcontract-receipts seeds first (each idempotent). Every name, number
 * and figure is made up.
 *
 *   questionnaire  company A's supplier questionnaire, version 1, published: eight due-diligence questions (made-up words
 *                  in Italian and English).
 *   answers        P2 answered version 1 in the portal; the buyer sent QUESTIONS back; P2 answered again (not reviewed
 *                  yet).
 *   ship notices   SEED-ASN-0001: P2 announced 120 ft² of PO1's black leather (lot and dye batch 2231) with the tannery's
 *                  packing list of three hides, and the office sent it (SENT; its dock note for the office only). A DRAFT
 *                  for the 12 protectors still open on PO1 (no number yet).
 *   workshop       P2 accepted SEED-SC-0002 (the subcontract-receipts seed's packing job) as asked, reported its 2 sleeve
 *                  sets finished, announced the return of the first (received: the order's receipt 1, DDT 77/2026) and
 *                  of the second (ANNOUNCED, DDT 81/2026).
 *
 * The SEED-ASN-0001 number is a seed number (as SEED-PO-0001): the ASN series of seed/numbering.ts starts unused.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first ship notice is the DRAFT, the first return notice the ANNOUNCED one and the first answer the one not
 * reviewed (ids that start with eight zeros). They read and write as party P1 (a customer and brand that also supplies):
 * with `partnerScope` (that test only) the seed also gives P1 rows of its own: a SENT purchase order SEED-PO-0003 with a
 * DRAFT ship notice, a line and a hide; a workshop location of P1 and its subcontract order SEED-SC-0003 at the workshop
 * with a planned kit line, a progress report and an announced return; an answer to the questionnaire. Without it nothing of
 * P1 is written, so the API tests count the same orders. Those rows' ids start with eight f's.
 *
 * Idempotent: each part is written once and skipped when its first row exists.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  questionnaire: new Date('2026-10-20T08:00:00.000Z'),
  published: new Date('2026-10-20T09:00:00.000Z'),
  answered: new Date('2026-10-26T15:20:00.000Z'),
  reviewed: new Date('2026-10-27T10:00:00.000Z'),
  answeredAgain: new Date('2026-10-28T11:45:00.000Z'),
  noticed: new Date('2026-11-04T08:30:00.000Z'),
  sent: new Date('2026-11-04T09:10:00.000Z'),
  draft: new Date('2026-11-05T16:00:00.000Z'),
  accepted: new Date('2026-11-17T12:40:00.000Z'),
  reported: new Date('2026-11-18T16:00:00.000Z'),
  announced: new Date('2026-11-18T17:30:00.000Z'),
  back: new Date('2026-11-19T09:30:00.000Z'),
  announcedAgain: new Date('2026-11-21T10:00:00.000Z'),
} as const
const DAY = {
  ship: new Date('2026-11-05T00:00:00.000Z'),
  arrive: new Date('2026-11-07T00:00:00.000Z'),
  ddt: new Date('2026-11-05T00:00:00.000Z'),
  draftShip: new Date('2026-11-12T00:00:00.000Z'),
  finishBy: new Date('2026-11-21T00:00:00.000Z'),
  backFirst: new Date('2026-11-19T00:00:00.000Z'),
  backSecond: new Date('2026-11-24T00:00:00.000Z'),
  ddtSecond: new Date('2026-11-21T00:00:00.000Z'),
} as const

/** The starter set (SCM-023; Forced Labour Regulation (EU) 2024/3015): made-up words, the kinds are the API's. */
const QUESTIONS = [
  { key: 'company.legal-name', section: 'company', kind: 'TEXT', required: true, text: { it: 'Ragione sociale', en: 'Legal name' } },
  { key: 'company.vat', section: 'company', kind: 'VAT', required: true, text: { it: 'Partita IVA', en: 'VAT number' } },
  { key: 'contacts.quality', section: 'contacts', kind: 'CONTACT', required: true, text: { it: 'Chi segue la qualità', en: 'Who handles quality' } },
  { key: 'sites.own', section: 'sites', kind: 'SITES', required: true, text: { it: 'I vostri stabilimenti', en: 'Your sites' } },
  { key: 'certs.lwg', section: 'certifications', kind: 'FILE', required: false, text: { it: 'Certificato LWG con scadenza', en: 'LWG certificate with its expiry' } },
  { key: 'certs.cr6-testing', section: 'certifications', kind: 'TEXT', required: true, text: { it: 'Come testate il cromo VI', en: 'How you test for chromium VI' } },
  { key: 'labour.forced-labour', section: 'labour', kind: 'YES_NO', required: true, text: { it: 'Lavoro forzato escluso in tutta la filiera?', en: 'Forced labour excluded across the supply chain?' } },
  { key: 'labour.code-of-conduct', section: 'labour', kind: 'SIGN', required: true, text: { it: 'Codice di condotta firmato', en: 'Code of conduct signed' } },
] as const

export interface PortalSupplySeedOptions {
  /** The generated isolation tests: party P1 gets rows of its own in every partner table (see above). */
  readonly partnerScope?: boolean
}

export interface PortalSupplySeed {
  readonly questionnaireId: string
  readonly answers: { readonly reviewed: string; readonly open: string }
  readonly shipNotices: { readonly sent: string; readonly draft: string }
  readonly shipNoticeLines: { readonly leather: string; readonly protectors: string }
  readonly shipNoticeHides: readonly string[]
  readonly progressReportId: string
  readonly returnNotices: { readonly received: string; readonly announced: string }
  /** SEED-SC-0002 (the workshop P2's job), its operation and receipt. */
  readonly subcontractOrderId: string
  readonly subcontractOperationId: string
  readonly subcontractReceiptId: string
  /** PO1 (P2) and its leather line. */
  readonly purchaseOrderId: string
  readonly leatherLineId: string
  readonly supplierUserId: string
  readonly partyId: string
  readonly companyId: string
  readonly tenantId: string
}

export async function seed(context: SeedContext, options: PortalSupplySeedOptions = {}): Promise<PortalSupplySeed> {
  const { db, namespace } = context
  const inventory = await seedInventory(context)
  const portal = await seedPortalAuth(context)
  const job = await seedSubcontractReceipts(context)
  const supply = inventory.supply
  const production = job.subcontract.production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const partyP1 = id('party:P1')
  const partyP2 = supply.supplierId
  const item = { protector: id('product:item:protector') }
  const office = { audience: 'office', tenantId, actorId } as const
  // A portal session runs in its party's scope; its actor is the partner user.
  const asSupplier = { audience: 'partner', tenantId, actorId: portal.userIds.p2Orders, partyId: partyP2 } as const
  const asBrand = { audience: 'partner', tenantId, actorId: portal.userIds.p1Buyer, partyId: partyP1 } as const
  const select = { id: true } as const

  const questionnaireId = firstId('portal-supply:questionnaire:A:1')
  const answers = { reviewed: id('portal-supply:answer:P2:1'), open: firstId('portal-supply:answer:P2:2') }
  const shipNotices = { sent: id('portal-supply:asn:P2:1'), draft: firstId('portal-supply:asn:P2:2') }
  const shipNoticeLines = { leather: id('portal-supply:asn:P2:1:10'), protectors: id('portal-supply:asn:P2:2:10') }
  const hides = [
    { id: firstId('portal-supply:asn:P2:1:hide:1'), hideNumber: '2231-017', area: '41.5000', grade: 'A', thicknessMm: '1.20' },
    { id: id('portal-supply:asn:P2:1:hide:2'), hideNumber: '2231-018', area: '39.8000', grade: 'A', thicknessMm: '1.25' },
    { id: id('portal-supply:asn:P2:1:hide:3'), hideNumber: '2231-019', area: '38.7000', grade: 'A', thicknessMm: '1.15' },
  ] as const
  const progressReportId = firstId('portal-supply:progress:SC-0002:1')
  const returnNotices = { received: id('portal-supply:return:SC-0002:1'), announced: firstId('portal-supply:return:SC-0002:2') }

  // --- the questionnaire and P2's answers -----------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.supplierQuestionnaire.findUnique({ where: { id: questionnaireId }, select })) return
      await tx.supplierQuestionnaire.create({
        data: {
          id: questionnaireId,
          companyId: companyA,
          revision: 1,
          title: 'Supplier due diligence',
          questions: QUESTIONS.map((question) => ({ ...question, text: { ...question.text } })),
          publishedAt: T.published,
          publishedById: actorId,
          createdAt: T.questionnaire,
          updatedAt: T.published,
          createdById: actorId,
        },
        select,
      })
    }),
  )
  const answer = (rowId: string, at: Date, explain: string) => ({
    id: rowId,
    companyId: companyA,
    partyId: partyP2,
    questionnaireId,
    answers: {
      'company.legal-name': { value: 'Seed Tannery Two S.r.l.' },
      'company.vat': { value: 'IT00000002022' },
      'certs.cr6-testing': { value: 'Every dye batch at an outside lab.' },
      'labour.forced-labour': { value: 'YES', explain },
      'labour.code-of-conduct': { value: 'SIGNED' },
    },
    sites: [{ name: 'Seed tannery, finishing', country: 'IT', steps: ['RETANNING', 'FINISHING'] }],
    subTierSites: [{ name: 'Seed beamhouse partner', country: 'IT', steps: ['BEAMHOUSE', 'TANNING'] }],
    signedName: 'Seed Order Desk',
    signedRole: 'Quality manager',
    submittedAt: at,
    createdAt: at,
    updatedAt: at,
  })
  if (!(await db.withScope(office, (client) => client.supplierQuestionnaireResponse.findUnique({ where: { id: answers.reviewed }, select })))) {
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierQuestionnaireResponse.create({ data: answer(answers.reviewed, T.answered, 'Our own sites only.'), select })
      }),
    )
    await db.withScope(office, (client) =>
      client.supplierQuestionnaireResponse.update({
        where: { id: answers.reviewed },
        data: { decision: SupplierQuestionnaireDecision.QUESTIONS, reviewedAt: T.reviewed, reviewedById: actorId, reviewNote: 'Ask for the beamhouse partner.', version: 2, updatedAt: T.reviewed },
        select,
      }),
    )
    await db.withScope(asSupplier, (client) =>
      client.supplierQuestionnaireResponse.create({ data: answer(answers.open, T.answeredAgain, 'Our sites and our beamhouse partner, audited each year.'), select }),
    )
  }

  // --- P2's ship notices of PO1 -----------------------------------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.shipNotice.findUnique({ where: { id: shipNotices.sent }, select })))) {
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        await tx.shipNotice.create({
          data: {
            id: shipNotices.sent,
            companyId: companyA,
            siteId: siteA,
            partyId: partyP2,
            purchaseOrderId: supply.purchaseOrderId,
            status: ShipNoticeStatus.DRAFT,
            supplierRef: 'SEED-SHIP-4410',
            ddtNumber: '512/2026',
            ddtDate: DAY.ddt,
            shipDate: DAY.ship,
            expectedDate: DAY.arrive,
            carrier: 'Seed Freight',
            trackingNumber: 'SEED00012345',
            parcels: 2,
            note: 'Second part of the black leather: one dye batch.',
            createdAt: T.noticed,
            updatedAt: T.noticed,
          },
          select,
        })
        await tx.shipNoticeLine.create({
          data: {
            id: shipNoticeLines.leather,
            siteId: siteA,
            partyId: partyP2,
            shipNoticeId: shipNotices.sent,
            seq: 10,
            purchaseOrderLineId: supply.leatherLineId,
            quantity: '120.0000',
            uom: Uom.FT2,
            supplierLot: 'SEED-LOT-2231',
            dyeBatch: '2231',
            createdAt: T.noticed,
            updatedAt: T.noticed,
          },
          select,
        })
        await tx.shipNoticeHide.createMany({
          data: hides.map((hide, index) => ({
            ...hide,
            siteId: siteA,
            partyId: partyP2,
            shipNoticeId: shipNotices.sent,
            shipNoticeLineId: shipNoticeLines.leather,
            seq: index + 1,
            areaUom: Uom.FT2,
            dyeBatch: '2231',
            createdAt: T.noticed,
            updatedAt: T.noticed,
          })),
        })
      }),
    )
    // The office (the API in the system context) numbers and sends it, and adds its dock note.
    await db.withScope(office, (client) =>
      client.shipNotice.update({
        where: { id: shipNotices.sent },
        data: { status: ShipNoticeStatus.SENT, number: 'SEED-ASN-0001', sentAt: T.sent, internalNote: 'Seed dock note: door 2.', version: 2, updatedAt: T.sent },
        select,
      }),
    )
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        await tx.shipNotice.create({
          data: {
            id: shipNotices.draft,
            companyId: companyA,
            siteId: siteA,
            partyId: partyP2,
            purchaseOrderId: supply.purchaseOrderId,
            status: ShipNoticeStatus.DRAFT,
            shipDate: DAY.draftShip,
            note: 'The protectors still open, once packed.',
            createdAt: T.draft,
            updatedAt: T.draft,
          },
          select,
        })
        await tx.shipNoticeLine.create({
          data: {
            id: shipNoticeLines.protectors,
            siteId: siteA,
            partyId: partyP2,
            shipNoticeId: shipNotices.draft,
            seq: 10,
            purchaseOrderLineId: supply.protectorLineId,
            quantity: '12.0000',
            uom: Uom.PCS,
            createdAt: T.draft,
            updatedAt: T.draft,
          },
          select,
        })
      }),
    )
  }

  // --- the workshop P2 on SEED-SC-0002 -------------------------------------------------------------------------------------
  const bundleId = job.bundleId
  const cellId = production.cellIds['BLK-52']
  if (!(await db.withScope(office, (client) => client.subcontractProgressReport.findUnique({ where: { id: progressReportId }, select })))) {
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        const order = await tx.subcontractOrder.findUniqueOrThrow({ where: { id: job.orderId }, select: { acceptedAt: true, version: true } })
        if (!order.acceptedAt) {
          await tx.subcontractOrder.update({ where: { id: job.orderId }, data: { acceptedAt: T.accepted, acceptedByName: 'Seed Workshop Desk', version: order.version + 1 }, select })
        }
        await tx.subcontractProgressReport.create({
          data: {
            id: progressReportId,
            siteId: siteA,
            workOrderId: production.workOrderId,
            partyId: partyP2,
            subcontractOrderId: job.orderId,
            subcontractOperationId: job.operationId,
            bundleId,
            workOrderSizeId: cellId,
            finishedQuantity: 2,
            finishBy: DAY.finishBy,
            reportedAt: T.reported,
            reportedByName: 'Seed Workshop Desk',
            note: 'Both sleeve sets finished; the first goes back tomorrow.',
            createdAt: T.reported,
          },
          select,
        })
        const back = (rowId: string, seq: number, at: Date, expectedDate: Date, workshopDdtNumber: string, workshopDdtDate: Date) => ({
          id: rowId,
          siteId: siteA,
          workOrderId: production.workOrderId,
          partyId: partyP2,
          subcontractOrderId: job.orderId,
          seq,
          quantities: [{ subcontractOperationId: job.operationId, bundleId, workOrderSizeId: cellId, finished: 1, scrapped: 0 }],
          parcels: 1,
          expectedDate,
          workshopDdtNumber,
          workshopDdtDate,
          announcedByName: 'Seed Workshop Desk',
          createdAt: at,
          updatedAt: at,
        })
        await tx.subcontractReturnNotice.create({ data: back(returnNotices.received, 1, T.announced, DAY.backFirst, '77/2026', DAY.backFirst), select })
        await tx.subcontractReturnNotice.create({ data: back(returnNotices.announced, 2, T.announcedAgain, DAY.backSecond, '81/2026', DAY.ddtSecond), select })
      }),
    )
    // The receive back of the first (the subcontract-receipts seed's receipt 1) was written from it.
    await db.withScope(office, (client) =>
      client.subcontractReturnNotice.update({
        where: { id: returnNotices.received },
        data: { status: SubcontractReturnNoticeStatus.RECEIVED, receiptId: job.receiptId, receivedAt: T.back, version: 2, updatedAt: T.back },
        select,
      }),
    )
  }

  if (options.partnerScope) await seedPartnerScope()

  return {
    questionnaireId,
    answers,
    shipNotices,
    shipNoticeLines,
    shipNoticeHides: hides.map((hide) => hide.id),
    progressReportId,
    returnNotices,
    subcontractOrderId: job.orderId,
    subcontractOperationId: job.operationId,
    subcontractReceiptId: job.receiptId,
    purchaseOrderId: supply.purchaseOrderId,
    leatherLineId: supply.leatherLineId,
    supplierUserId: portal.userIds.p2Orders,
    partyId: partyP2,
    companyId: companyA,
    tenantId,
  }

  /** P1's own rows, for the generated isolation tests only (see above). */
  async function seedPartnerScope(): Promise<void> {
    const row = {
      order: lateId('portal-supply:P1:PO-0003'),
      orderLine: lateId('portal-supply:P1:PO-0003:10'),
      notice: lateId('portal-supply:P1:asn'),
      noticeLine: lateId('portal-supply:P1:asn:10'),
      hide: lateId('portal-supply:P1:asn:hide:1'),
      location: lateId('portal-supply:P1:location'),
      job: lateId('portal-supply:P1:SC-0003'),
      operation: lateId('portal-supply:P1:SC-0003:op:10'),
      kitLine: lateId('portal-supply:P1:SC-0003:kit:10'),
      report: lateId('portal-supply:P1:SC-0003:progress:1'),
      back: lateId('portal-supply:P1:SC-0003:return:1'),
      answer: lateId('portal-supply:P1:answer:1'),
    }
    if (await db.withScope(office, (client) => client.purchaseOrder.findUnique({ where: { id: row.order }, select }))) return
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.purchaseOrder.create({
          data: { id: row.order, companyId: companyA, siteId: siteA, number: 'SEED-PO-0003', partyId: partyP1, orderDate: DAY.ship, netAmount: 5_000, createdAt: T.noticed, updatedAt: T.noticed, createdById: actorId },
          select,
        })
        await tx.purchaseOrderLine.create({
          data: {
            id: row.orderLine,
            purchaseOrderId: row.order,
            partyId: partyP1,
            siteId: siteA,
            seq: 10,
            itemId: item.protector,
            quantity: '10.0000',
            uom: Uom.PCS,
            baseQuantity: '10.0000',
            unitPrice: '5.000000',
            netAmount: 5_000,
            needDate: DAY.draftShip,
            createdAt: T.noticed,
            updatedAt: T.noticed,
            createdById: actorId,
          },
          select,
        })
        await tx.purchaseOrder.update({ where: { id: row.order }, data: { status: PurchaseOrderStatus.SENT, sentAt: T.sent, sentById: actorId, version: 2 }, select })
        await tx.location.create({
          data: { id: row.location, companyId: companyA, siteId: siteA, code: 'A1-TERZ-P1', name: 'Seed workshop P1 (our stock there)', kind: LocationKind.SUBCONTRACTOR, partyId: partyP1, createdAt: T.noticed, updatedAt: T.noticed, createdById: actorId },
          select,
        })
        await tx.subcontractOrder.create({
          data: {
            id: row.job,
            companyId: companyA,
            siteId: siteA,
            number: 'SEED-SC-0003',
            partyId: partyP1,
            locationId: row.location,
            workOrderId: production.workOrderId,
            orderDate: DAY.ship,
            netAmount: 700,
            createdAt: T.noticed,
            updatedAt: T.noticed,
            createdById: actorId,
          },
          select,
        })
        await tx.subcontractOperation.create({
          data: { id: row.operation, siteId: siteA, workOrderId: production.workOrderId, subcontractOrderId: row.job, seq: 10, workOrderOperationId: production.operationIds.qc, pieces: 7, pricePerPiece: '1.000000', netAmount: 700, createdAt: T.noticed, updatedAt: T.noticed, createdById: actorId },
          select,
        })
        await tx.subcontractKitLine.create({
          data: { id: row.kitLine, siteId: siteA, partyId: partyP1, subcontractOrderId: row.job, seq: 10, itemId: item.protector, quantity: '7.0000', uom: Uom.PCS, baseQuantity: '7.0000', createdAt: T.noticed, updatedAt: T.noticed, createdById: actorId },
          select,
        })
        await tx.subcontractOrder.update({ where: { id: row.job }, data: { status: SubcontractOrderStatus.ISSUED, issuedAt: T.sent, issuedById: actorId, version: 2 }, select })
        await tx.subcontractOrder.update({ where: { id: row.job }, data: { status: SubcontractOrderStatus.AT_WORKSHOP, version: 3 }, select })
      }),
    )
    await db.withScope(asBrand, (client) =>
      client.$transaction(async (tx) => {
        await tx.shipNotice.create({
          data: { id: row.notice, companyId: companyA, siteId: siteA, partyId: partyP1, purchaseOrderId: row.order, shipDate: DAY.draftShip, createdAt: T.draft, updatedAt: T.draft },
          select,
        })
        await tx.shipNoticeLine.create({
          data: { id: row.noticeLine, siteId: siteA, partyId: partyP1, shipNoticeId: row.notice, seq: 10, purchaseOrderLineId: row.orderLine, quantity: '10.0000', uom: Uom.PCS, createdAt: T.draft, updatedAt: T.draft },
          select,
        })
        await tx.shipNoticeHide.create({
          data: { id: row.hide, siteId: siteA, partyId: partyP1, shipNoticeId: row.notice, shipNoticeLineId: row.noticeLine, seq: 1, hideNumber: 'P1-0001', area: '1.0000', areaUom: Uom.M2, createdAt: T.draft, updatedAt: T.draft },
          select,
        })
        await tx.subcontractProgressReport.create({
          data: { id: row.report, siteId: siteA, workOrderId: production.workOrderId, partyId: partyP1, subcontractOrderId: row.job, subcontractOperationId: row.operation, finishedQuantity: 1, reportedAt: T.reported, reportedByName: 'Seed Buyer One', createdAt: T.reported },
          select,
        })
        await tx.subcontractReturnNotice.create({
          data: {
            id: row.back,
            siteId: siteA,
            workOrderId: production.workOrderId,
            partyId: partyP1,
            subcontractOrderId: row.job,
            seq: 1,
            quantities: [{ subcontractOperationId: row.operation, finished: 1, scrapped: 0 }],
            parcels: 1,
            expectedDate: DAY.backSecond,
            announcedByName: 'Seed Buyer One',
            createdAt: T.announced,
            updatedAt: T.announced,
          },
          select,
        })
        await tx.supplierQuestionnaireResponse.create({
          data: {
            id: row.answer,
            companyId: companyA,
            partyId: partyP1,
            questionnaireId,
            answers: { 'labour.forced-labour': { value: 'YES' } },
            signedName: 'Seed Buyer One',
            submittedAt: T.answered,
            createdAt: T.answered,
            updatedAt: T.answered,
          },
          select,
        })
      }),
    )
  }
}
