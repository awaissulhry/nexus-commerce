import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { sumMinutes } from '@nexus/factory-domain/production/dispatch/load'
import { MATERIAL_LOOK, worstMaterial } from '@nexus/factory-domain/production/dispatch/material'
import { PRODUCTION_DISPATCH_HANDOVER, PRODUCTION_DISPATCH_MANAGE, PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import { assignmentKindOf, DISPATCH_REFUSALS } from '@nexus/factory-domain/production/dispatch/rules'
import { shiftLabelAt } from '@nexus/factory-domain/production/dispatch/handover'
import { openStretchOf, stretchesOf } from '@nexus/factory-domain/production/terminal/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { systemView } from '../scans/access'
import { openCandidates, readBundlesRows } from '../terminal/store'
import { floorOf, may } from './access'
import { materialView, sortCards } from './board'
import { attendanceOfDay, lineLoads, lineMinutesOf } from './facts'
import { lineRowOf, siteRowOf, type Reader } from './store'
import { cardAt, dispatchWorld, materialFlags, planView, type DayCard, type DispatchWorld, type MaterialFlags } from './world'

/**
 * The floor's side of dispatch (B-W2b-49):
 *
 *   GET /production/dispatch/mine        My work (MES-022; design floor.mywork "personal list across stations", "Personal
 *                                        list of the operations assigned to the signed-in operator across stations, current
 *                                        one on top"; floor.work): what the day's assignments name them for, a station's
 *                                        work where they are its operator; their own list, nobody else's
 *   GET /production/dispatch/floor/line  the team leader's line view (MES-028, MES-031; design floor.supervisor "Stations",
 *                                        production.dispatch.view): the line's load and each station's queue, with the work
 *                                        to reassign. No name and no figure per person (Owner answer F2): a station says
 *                                        "Reassign", never who is away, and why never exists here; `signedIn` says whether
 *                                        anyone is signed in at the station (B-W2b-70: "nobody signed in"), never who
 *
 * The queue reads in the floor's own scope (published plans only: Owner answer P3); the material flag, the calendars and
 * the clock through the tenant's system view, after the checks: the floor role reads none of them.
 */

/** A card as a list entry (the W2a dispatch list's shape; a card with no slot names its row). */
export function entryOfCard(card: DayCard, world: Pick<DispatchWorld, 'start' | 'end'>, flags: MaterialFlags) {
  return {
    slotId: card.slot?.id ?? card.rows[0]?.id ?? card.operation.id,
    workOrder: { id: card.workOrder.id, number: card.workOrder.number, status: card.workOrder.status, priority: card.workOrder.priority, rush: card.workOrder.rush, dueDate: card.workOrder.dueDate ? card.workOrder.dueDate.toISOString().slice(0, 10) : null, style: card.workOrder.style, holdReason: card.workOrder.holdReason },
    operation: { id: card.operation.id, seq: card.operation.seq, code: card.operation.code, name: card.operation.name },
    previous: card.previous ? { seq: card.previous.seq, code: card.previous.code, name: card.previous.name } : null,
    startAt: toUtcIso(card.slot?.startAt ?? world.start),
    endAt: toUtcIso(card.slot?.endAt ?? world.end),
    garments: card.pieces,
    minutes: card.minutes,
    state: card.state,
    words: card.words,
    arrived: card.arrived,
    waiting: card.waiting,
    done: 0,
    sequence: card.sequence,
    material: materialView(flags.of(card.workOrder.id, card.operation.id)),
  }
}

/** The one next task: the first READY entry; at a FREE site, else the first still waiting for the operation before it. */
export function nextOf<Entry extends { readonly state: string; readonly sequence: { readonly rule: string } }>(entries: readonly Entry[]): Entry | null {
  return entries.find((entry) => entry.state === 'READY') ?? entries.find((entry) => entry.state === 'WAITING_FOR_PREVIOUS' && entry.sequence.rule === 'FREE') ?? null
}

/** The day's cards that name this person: their rows' work, and whatever queues at the stations they are the operator of. */
export function cardsOfPerson(world: Pick<DispatchWorld, 'rows' | 'stations' | 'cards'>, workerId: string) {
  const mine = world.rows.filter((row) => row.workerId === workerId)
  const ownStations = new Set(mine.flatMap((row) => (assignmentKindOf(row) === 'STATION_OPERATOR' ? [row.stationId!] : [])))
  const stations = world.stations.filter((station) => ownStations.has(station.id))
  const stationFor = (card: DayCard) => stations.find((station) => cardAt(card, { kind: 'STATION', id: station.id, lineId: station.lineId, workCentreId: station.workCentreId }, world.stations))
  return { stationFor, cards: world.cards.filter((card) => card.rows.some((row) => row.workerId === workerId) || stationFor(card) !== undefined) }
}

/** GET /production/dispatch/mine. */
export async function myWork(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const read = await caller.withClient(async (db: Reader) => {
    const site = await siteRowOf(db, context.siteId)
    if (!site) throw new NotFoundError('Site not found.')
    const today = businessDate(now, site.timezone)
    const world = await dispatchWorld(db, site, today, now)
    const open = world.subject === 'WORKER' ? await openCandidates(db, { siteId: site.id, workerId: context.actorId, stationId: null, now }) : []
    const rows = open.length > 0 ? await readBundlesRows(db, [...new Set(open.map((place) => place.bundleId))]) : []
    return { site, world, open, rows }
  })
  const { site, world } = read
  const base = { site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone }, asOf: toUtcIso(now), day: world.today, version: world.plan ? planView(world.plan) : null }
  if (world.subject !== 'WORKER') return { ...base, current: null, next: null, entries: [], words: DISPATCH_REFUSALS.SITE_NAMES_NO_WORKERS.message }
  if (!world.rows.some((row) => row.workerId === context.actorId)) return { ...base, current: null, next: null, entries: [], words: 'Nothing is assigned to you today. Scan a bundle to work on it.' }
  const person = cardsOfPerson(world, context.actorId)
  const { stationFor } = person
  const cards = sortCards(person.cards)
  const flags = await systemView(caller).withClient((db: Reader) => materialFlags(db, site, cards.map((card) => card.workOrder.id)))
  // Their running or paused work comes first ("current one on top").
  const running = new Set(
    read.open.flatMap((place) => {
      const stretch = openStretchOf(stretchesOf(read.rows.filter((row) => row.bundleId === place.bundleId && row.workOrderOperationId === place.workOrderOperationId)))
      return stretch ? [place.workOrderOperationId] : []
    }),
  )
  const entries = cards
    .map((card) => {
      const station = world.stations.find((row) => row.id === card.stationId) ?? stationFor(card)
      return { ...entryOfCard(card, world, flags), station: station ? { id: station.id, code: station.code, name: station.name } : null, bundles: card.bundleIds.length, current: running.has(card.operation.id) }
    })
    .sort((a, b) => Number(b.current) - Number(a.current))
  return { ...base, current: entries.find((entry) => entry.current) ?? null, next: nextOf(entries), entries, words: entries.length > 0 ? null : 'Everything assigned to you today is done.' }
}

