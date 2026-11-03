import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { repairMinutes, repairStateOf } from '@nexus/factory-domain/production/repair/rules'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { workerGateFor, workersAmong } from '../../people/privacy/worker-gate'
import { may, officeOf } from './access'
import { readRepair } from './store'

/**
 * A rework's repair in the office (B-W2b-126; MES-132; design production.scrap pop:sc-item, a rework row): where it stands at
 * the repair station, scanned in when and at which station, scanned out when, the repair minutes (per rework, never per
 * person), the garments that came out good and scrapped. Office, production.scrap.view (the rework's company and site).
 *
 * Who scanned it in and out comes from the scans' audit rows (the device's signed-in person) and goes through THE rule
 * (people/privacy worker-gate, B-W2b-F3): with the site's PERFORMANCE gate not open the answer says a person is on it
 * (`workerHidden`) and never who. A list never names who repaired: only this one record, behind the gate.
 */

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

/** GET /production/repair/:reworkId. */
export async function repairRecord(caller: CommandCaller, reworkId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const row = await readRepair(db, reworkId)
    if (!row || !may(context, PRODUCTION_SCRAP_VIEW, row)) throw new NotFoundError('Rework not found.')
    const order = await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { id: true, number: true } })
    const station = row.repairStationId ? await db.station.findUnique({ where: { id: row.repairStationId }, select: { id: true, code: true } }) : null
    const audits = await db.auditLog.findMany({
      where: { recordType: 'ReworkOrder', recordId: row.id, action: { in: ['production.repairIn', 'production.repairOut'] }, audience: 'FLOOR' },
      select: { action: true, actorId: true },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    })
    const gate = await workerGateFor(db, row.siteId)
    const actorOfStep = (action: string) => audits.find((entry) => entry.action === action)?.actorId ?? null
    const ids = [actorOfStep('production.repairIn'), actorOfStep('production.repairOut')]
    const workers = await workersAmong(db, ids)
    const names = new Map(
      (await db.worker.findMany({ where: { id: { in: gate.lookup(ids.filter((id): id is string => id !== null && workers.has(id))) } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName]),
    )
    const person = (id: string | null) => (id && workers.has(id) ? gate.person(id, names) : null)
    const now = serverClock.now()
    return {
      repair: {
        reworkId: row.id,
        workOrder: { id: row.workOrderId, number: order?.number ?? '' },
        status: row.status,
        state: repairStateOf(row),
        repairInAt: at(row.repairInAt),
        repairOutAt: at(row.repairOutAt),
        station: station ? { id: station.id, code: station.code } : null,
        minutes: repairMinutes(row.repairInAt, row.repairOutAt, row.repairOutAt ? undefined : now),
        goodQuantity: row.goodQuantity,
        scrapQuantity: row.scrapQuantity,
        scannedInBy: person(ids[0] ?? null),
        scannedOutBy: person(ids[1] ?? null),
        // A person scanned it and the PERFORMANCE gate keeps them back (never who).
        workerHidden: ids.some((id) => id !== null && workers.has(id) && gate.hidden(id)),
      },
    }
  })
}
