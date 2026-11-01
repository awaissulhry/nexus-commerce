import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { operationFor, standingScans } from '@nexus/factory-domain/production/scans/rules'
import { clockOutWarning, continueWords, minutesText, pausedWords, secondsSoFar, stretchesOf, type WorkPlace } from '@nexus/factory-domain/production/terminal/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { bundleFlowOf } from '../bundles/flow'
import { floorOf, scanWorkOrder } from '../scans/access'
import { readBundleScans, readOperations, readStations } from '../scans/store'
import { refuseTiming } from './access'
import { resolveBundle, openWorkOf, stateView, subjectOf, type BundleRef } from './timing'
import { bundleCodes, operationsById, readMembers, readOperationRows, readWorkOrderRows, workOrderNumbers } from './store'
import { deviceStationOf, siteTimeZone } from '../scans/store'
import { scanSubjectFor } from '../settings/subject'

/**
 * The timing's reads (B-W2b-40). Floor (production.scan, the device's own site): the subject's open work (the operation
 * screen, Home's "Continue", the sign-in's "Continue bundle B-000123 at Op 30?" after a clock-out, the clock page's "Clock
 * out?" warning) and one bundle at an operation (state, its own clock, the buttons). Office (workorders.view, part of the
 * work order record): the minutes per operation of a work order — the work order's, never a person's (Statuto art. 4):
 * no worker, no station, no list by person.
 */

async function floorFacts(caller: CommandCaller) {
  const context = floorOf(caller)
  return caller.withClient(async (db) => ({ context, stationId: await deviceStationOf(db, context.deviceId), scanSubject: await scanSubjectFor(db, context.siteId), timeZone: await siteTimeZone(db, context.siteId) }))
}

/** GET /production/terminal/open: the signed-in worker's (or the station's) open work, running first, then paused. */
export async function openWork(caller: CommandCaller) {
  const facts = await floorFacts(caller)
  const subject = subjectOf(facts)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const open = await openWorkOf(db, facts.context.siteId, subject, now)
    const codes = await bundleCodes(db, open.map((entry) => entry.bundleId))
    const numbers = await workOrderNumbers(db, open.map((entry) => entry.workOrderId))
    const operations = await operationsById(db, open.map((entry) => entry.workOrderOperationId))
    const members = await readMembers(db, open.flatMap((entry) => entry.rows.map((row) => row.id)))
    const items = open
      .map((entry) => {
        const operation = operations.get(entry.workOrderOperationId) ?? { id: entry.workOrderOperationId, seq: 0, code: '', name: '' }
        const place: WorkPlace = { bundleCode: codes.get(entry.bundleId) ?? '', operation }
        const view = stateView(entry.rows, subject, members)
        return {
          bundleId: entry.bundleId,
          bundleCode: place.bundleCode,
          workOrderId: entry.workOrderId,
          number: numbers.get(entry.workOrderId) ?? '',
          operation,
          ...view,
          words: view.state === 'PAUSED' ? pausedWords(place) : null,
          continueWords: view.state === 'PAUSED' ? continueWords(place) : null,
        }
      })
      .sort((a, b) => (a.state === b.state ? (a.startedAt ?? '').localeCompare(b.startedAt ?? '') : a.state === 'RUNNING' ? -1 : 1))
    const offer = items.find((item) => item.pausedAtClockOut) ?? null
    const running = items.filter((item) => item.state === 'RUNNING')
    return {
      items,
      /** After a clock-out paused work: "Continue bundle B-000123 at Op 30?" (the sign-in's card; its main action is the RESUME). */
      offer: offer ? { bundleId: offer.bundleId, workOrderOperationId: offer.operation.id, words: offer.continueWords! } : null,
      /** The clock page's "Clock out?" pop-up: what a clock-out pauses (the running work). */
      clockOutWarning: clockOutWarning(running.map((item) => ({ bundleCode: item.bundleCode, operation: item.operation }))),
      serverTime: toUtcIso(now),
    }
  })
}

/**
 * GET /production/terminal/state: one bundle at an operation as the operation screen shows it: the operation named, a
 * coupon's, the subject's open work on the bundle, else the one this station does next (as a report decides it).
 */
