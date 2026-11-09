import type { Prisma } from '../src/generated/prisma/client'
import { ChangeEffect, ChangeItemKind, ChangePriority, ChangeRequestSource, ChangeRequestStatus, WipDisposition } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction } from './production'
import { seed as seedSamples } from './samples'

/**
 * The change control seed (W2b-4, schema wave 29/33, B-W2b-212), per tenant of seed/_core.ts, written in the tenant's office
 * scope as the app does. The CLI runs the seed files in name order and this one sorts early: it runs the samples seed (→
 * production, product, parties, compliance, auth) first, all idempotent. Every name, number and value is made up. No new
 * style revision is made (the product and production seeds own them; a draft would change what their tests see), so the
 * change order stays a DRAFT without its proposed revision.
 *
 *   requests   on SEED-JKT-02: SEED-CR-0001 from the office about WO-0001 at plant A1 (OPEN, high); a request from A1's floor
 *              about WO-0001 (OPEN, not numbered yet, no creator: a device names no worker); SEED-CR-0002 from the brand P1
 *              (ACCEPTED by a second office user, carried by SEED-ECO-0001); on SEED-JKT-01: SEED-CR-0003 from the proto round
 *              SEED-SR-0002 (REJECTED, with why).
 *   order      SEED-ECO-0001, DRAFT, from SEED-JKT-02's released revision 1, for the next order: a CHANGE line (the leather
 *              line's quantity, before and after), WO-0001's work in progress finished on the old revision, WO-0002 held; one
 *              required approval asked of the member (not the author, the seed's actor), undecided.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first request is the plain OPEN office one (an office row at A1 the floor may not copy), the first change order the
 * DRAFT one, its first line the CHANGE line (one work in progress line per work order) and the first approval undecided. A
 * floor session inserts the copy of the floor's request. Rows are written once.
 */

const T = {
  raised: new Date('2026-11-03T08:00:00.000Z'),
  floor: new Date('2026-11-03T10:30:00.000Z'),
  decided: new Date('2026-11-04T09:00:00.000Z'),
  drafted: new Date('2026-11-04T15:00:00.000Z'),
} as const

export interface ChangesSeed {
  readonly requestIds: { readonly office: string; readonly floor: string; readonly customer: string; readonly sample: string }
  readonly changeOrderId: string
  readonly itemIds: { readonly change: string; readonly wipStarted: string; readonly wipDraft: string }
  readonly approvalId: string
}

