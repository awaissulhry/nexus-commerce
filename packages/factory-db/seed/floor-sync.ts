import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The floor sync seed (B-W0-30): each seeded cutting tablet (seed/floor-auth.ts: plants A1 and B1) has one event of its
 * queue recorded (a made-up bundle report, in the sync ledger) and one refused action, open (a made-up cut of a hide
 * that was used up: final, with its fix). Made-up data only. It runs after seed/floor-auth.ts (seeds run in name order).
 *
 * Written in each tablet's own floor scope, as its sync writes them; a second run inserts nothing (the rows are found
 * by id first; the ledger is append-only, so no upsert). B1's rows have ids that start with eight f's (still derived from
 * the namespace), so A1's sort first: those are the ones the generated isolation tests copy, inside A1's floor scope.
 * The refused action names no worker (it names the station, as a site that records the station only would).
 */

const RECORDED_AT = new Date('2026-10-28T09:30:00.000Z')
const DEVICE_AT = new Date('2026-10-28T09:12:00.000Z')
const REFUSED_AT = new Date('2026-10-28T09:31:00.000Z')
const REQUEST = 'seed-floor-sync'

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const late = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const tablets = [
    { plant: 'A1', companyId: id('company:A'), siteId: id('site:A1'), rowId: id },
    { plant: 'B1', companyId: id('company:B'), siteId: id('site:B1'), rowId: late },
  ]

  for (const tablet of tablets) {
    const deviceId = id(`device:${tablet.plant}:cutting`)
    const event: Prisma.FloorSyncEventCreateManyInput = {
      id: tablet.rowId(`floor-sync:${tablet.plant}:event:1`),
      siteId: tablet.siteId,
      deviceId,
      clientEventId: `seed-${tablet.plant.toLowerCase()}-event-0001`,
      kind: 'production.scan.report',
      deviceSeq: 1,
      deviceTime: DEVICE_AT,
      serverTime: RECORDED_AT,
      clockSkewSeconds: 4,
      outcome: 'ACCEPTED',
      resultType: 'OperationScan',
      resultId: id(`floor-sync:${tablet.plant}:result:1`),
      requestId: REQUEST,
      createdAt: RECORDED_AT,
    }
    const refused: Prisma.FloorRefusedActionCreateManyInput = {
      id: tablet.rowId(`floor-sync:${tablet.plant}:refused:1`),
      companyId: tablet.companyId,
      siteId: tablet.siteId,
      deviceId,
      clientEventId: `seed-${tablet.plant.toLowerCase()}-event-0002`,
      kind: 'production.cut.log',
      deviceSeq: 2,
      code: 'HIDE_USED_UP',
      message: 'Hide SEED-HD-0001 is used up: its cuts are final but its closing cut.',
      fix: 'Discard it: the hide is used up.',
      final: true,
      summary: { code: 'SEED-HD-0001', sets: 2 },
      payload: { workOrderId: id('work-order:WO-0001'), code: 'SEED-HD-0001', lines: [{ workOrderSizeId: id('work-order:WO-0001:cell:1'), sets: 2 }] },
      workerId: null,
      stationId: id(`site:${tablet.plant}:station:CUT-01`),
      deviceTime: DEVICE_AT,
      serverTime: REFUSED_AT,
      createdAt: REFUSED_AT,
      updatedAt: REFUSED_AT,
    }
    await db.withScope({ audience: 'floor', tenantId, actorId: deviceId, siteId: tablet.siteId }, (client) =>
      client.$transaction(async (tx) => {
        if (!(await tx.floorSyncEvent.findUnique({ where: { id: event.id! }, select: { id: true } }))) await tx.floorSyncEvent.create({ data: event, select: { id: true } })
        if (!(await tx.floorRefusedAction.findUnique({ where: { id: refused.id! }, select: { id: true } }))) await tx.floorRefusedAction.create({ data: refused, select: { id: true } })
      }),
    )
  }
}