export async function bundleState(caller: CommandCaller, query: BundleRef) {
  const facts = await floorFacts(caller)
  const { bundle, workOrder } = await resolveBundle(caller, facts.context, query)
  const subject = subjectOf(facts)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const operations = await readOperations(db, workOrder.id)
    const coupon = query.code !== undefined ? await db.bundleCoupon.findFirst({ where: { code: query.code.trim().toUpperCase(), bundleId: bundle.id, status: 'ACTIVE' }, select: { workOrderOperationId: true } }) : null
    let operationId: string | null = query.workOrderOperationId ?? coupon?.workOrderOperationId ?? null
    if (!operationId) {
      const mine = (await openWorkOf(db, facts.context.siteId, subject, now)).find((entry) => entry.bundleId === bundle.id)
      operationId = mine?.workOrderOperationId ?? null
    }
    if (!operationId) {
      const counts = await readBundleScans(db, bundle.id)
      const flow = await bundleFlowOf(db, bundle, operations, standingScans(counts))
      const station = facts.stationId ? ((await readStations(db, [facts.stationId])).get(facts.stationId) ?? null) : null
      const found = operationFor({ operations, station: station ? { code: station.code, kind: station.kind } : null, standing: flow.standing, bundleId: bundle.id, bundle: { code: bundle.code, quantity: flow.quantity, status: bundle.status, replacedCodes: bundle.replacedCodes } })
      if (!found.ok) refuseTiming(found.refusal)
      operationId = (found as { operation: { id: string } }).operation.id
    }
    const operation = operations.find((entry) => entry.id === operationId)
    if (!operation) throw new NotFoundError(`This is not an operation of work order ${workOrder.number}.`)
    const rows = await readOperationRows(db, bundle.id, operation.id)
    const members = await readMembers(db, rows.map((row) => row.id))
    return {
      bundle: { id: bundle.id, code: bundle.code, quantity: bundle.quantity, status: bundle.status },
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
      operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
      timing: stateView(rows, subject, members),
      serverTime: toUtcIso(now),
    }
  })
}

/**
 * GET /production/terminal/work-orders/:workOrderId/timing (office, workorders.view): per operation of the work order
 * the timed minutes (closed stretches, pauses left out), the person-minutes (a team counts once per member), what runs or
 * is paused now (counts), the stretches, hand-backs and pieces-so-far reports, and the pauses per reason code (count and
 * minutes). The work order's figures: no worker, no station, nothing per person (Statuto art. 4; Owner answers W1, F2).
 */
export async function workOrderTiming(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, 'workorders.view')
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const operations = await readOperations(db, workOrder.id)
    const rows = await readWorkOrderRows(db, workOrder.id)
    const members = await readMembers(db, rows.filter((row) => row.kind === 'START' || row.kind === 'RESUME').map((row) => row.id))
    const groups = new Map<string, typeof rows>()
    for (const row of rows) groups.set(`${row.bundleId}|${row.workOrderOperationId}`, [...(groups.get(`${row.bundleId}|${row.workOrderOperationId}`) ?? []), row])
    const perOperation = new Map<string, { seconds: number; personSeconds: number; openSeconds: number; stretches: number; running: number; paused: number; handedBack: number; partials: number; pieces: number; pauses: Map<string, { count: number; seconds: number }> }>()
    const accOf = (operationId: string) => {
      let acc = perOperation.get(operationId)
      if (!acc) perOperation.set(operationId, (acc = { seconds: 0, personSeconds: 0, openSeconds: 0, stretches: 0, running: 0, paused: 0, handedBack: 0, partials: 0, pieces: 0, pauses: new Map() }))
      return acc
    }
    for (const group of groups.values()) {
      const acc = accOf(group[0]!.workOrderOperationId)
      for (const stretch of stretchesOf(group, members)) {
        acc.stretches += 1
        acc.seconds += stretch.secondsClosed
        acc.personSeconds += stretch.personSecondsClosed
        if (stretch.open === 'RUNNING') acc.running += 1
        if (stretch.open === 'PAUSED') acc.paused += 1
        if (stretch.open !== null) acc.openSeconds += secondsSoFar(stretch, now).seconds - stretch.secondsClosed
        if (stretch.closedBy?.kind === 'HAND_BACK') acc.handedBack += 1
        for (const pause of stretch.pauses) {
          const entry = acc.pauses.get(pause.code) ?? { count: 0, seconds: 0 }
          acc.pauses.set(pause.code, { count: entry.count + 1, seconds: entry.seconds + pause.seconds })
        }
      }
      for (const row of group) {
        if (row.kind === 'PARTIAL') {
          acc.partials += 1
          acc.pieces += row.goodQuantity + row.scrapQuantity + row.reworkQuantity
        }
      }
    }
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
      operations: operations.map((operation) => {
        const acc = perOperation.get(operation.id)
        return {
          operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
          timedMinutes: minutesText(acc?.seconds ?? 0),
          personMinutes: minutesText(acc?.personSeconds ?? 0),
          /** The running parts of open stretches so far (not in timedMinutes until they close). */
          openMinutes: minutesText(acc?.openSeconds ?? 0),
          stretches: acc?.stretches ?? 0,
          running: acc?.running ?? 0,
          paused: acc?.paused ?? 0,
          handedBack: acc?.handedBack ?? 0,
          partials: acc?.partials ?? 0,
          piecesSoFar: acc?.pieces ?? 0,
          pauses: [...(acc?.pauses.entries() ?? [])].map(([code, entry]) => ({ code, count: entry.count, minutes: minutesText(entry.seconds) })).sort((a, b) => a.code.localeCompare(b.code)),
        }
      }),
      serverTime: toUtcIso(now),
    }
  })
}