export async function seed(context: SeedContext): Promise<ChangesSeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  const samples = await seedSamples(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const P1 = id('party:P1')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const requestIds = { office: firstId('changes:request:office:1'), floor: id('changes:request:floor:1'), customer: id('changes:request:P1:1'), sample: id('changes:request:proto:1') }
  const changeOrderId = firstId('changes:order:JKT-02:1')
  const itemIds = { change: firstId('changes:item:ECO-1:10'), wipStarted: id('changes:item:ECO-1:20'), wipDraft: id('changes:item:ECO-1:30') }
  const approvalId = firstId('changes:approval:ECO-1:member')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.changeOrder.findUnique({ where: { id: changeOrderId }, select: { id: true } })) return

      const jkt01 = await tx.style.findFirstOrThrow({ where: { code: 'SEED-JKT-01' }, select: { id: true } })
      const leatherLine = await tx.bomLine.findFirstOrThrow({ where: { revisionId: production.revisionId }, orderBy: { seq: 'asc' }, select: { id: true, qty: true } })

      // The change order first (a request names the order that carries it).
      await tx.changeOrder.create({
        data: {
          id: changeOrderId,
          companyId: companyA,
          number: 'SEED-ECO-0001',
          styleId: production.styleId,
          fromRevisionId: production.revisionId,
          title: 'More leather for the longer back panel',
          reason: 'The brand asks a back panel 1 cm longer from size 52 up; the cut needs more leather (made-up).',
          priority: ChangePriority.HIGH,
          effect: ChangeEffect.NEXT_ORDER,
          authorId: actorId,
          ...stamp(T.drafted),
        },
        select: { id: true },
      })
      const items: (Prisma.ChangeOrderItemCreateManyInput & { id: string })[] = [
        {
          id: itemIds.change,
          changeOrderId,
          seq: 10,
          kind: ChangeItemKind.CHANGE,
          recordType: 'BomLine',
          recordId: leatherLine.id,
          field: 'qty',
          before: { qty: leatherLine.qty.toFixed(4) },
          after: { qty: leatherLine.qty.add('0.5').toFixed(4) },
          note: 'Half a square foot more per garment (made-up).',
          ...stamp(T.drafted),
        },
        { id: itemIds.wipStarted, changeOrderId, seq: 20, kind: ChangeItemKind.WORK_IN_PROGRESS, siteId: siteA, workOrderId: production.workOrderId, disposition: WipDisposition.FINISH_OLD, note: 'Already cut: finish on revision 1 (made-up).', ...stamp(T.drafted) },
        { id: itemIds.wipDraft, changeOrderId, seq: 30, kind: ChangeItemKind.WORK_IN_PROGRESS, siteId: siteA, workOrderId: production.draftWorkOrderId, disposition: WipDisposition.HOLD, ...stamp(T.drafted) },
      ]
      await tx.changeOrderItem.createMany({ data: items })
      await tx.changeApproval.create({ data: { id: approvalId, changeOrderId, stage: 1, approverId: memberId, required: true, ...stamp(T.drafted) }, select: { id: true } })

      // Requests (PRD-169, PRD-259, MES-006).
      const requests: (Prisma.ChangeRequestCreateManyInput & { id: string })[] = [
        {
          id: requestIds.office,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-CR-0001',
          source: ChangeRequestSource.OFFICE,
          styleId: production.styleId,
          revisionId: production.revisionId,
          workOrderId: production.workOrderId,
          title: 'Reinforce the elbow pocket seam',
          reason: 'Two pockets opened at the final inspection of WO-0001 (made-up).',
          priority: ChangePriority.HIGH,
          ...stamp(T.raised),
        },
        {
          id: requestIds.floor,
          companyId: companyA,
          siteId: siteA,
          source: ChangeRequestSource.FLOOR,
          styleId: production.styleId,
          revisionId: production.revisionId,
          workOrderId: production.workOrderId,
          title: 'Sleeve seam allowance too tight at 54',
          reason: 'The sewing step leaves 6 mm instead of 10 on size 54 (made-up).',
          createdAt: T.floor,
          updatedAt: T.floor,
          createdById: null,
        },
        {
          id: requestIds.customer,
          companyId: companyA,
          number: 'SEED-CR-0002',
          source: ChangeRequestSource.CUSTOMER,
          partyId: P1,
          styleId: production.styleId,
          revisionId: production.revisionId,
          title: 'Back panel 1 cm longer from size 52',
          reason: 'The brand\'s riders find the back short on the bike (made-up).',
          status: ChangeRequestStatus.ACCEPTED,
          decidedAt: T.decided,
          decidedById: memberId,
          changeOrderId,
          ...stamp(T.raised),
          updatedAt: T.drafted,
        },
        {
          id: requestIds.sample,
          companyId: companyA,
          number: 'SEED-CR-0003',
          source: ChangeRequestSource.SAMPLE,
          sampleRoundId: samples.roundIds.proto,
          styleId: jkt01.id,
          title: 'Wider collar',
          reason: 'Proto comment: the collar rubs at the neck (made-up).',
          status: ChangeRequestStatus.REJECTED,
          decidedAt: T.decided,
          decidedById: memberId,
          decisionNote: 'The fit round moves the shoulder pocket instead; the collar stays (made-up).',
          ...stamp(T.raised),
          updatedAt: T.decided,
        },
      ]
      // A new request is OPEN and in no change order: the decided ones are written open, then decided (as the app does).
      await tx.changeRequest.createMany({
        data: requests.map((row) => ({ ...row, status: ChangeRequestStatus.OPEN, decidedAt: null, decidedById: null, decisionNote: null, changeOrderId: null })),
      })
      for (const row of requests.filter((entry) => entry.status !== undefined && entry.status !== ChangeRequestStatus.OPEN)) {
        await tx.changeRequest.update({
          where: { id: row.id },
          data: { status: row.status!, decidedAt: row.decidedAt ?? null, decidedById: row.decidedById ?? null, decisionNote: row.decisionNote ?? null, changeOrderId: row.changeOrderId ?? null, updatedAt: row.updatedAt! },
          select: { id: true },
        })
      }
    }),
  )

  return { requestIds, changeOrderId, itemIds, approvalId }
}
