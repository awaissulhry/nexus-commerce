import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import {
  actionRefusal,
  actionsOf,
  autoClockOutAt,
  breakDueWords,
  clockAheadRefusal,
  clockLooksWrong,
  countedEvents,
  EMPLOYEE_LEFT,
  fixedBreakWords,
  minutesSoFar,
  MONTH_CLOSED,
  NO_EMPLOYEE,
  nextActionOf,
  nextBreakOf,
  offlineWords,
  OTHER_PERSON,
  recordedWords,
  repeatOf,
  shiftForClockIn,
  shiftToShow,
  sourceAndFlags,
  standingOf,
  stateWords,
  todayFrom,
  type ClockAction,
  type ClockFlag,
  type ClockWay,
} from '@nexus/factory-domain/people/clock/rules'
import { clockCheck } from '@nexus/factory-domain/production/scans/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { requireDevice } from '../../../platform/auth/floor/device'
import { refuseByMode } from '../../../platform/auth/floor/sign-in'
import { floorContext } from '../../../platform/auth/floor/store'
import { assertCsrf } from '../../../platform/auth/sessions/cookies'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { systemContext } from '../../../platform/outbox/system'
import { endRunningBlock } from '../../production/offstandard/writes'
import { gateClosedError, legalGateFor } from '../privacy/gate'
import { asContext, floorOf, refuse, requireAttendanceGate, systemOf } from './access'
import type { FloorClockBody, QueuedClockBody, ScanClockBody } from './contract'
import { proveClocker } from './credentials'
import {
  breakRuleFor,
  clockSettingsOf,
  employeeOf,
  EVENT_SELECT,
  eventByClient,
  eventsOf,
  factOf,
  monthClosed,
  recentFrom,
  sessionWayOf,
  shiftsAround,
  siteOf,
  workerOf,
  type EventRow,
  type SiteRow,
  type WorkerRow,
} from './store'

/**
 * Clock in and out (B-W2b-33; MES-223 clock in and out, MES-224 breaks, MES-239 forgot badge, MES-199 offline clock-in
 * and clock-out; design floor.clock SCR-170). One ClockEvent per action, in ONE command with its audit row and its
 * events (attendance.clock_event; clock.out on a clock-out, which also ends the worker's running off-standard block,
 * B-W2b-29 `endRunningBlock(…, 'CLOCK_OUT')`); B-W2b-40 pauses the open operations when it hears clock.out.
 *
 *   floor state   GET  /people/clock/floor   the signed-in worker's "Your time today"
 *   floor clock   POST /people/clock/floor   the signed-in worker taps Clock in / Clock out / Break (or a badge scan's
 *                                            toggle when no action is sent); source BADGE when the session began with a
 *                                            badge, NAME_PIN (flagged FORGOT_BADGE) when it began by name and PIN
 *   tablet clock  POST /people/clock/scan    anyone at an enrolled tablet, signed in or not (a kiosk): a badge alone, or
 *                                            name and PIN; a badge scanned offline is sent later with the tablet's time
 *   queued        floor-sync `people.clock.record` (platform/floor-sync kinds.ts → clockFromQueue): the signed-in
 *                 worker's action kept offline with the tablet's time
 *
 * Every path first asks the site's ATTENDANCE legal gate (Statuto dei Lavoratori art. 4 c.2-3; B-W2b-27): while it is
 * off nothing of a person is read and nothing is recorded (409 `gate/ATTENDANCE` in words). Online actions follow the
 * person's state (refused in words otherwise); a badge scanned again within a minute answers the scan before; an
 * offline action is kept as the tablet recorded it (its time, its action), flagged when the tablet's clock looked
 * wrong; the attendance day (B-W2b-37) judges the sequence. The person is the one their badge, PIN or session proves:
 * nobody clocks for another person on the floor.
 *
 * The person's state is read from the events their tablet's site sees (a person clocking at two plants has a state per
 * plant; the attendance day joins them).
 */

const keyOf = (deviceId: string, clientEventId: string) => `${deviceId}.${clientEventId}`

interface Person {
  readonly worker: WorkerRow
  readonly employee: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly status: string }
  readonly site: SiteRow
}