/** GET /production/dispatch/floor/line. */
export async function floorLine(caller: CommandCaller, query: { readonly lineId?: string | undefined }) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const lineId = query.lineId ?? (await caller.withClient((db: Reader) => deviceLine(db, context.deviceId)))
  if (!lineId) throw new ValidationError('This tablet belongs to no line: name one.', [{ path: 'querystring/lineId', message: 'Give the line.' }])
  return systemView(caller).withClient(async (db: Reader) => {
    const line = await lineRowOf(db, lineId)
    if (!line || !may(context, PRODUCTION_DISPATCH_VIEW, { companyId: line.companyId, siteId: line.siteId })) throw new NotFoundError('Line not found.')
    const site = (await siteRowOf(db, line.siteId))!
    const world = await dispatchWorld(db, site, businessDate(now, site.timezone), now)
    const minutes = await lineMinutesOf(db, world, [line])
    const attendance = await attendanceOfDay(db, world, minutes)
    const loads = await lineLoads(db, world, minutes, attendance)
    const scope = { companyId: line.companyId, siteId: line.siteId }
    const mayManage = may(context, PRODUCTION_DISPATCH_MANAGE, scope)
    const stations = world.stations.filter((station) => station.lineId === line.id)
    const onLine = world.cards.filter((card) => stations.some((station) => station.id === card.stationId))
    const flags = await materialFlags(db, site, onLine.map((card) => card.workOrder.id))
    const opOf = new Map(world.cards.map((card) => [card.operation.id, card]))
    const rowsOf = (stationId: string) => world.rows.filter((row) => row.stationId === stationId && row.workerId !== null)
    const signedIn = await stationsWithSomeone(db, stations.map((station) => station.id), now)
    return {
      line: { id: line.id, code: line.code, name: line.name },
      site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
      day: world.today,
      asOf: toUtcIso(now),
      shift: shiftLabelAt(minutes.get(line.id)?.shifts ?? [], now),
      load: loads.get(line.id)!,
      stations: stations.map((station) => {
        const cards = sortCards(onLine.filter((card) => card.stationId === station.id))
        const queued = cards.filter((card) => card.counted)
        const reassign = mayManage
          ? rowsOf(station.id).flatMap((row) => {
              const standing = attendance.standingOf(row.employeeId, line.id)
              if (!standing.reassign) return []
              const card = row.workOrderOperationId ? opOf.get(row.workOrderOperationId) : undefined
              return [{ assignmentId: row.id, version: row.version, kind: assignmentKindOf(row), workOrder: card ? { number: card.workOrder.number } : null, operation: card ? { seq: card.operation.seq, name: card.operation.name } : null, words: standing.words! }]
            })
          : []
        // B-W2b-88: each card's own operation's flag (an operation that uses no material says nothing).
        const material = worstMaterial(cards.flatMap((card) => flags.of(card.workOrder.id, card.operation.id)?.state ?? []))
        return { id: station.id, code: station.code, name: station.name, signedIn: signedIn.has(station.id), work: { cards: cards.length, pieces: cards.reduce((sum, card) => sum + card.pieces, 0), minutes: sumMinutes(queued.map((card) => card.minutes)) }, material: material ? { state: material, ...MATERIAL_LOOK[material] } : null, reassign }
      }),
      mayManage,
      mayWriteHandover: may(context, PRODUCTION_DISPATCH_HANDOVER, scope),
    }
  })
}

/** The stations with someone signed in on a tablet of theirs now (Owner answer F2: yes or no, never who). */
async function stationsWithSomeone(db: Reader, stationIds: readonly string[], now: Date): Promise<ReadonlySet<string>> {
  if (stationIds.length === 0) return new Set()
  const live = await db.floorSession.findMany({ where: { endedAt: null, idleExpiresAt: { gt: now }, endsAt: { gt: now }, device: { stationId: { in: [...stationIds] } } }, select: { device: { select: { stationId: true } } } })
  return new Set(live.flatMap((session) => (session.device.stationId ? [session.device.stationId] : [])))
}

/** The line a tablet belongs to: its own (a line tablet or display), else its station's. */
export async function deviceLine(db: Reader, deviceId: string): Promise<string | null> {
  if (!isUuid(deviceId)) return null
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { lineId: true, stationId: true } })
  if (!device) return null
  if (device.lineId) return device.lineId
  if (!device.stationId) return null
  return (await db.station.findUnique({ where: { id: device.stationId }, select: { lineId: true } }))?.lineId ?? null
}

