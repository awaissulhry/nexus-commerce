import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { floorGroupOf } from '@nexus/factory-domain/production/baskets/signals'
import { nextOfPlace, type DepartmentLook } from '@nexus/factory-domain/production/baskets/steps'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { SCAN_KINDS, standingScans, type ScanFact } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { myWorkMessages } from '../dispatch/mywork-messages'
import { floorOf, systemView } from '../scans/access'
import { deviceStationOf, SCAN_COLUMNS, type Reader } from '../scans/store'
import { scanSubjectFor } from '../settings/subject'
import { readBundlesRows, readMembers } from '../terminal/store'
import { stateView, subjectOf } from '../terminal/timing'
import type { HomeView } from './contract'
import { routeAndPlace } from './read'
import { departmentLooks, hereOfDevice, operationsOf, orderFactsOf, readCalls, readEdits, readFirstFlags, readLate, readMoves, stepDepartmentsOf } from './store'

/**
 * GET /production/baskets/home (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 3 "fl1"; design "the basket on a phone",
 * the worker's home): the phone's department (its pick, settle 2; a tablet: its station's kind's), then
 *
 *   For you         what concerns this person now, newest first: the "design changed" note of a work order in hand, the
 *                   answer to their ask and the problem they told that was solved (the last day, raised by this person or this
 *                   device), and for the team leader (floor.lead) every open problem and ask of the site. Whether it was seen
 *                   stays on the device (settle 12: no read record of a worker)
 *   In this department   the open baskets whose place (factory-domain baskets/place, their own route) is a step of this
 *                   department
 *   Coming next     the open baskets whose NEXT step is of this department
 *
 * The open baskets of the site's released and in-progress work orders, read in the floor's own scope (row-level security: its
 * site only); a basket of a restricted order (need to know) shows only to the team leader and to the people given it. The
 * customer's CODE and the picture come through the tenant's system view after these checks, as the basket read's. No name.
 */

const OPEN_WORK_ORDERS = ['RELEASED', 'IN_PROGRESS'] as const
const IN_CALLS = ['SENT', 'SEEN', 'ON_THE_WAY'] as const
const DESIGN_CHANGED = /^The design changed:/
const DAY_MS = 24 * 60 * 60 * 1000
/** The most work orders, rows per list and For-you lines one home reads. */
export const HOME_LIMITS = Object.freeze({ workOrders: 200, rows: 100, forYou: 30, pictures: 30 })

type Row = HomeView['here'][number]
type Item = HomeView['forYou'][number]