/** The worker at the device's site and their employee record (read as the system: their home site may be another). */
async function personAt(caller: CommandCaller, context: FloorContext, workerId: string): Promise<Person> {
  const { worker, site } = await caller.withClient(async (db) => ({ worker: await workerOf(db, workerId), site: await siteOf(db, context.siteId) }))
  if (!worker || worker.siteId !== context.siteId || !site) throw new NotFoundError('Worker not found.')
  if (!worker.employeeId) refuse(NO_EMPLOYEE)
  const employee = await systemOf(caller).withClient((db) => employeeOf(db, worker.employeeId!))
  if (!employee || employee.companyId !== site.companyId) refuse(NO_EMPLOYEE)
  if (employee!.status !== 'ACTIVE') refuse(EMPLOYEE_LEFT)
  return { worker, employee: employee!, site }
}

const eventView = (row: Pick<EventRow, 'id' | 'kind' | 'source' | 'occurredAt' | 'flags'>) => ({
  id: row.id,
  kind: row.kind as ClockAction,
  source: row.source as EventRow['source'],
  occurredAt: toUtcIso(row.occurredAt),
  flags: row.flags as ClockFlag[],
  flagged: row.flags.length > 0,
})
type EventView = ReturnType<typeof eventView>

/** "Your time today" of one person (their own: the worker signed in, or the person their badge just proved). */
export async function clockViewOf(caller: CommandCaller, person: Person, now: Date) {
  const { site, employee, worker } = person
  const { settings, rows } = await caller.withClient(async (db) => ({ settings: await clockSettingsOf(db, site.companyId), rows: await eventsOf(db, employee.id, recentFrom(now)) }))
  const facts = rows.map(factOf)
  const standing = standingOf(facts, now)
  const { shifts, breakRule } = await systemOf(caller).withClient(async (db) => ({
    shifts: await shiftsAround(db, employee.id, standing.openSince ?? now, site.timezone),
    breakRule: settings.fixedBreaks ? null : await breakRuleFor(db, site.companyId, site.id),
  }))
  const shift = shiftToShow(shifts, standing, now, site.timezone)
  const from = todayFrom(standing, now, site.timezone)
  const minutes = minutesSoFar(facts, { from, now, fixedBreaks: settings.fixedBreaks && shift ? shift.breaks : [] })
  const next = settings.fixedBreaks ? nextBreakOf(shift, now) : null
  const openShift = standing.openSince ? shiftForClockIn(shifts, standing.openSince) : null
  const counted = new Set(countedEvents(facts).map((fact) => fact.id))
  return {
    person: { workerId: worker.id, employeeId: employee.id, name: worker.displayName },
    state: standing.state,
    inSince: standing.since ? toUtcIso(standing.since) : null,
    breakSince: standing.breakSince ? toUtcIso(standing.breakSince) : null,
    forgottenSince: standing.forgotten ? toUtcIso(standing.forgotten) : null,
    words: stateWords(standing, minutes.worked, now, site.timezone),
    minutes: { worked: minutes.worked, present: minutes.present, breaks: minutes.clockedBreaks + minutes.fixedBreaks },
    shift: shift ? { label: shift.label, date: shift.date, startsAt: toUtcIso(shift.startsAt), endsAt: toUtcIso(shift.endsAt), source: shift.source } : null,
    breaks: {
      mode: settings.fixedBreaks ? ('FIXED' as const) : ('CLOCKED' as const),
      next: next ? { label: next.label, startsAt: toUtcIso(next.startsAt), endsAt: toUtcIso(next.endsAt), words: fixedBreakWords(next, site.timezone) } : null,
      due: !settings.fixedBreaks && standing.state === 'IN' && breakRule ? breakDueWords(minutes.sinceBreak, breakRule) : null,
    },
    autoClockOutAt: openShift && settings.autoClockOutAfterMinutes !== null ? toUtcIso(autoClockOutAt(openShift, settings.autoClockOutAfterMinutes)) : null,
    actions: actionsOf(standing, settings.fixedBreaks),
    next: nextActionOf(standing),
    events: rows.filter((row) => counted.has(row.id) && row.occurredAt.getTime() >= from.getTime()).map(eventView),
    serverTime: toUtcIso(now),
  }
}

// ---- recording -----------------------------------------------------------------------------------------------------------------

/** The person's clock is taken one action at a time (two tablets at once: the second sees the first). */
async function lockPerson(tx: CommandTx, tenantId: string, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.clock', ${tenantId}::uuid, ${employeeId}::uuid), 0))`
}

