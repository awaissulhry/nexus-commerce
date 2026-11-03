import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_REPAIR } from '@nexus/factory-domain/production/repair/permissions'
import { compareRepairRows, REPAIR_LIMITS, repairMinutes, repairStateOf, repairTimeOf, scanRefusal, type RepairStep } from '@nexus/factory-domain/production/repair/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { assertFloorReady } from '../bundles/bundles'
import { assertMay, floorOf, may, refuse } from './access'
import { deviceStationOf, lockRepair, readOrder, readRepair, REPAIR_COLUMNS, repairFacts, type Reader, type RepairRow } from './store'

/**
 * The repair station on the floor (B-W2b-126; MES-132; design floor.mywork "repair queue (W2b, MES-132)"). A tablet with
 * production.repair, at its own site only:
 *
 *   GET  /production/repair/station        the site's open rework that is not scanned out, WAITING or IN_REPAIR, this
 *                                          station's first (what it scanned in, then what was sent back to an operation of its
 *                                          work centre), then the rest of the site; held work orders last in their group, then
 *                                          the due date, then the oldest. No person, no money, no pace.
 *   POST /production/repair/:reworkId/in   ONE command: the work order's issue lock (as every rework move), the row FOR UPDATE,
 *                                          the rules (the bundle scanned is the rework's, a station, the work order open and
 *                                          not held) → the scan time (a queued one: the tablet's when believable) and the
 *                                          station; an OPEN rework starts with it → audit, production.repair_scanned.
 *   POST /production/repair/:reworkId/out  ONE command: as above → scanned out (never before the scan in) and the rework
 *                                          DONE with the garments that came out good and those scrapped, in the same write
 *                                          (the guard freezes a DONE rework) → audit, production.repair_scanned.
 *
 * No version from the tablet: each scan is set once, a retry under the same key answers from the receipt (B-W2b-77), and a
 * second scan of the same step is refused in words. Repair minutes = out − in, per rework: never per person, and kept apart
 * from piece pay (no operation scan, no earnings entry). The audit row names the device and its signed-in person, as every
 * floor write; an office read names them only behind the site's PERFORMANCE gate (./office.ts).
 */

export interface ScanBody {
  /** The bundle label scanned (it must be the rework's bundle); left out: a row tapped on a rework with no bundle. */
  readonly code?: string | undefined
  /** OUT: the garments that came out good and those scrapped. */
  readonly good?: number | undefined
  readonly scrap?: number | undefined
  /** A queued scan: the tablet's clock (believed when believable). */
  readonly occurredAt?: string | undefined
}

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

/** The queue's row views for this tablet. */
async function queueRows(db: Reader, rows: readonly RepairRow[], station: { readonly id: string; readonly workCentreId: string } | null) {
  const facts = await repairFacts(db, rows)
  return rows
    .flatMap((row) => {
      const state = repairStateOf(row)
      if (!state) return []
      const order = facts.orders.get(row.workOrderId)
      const style = order ? facts.styles.get(order.styleId) : undefined
      const bundle = row.bundleId ? facts.bundles.get(row.bundleId) : undefined
      const foundAt = row.foundAtOperationId ? facts.operations.get(row.foundAtOperationId) : undefined
      const reworkAt = facts.operations.get(row.reworkAtOperationId)
      const reason = facts.reasons.get(row.reasonCode)
      const here = station !== null && (row.repairStationId === station.id || (state === 'WAITING' && reworkAt?.workCentreId === station.workCentreId))
      return [
        {
          reworkId: row.id,
          workOrder: {
            id: row.workOrderId,
            number: order?.number ?? '',
            status: order?.status ?? 'RELEASED',
            dueDate: order?.dueDate ? order.dueDate.toISOString().slice(0, 10) : null,
            rush: order?.rush ?? false,
            holdReason: order?.status === 'ON_HOLD' ? (order.holdReason ?? null) : null,
            style: { code: style?.code ?? '', name: style?.name ?? '' },
          },
          cell: facts.cellOf.get(row.workOrderSizeId) ?? { id: row.workOrderSizeId, colourwayCode: '', size: '' },
          bundle: bundle ? { id: bundle.id, code: bundle.code, part: bundle.part } : null,
          quantity: row.quantity,
          reason: { code: row.reasonCode, it: reason?.labelIt ?? null, en: reason?.labelEn ?? null },
          description: row.description,
          foundAt: foundAt ? { seq: foundAt.seq, code: foundAt.code, name: foundAt.name } : null,
          reworkAt: { seq: reworkAt?.seq ?? 0, code: reworkAt?.code ?? '', name: reworkAt?.name ?? '' },
          state,
          here,
          station: row.repairStationId ? { id: row.repairStationId, code: facts.stations.get(row.repairStationId) ?? '' } : null,
          inAt: at(row.repairInAt),
          since: toUtcIso(row.createdAt),
          held: order?.status === 'ON_HOLD',
          version: row.version,
        },
      ]
    })
    .sort((a, b) => compareRepairRows({ state: a.state, here: a.here, held: a.held, dueDate: a.workOrder.dueDate, since: a.inAt ?? a.since, id: a.reworkId }, { state: b.state, here: b.here, held: b.held, dueDate: b.workOrder.dueDate, since: b.inAt ?? b.since, id: b.reworkId }))
}

