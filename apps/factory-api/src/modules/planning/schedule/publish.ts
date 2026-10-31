import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_SCHEDULE_PUBLISH } from '@nexus/factory-domain/planning/schedule/permissions'
import { ScheduleRefusal, type PublishHoldCode } from '@nexus/factory-domain/planning/schedule/refusals'
import { diffWords, laneKey, laneOfSlot, planDiff, PUBLISH_LIMITS, type PlanDiff } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords, whenWords } from '@nexus/factory-domain/planning/schedule/time'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { capacityAnswer } from '../capacity/service'
import { readinessFor } from '../readiness/service'
import { dayOf, SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import type { PublishBody, PublishQuery } from './contract'
import { scheduleWorld, type ScheduleWorld } from './service'
import { diffSlotOf, lockedWorkingPlan, PLAN_COLUMNS, publishedOf, SLOT_COLUMNS, slotsOf, userNamesOf, type PlanRow, type SlotRow } from './store'

/**
 * Publish the working plan to the floor (B-W2a-34; PLN-147; design planning.board pop "Publish schedule v13 to the
 * floor"; Owner answer P3: the floor sees nothing of the working plan until a publish).
 *
 *   range      the days the version covers: by default the site's next working day and the four working days after it
 *              ("next 5 working days"); the floor works to it from `effectiveFrom` (default the first shift of the first
 *              day, or now when that has passed): "New schedule v13 from 06:00".
 *   diff       the working plan's slots that reach into those days against the last published version's slots there:
 *              moved, added, removed, per lane (slots/diff in factory-domain). Nothing changed: publishing is held.
 *   checks     warnings, never a block: overbooked lanes on those days, slots that end before the floor starts working
 *              to the version while their work is not done (operations in the past), work orders whose material is not
 *              ready (planning/readiness NOT_ENOUGH or DELAYED).
 *   publish    ONE command under the site's schedule lock, at the working plan's version the dialog reviewed (409 when it
 *              moved since): the PUBLISHED version (number above every earlier one, the one it follows, the range, the
 *              start), a copy of each slot, then publishedAt and who published (the …_production_w2a_guards triggers
 *              freeze it from then on); audited; event planning.schedule_published (live to the site's floor devices).
 */

const storedDay = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

export interface PublishRange {
  readonly coversFrom: BusinessDate
  readonly coversTo: BusinessDate
  readonly effectiveFrom: Date
  readonly workingDays: number
  readonly isDefault: boolean
  readonly start: Date
  readonly end: Date
}

/** The site's working days after `from` (the site calendar's), `count` of them; the first one included when working. */
function workingDaysFrom(world: ScheduleWorld, from: BusinessDate, count: number, includeFrom: boolean): BusinessDate[] {
  const out: BusinessDate[] = []
  for (const day of world.siteDays) {
    if (day.date < from || (!includeFrom && day.date === from) || !day.working) continue
    out.push(day.date)
    if (out.length === count) break
  }
  return out
}

function firstShiftOf(world: ScheduleWorld, date: BusinessDate): Date {
  const day = world.siteDays.find((candidate) => candidate.date === date)
  const start = day?.shifts[0]?.start
  return start ?? businessDayStart(date, world.site.timezone)
}

/** The range asked for, its defaults filled and checked (400 in words). */
export function rangeOf(world: ScheduleWorld, query: Pick<PublishQuery, 'coversFrom' | 'coversTo' | 'effectiveFrom'>): PublishRange {
  const tomorrowOn = workingDaysFrom(world, world.today, 5, false)
  const coversFrom = query.coversFrom ?? tomorrowOn[0] ?? plusDays(world.today, 1)
  const coversTo = query.coversTo ?? (query.coversFrom ? (workingDaysFrom(world, coversFrom, 5, true)[4] ?? plusDays(coversFrom, 4)) : (tomorrowOn[4] ?? plusDays(coversFrom, 4)))
  const problems: Issue[] = []
  if (coversTo < coversFrom) problems.push({ path: 'coversTo', message: 'The last day comes on or after the first.' })
  else if (daysFrom(coversFrom, coversTo) + 1 > PUBLISH_LIMITS.maxDays) problems.push({ path: 'coversTo', message: `A version covers at most ${PUBLISH_LIMITS.maxDays} days.` })
  const now = world.now
  const start = businessDayStart(coversFrom, world.site.timezone)
  const end = businessDayStart(plusDays(coversTo, 1), world.site.timezone)
  let effectiveFrom: Date
  if (query.effectiveFrom) {
    effectiveFrom = parseInstant(query.effectiveFrom)!
    if (effectiveFrom.getTime() < now.getTime() - 60_000) problems.push({ path: 'effectiveFrom', message: 'The floor cannot start working to it in the past: choose now or later.' })
    else if (problems.length === 0 && effectiveFrom >= end) problems.push({ path: 'effectiveFrom', message: 'The floor starts working to it before its last day ends.' })
  } else {
    const first = firstShiftOf(world, coversFrom)
    effectiveFrom = first > now ? first : now
  }
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const workingDays = world.siteDays.filter((day) => day.working && day.date >= coversFrom && day.date <= coversTo).length
  return { coversFrom, coversTo, effectiveFrom, workingDays, isDefault: !query.coversFrom && !query.coversTo && !query.effectiveFrom, start, end }
}

const inRange = (range: Pick<PublishRange, 'start' | 'end'>) => (slot: SlotRow) => slot.startAt < range.end && slot.endAt > range.start

/** The working plan's slots on the range against the last version's there. */
export async function publishDiff(db: Reader, world: ScheduleWorld, range: Pick<PublishRange, 'start' | 'end'>): Promise<{ previous: PlanRow | null; set: SlotRow[]; diff: PlanDiff }> {
  const [previous] = await publishedOf(db, world.site.id, 1)
  const set = world.slots.filter(inRange(range))
  const before = previous ? await slotsOf(db, previous.id, range) : []
  return { previous: previous ?? null, set, diff: planDiff(set.map(diffSlotOf), before.map(diffSlotOf)) }
}

/** B-W2b-20: why publishing is held, with its stable code and the facts a screen says it from. */
export interface PublishHold {
  readonly code: PublishHoldCode
  readonly words: string
  /** NOTHING_CHANGED: the version nothing changed since. */
  readonly previousVersion: number | null
  readonly coversFrom: BusinessDate | null
  readonly coversTo: BusinessDate | null
}

/** Why publishing is held (nothing changed, nothing to publish); null: it may be published. */
export function publishHoldOf(previous: PlanRow | null, set: readonly SlotRow[], diff: PlanDiff, range: Pick<PublishRange, 'coversFrom' | 'coversTo'>): PublishHold | null {
  if (diff.moved + diff.added + diff.removed > 0) return null
  const days = `${dayWords(range.coversFrom)} to ${dayWords(range.coversTo)}`
  const facts = { coversFrom: range.coversFrom, coversTo: range.coversTo }
  if (set.length === 0) return { code: 'NOTHING_ON_DAYS', words: `The working plan has nothing on ${days} to publish.`, previousVersion: previous?.number ?? null, ...facts }
  return previous ? { code: 'NOTHING_CHANGED', words: `Nothing changed since v${previous.number} was published for ${days}.`, previousVersion: previous.number, ...facts } : null
}

/** Why publishing is held, in words (null: it may be published). */
export const heldReasonOf = (previous: PlanRow | null, set: readonly SlotRow[], diff: PlanDiff, range: Pick<PublishRange, 'coversFrom' | 'coversTo'>): string | null => publishHoldOf(previous, set, diff, range)?.words ?? null

/** The hold of a person who may not publish at the site. */
export const NO_PERMISSION_HOLD: PublishHold = { code: 'NO_PERMISSION', words: 'Publishing needs planning.schedule.publish at this site.', previousVersion: null, coversFrom: null, coversTo: null }

/** A hold as the board's band and the dialog give it (without the words). */
export const holdViewOf = (hold: PublishHold | null) => (hold ? { code: hold.code, previousVersion: hold.previousVersion, coversFrom: hold.coversFrom, coversTo: hold.coversTo } : null)

/** A published version's header (who published it by name: inside the one record). */
export async function versionHeaderOf(db: Reader, version: PlanRow) {
  const names = await userNamesOf(db, [version.publishedById])
  return {
    id: version.id,
    number: version.number!,
    previousId: version.previousId,
    coversFrom: dayOf(version.coversFrom!),
    coversTo: dayOf(version.coversTo!),
    effectiveFrom: toUtcIso(version.effectiveFrom!),
    publishedAt: toUtcIso(version.publishedAt!),
    publishedBy: version.publishedById ? { id: version.publishedById, name: names.get(version.publishedById) ?? '' } : null,
    note: version.note,
  }
}

const siteViewOf = (site: SiteRow) => ({ id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone })

function laneNameOf(world: ScheduleWorld, slot: SlotRow): { code: string; name: string } {
  const lane = world.lanes.get(laneKey(laneOfSlot(slot)))
  return { code: lane?.code ?? '', name: lane?.name ?? '' }
}

/** GET /planning/schedule/publish (planning.view): what Publish would send, its diff and its checks. */
export async function publishPreview(caller: CommandCaller, query: PublishQuery) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(db, site, { from: today, to: plusDays(today, 70) }, now)
    const range = rangeOf(world, query)
    const { previous, set, diff } = await publishDiff(db, world, range)
    const checks = await checksOf(db, world, range, set)
    const may = mayAt(context, PLANNING_SCHEDULE_PUBLISH, { companyId: site.companyId, siteId: site.id })
    const hold = publishHoldOf(previous, set, diff, range)
    const held = hold?.words ?? null
    return {
      site: siteViewOf(site),
      asOf: toUtcIso(now),
      plan: { id: world.plan?.id ?? null, version: world.plan?.version ?? null },
      next: (previous?.number ?? 0) + 1,
      previous: previous ? await versionHeaderOf(db, previous) : null,
      range: { coversFrom: range.coversFrom, coversTo: range.coversTo, effectiveFrom: toUtcIso(range.effectiveFrom), workingDays: range.workingDays, isDefault: range.isDefault },
      slots: set.length,
      diff: {
        moved: diff.moved,
        added: diff.added,
        removed: diff.removed,
        words: diffWords(diff),
        byLane: diff.byLane.map((entry) => {
          const lane = world.lanes.get(laneKey(entry.lane))
          return { lane: entry.lane, code: lane?.code ?? '', name: lane?.name ?? '', moved: entry.moved, added: entry.added, removed: entry.removed }
        }),
      },
      checks,
      mayPublish: may && held === null,
      heldReason: held ?? (may ? null : NO_PERMISSION_HOLD.words),
      // B-W2b-20: the stable code of the hold and its facts (null: it may be published).
      heldCode: hold?.code ?? (may ? null : NO_PERMISSION_HOLD.code),
      hold: holdViewOf(hold ?? (may ? null : NO_PERMISSION_HOLD)),
    }
  })
}

