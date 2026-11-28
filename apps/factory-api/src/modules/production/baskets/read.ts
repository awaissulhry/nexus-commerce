import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE } from '@nexus/factory-domain/production/baskets/permissions'
import { basketPlace, effectiveMoves, type BasketPlace } from '@nexus/factory-domain/production/baskets/place'
import { basketRoute, ownRoute, type RouteMarks } from '@nexus/factory-domain/production/baskets/route'
import { floorGroupOf, minutesOpen } from '@nexus/factory-domain/production/baskets/signals'
import { hereOf, nextOfPlace, stepStates, type DepartmentLook } from '@nexus/factory-domain/production/baskets/steps'
import { PRODUCTION_BUNDLES_VIEW } from '@nexus/factory-domain/production/bundles/permissions'
import { standingTicks } from '@nexus/factory-domain/production/checklists/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { standingScans, voidedIds, type ScanOperation } from '@nexus/factory-domain/production/scans/rules'
import { floorFaceOf, type LogActorRow } from '@nexus/factory-domain/sales/order-log/faces'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { holdOnScan } from '../../quality/holds/checks'
import { smallAddresses } from '../../product/images/small-pictures'
import { readBundle } from '../bundles/store'
import { bundleFlowOf } from '../bundles/flow'
import { readTicks, stepsOfOperation } from '../checklists/store'
import { myWorkMessages } from '../dispatch/mywork-messages'
import { floorOrOffice, systemView } from '../scans/access'
import { deviceStationOf, readBundleScans, readOperations, siteTimeZone, type OperationRow, type Reader } from '../scans/store'
import { bundleCard } from '../scans/views'
import { scanSubjectFor } from '../settings/subject'
import { readMembers, readOperationRows } from '../terminal/store'
import { stateView, subjectOf } from '../terminal/timing'
import type { BasketView, HISTORY_KINDS } from './contract'
import { departmentLooks, hereOfDevice, orderFactsOf, readBasketRow, readCalls, readEdits, readFirstFlags, readLate, readMoves, smallPartsOf, stepDepartments, teamLook, teamOfWorker, type CallRow, type EditRow, type MoveRow, type OrderFacts } from './store'

/**
 * GET /production/baskets/:bundleId (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 3 "fl1"; build/briefs/owb-fl1.md steps
 * 1, 3, 4): one basket, on a phone or in the office.
 *
 *   who      the floor with production.scan at its device's own site; the office with production.bundles.view within its
 *            grants (the work order's company, site and customer: the brand wall of scans/access mayScan). The scan card
 *            (scans/views bundleCard) is CALLED with that right, never copied: it answers an unknown basket, another site's
 *            or another customer's as not found (404)
 *   what     the card's facts (code, cell, work order, refusal, first piece), then the basket's own: its route and place
 *            (factory-domain baskets: basketRoute / basketPlace — with no edit and no move exactly today's answers), each
 *            step's department, the phone's department against the route (settle 2, 8), the work state of the step it is
 *            at (the terminal's), the hold (pick B: today's words of holdOnScan, or the first piece the step waits for;
 *            `can.start` false), the flags ("Do this first", "Will be late", the open problem and ask, the newest answer),
 *            the quality step's ticks and photos, the office's notes for the floor of its work order, its history in the
 *            floor's words (the base's floorFaceOf: "You", "Office", a department, never a name), the design page link
 *   walls    the customer's CODE only, never its name, and no price (the floor role reads no party: the order facts come
 *            through the tenant's system view after these checks); no worker's name anywhere in this read; a restricted
 *            order (SalesOrder.floorRestricted, "need to know") shows its basket to the team leader and to the people given it
 *            by name — anyone else reads `restricted: 'RESTRICTED'` with no picture, no notes and no design page
 *
 * The office reads the same answer (no phone department, no notes: the office has the work order's thread).
 */

const IN_CALLS = ['SENT', 'SEEN', 'ON_THE_WAY'] as const
/** The words S3's "Print again → A small change" writes on the work order's floor note (owb-ss2's fixed wording). */
const DESIGN_CHANGED = /^The design changed:/
const FLOOR_LEAD = 'floor.lead'
/** The design page: today's floor instructions screen; the phone hands it the basket (settle 11). */
const DESIGN_PAGE = '/floor/instructions'

