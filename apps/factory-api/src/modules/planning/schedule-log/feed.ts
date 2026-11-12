import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { CHANGE_KINDS, CHANGE_LOG_LIMITS, changeWords, isUndoable, standingLatest, undoHoldOf, undoHoldWords, undoPermissionOf, type ChangeFacts, type ChangeKind, type ChangePlace, type SlotNow } from '@nexus/factory-domain/planning/schedule-log/changes'
import { laneKey, laneOfSlot, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayAt, officeContextOf, siteFor } from '../access'
import type { Reader, SiteRow } from '../store'
import { siteViewOf } from '../schedule/publish'
import { publishedOf, userNamesOf, workingPlanOf } from '../schedule/store'
import type { ChangeEntry, ChangesQuery } from './contract'

/**
 * The board's change log (B-W2b-329; PLN-149; design planning.board sec:log "Changes": "Move, pin, publish, apply what-if;
 * ChangeValue from → to", "Undo one move", "Filter by planner", empty "No moves since v12"): GET /planning/schedule/changes
 * (planning.view over the site), newest first, paged by a cursor (changedAt, id). By default the changes since the last
 * published version; `since=ALL` the whole log. Each entry says where the slot was and went (lane names read now: a lane
 * archived since keeps its code), who changed it (an office user, inside the entry; never counted), its undo, and whether
 * the reader may undo it now (factory-domain planning/schedule-log/changes undoHoldOf: the latest change of its slot, the
 * slot still where it left it, the permission of its kind).
 */

export const CHANGE_COLUMNS = {
  id: true,
  siteId: true,
  planVersionId: true,
  kind: true,
  slotId: true,
  workOrderId: true,
  workOrderOperationId: true,
  fromLineId: true,
  fromWorkCentreId: true,
  fromPartyId: true,
  fromStartAt: true,
  fromEndAt: true,
  toLineId: true,
  toWorkCentreId: true,
  toPartyId: true,
  toStartAt: true,
  toEndAt: true,
  publishedVersionId: true,
  undoesChangeId: true,
  whatIfScenarioId: true,
  reason: true,
  changedById: true,
  changedAt: true,
  workOrder: { select: { id: true, number: true } },
  operation: { select: { id: true, seq: true, code: true, name: true } },
  publishedVersion: { select: { id: true, number: true } },
  undoes: { select: { id: true, kind: true } },
  undoneBy: { select: { id: true, changedAt: true, changedById: true }, take: 1 },
} as const satisfies Prisma.ScheduleChangeSelect
export type ChangeRow = Prisma.ScheduleChangeGetPayload<{ select: typeof CHANGE_COLUMNS }>

const sideOf = (lineId: string | null, workCentreId: string | null, partyId: string | null, startAt: Date | null, endAt: Date | null): ChangePlace | null =>
  startAt && endAt ? { lane: laneOfSlot({ lineId, workCentreId, partyId }), startAt: startAt.getTime(), endAt: endAt.getTime() } : null

/** The change as the domain's rules read it. */
export const factsOf = (row: Pick<ChangeRow, 'id' | 'kind' | 'slotId' | 'workOrderOperationId' | 'fromLineId' | 'fromWorkCentreId' | 'fromPartyId' | 'fromStartAt' | 'fromEndAt' | 'toLineId' | 'toWorkCentreId' | 'toPartyId' | 'toStartAt' | 'toEndAt'>): ChangeFacts => ({
  id: row.id,
  kind: row.kind as ChangeKind,
  slotId: row.slotId,
  operationId: row.workOrderOperationId,
  from: sideOf(row.fromLineId, row.fromWorkCentreId, row.fromPartyId, row.fromStartAt, row.fromEndAt),
  to: sideOf(row.toLineId, row.toWorkCentreId, row.toPartyId, row.toStartAt, row.toEndAt),
})