type Check = { code: 'OVERBOOKED' | 'IN_THE_PAST' | 'MATERIAL_NOT_READY'; state: 'PASS' | 'WARNING'; count: number; words: string; items: { words: string; workOrderId: string | null; slotId: string | null; lane: { kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP'; id: string } | null; date: string | null }[] }

/** The dialog's CheckList: warnings with what to show, never a block. */
async function checksOf(db: Reader, world: ScheduleWorld, range: PublishRange, set: readonly SlotRow[]): Promise<Check[]> {
  const tz = world.site.timezone
  // Overbooked lanes on the range's days.
  const buckets = uniformBuckets(range.coversFrom, range.coversTo, 'DAY')
  const answer = capacityAnswer(world.capacity, { from: range.coversFrom, to: range.coversTo, buckets })
  const over: Check['items'] = []
  for (const lane of answer.lanes) {
    for (const cell of lane.cells) {
      if (!(Number(cell.overMinutes) > 0)) continue
      over.push({ words: `${lane.code} is at ${cell.loadPct ?? '—'}% on ${dayWords(cell.from)} (+${cell.overMinutes} min over).`, workOrderId: null, slotId: null, lane: { kind: lane.kind, id: lane.id }, date: cell.from })
    }
  }
  // Operations in the past: slots that end before the floor starts working to the version, their work not done.
  const byId = new Map(world.workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const past: Check['items'] = []
  for (const slot of set) {
    if (slot.endAt > range.effectiveFrom) continue
    const workOrder = byId.get(slot.workOrderId)
    if (!workOrder) continue
    const operation = slot.workOrderOperationId ? workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId) : null
    const left = operation ? operation.remaining > 0 : workOrder.operations.some((candidate) => candidate.remaining > 0)
    if (!left) continue
    const what = operation ? `Op ${operation.seq} ${operation.name} of ${workOrder.number}` : `Part of ${workOrder.number}`
    past.push({ words: `${what} ends on ${whenWords(slot.endAt.getTime(), tz)}, before the floor starts working to this version, and is not done.`, workOrderId: workOrder.id, slotId: slot.id, lane: laneOfSlot(slot), date: businessDate(slot.endAt, tz) })
  }
  // Material not ready.
  const ids = [...new Set(set.map((slot) => slot.workOrderId))].filter((workOrderId) => byId.has(workOrderId))
  const readiness = ids.length ? await readinessFor(db, world.site, ids) : []
  const material: Check['items'] = readiness
    .filter((row) => row.word === 'NOT_ENOUGH' || row.word === 'DELAYED')
    .map((row) => ({ words: `${byId.get(row.workOrderId)!.number}: ${row.label}. ${row.reason}`, workOrderId: row.workOrderId, slotId: null, lane: null, date: row.date }))
  const check = (code: Check['code'], items: Check['items'], pass: string, warn: (count: number) => string): Check => ({ code, state: items.length ? 'WARNING' : 'PASS', count: items.length, words: items.length ? warn(items.length) : pass, items })
  return [
    check('OVERBOOKED', over, 'No lane is overbooked on these days.', (count) => `${count} lane ${count === 1 ? 'day is' : 'days are'} overbooked.`),
    check('IN_THE_PAST', past, 'No operation ends before the floor starts working to it.', (count) => `${count} ${count === 1 ? 'operation ends' : 'operations end'} before the floor starts working to it, not done.`),
    check('MATERIAL_NOT_READY', material, 'The material of every work order on these days is ready or on its way in time.', (count) => `${count} work ${count === 1 ? 'order has' : 'orders have'} material not ready.`),
  ]
}

/** POST /planning/schedule/publish (planning.schedule.publish): the next numbered version, frozen, for the floor. */
export async function publish(caller: CommandCaller, body: PublishBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_SCHEDULE_PUBLISH)
  const { result, replayed } = await command(caller, { name: 'planning.schedule.publish', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockedWorkingPlan(tx, site, context.tenantId, { actorId: context.actorId, now, expectedVersion: body.version, bump: false })
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(tx, site, { from: today, to: plusDays(today, 70) }, now)
    const range = rangeOf(world, body)
    const { previous, set, diff } = await publishDiff(tx, world, range)
    const hold = publishHoldOf(previous, set, diff, range)
    if (hold) throw new ScheduleRefusal(hold.code === 'NOTHING_ON_DAYS' ? 'NOTHING_ON_DAYS' : 'NOTHING_CHANGED', hold.words)
    const number = (previous?.number ?? 0) + 1
    const versionId = newId()
    await tx.planVersion.create({
      data: {
        id: versionId,
        companyId: site.companyId,
        siteId: site.id,
        kind: 'PUBLISHED',
        number,
        previousId: previous?.id ?? null,
        coversFrom: storedDay(range.coversFrom),
        coversTo: storedDay(range.coversTo),
        effectiveFrom: range.effectiveFrom,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    if (set.length > 0) {
      await tx.scheduleSlot.createMany({
        data: set.map((slot) => ({
          id: newId(),
          siteId: site.id,
          planVersionId: versionId,
          planKind: 'PUBLISHED' as const,
          workOrderId: slot.workOrderId,
          workOrderOperationId: slot.workOrderOperationId,
          lineId: slot.lineId,
          workCentreId: slot.workCentreId,
          partyId: slot.partyId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          pieces: slot.pieces,
          minutes: slot.minutes,
          overloadReason: slot.overloadReason,
          note: slot.note,
          createdAt: now,
          updatedAt: slot.updatedAt,
          createdById: context.actorId,
          updatedById: slot.updatedById,
        })),
      })
    }
    await tx.planVersion.update({ where: { id: versionId }, data: { publishedAt: now, publishedById: context.actorId, version: 2, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'planning.schedule.publish',
      recordType: 'PlanVersion',
      recordId: versionId,
      companyId: site.companyId,
      siteId: site.id,
      before: previous ? { number: previous.number, coversFrom: dayOf(previous.coversFrom!), coversTo: dayOf(previous.coversTo!) } : null,
      after: { number, coversFrom: range.coversFrom, coversTo: range.coversTo, effectiveFrom: toUtcIso(range.effectiveFrom), slots: set.length, moved: diff.moved, added: diff.added, removed: diff.removed },
    })
    tools.emit({
      type: 'planning.schedule_published',
      subject: versionId,
      companyId: site.companyId,
      siteId: site.id,
      payload: { siteId: site.id, planVersionId: versionId, number, previousId: previous?.id ?? null, coversFrom: range.coversFrom, coversTo: range.coversTo, effectiveFrom: toUtcIso(range.effectiveFrom), slots: set.length, moved: diff.moved, added: diff.added, removed: diff.removed },
    })
    return { versionId, slots: set.length, diff: { moved: diff.moved, added: diff.added, removed: diff.removed, words: diffWords(diff) } }
  })
  const version = await caller.withClient(async (db) => versionHeaderOf(db, (await db.planVersion.findUniqueOrThrow({ where: { id: result.versionId }, select: PLAN_COLUMNS }))))
  return { version, slots: result.slots, diff: result.diff, replayed }
}

/** GET /planning/schedule/versions (planning.view): the site's published versions, the latest first. */
export async function listVersions(caller: CommandCaller, query: { readonly siteId: string }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const versions = await publishedOf(db, site.id)
    const counts = versions.length ? await db.scheduleSlot.groupBy({ by: ['planVersionId'], where: { planVersionId: { in: versions.map((version) => version.id) } }, _count: { _all: true } }) : []
    const out = []
    for (const version of versions) out.push({ ...(await versionHeaderOf(db, version)), slots: counts.find((row) => row.planVersionId === version.id)?._count._all ?? 0 })
    return { site: siteViewOf(site), versions: out }
  })
}

/** GET /planning/schedule/versions/:versionId (planning.view): one published version as the floor was given it. */
export async function getVersion(caller: CommandCaller, versionId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const version = isUuid(versionId) ? await db.planVersion.findUnique({ where: { id: versionId }, select: { ...PLAN_COLUMNS, site: { select: SITE_COLUMNS } } }) : null
    if (!version || version.kind !== 'PUBLISHED') throw new NotFoundError('Published version not found.')
    assertMayAt(context, PLANNING_VIEW, { companyId: version.companyId, siteId: version.siteId }, 'Published version')
    const now = serverClock.now()
    const today = businessDate(now, version.site.timezone)
    const world = await scheduleWorld(db, version.site, { from: today, to: today }, now)
    const slots = await db.scheduleSlot.findMany({
      where: { planVersionId: version.id },
      select: { ...SLOT_COLUMNS, workOrder: { select: { id: true, number: true } }, operation: { select: { id: true, seq: true, code: true, name: true } } },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    })
    const names = await userNamesOf(db, slots.map((slot) => slot.updatedById))
    return {
      site: siteViewOf(version.site),
      version: await versionHeaderOf(db, version),
      slots: slots.map((slot) => ({
        ...storedSlotView(slot, names),
        workOrder: slot.workOrder,
        operation: slot.operation,
        laneCode: laneNameOf(world, slot).code,
        laneName: laneNameOf(world, slot).name,
      })),
    }
  })
}

/** A stored slot as the answers give it. */
export function storedSlotView(slot: SlotRow, names: ReadonlyMap<string, string>) {
  return {
    id: slot.id,
    version: slot.version,
    planVersionId: slot.planVersionId,
    lane: laneOfSlot(slot),
    workOrderId: slot.workOrderId,
    operationId: slot.workOrderOperationId,
    startAt: toUtcIso(slot.startAt),
    endAt: toUtcIso(slot.endAt),
    pieces: slot.pieces,
    minutes: slot.minutes.toFixed(1),
    overloadReason: slot.overloadReason,
    note: slot.note,
    updatedAt: toUtcIso(slot.updatedAt),
    updatedBy: slot.updatedById ? { id: slot.updatedById, name: names.get(slot.updatedById) ?? '' } : null,
  }
}

export { siteViewOf }