/** The badge was scanned again within the repeat window: that event answers (thrown out of the command: nothing written). */
class Repeated extends Error {
  constructor(readonly row: EventRow) {
    super('repeated')
  }
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The database refused a clock event dated in a closed month (…_time_w2b_guards factory_time_refuse_closed). */
function isClosedMonthError(error: unknown): boolean {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  return cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.includes('closed month')
}

export interface Recording {
  readonly person: Person
  readonly context: FloorContext
  readonly clientEventId: string
  readonly way: ClockWay
  /** The action; null: a badge scan's toggle (online only). */
  readonly action: ClockAction | null
  /** Kept offline: the tablet's time it happened and its clock's skew when it sent (null: not said). */
  readonly offline: { readonly deviceTime: Date; readonly skewSeconds: number | null } | null
  /** Online: the tablet's clock when tapped (the server's time counts). */
  readonly deviceTime: Date | null
  readonly fixedBreaks: boolean
  /** A PIN proved at the tablet: claimed again inside the command (B-W2b-52's `claimProved`); null otherwise. */
  readonly claim: ((tx: CommandTx, now: Date) => Promise<void>) | null
}

export interface Recorded {
  readonly event: EventView
  readonly action: ClockAction
  /** Sent before under this event id: nothing done again. */
  readonly replayed: boolean
  /** A badge scanned again within a minute: nothing new recorded. */
  readonly repeated: boolean
}

/** Writes the clock event, its audit row and its events, and ends the worker's running off-standard block at a clock-out. */
async function insertClockEvent(
  tools: CommandTools,
  input: { readonly tenantId: string; readonly person: Person; readonly workerId: string; readonly deviceId: string; readonly clientEventId: string; readonly action: ClockAction; readonly source: 'BADGE' | 'NAME_PIN' | 'OFFLINE'; readonly flags: ClockFlag[]; readonly occurredAt: Date; readonly deviceTime: Date },
): Promise<EventView> {
  const { person, action, occurredAt } = input
  const id = newId()
  const row = await tools.tx.clockEvent.create({
    data: {
      id,
      companyId: person.site.companyId,
      siteId: person.site.id,
      employeeId: person.employee.id,
      workerId: input.workerId,
      deviceId: input.deviceId,
      kind: action,
      source: input.source,
      occurredAt,
      deviceTime: input.deviceTime,
      flags: input.flags,
      clientEventId: input.clientEventId,
    },
    select: EVENT_SELECT,
  })
  tools.audit({
    recordType: 'ClockEvent',
    recordId: id,
    companyId: person.site.companyId,
    siteId: person.site.id,
    after: { employeeId: person.employee.id, workerId: input.workerId, kind: action, source: input.source, flags: input.flags, occurredAt: toUtcIso(occurredAt) },
  })
  emitClockEvent(tools, { id, companyId: person.site.companyId, siteId: person.site.id, employeeId: person.employee.id, workerId: input.workerId, kind: action, source: input.source, flagged: input.flags.length > 0 })
  if (action === 'OUT') await endRunningBlock(tools, { tenantId: input.tenantId, siteId: person.site.id, subject: { workerId: input.workerId, stationId: null }, at: occurredAt, endedBy: 'CLOCK_OUT' })
  return eventView(row)
}

/** attendance.clock_event for every event; clock.out for a clock-out (B-W2b-40 listens: open work pauses). */
export function emitClockEvent(
  tools: Pick<CommandTools, 'emit'>,
  event: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly employeeId: string; readonly workerId: string | null; readonly kind: ClockAction; readonly source: 'BADGE' | 'NAME_PIN' | 'OFFLINE' | 'AUTO'; readonly flagged: boolean },
): void {
  const where = { subject: event.employeeId, companyId: event.companyId, siteId: event.siteId }
  tools.emit({ type: 'attendance.clock_event', ...where, payload: { clockEventId: event.id, siteId: event.siteId, employeeId: event.employeeId, kind: event.kind, source: event.source, flagged: event.flagged } })
  if (event.kind === 'OUT') tools.emit({ type: 'clock.out', ...where, payload: { clockEventId: event.id, siteId: event.siteId, employeeId: event.employeeId, workerId: event.workerId, source: event.source } })
}