/** Lanes by key with their code and name (any status: the log names lanes archived since). */
export async function laneNamesOf(db: Reader, lanes: Iterable<LaneRef>): Promise<Map<string, { code: string; name: string }>> {
  const all = [...lanes]
  const ids = (kind: LaneRef['kind']) => [...new Set(all.filter((lane) => lane.kind === kind).map((lane) => lane.id))]
  // One query after another on the caller's client (a command's tx runs one at a time).
  const lines = ids('LINE').length ? await db.line.findMany({ where: { id: { in: ids('LINE') } }, select: { id: true, code: true, name: true } }) : []
  const centres = ids('WORK_CENTRE').length ? await db.workCentre.findMany({ where: { id: { in: ids('WORK_CENTRE') } }, select: { id: true, code: true, name: true } }) : []
  const parties = ids('WORKSHOP').length ? await db.party.findMany({ where: { id: { in: ids('WORKSHOP') } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : []
  const out = new Map<string, { code: string; name: string }>()
  for (const row of lines) out.set(laneKey({ kind: 'LINE', id: row.id }), { code: row.code, name: row.name })
  for (const row of centres) out.set(laneKey({ kind: 'WORK_CENTRE', id: row.id }), { code: row.code, name: row.name })
  for (const row of parties) out.set(laneKey({ kind: 'WORKSHOP', id: row.id }), { code: row.code, name: row.tradeName ?? row.legalName })
  return out
}

/** "Op 20 Sew of SEED-WO-0001" / "SEED-WO-0001's part of the order". */
export const whatOf = (row: Pick<ChangeRow, 'workOrder' | 'operation'>): string =>
  row.operation ? `Op ${row.operation.seq} ${row.operation.name} of ${row.workOrder?.number ?? 'the work order'}` : `${row.workOrder?.number ?? 'The work order'}'s part of the order`

const VERBS: Record<ChangeKind, string> = { PLACE: 'placed', MOVE: 'moved', REMOVE: 'sent back to the tray', PIN: 'pinned', UNPIN: 'unpinned', PUBLISH: 'published', UNDO: 'a change undone' }

/** "by Paolo at 10 Nov 10:00". */
export const byWords = (change: { readonly changedById: string; readonly changedAt: Date }, names: ReadonlyMap<string, string>, timeZone: string): string =>
  `by ${names.get(change.changedById) || 'someone'} at ${whenWords(change.changedAt.getTime(), timeZone)}`

/** "moved by Paolo at 10 Nov 10:00": a change in a few words (why an older one is held). */
export const laterWords = (change: { readonly kind: string; readonly changedById: string; readonly changedAt: Date }, names: ReadonlyMap<string, string>, timeZone: string): string =>
  `${VERBS[change.kind as ChangeKind] ?? 'changed'} ${byWords(change, names, timeZone)}`

/**
 * The latest standing change of each slot in the log (factory-domain standingLatest: an undone change and its undo left
 * out), with what it was and who made it.
 */
export async function latestOfSlots(db: Reader, slotIds: readonly string[]): Promise<Map<string, { id: string; kind: string; changedById: string; changedAt: Date }>> {
  const out = new Map<string, { id: string; kind: string; changedById: string; changedAt: Date }>()
  if (slotIds.length === 0) return out
  const rows = await db.scheduleChange.findMany({ where: { slotId: { in: [...new Set(slotIds)] } }, select: { id: true, slotId: true, kind: true, undoesChangeId: true, changedById: true, changedAt: true }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }] })
  const bySlot = new Map<string, typeof rows>()
  for (const row of rows) if (row.slotId) bySlot.set(row.slotId, [...(bySlot.get(row.slotId) ?? []), row])
  for (const [slotId, changes] of bySlot) {
    const latest = standingLatest(changes)
    const row = changes.find((change) => change.id === latest)
    if (row) out.set(slotId, row)
  }
  return out
}

/** The working slots by id, as the undo's rule reads them. */
export async function slotsNowOf(db: Reader, slotIds: readonly string[]): Promise<Map<string, SlotNow>> {
  if (slotIds.length === 0) return new Map()
  const rows = await db.scheduleSlot.findMany({ where: { id: { in: [...new Set(slotIds)] }, planKind: 'WORKING' }, select: { id: true, lineId: true, workCentreId: true, partyId: true, startAt: true, endAt: true, pinned: true } })
  return new Map(rows.map((row) => [row.id, { lane: laneOfSlot(row), startAt: row.startAt.getTime(), endAt: row.endAt.getTime(), pinned: row.pinned }]))
}

/** The entries of rows as the feed and the undo answer them, for the reader at the site. */
export async function entriesOf(db: Reader, caller: CommandCaller, site: SiteRow, rows: readonly ChangeRow[]): Promise<ChangeEntry[]> {
  const context = officeContextOf(caller)
  const tz = site.timezone
  const facts = rows.map(factsOf)
  const slotIds = rows.flatMap((row) => (row.slotId ? [row.slotId] : []))
  const latest = await latestOfSlots(db, slotIds)
  const now = await slotsNowOf(db, slotIds)
  const lanes = await laneNamesOf(db, facts.flatMap((fact) => [fact.from?.lane, fact.to?.lane].filter((lane): lane is LaneRef => lane !== undefined)))
  const names = await userNamesOf(db, [...rows.map((row) => row.changedById), ...rows.flatMap((row) => row.undoneBy.map((undo) => undo.changedById)), ...[...latest.values()].map((row) => row.changedById)])
  const who = (userId: string | null) => (userId ? { id: userId, name: names.get(userId) ?? '' } : null)
  const placeView = (side: ChangePlace | null) => {
    if (!side) return null
    const lane = lanes.get(laneKey(side.lane))
    return { lane: { kind: side.lane.kind, id: side.lane.id, code: lane?.code ?? '', name: lane?.name ?? '' }, startAt: toUtcIso(new Date(side.startAt)), endAt: toUtcIso(new Date(side.endAt)) }
  }
  const sideWords = (side: ChangePlace | null) => (side ? { place: side, laneName: lanes.get(laneKey(side.lane))?.code || lanes.get(laneKey(side.lane))?.name || 'a lane' } : null)
  return rows.map((row, index) => {
    const fact = facts[index]!
    const kind = row.kind as ChangeKind
    const undone = row.undoneBy[0] ?? null
    const what = whatOf(row)
    const slot = row.slotId ? (now.get(row.slotId) ?? null) : null
    const last = row.slotId ? (latest.get(row.slotId) ?? null) : null
    const permission = isUndoable(kind) ? undoPermissionOf(kind) : null
    const may = permission !== null && mayAt(context, permission, { companyId: site.companyId, siteId: site.id })
    const code = undoHoldOf(fact, { undone: undone !== null, latestOfSlot: last?.id ?? null, slot, may })
    const later = last && last.id !== row.id ? laterWords(last, names, tz) : null
    const undoneWords = undone ? byWords(undone, names, tz) : null
    return {
      id: row.id,
      kind,
      changedAt: toUtcIso(row.changedAt),
      changedBy: who(row.changedById),
      slotId: row.slotId,
      onBoard: slot !== null,
      workOrder: row.workOrder ? { id: row.workOrder.id, number: row.workOrder.number } : null,
      operation: row.operation ? { id: row.operation.id, seq: row.operation.seq, code: row.operation.code, name: row.operation.name } : null,
      from: placeView(fact.from),
      to: placeView(fact.to),
      reason: row.reason,
      whatIfScenarioId: row.whatIfScenarioId,
      publishedVersion: row.publishedVersion ? { id: row.publishedVersion.id, number: row.publishedVersion.number! } : null,
      undoes: row.undoes ? { id: row.undoes.id, kind: row.undoes.kind as ChangeKind } : null,
      undoneBy: undone ? { id: undone.id, changedAt: toUtcIso(undone.changedAt), changedBy: who(undone.changedById) } : null,
      undo: { may: code === null, code, permission, words: code ? undoHoldWords(code, { kind, operationId: row.workOrderOperationId, what, undoneBy: undoneWords, later, permission: permission ?? 'planning.schedule.manage' }) : null },
      words: changeWords({ kind, what, from: sideWords(fact.from), to: sideWords(fact.to), published: row.publishedVersion?.number ?? null, undoes: (row.undoes?.kind as ChangeKind | undefined) ?? null, fromWhatIf: row.whatIfScenarioId !== null, timeZone: tz }),
    }
  })
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f-]{36})$/