type History = BasketView['history'][number]
type HistoryKind = (typeof HISTORY_KINDS)[number]

/** The right this caller reads a basket with, or a 403 in words. */
function readingRight(context: FloorContext | OfficeContext) {
  const actor = actorOf(context)
  if (context.audience === 'floor') {
    if (holds(actor, PRODUCTION_SCAN)) return PRODUCTION_SCAN
    throw new ForbiddenError('A basket is read on a floor device signed in to scan.')
  }
  if (holds(actor, PRODUCTION_BUNDLES_VIEW)) return PRODUCTION_BUNDLES_VIEW
  throw new ForbiddenError('Reading a basket needs the right to see where the bundles are.')
}

/** The code the request names: a basket's id (read at the caller's site) or its ticket's code. */
async function codeOf(caller: CommandCaller, value: string): Promise<string> {
  if (!isUuid(value)) return value
  const row = await caller.withClient((db) => db.bundle.findUnique({ where: { id: value }, select: { code: true } }))
  if (!row) throw new NotFoundError('Not a basket of this site: scan its ticket.')
  return row.code
}

/** The newest open call of a group (PROBLEM, ASK), as the page shows it. */
function callOf(calls: readonly CallRow[], group: 'PROBLEM' | 'ASK', now: Date) {
  const call = calls.find((row) => (IN_CALLS as readonly string[]).includes(row.status) && floorGroupOf(row.typeCode) === group)
  return call ? { callId: call.id, typeCode: call.typeCode, state: call.status, minutes: minutesOpen(call.sentAt, now), escalated: call.escalatedAt !== null, spot: call.spot } : null
}