/** Records one floor action (or answers the one recorded before under its event id, or the scan it repeats). */
export async function recordClock(caller: CommandCaller, rec: Recording, idempotencyKey: string): Promise<Recorded> {
  const { context, person } = rec
  const before = await caller.withClient((db) => eventByClient(db, context.deviceId, rec.clientEventId))
  if (before) return { event: eventView(before), action: before.kind as ClockAction, replayed: true, repeated: false }
  const input = { clientEventId: rec.clientEventId, workerId: person.worker.id, action: rec.action, way: rec.way, offlineAt: rec.offline ? toUtcIso(rec.offline.deviceTime) : null }
  try {
    const { result, replayed } = await command(
      caller,
      { name: 'people.clock', idempotencyKey, input, ...(rec.offline ? { deviceTime: rec.offline.deviceTime } : rec.deviceTime ? { deviceTime: rec.deviceTime } : {}) },
      async (tools) => {
        await lockPerson(tools.tx, context.tenantId, person.employee.id)
        if (rec.claim) await rec.claim(tools.tx, tools.now)
        let action: ClockAction
        let occurredAt: Date
        if (rec.offline) {
          action = rec.action!
          occurredAt = rec.offline.deviceTime
        } else {
          const rows = await eventsOf(tools.tx, person.employee.id, recentFrom(tools.now))
          const standing = standingOf(rows.map(factOf), tools.now)
          if (rec.action === null) {
            const repeat = repeatOf(standing, tools.now)
            if (repeat) throw new Repeated(rows.find((row) => row.id === repeat.id)!)
          }
          action = rec.action ?? nextActionOf(standing)
          const refusal = actionRefusal(standing, action, { fixedBreaks: rec.fixedBreaks, timeZone: person.site.timezone, now: tools.now })
          if (refusal) refuse(refusal)
          occurredAt = tools.now
        }
        if (await monthClosed(tools.tx, person.site.companyId, businessDate(occurredAt, person.site.timezone))) refuse(MONTH_CLOSED)
        const { source, flags } = sourceAndFlags({ way: rec.way, offline: rec.offline !== null, skewSeconds: rec.offline?.skewSeconds ?? null })
        const event = await insertClockEvent(tools, {
          tenantId: context.tenantId,
          person,
          workerId: person.worker.id,
          deviceId: context.deviceId,
          clientEventId: rec.clientEventId,
          action,
          source,
          flags,
          occurredAt,
          deviceTime: rec.offline?.deviceTime ?? rec.deviceTime ?? tools.now,
        })
        return { event, action }
      },
    )
    return { ...result, replayed, repeated: false }
  } catch (error) {
    if (error instanceof Repeated) return { event: eventView(error.row), action: error.row.kind as ClockAction, replayed: false, repeated: true }
    if (error instanceof DomainError) throw error
    // The same tablet event sent twice at once: the one that won answers.
    if (isUniqueViolation(error)) {
      const raced = await caller.withClient((db) => eventByClient(db, context.deviceId, rec.clientEventId)).catch(() => null)
      if (raced) return { event: eventView(raced), action: raced.kind as ClockAction, replayed: true, repeated: false }
    }
    if (isClosedMonthError(error)) refuse(MONTH_CLOSED)
    throw error
  }
}

async function answerOf(caller: CommandCaller, person: Person, recorded: Recorded, offline: Recording['offline']) {
  const now = serverClock.now()
  const at = new Date(recorded.event.occurredAt)
  const words = offline
    ? offlineWords(offline.deviceTime, person.site.timezone, clockLooksWrong(offline.skewSeconds))
    : recorded.repeated || recorded.replayed
      ? `Already recorded: ${recordedWords(recorded.action, at, person.site.timezone).toLowerCase()}`
      : recordedWords(recorded.action, at, person.site.timezone)
  return { event: recorded.event, repeated: recorded.repeated, words, clock: await clockViewOf(caller, person, now) }
}

// ---- the signed-in worker -------------------------------------------------------------------------------------------------------

/** GET /people/clock/floor: the signed-in worker's own clock today. */
export async function floorClockState(caller: CommandCaller) {
  const context = floorOf(caller)
  await requireAttendanceGate(caller, context.siteId)
  const person = await personAt(caller, context, context.actorId)
  return { clock: await clockViewOf(caller, person, serverClock.now()) }
}

/** The way the signed-in worker's session began (a badge, or name and PIN). */
async function wayOfSession(caller: CommandCaller, context: FloorContext): Promise<ClockWay> {
  const way = await caller.withClient((db) => sessionWayOf(db, context.deviceId, context.actorId))
  if (!way) throw new UnauthenticatedError()
  return way
}

/** POST /people/clock/floor: the signed-in worker clocks (an action, or the badge scan's toggle). */
export async function floorClock(caller: CommandCaller, body: FloorClockBody) {
  const context = floorOf(caller)
  await requireAttendanceGate(caller, context.siteId)
  const person = await personAt(caller, context, context.actorId)
  const way = await wayOfSession(caller, context)
  const settings = await caller.withClient((db) => clockSettingsOf(db, person.site.companyId))
  const recorded = await recordClock(
    caller,
    { person, context, clientEventId: body.clientEventId, way, action: body.action ?? null, offline: null, deviceTime: parseInstant(body.deviceTime), fixedBreaks: settings.fixedBreaks, claim: null },
    keyOf(context.deviceId, body.clientEventId),
  )
  return { created: !recorded.replayed && !recorded.repeated, answer: await answerOf(caller, person, recorded, null) }
}