export async function basketHome(caller: CommandCaller): Promise<HomeView> {
  const context: FloorContext = floorOf(caller)
  const actor = actorOf(context)
  if (!holds(actor, PRODUCTION_SCAN)) throw new ForbiddenError('The baskets are read on a floor device signed in to scan.')
  const lead = holds(actor, 'floor.lead')
  const now = serverClock.now()

  const read = await caller.withClient(async (db: Reader) => {
    const departments = await departmentLooks(db)
    const here = await hereOfDevice(db, context.deviceId, departments)
    const department = departments.find((entry) => entry.id === here.departmentId) ?? null
    const workOrders = await db.workOrder.findMany({ where: { siteId: context.siteId, status: { in: [...OPEN_WORK_ORDERS] } }, select: { id: true }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: HOME_LIMITS.workOrders })
    const workOrderIds = workOrders.map((row) => row.id)
    const bundles = workOrderIds.length === 0 ? [] : await db.bundle.findMany({ where: { workOrderId: { in: workOrderIds }, status: 'ACTIVE' }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true } })
    const bundleIds = bundles.map((row) => row.id)
    const operations = await operationsOf(db, workOrderIds)
    const stepDepartment = await stepDepartmentsOf(db, workOrderIds, [...operations.values()].flat(), departments)
    const scans = bundleIds.length === 0 ? [] : ((await db.operationScan.findMany({ where: { bundleId: { in: bundleIds }, kind: { in: [...SCAN_KINDS] } }, select: SCAN_COLUMNS, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })) as unknown as ScanFact[])
    const scansOf = new Map<string, ScanFact[]>()
    for (const scan of scans) scansOf.set(scan.bundleId, [...(scansOf.get(scan.bundleId) ?? []), scan])
    const moves = await readMoves(db, bundleIds)
    const edits = await readEdits(db, bundleIds)
    const first = await readFirstFlags(db, bundleIds)
    const late = await readLate(db, workOrderIds)
    const openCalls = bundleIds.length === 0 ? [] : await readCalls(db, { bundleId: { in: bundleIds }, status: { in: [...IN_CALLS] } }, 500)
    const since = new Date(now.getTime() - DAY_MS)
    const siteCalls = await readCalls(db, { siteId: context.siteId, bundleId: { not: null }, OR: [{ status: { in: [...IN_CALLS] } }, { solvedAt: { gte: since } }] }, 200)
    const given = new Set((await db.dispatchAssignment.findMany({ where: { workerId: context.actorId }, select: { bundleIds: true } })).flatMap((row) => row.bundleIds))
    const stationId = await deviceStationOf(db, context.deviceId)
    const scanSubject = await scanSubjectFor(db, context.siteId)
    return { department, bundles, operations, stepDepartment, scansOf, moves, edits, first, late, openCalls, siteCalls, given, stationId, scanSubject }
  })

  // Each open basket's place and next step on its own route.
  const departmentId = read.department?.id ?? null
  const placed = read.bundles.flatMap((bundle) => {
    const operations = read.operations.get(bundle.workOrderId) ?? []
    const { route, place } = routeAndPlace(operations, standingScans(read.scansOf.get(bundle.id) ?? []), bundle.id, read.moves.get(bundle.id) ?? [], read.edits.get(bundle.id) ?? [])
    if (place.operationId === null) return []
    const nextId = nextOfPlace(route, place)
    const at = read.stepDepartment.get(place.operationId)?.id ?? null
    const next = nextId ? (read.stepDepartment.get(nextId)?.id ?? null) : null
    return [{ bundle, operationId: place.operationId, list: departmentId === null ? null : at === departmentId ? ('here' as const) : next === departmentId ? ('comingNext' as const) : null }]
  })
  const listed = placed.filter((entry) => entry.list !== null)

  // What the floor role may not read: the order (restricted? its picture) and the customer's code, through the system view.
  const system = systemView(caller)
  const orderOf = new Map<string, Awaited<ReturnType<typeof orderFactsOf>>>()
  for (const entry of listed) {
    if (orderOf.has(entry.bundle.workOrderId) || orderOf.size >= HOME_LIMITS.pictures) continue
    orderOf.set(entry.bundle.workOrderId, await system.withClient((db: Reader) => orderFactsOf(db, { workOrderId: entry.bundle.workOrderId, workOrderSizeId: entry.bundle.workOrderSizeId, siteId: context.siteId })))
  }
  const shown = listed.filter((entry) => lead || !orderOf.get(entry.bundle.workOrderId)?.floorRestricted || read.given.has(entry.bundle.id))

  // The work state of each shown basket at its step, in the viewer's words.
  const states = await caller.withClient(async (db: Reader) => {
    const rows = await readBundlesRows(db, shown.map((entry) => entry.bundle.id))
    const members = await readMembers(db, rows.map((row) => row.id))
    const subject = subjectOf({ context, stationId: read.stationId, scanSubject: read.scanSubject })
    return new Map(
      shown.map((entry) => {
        const view = stateView(rows.filter((row) => row.bundleId === entry.bundle.id && row.workOrderOperationId === entry.operationId), subject, members)
        return [entry.bundle.id, view.state === 'RUNNING' ? ('WORKING' as const) : view.state === 'PAUSED' ? ('PAUSED' as const) : ('WAITING' as const)]
      }),
    )
  })

  const look = (operationId: string): DepartmentLook | null => read.stepDepartment.get(operationId) ?? null
  const problemOn = new Set(read.openCalls.filter((call) => floorGroupOf(call.typeCode) === 'PROBLEM').map((call) => call.bundleId))
  const lateOn = (bundle: { readonly id: string; readonly workOrderId: string }) => read.late.some((warning) => warning.workOrderId === bundle.workOrderId && (warning.bundleId === null || warning.bundleId === bundle.id))
  const row = (entry: (typeof shown)[number]): Row => ({
    bundleId: entry.bundle.id,
    code: entry.bundle.code,
    // A picture costs a presign each: the home leaves it to the basket page (null here; the page reads it).
    picture: null,
    customerCode: orderOf.get(entry.bundle.workOrderId)?.customerCode ?? '',
    step: { operationId: entry.operationId, department: look(entry.operationId) },
    state: states.get(entry.bundle.id) ?? 'WAITING',
    flags: { first: read.first.has(entry.bundle.id), late: lateOn(entry.bundle), problem: problemOn.has(entry.bundle.id) },
  })
  // "Do this first" first, then as the work orders come (due first).
  const ordered = (list: 'here' | 'comingNext') => shown.filter((entry) => entry.list === list).sort((a, b) => Number(read.first.has(b.bundle.id)) - Number(read.first.has(a.bundle.id))).slice(0, HOME_LIMITS.rows).map(row)

  // ---- For you ----
  const codeOf = new Map(read.bundles.map((bundle) => [bundle.id, bundle.code]))
  const items: Item[] = []
  const mine = (call: (typeof read.siteCalls)[number]) => call.workerId === context.actorId || call.deviceId === context.deviceId
  for (const call of read.siteCalls) {
    if (!call.bundleId) continue
    const group = floorGroupOf(call.typeCode)
    const code = codeOf.get(call.bundleId) ?? null
    if (call.status === 'SOLVED' && call.solvedAt && mine(call)) {
      if (group === 'ASK' && (call.resolutionNote ?? '').trim() !== '') items.push({ kind: 'ANSWER', bundleId: call.bundleId, code, words: call.resolutionNote!.trim(), at: toUtcIso(call.solvedAt) })
      else if (group === 'PROBLEM') items.push({ kind: 'SOLVED', bundleId: call.bundleId, code, words: call.typeCode, at: toUtcIso(call.solvedAt) })
    }
    if (lead && (IN_CALLS as readonly string[]).includes(call.status) && group !== null) items.push({ kind: group, bundleId: call.bundleId, code, words: call.typeCode, at: toUtcIso(call.sentAt) })
  }
  const inHand = new Map(shown.map((entry) => [entry.bundle.workOrderId, entry.bundle]))
  if (inHand.size > 0) {
    const notes = (await myWorkMessages(caller)).messages.filter((note) => DESIGN_CHANGED.test(note.text) && inHand.has(note.workOrder.id))
    for (const note of notes) {
      const bundle = inHand.get(note.workOrder.id)!
      items.push({ kind: 'CHANGED_DESIGN', bundleId: bundle.id, code: bundle.code, words: note.text, at: note.at })
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  return { department: read.department, forYou: items.slice(0, HOME_LIMITS.forYou), here: ordered('here'), comingNext: ordered('comingNext') }
}