/** The basket's history (reports that stand, moves, route edits), oldest first, in the floor's words. */
function historyOf(input: { readonly reports: readonly { readonly serverTime: Date; readonly workOrderOperationId: string; readonly workerId: string | null; readonly deviceId: string | null }[]; readonly moves: readonly MoveRow[]; readonly edits: readonly EditRow[]; readonly departmentNo: (operationId: string | null) => number | null; readonly viewerWorkerId: string | null }): History[] {
  const MOVE_WHAT: Record<MoveRow['kind'], HistoryKind> = { FORWARD: 'MOVED_FORWARD', BACK: 'MOVED_BACK', TAKEN_HERE: 'TAKEN_HERE', UNDO: 'MOVE_UNDONE' }
  const EDIT_WHAT: Record<EditRow['kind'], HistoryKind> = { SKIP: 'STEP_SKIPPED', PUT_BACK: 'STEP_PUT_BACK', ADD: 'STEP_ADDED', NORMAL: 'ROUTE_NORMAL' }
  const actor = (row: { readonly workerId: string | null; readonly deviceId: string | null; readonly userId?: string | null }, operationId: string | null): LogActorRow => ({
    audience: row.workerId || row.deviceId ? 'FLOOR' : 'OFFICE',
    actorId: row.workerId ?? row.userId ?? '',
    actorName: null,
    departmentNo: input.departmentNo(operationId),
  })
  const lines = [
    ...input.reports.map((row) => ({ at: row.serverTime, what: 'DONE' as HistoryKind, operationId: row.workOrderOperationId as string | null, toOperationId: null as string | null, actor: actor(row, row.workOrderOperationId) })),
    ...input.moves.map((row) => ({ at: row.serverTime, what: MOVE_WHAT[row.kind], operationId: row.fromOperationId, toOperationId: row.toOperationId, actor: actor(row, row.toOperationId ?? row.fromOperationId) })),
    ...input.edits.map((row) => ({ at: row.serverTime, what: EDIT_WHAT[row.kind], operationId: row.kind === 'NORMAL' ? null : row.operationId, toOperationId: null, actor: actor(row, row.kind === 'NORMAL' ? null : row.operationId) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())
  const faces = floorFaceOf(
    lines.map((line) => line.actor),
    { viewerWorkerId: input.viewerWorkerId },
  )
  return lines.map((line, index) => {
    const face = faces[index]!
    const who = face.face === 'YOU' || face.face === 'OFFICE' || face.face === 'DEPARTMENT' || face.face === 'SYSTEM' ? face.face : 'OFFICE'
    return { at: toUtcIso(line.at), what: line.what, operationId: line.operationId, toOperationId: line.toOperationId, who: { face: who, departmentNo: face.departmentNo } }
  })
}

/** The small address of the basket's picture (presigned through the tenant's system view), or null. */
async function pictureOf(caller: CommandCaller, picture: OrderFacts['picture']): Promise<BasketView['picture']> {
  if (!picture) return null
  const system = systemView(caller)
  const file = await system.withClient((db) => db.storedFile.findUnique({ where: { id: picture.fileId }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }))
  if (!file) return null
  const address = (await smallAddresses(system, [file])).get(file.id)
  return address ? { fileId: file.id, src: address.url, expiresAt: address.expiresAt } : null
}

/** GET /production/baskets/:bundleId (see the file's head). */
export async function readBasket(caller: CommandCaller, bundleIdOrCode: string, query: { readonly via?: 'scan' | 'tap' | undefined } = {}): Promise<BasketView> {
  const context = floorOrOffice(caller)
  const actor = actorOf(context)
  const right = readingRight(context)
  const floor = context.audience === 'floor' ? context : null
  const card = await bundleCard(caller, { code: await codeOf(caller, bundleIdOrCode) }, right)
  const bundleId = card.bundle.id
  const workOrderId = card.workOrder.id
  const now = serverClock.now()

  const facts = await caller.withClient(async (db: Reader) => {
    const bundle = await readBundle(db, bundleId)
    const own = await readBasketRow(db, bundleId)
    if (!bundle || !own) throw new NotFoundError('Not a basket of this site: scan its ticket.')
    const operations = await readOperations(db, workOrderId)
    const scans = await readBundleScans(db, bundleId)
    const flow = await bundleFlowOf(db, bundle, operations, standingScans(scans))
    const moves = (await readMoves(db, [bundleId])).get(bundleId) ?? []
    const edits = (await readEdits(db, [bundleId])).get(bundleId) ?? []
    const route = basketRoute(operations, edits)
    const place = basketPlace(route, flow.standing, bundleId, moves)
    const departments = await departmentLooks(db)
    const stepDepartment = await stepDepartments(db, workOrderId, operations, departments)
    const header = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { styleId: true, dueDate: true, siteId: true } })
    const smallParts = header ? await smallPartsOf(db, header.styleId) : false
    const here = floor ? await hereOfDevice(db, floor.deviceId, departments) : { departmentId: null, stationId: null, picked: false }
    const calls = await readCalls(db, { bundleId }, 50)
    const late = (await readLate(db, [workOrderId])).find((row) => row.bundleId === bundleId || row.bundleId === null) ?? null
    const first = (await readFirstFlags(db, [bundleId])).has(bundleId)
    // The work state of the step it is at, in the viewer's words (the terminal's: its own clock, mine or another's).
    const stationId = floor ? await deviceStationOf(db, floor.deviceId) : null
    const scanSubject = await scanSubjectFor(db, card.workOrder.siteId)
    const subject = floor ? subjectOf({ context: floor, stationId, scanSubject }) : { workerId: null, stationId: null }
    const timingRows = place.operationId ? await readOperationRows(db, bundleId, place.operationId) : []
    const timing = place.operationId ? stateView(timingRows, subject, await readMembers(db, timingRows.map((row) => row.id))) : null
    // The quality check of the step it is at: its steps, what stands of them, which carry a photo.
    const steps = place.operationId ? await stepsOfOperation(db, place.operationId) : []
    const ticks = place.operationId && steps.length > 0 ? await readTicks(db, bundleId, place.operationId) : []
    const photoSteps = place.operationId && steps.length > 0 ? new Set((await db.operationChecklistResult.findMany({ where: { bundleId, workOrderOperationId: place.operationId, fileId: { not: null } }, select: { stepCode: true } })).map((row) => row.stepCode)) : new Set<string>()
    const workerTeam = floor && scanSubject === 'WORKER' ? await teamOfWorker(db, floor.actorId, new Date(`${businessDate(now, await siteTimeZone(db, card.workOrder.siteId))}T00:00:00.000Z`)) : null
    const given = floor ? (await db.dispatchAssignment.findFirst({ where: { workerId: floor.actorId, bundleIds: { has: bundleId } }, select: { id: true } })) !== null : false
    return { bundle, own, operations, scans, flow, moves, edits, route, place, departments, stepDepartment, header, smallParts, here, calls, late, first, timing, steps, ticks, photoSteps, workerTeam, given, scanSubject }
  })

  // What the floor role may not read: through the tenant's system view after the checks above (the office: its own client).
  const order = await (floor ? systemView(caller) : caller).withClient((db: Reader) => orderFactsOf(db, { workOrderId, workOrderSizeId: facts.own.workOrderSizeId, siteId: card.workOrder.siteId }))
  const basketTeamId = order.teams.find((team) => team.bundleIds.includes(bundleId))?.teamId ?? order.teams.find((team) => team.inCharge)?.teamId ?? null
  const team = basketTeamId ? await caller.withClient((db: Reader) => teamLook(db, basketTeamId)) : null

  // Pick B: a hold still refuses the scan (the server's words, the database's triggers untouched).
  const scanHold = await caller.withClient((db) => db.$transaction((tx) => holdOnScan(tx, context, { bundleId, workOrderId })))
  const firstPieceHeld = card.firstPiece && facts.place.operationId && card.firstPiece.heldOperationIds.includes(facts.place.operationId) ? card.firstPiece : null
  const hold: BasketView['hold'] = scanHold
    ? { kind: scanHold.holdId ? 'QUALITY_HOLD' : 'HOLD', words: scanHold.message, fix: scanHold.fix }
    : firstPieceHeld?.message
      ? { kind: 'FIRST_PIECE', words: firstPieceHeld.message, fix: firstPieceHeld.fix ?? '' }
      : null

  const lead = holds(actor, FLOOR_LEAD)
  const restricted: BasketView['restricted'] = !floor ? null : order.floorRestricted && !lead && !facts.given ? 'RESTRICTED' : facts.workerTeam && basketTeamId && facts.workerTeam !== basketTeamId && !lead ? 'OTHER_TEAM' : null
  const hidden = restricted === 'RESTRICTED'

  const notes = floor && !hidden ? (await myWorkMessages(caller, { workOrderId })).messages : []
  const designNote = notes.find((note) => DESIGN_CHANGED.test(note.text)) ?? null
  const picture = hidden ? null : await pictureOf(caller, order.picture)

  const departmentOf = new Map([...facts.stepDepartment].map(([operationId, department]) => [operationId, department?.id ?? null]))
  const look = (operationId: string | null): DepartmentLook | null => (operationId ? (facts.stepDepartment.get(operationId) ?? null) : null)
  const here = hereOf(facts.route, facts.place, departmentOf, facts.here.departmentId)
  const nextId = nextOfPlace(facts.route, facts.place)
  const byId = new Map(facts.route.map((operation) => [operation.id, operation]))
  const reports = [...facts.flow.standing.values()].filter((scan) => scan.bundleId === bundleId)
  const anyReport = reports.length > 0
  const label = card.bundle

  const required = facts.steps.filter((step) => step.required)
  const standing = standingTicks(facts.ticks)
  const quality: BasketView['quality'] =
    facts.place.operationId && facts.steps.length > 0
      ? {
          operationId: facts.place.operationId,
          ticks: { required: required.length, done: required.filter((step) => standing.has(step.code)).length },
          // No step of an instruction is marked "proved by a photo" yet (named in owb-fl1's notes): none is required; a photo
          // taken with a tick still counts.
          photos: { required: 0, done: facts.photoSteps.size },
          steps: facts.steps.map((step) => ({ code: step.code, words: step.words, icon: step.icon, required: step.required, photo: false, done: standing.has(step.code) })),
        }
      : null

  const waiting = facts.timing === null || facts.timing.state === 'NOT_STARTED' || facts.timing.state === 'REPORTED'
  const work: BasketView['work'] = { state: waiting ? 'WAITING' : facts.timing!.state === 'PAUSED' ? 'PAUSED' : 'WORKING', mine: facts.timing?.mine ?? false }
  const open = card.refusal === null && hold === null && facts.place.operationId !== null && restricted === null
  const canScan = floor !== null && holds(actor, PRODUCTION_SCAN)
  const answer = facts.calls.find((row) => row.status === 'SOLVED' && floorGroupOf(row.typeCode) === 'ASK' && (row.resolutionNote ?? '').trim() !== '' && row.solvedAt !== null) ?? null

  return {
    scanned: query.via === 'scan',
    refusal: card.refusal,
    basket: {
      id: bundleId,
      code: card.bundle.code,
      quantity: card.bundle.quantity,
      smallParts: facts.smallParts,
      workOrderId,
      workOrderNumber: card.workOrder.number,
      salesOrderId: order.salesOrderId,
      customerCode: order.customerCode ?? '',
      due: facts.header?.dueDate ? facts.header.dueDate.toISOString().slice(0, 10) : null,
      // The cell's size and colour; the label is the piece a small-parts basket holds. The leather is not on the card (null).
      words: { size: label.size, colour: label.colourwayName, label: label.part, leather: null },
      team: team ? { id: team.id, name: team.name, picture: { kind: team.picture.kind, icon: team.picture.icon, colour: team.picture.colour } } : null,
      rush: card.workOrder.rush,
    },
    picture,
    route: {
      own: ownRoute(facts.edits),
      steps: stepStates(facts.route, facts.place).map((step) => {
        const operation = byId.get(step.operationId)!
        return { operationId: step.operationId, seq: operation.seq, name: operation.name, department: look(step.operationId), state: step.state, added: step.added }
      }),
    },
    place: { operationId: facts.place.operationId, how: facts.place.how, waitingFirst: facts.own.madeAtPrint && facts.place.how === 'SCANS' && !anyReport && effectiveMoves(facts.moves).length === 0 },
    work,
    here,
    hold,
    changedDesign: designNote ? { words: designNote.text, at: designNote.at, seen: false } : null,
    flags: {
      first: facts.first,
      late: facts.late ? { days: facts.late.days, reason: facts.late.reason } : null,
      problem: callOf(facts.calls, 'PROBLEM', now),
      ask: callOf(facts.calls, 'ASK', now),
      answer: answer ? { words: answer.resolutionNote!.trim(), at: toUtcIso(answer.solvedAt!) } : null,
    },
    restricted,
    quality,
    next: { operationId: nextId, department: look(nextId) },
    notes: notes.map((note) => ({ at: note.at, words: note.text, fileIds: [] })),
    history: historyOf({
      reports: facts.scans.filter((scan) => scan.kind !== 'UNDO' && !voidedIds(facts.scans).has(scan.id)),
      moves: facts.moves,
      edits: facts.edits,
      departmentNo: (operationId) => look(operationId)?.number ?? null,
      viewerWorkerId: floor && facts.scanSubject === 'WORKER' ? floor.actorId : null,
    }),
    designPageHref: floor && !hidden ? DESIGN_PAGE : null,
    can: {
      start: canScan && open && work.state !== 'WORKING' && (here.departmentId === null || here.sameDepartment),
      done: canScan && open,
      moveForward: holds(actor, PRODUCTION_BASKETS_MOVE) && hold === null && facts.place.operationId !== null && restricted === null,
      moveBack: holds(actor, PRODUCTION_BASKETS_ROUTE) && hold === null && restricted === null && stepStates(facts.route, facts.place).some((step) => step.state === 'DONE'),
      route: holds(actor, PRODUCTION_BASKETS_ROUTE) && restricted === null,
      give: floor !== null && lead,
      flag: floor !== null && lead,
      late: floor !== null && lead,
    },
  }
}

// ---- helpers the home and fl2 share ---------------------------------------------------------------------------------------------

/** One basket's route and place from rows already read (the home reads many baskets at once). */
export function routeAndPlace(operations: readonly OperationRow[], standing: ReadonlyMap<string, { readonly serverTime: Date }>, bundleId: string, moves: readonly MoveRow[], edits: readonly EditRow[]): { readonly route: (OperationRow & RouteMarks)[]; readonly place: BasketPlace } {
  const route = basketRoute(operations, edits)
  return { route, place: basketPlace(route as readonly ScanOperation[], standing, bundleId, moves) }
}