function kindsOf(value: string | undefined): ChangeKind[] | null {
  if (value === undefined || value.trim() === '') return null
  const kinds = value.split(',').map((part) => part.trim()).filter((part) => part !== '')
  const bad = kinds.find((kind) => !(CHANGE_KINDS as readonly string[]).includes(kind))
  if (bad) throw new ValidationError(`"${bad}" is not a change kind.`, [{ path: 'querystring/kinds', message: `One or more of ${CHANGE_KINDS.join(', ')}.` }])
  return kinds as ChangeKind[]
}

/** GET /planning/schedule/changes. */
export async function changes(caller: CommandCaller, query: ChangesQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const kinds = kindsOf(query.kinds)
  const cursor = query.cursor ? CURSOR.exec(query.cursor) : null
  if (query.cursor && !cursor) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Send the `next` of the page before.' }])
  const limit = query.limit ?? CHANGE_LOG_LIMITS.page
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const plan = await workingPlanOf(db, site.id)
    const [published] = query.since === 'ALL' ? [] : await publishedOf(db, site.id, 1)
    const at = cursor ? parseInstant(cursor[1]!)! : null
    const where: Prisma.ScheduleChangeWhereInput = {
      siteId: site.id,
      ...(published?.publishedAt ? { changedAt: { gt: published.publishedAt } } : {}),
      ...(kinds ? { kind: { in: kinds } } : {}),
      ...(query.changedById ? { changedById: query.changedById } : {}),
      ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
      ...(query.slotId ? { slotId: query.slotId } : {}),
      ...(at && isUuid(cursor![2]!) ? { AND: [{ OR: [{ changedAt: { lt: at } }, { changedAt: at, id: { lt: cursor![2]! } }] }] } : {}),
    }
    const rows = await db.scheduleChange.findMany({ where, select: CHANGE_COLUMNS, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      site: siteViewOf(site),
      asOf: toUtcIso(now),
      plan: { id: plan?.id ?? null, version: plan?.version ?? null },
      since: published?.publishedAt ? { id: published.id, number: published.number!, publishedAt: toUtcIso(published.publishedAt) } : null,
      entries: await entriesOf(db, caller, site, page),
      next: rows.length > limit && last ? `${toUtcIso(last.changedAt)}|${last.id}` : null,
    }
  })
}
