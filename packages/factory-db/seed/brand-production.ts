import { BrandHealth, BrandStage, BrandUrgency, HealthReason, IssueSource, IssueStatus, UrgencyActor, WaitingOn, WorkOrderHoldKind, WorkOrderHoldStatus } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar' // B-PR-23: the need-by date is the seeds' future
import { seedUuid, type SeedContext } from '../src/seeding'
import { seedSecondBrand } from '../src/testing/second-brand'
import { seed as seedAuth } from './auth'
import { seed as seedFiles } from './files'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedProduction } from './production'
import { seed as seedQuality } from './quality'
import { seed as seedSales } from './sales'
import { seed as seedSalesPricing } from './sales-pricing' // B-PR-23

/**
 * B-PR-15 (production plan, schema wave 3/5; review fix R-57): a customer's production state of its orders, an issue that needs
 * an answer and a plain production hold, per tenant of seed/_core.ts, written in the tenant's office scope as the app does
 * (the keeper, the urgency commands and the factory's lock write BrandOrderProduction there; a customer's mark is the
 * portal's command written in the office scope after the partner read).
 *
 *   P1 (the customer and brand)  its urgency switch ON with the default quota 3 — its share level stays STATUS: the portal
 *                                golden flow (C01) and the portal-orders tests read P1's production progress as not shared
 *                                until the sales office shares it through the limits card;
 *     SEED-SO-0002   Urgent, 1st of its Urgent list, marked by P1's portal buyer (batch 1)
 *     SEED-SO-0003   Urgent, 2nd, the same mark (batch 1); its health raised by us to At risk (QUALITY) with the office's note
 *     SEED-SO-0001   Regular, set back and locked by us with the reason P1 reads (its deposit); waits on P1 (the deposit)
 *                    ("2 of 3 urgent used")
 *   Seed Brand Two (the threads' second brand of tenant A, src/testing/second-brand.ts)
 *     SEED-SO-B001   Regular, waiting on us since it reported a problem: ONE open BRAND issue on the order, raised with its own
 *                    portal message in the order's thread, with its Task (record = the SALES ORDER; the batch's one task, no
 *                    assignee until a supervisor is set: B-PR-42a seeds the supervisors)
 *   SEED-WO-0001 (P1, site A1)   a PRODUCTION hold for missing material, placed and lifted on its release day: history, so no
 *                                work order changes state (the floor reads it, the office's note never).
 *   SEED-SO-0004 (P1, CONFIRMED, typed by the office; no production state row yet)   B-PR-23 (R-57's "Urgent – asked"): P1's
 *                                portal buyer asked it Urgent with a need-by date (a RUSH request, OPEN, no batch, no impact
 *                                kept: B-PR-24 gives the impact its shape), written in P1's own partner scope as the portal
 *                                does, so the database's rules for the asks run. The office list of change requests and the
 *                                portal order's list read it in words ("Urgent – asked"); Sales does not answer it (Home ›
 *                                Approvals does, B-PR-26/27b); it never blocks a change or a cancel of the order.
 *
 * The CLI runs the seeds in name order, so this one runs the seeds whose rows it names first (each idempotent): auth, files,
 * sales (SEED-SO-0001), production (SEED-SO-0002, SEED-WO-0001), quality (SEED-SO-0003), the portal people (P1's buyer) and
 * the second brand's fixture. The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table
 * by id and insert the copy: every row here of a new table may be copied as it is (the key of a copy takes a suffix; an issue
 * copy is OPEN; the hold is written whole as history), and the task (an older table) and the second brand's row take ids that
 * start with eight f's, so no generated test copies them. Every name and word is made up. Idempotent: rows are written once and
 * left as they are (an order that has a production state row already, the seed's or the app's, keeps it); P1's switch is
 * turned on once.
 */

/** Fixed instants of the seeds' story, all on or before SEED_DAY (history, never moved). */
const T = {
  marked: new Date('2026-11-13T09:00:00.000Z'),
  locked: new Date('2026-11-13T15:00:00.000Z'),
  depositAsked: new Date('2026-10-30T09:00:00.000Z'),
  raised: new Date('2026-11-14T11:00:00.000Z'),
  quality: new Date('2026-11-14T10:00:00.000Z'),
  released: new Date('2026-11-15T10:00:00.000Z'),
  held: new Date('2026-11-15T11:00:00.000Z'),
  lifted: new Date('2026-11-15T14:00:00.000Z'),
  switched: new Date('2026-11-13T08:00:00.000Z'),
  // B-PR-23
  asked: new Date('2026-11-14T15:00:00.000Z'),
} as const
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)