// ---- the tablet's clock (a kiosk) --------------------------------------------------------------------------------------------

/**
 * POST /people/clock/scan (public: the device token and the CSRF double submit): a badge, or a name and PIN, clocks at
 * the tablet, signed in or not. The device's mode first (B-W2b-52: never on a line board; a phone only its person), the
 * gate next (nothing of a person is read while it is off), then the person, then the action in the person's own floor
 * command (the person is the actor; the device on the audit row).
 */
export async function scanClock(auth: OfficeAuth, request: FastifyRequest, body: ScanClockBody) {
  assertCsrf(request)
  const place = await requireDevice(auth, request)
  // B-W2b-52: nobody clocks on a line board (before anything else is read); a phone only its own person (after the proof).
  refuseByMode(place, null)
  const offlineAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  if (offlineAt && body.workerId !== undefined) {
    throw new ValidationError('Clocking by name needs the network: the PIN is never kept on the tablet.', [{ path: 'occurredAt', message: 'A name and PIN are sent online only.' }])
  }
  if (offlineAt && !body.action) throw new ValidationError('An event kept offline says what it was (in, out or a break).', [{ path: 'action', message: 'Required with occurredAt.' }])
  const tenantId = place.device.tenantId
  const system = asContext(request, systemContext(tenantId, String(request.id)))
  const { gate } = await system.withClient((db) => legalGateFor(db, place.device.siteId, 'ATTENDANCE'))
  if (!gate) throw gateClosedError('ATTENDANCE')
  const proved = await proveClocker(auth, request, place, body)
  const context = floorContext(request, place.device, proved.worker.id)
  const caller = asContext(request, context)
  const person = await personAt(caller, context, proved.worker.id)
  const settings = await caller.withClient((db) => clockSettingsOf(db, person.site.companyId))
  const now = serverClock.now()
  let offline: Recording['offline'] = null
  if (offlineAt) {
    const ahead = clockAheadRefusal(offlineAt, now)
    if (ahead) refuse(ahead)
    const sentAt = body.sentAt ? parseInstant(body.sentAt) : null
    offline = { deviceTime: offlineAt, skewSeconds: sentAt ? clockCheck(sentAt, now).skewSeconds : null }
  }
  const recorded = await recordClock(
    caller,
    { person, context, clientEventId: body.clientEventId, way: proved.way, action: body.action ?? null, offline, deviceTime: parseInstant(body.deviceTime), fixedBreaks: settings.fixedBreaks, claim: proved.claim },
    keyOf(place.device.id, body.clientEventId),
  )
  return { created: !recorded.replayed && !recorded.repeated, answer: await answerOf(caller, person, recorded, offline) }
}

// ---- the offline queue ---------------------------------------------------------------------------------------------------------

/**
 * The floor-sync kind `people.clock.record` (B-W0-30 queue): the signed-in worker's action kept offline, with the
 * tablet's time; flagged when the tablet's clock looked wrong at sending; a time in the future, a closed month or a
 * closed gate is refused in words; another person's event waits for them (refused, not final). `key`: the floor-sync
 * key `<device>.<client event id>`.
 */
export async function clockFromQueue(caller: CommandCaller, body: QueuedClockBody & { readonly workerId?: string | undefined }, key: string, sentAt?: string | undefined): Promise<{ readonly id: string; readonly replayed: boolean }> {
  const context = floorOf(caller)
  if (body.workerId !== undefined && body.workerId !== context.actorId) refuse(OTHER_PERSON)
  await requireAttendanceGate(caller, context.siteId)
  const person = await personAt(caller, context, context.actorId)
  const way = await wayOfSession(caller, context)
  const deviceTime = parseInstant(body.occurredAt)!
  const now = serverClock.now()
  const ahead = clockAheadRefusal(deviceTime, now)
  if (ahead) refuse(ahead)
  const sent = sentAt ? parseInstant(sentAt) : null
  const recorded = await recordClock(
    caller,
    { person, context, clientEventId: body.clientEventId, way, action: body.action, offline: { deviceTime, skewSeconds: sent ? clockCheck(sent, now).skewSeconds : null }, deviceTime: null, fixedBreaks: true, claim: null },
    key,
  )
  return { id: recorded.event.id, replayed: recorded.replayed }
}