/** GET /production/repair/station. */
export async function stationQueue(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const station = await deviceStationOf(db, context.deviceId)
    const where: Prisma.ReworkOrderWhereInput = { siteId: context.siteId, status: { in: ['OPEN', 'IN_PROGRESS'] }, repairOutAt: null }
    // A tablet reads only what its grants reach (its site, by can()).
    const rows = (await db.reworkOrder.findMany({ where, select: REPAIR_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: REPAIR_LIMITS.rows })).filter((row) => may(context, PRODUCTION_REPAIR, row))
    const views = await queueRows(db, rows, station)
    return {
      asOf: toUtcIso(now),
      station: station ? { id: station.id, code: station.code, name: station.name } : null,
      rows: views,
      counts: { here: views.filter((row) => row.here).length, waiting: views.filter((row) => row.state === 'WAITING').length, inRepair: views.filter((row) => row.state === 'IN_REPAIR').length },
    }
  })
}

/** POST /production/repair/:reworkId/in|out: one command each. */
export async function scanRepair(caller: CommandCaller, reworkId: string, step: RepairStep, body: ScanBody, idempotencyKey?: string) {
  const context = floorOf(caller)
  const known = await caller.withClient((db) => readRepair(db, reworkId))
  assertMay(context, PRODUCTION_REPAIR, known, 'Rework')
  // The floor's work needs its site's floor ready (the privacy gate), as every rework move from a tablet.
  await assertFloorReady(caller, context, known!.siteId)
  const deviceTime = body.occurredAt ? new Date(body.occurredAt) : undefined
  const name = step === 'IN' ? 'production.repairIn' : 'production.repairOut'
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { reworkId, step, ...body }, ...(deviceTime && Number.isFinite(deviceTime.getTime()) ? { deviceTime } : {}) }, async (tools) => {
    const { tx } = tools
    await lockWorkOrderIssues(tx, context.tenantId, known!.workOrderId)
    const rework = (await lockRepair(tx, reworkId))!
    const workOrder = (await readOrder(tx, rework.workOrderId))!
    const station = await deviceStationOf(tx, context.deviceId)
    const bundle = rework.bundleId ? await tx.bundle.findUnique({ where: { id: rework.bundleId }, select: { id: true, code: true } }) : null
    const inStation = rework.repairStationId ? await tx.station.findUnique({ where: { id: rework.repairStationId }, select: { code: true } }) : null
    const refusal = scanRefusal({ step, workOrder, rework: { ...rework, bundleCode: bundle?.code ?? null, stationCode: inStation?.code ?? null }, station, code: body.code, good: body.good, scrap: body.scrap })
    if (refusal) refuse(refusal)
    const when = repairTimeOf(deviceTime ?? null, tools.now, step === 'OUT' ? rework.repairInAt : null)
    const data: Prisma.ReworkOrderUncheckedUpdateInput =
      step === 'IN'
        ? { repairInAt: when, repairStationId: station!.id, version: { increment: 1 }, updatedAt: tools.now, ...(rework.status === 'OPEN' ? { status: 'IN_PROGRESS', startedAt: when } : {}) }
        : { repairOutAt: when, status: 'DONE', doneAt: when, goodQuantity: body.good!, scrapQuantity: body.scrap!, version: { increment: 1 }, updatedAt: tools.now }
    await tx.reworkOrder.update({ where: { id: rework.id }, data, select: { id: true } })
    const after = (await readRepair(tx, rework.id))!
    const minutes = step === 'OUT' ? repairMinutes(after.repairInAt, after.repairOutAt) : null
    const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
    tools.audit({
      action: name,
      recordType: 'ReworkOrder',
      recordId: rework.id,
      ...scope,
      before: { status: rework.status, repairInAt: at(rework.repairInAt), repairOutAt: at(rework.repairOutAt), goodQuantity: rework.goodQuantity, scrapQuantity: rework.scrapQuantity },
      after: { status: after.status, repairInAt: at(after.repairInAt), repairStationId: after.repairStationId, repairOutAt: at(after.repairOutAt), goodQuantity: after.goodQuantity, scrapQuantity: after.scrapQuantity, minutes, deviceId: context.deviceId, code: body.code ?? null },
    })
    tools.emit({
      type: 'production.repair_scanned',
      subject: workOrder.id,
      ...scope,
      payload: {
        workOrderId: workOrder.id,
        number: workOrder.number,
        reworkId: rework.id,
        bundleId: rework.bundleId,
        step,
        stationId: after.repairStationId!,
        status: after.status,
        repairInAt: toUtcIso(after.repairInAt!),
        repairOutAt: at(after.repairOutAt),
        minutes,
        goodQuantity: after.goodQuantity,
        scrapQuantity: after.scrapQuantity,
      },
    })
    const [view] = await queueRows(tx, [after], station)
    return {
      repair: {
        reworkId: after.id,
        workOrder: { id: workOrder.id, number: workOrder.number },
        status: after.status,
        step,
        repairInAt: at(after.repairInAt),
        repairOutAt: at(after.repairOutAt),
        goodQuantity: after.goodQuantity,
        scrapQuantity: after.scrapQuantity,
        version: after.version,
        row: view ?? null,
      },
    }
  })
  return { ...result, replayed }
}