export interface BrandProductionSeed {
  /** P1's orders' production state rows, and Seed Brand Two's. */
  readonly rowIds: { readonly so1: string; readonly so2: string; readonly so3: string; readonly secondBrand: string }
  readonly orderIds: { readonly so1: string; readonly so2: string; readonly so3: string; readonly secondBrand: string }
  /** P1's urgency batch (SO-0002 and SO-0003 marked together) and our lock of SO-0001. */
  readonly batchIds: { readonly marked: string; readonly locked: string }
  /** Seed Brand Two's open BRAND issue, its task and the portal message it was raised with. */
  readonly issue: { readonly id: string; readonly taskId: string; readonly messageId: string; readonly partyId: string }
  /** The lifted production hold on SEED-WO-0001. */
  readonly holdId: string
  /** B-PR-23: P1's open RUSH request ("Urgent – asked") on SEED-SO-0004. */
  readonly urgentAsk: { readonly requestId: string; readonly orderId: string }
}

export async function seed(context: SeedContext): Promise<BrandProductionSeed> {
  const { db, namespace } = context
  const { ownerId } = await seedAuth(context)
  await seedFiles(context)
  const sales = await seedSales(context)
  const production = await seedProduction(context)
  const quality = await seedQuality(context)
  const portal = await seedPortalAuth(context)
  const second = await seedSecondBrand(context)
  const pricing = await seedSalesPricing(context) // B-PR-23: SEED-SO-0004
  const id = (key: string): string => seedUuid(namespace, key)
  /** An id that sorts last: no generated test copies the row (see above). */
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const p1 = id('party:P1')
  const buyer = portal.userIds.p1Buyer

  const orderIds = { so1: sales.orderId, so2: production.salesOrderId, so3: quality.serialSalesOrderId, secondBrand: second.salesOrderId }
  const rowIds = {
    so1: id('brand-production:SO-0001'),
    so2: id('brand-production:SO-0002'),
    so3: id('brand-production:SO-0003'),
    secondBrand: lastId('brand-production:second-brand:SO-B001'),
  }
  const batchIds = { marked: id('brand-production:batch:P1:marked'), locked: id('brand-production:batch:P1:locked') }
  const issue = { id: id('brand-production:issue:second-brand:SO-B001'), taskId: lastId('brand-production:task:second-brand:SO-B001'), messageId: second.messageIds[1]!, partyId: second.partyId }
  const holdId = id('brand-production:hold:WO-0001')
  // B-PR-23: P1's "Urgent – asked" on SEED-SO-0004 (an ordinary id: the generated isolation tests copy portal-sales' first,
  // plain OPEN change request, whose id starts with eight zeros).
  const urgentAsk = { requestId: id('brand-production:ask:P1:SO-0004:rush'), orderId: pricing.order.orderId }
  /** When Seed Brand Two reported its problem: its portal message in the order's thread (second-brand.ts minutes(20)). */
  const reported = new Date('2026-10-29T08:20:00.000Z')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: ownerId })
  const keyOf = (salesOrderId: string): string => `brand-production:${salesOrderId}`

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      // P1 may mark its orders Urgent (L18): its switch on once, the quota the default 3; its share level stays as it is.
      const settings = await tx.portalSettings.findUnique({ where: { id: p1 }, select: { productionUrgencyOn: true, version: true } })
      if (settings && !settings.productionUrgencyOn) {
        await tx.portalSettings.update({ where: { id: p1 }, data: { productionUrgencyOn: true, version: settings.version + 1, updatedAt: T.switched }, select: { id: true } })
      }

      const rows = [
        {
          id: rowIds.so2,
          companyId: companyA,
          partyId: p1,
          salesOrderId: orderIds.so2,
          stage: BrandStage.PREPARING,
          stageAt: T.released,
          health: BrandHealth.ON_TRACK,
          healthAt: T.released,
          waitingOn: WaitingOn.US,
          waitingSince: T.released,
          urgency: BrandUrgency.URGENT,
          urgentRank: 1,
          urgencySetAt: T.marked,
          urgencySetBy: UrgencyActor.BRAND,
          urgencySetById: buyer,
          urgencyBatchId: batchIds.marked,
          ...stamp(T.marked),
        },
        {
          id: rowIds.so3,
          companyId: companyA,
          partyId: p1,
          salesOrderId: orderIds.so3,
          stage: BrandStage.QUALITY,
          stageAt: T.quality,
          health: BrandHealth.ON_TRACK,
          healthAt: T.quality,
          healthSet: BrandHealth.AT_RISK,
          healthReasonCode: HealthReason.QUALITY,
          healthNote: 'Seed: one sleeve is cut again after the inspection.',
          healthSetAt: T.raised,
          healthSetById: ownerId,
          healthSetUntil: day('2026-11-21'),
          waitingOn: WaitingOn.US,
          waitingSince: T.quality,
          urgency: BrandUrgency.URGENT,
          urgentRank: 2,
          urgencySetAt: T.marked,
          urgencySetBy: UrgencyActor.BRAND,
          urgencySetById: buyer,
          urgencyBatchId: batchIds.marked,
          ...stamp(T.marked),
        },
        {
          id: rowIds.so1,
          companyId: companyA,
          partyId: p1,
          salesOrderId: orderIds.so1,
          stage: BrandStage.PREPARING,
          stageAt: T.depositAsked,
          waitingOn: WaitingOn.BRAND,
          waitingSince: T.depositAsked,
          urgency: BrandUrgency.REGULAR,
          urgencySetAt: T.locked,
          urgencySetBy: UrgencyActor.FACTORY,
          urgencySetById: ownerId,
          urgencyBatchId: batchIds.locked,
          urgencyLocked: true,
          urgencyLockReason: 'Seed: the deposit is not paid yet; we plan this order as soon as it is.',
          urgencyLockedAt: T.locked,
          urgencyLockedById: ownerId,
          ...stamp(T.depositAsked),
        },
        {
          id: rowIds.secondBrand,
          companyId: companyA,
          partyId: second.partyId,
          salesOrderId: orderIds.secondBrand,
          stage: BrandStage.PREPARING,
          stageAt: reported,
          waitingOn: WaitingOn.US,
          waitingSince: reported,
          ...stamp(reported),
        },
      ]
      // B-W2b-GS1: an order the app (the keeper, B-PR-17) has given its row already keeps that row; the seed writes only its own.
      for (const { id: rowId, ...row } of rows) {
        const key = keyOf(row.salesOrderId)
        if (await tx.brandOrderProduction.findFirst({ where: { key }, select: { id: true } })) continue
        await tx.brandOrderProduction.create({ data: { id: rowId, key, ...row }, select: { id: true } })
      }

      // Seed Brand Two's problem on SEED-SO-B001 (B-PR-45's "Report a problem"): the batch's one task on the SALES ORDER, made
      // from the portal message it wrote, then the issue (OPEN, due one working day later: Friday 30 October).
      await tx.task.upsert({
        where: { id: issue.taskId },
        create: {
          id: issue.taskId,
          companyId: companyA,
          partyId: second.partyId,
          title: 'Seed: answer the problem the customer reported',
          description: 'Seed Brand Two wrote in the order thread: answer it there.',
          recordType: 'SalesOrder',
          recordId: orderIds.secondBrand,
          recordLabel: 'SEED-SO-B001',
          dueDate: day('2026-10-30'),
          messageId: issue.messageId,
          ...stamp(reported),
        },
        update: {},
        select: { id: true },
      })
      await tx.productionIssue.upsert({
        where: { id: issue.id },
        create: {
          id: issue.id,
          companyId: companyA,
          partyId: second.partyId,
          recordType: 'SalesOrder',
          recordId: orderIds.secondBrand,
          salesOrderId: orderIds.secondBrand,
          taskId: issue.taskId,
          messageId: issue.messageId,
          source: IssueSource.BRAND,
          status: IssueStatus.OPEN,
          raisedAt: reported,
          dueDate: day('2026-10-30'),
          ...stamp(reported),
        },
        update: {},
        select: { id: true },
      })

      // SEED-WO-0001's production hold, placed and lifted on its release day (history: the work order keeps its state).
      const workOrder = await tx.workOrder.findUniqueOrThrow({ where: { id: production.workOrderId }, select: { companyId: true, siteId: true, partyId: true } })
      await tx.workOrderHold.upsert({
        where: { id: holdId },
        create: {
          id: holdId,
          companyId: workOrder.companyId,
          siteId: workOrder.siteId,
          workOrderId: production.workOrderId,
          partyId: workOrder.partyId,
          kind: WorkOrderHoldKind.PRODUCTION,
          reasonCode: 'MATERIAL_MISSING',
          note: 'Seed: the lining roll came in short; held until the rest arrived.',
          brandWords: 'Seed: waiting for one material, back in production the same day.',
          status: WorkOrderHoldStatus.LIFTED,
          placedAt: T.held,
          placedById: ownerId,
          liftedAt: T.lifted,
          liftedById: ownerId,
          liftReason: 'Seed: the rest of the lining arrived.',
          ...stamp(T.held),
        },
        update: {},
        select: { id: true },
      })
    }),
  )

  // B-PR-23: "Urgent – asked" — P1's buyer asks SEED-SO-0004 Urgent, needed by a day to come; in P1's own scope (the portal's
  // command), once.
  await db.withScope({ audience: 'partner', tenantId, actorId: buyer, partyId: p1 }, (client) =>
    client.orderChangeRequest.createMany({
      data: [
        {
          id: urgentAsk.requestId,
          companyId: companyA,
          partyId: p1,
          orderId: urgentAsk.orderId,
          kind: 'RUSH',
          reason: 'Seed: our shop opens the new season early; we need this order by then.',
          requestedDate: seedAt('2026-12-04T00:00:00.000Z'),
          createdAt: T.asked,
          updatedAt: T.asked,
          createdById: buyer,
        },
      ],
      skipDuplicates: true,
    }),
  )

  return { rowIds, orderIds, batchIds, issue, holdId, urgentAsk }
}
