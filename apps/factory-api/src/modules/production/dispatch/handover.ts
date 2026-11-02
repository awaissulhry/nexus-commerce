import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { dayOf as calendarDayOf } from '@nexus/factory-domain/calendars/working-time'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { HANDOVER_LIMITS, HANDOVER_LOOK, handoverProblems, newSince, shiftLabelAt, type HandoverTopic } from '@nexus/factory-domain/production/dispatch/handover'
import { PRODUCTION_DISPATCH_HANDOVER, PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import { DISPATCH_REFUSALS } from '@nexus/factory-domain/production/dispatch/rules'
import type { Prisma } from '@nexus/factory-db'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { contextOf, floorOf, may, readerOf, refuse, type DispatchContext } from './access'
import { deviceLine } from './mine'
import { dayColumn, dayOf, lineRowOf, siteRowOf, type LineRow, type Reader } from './store'
import type { SiteRow } from '../../planning/store'

/**
 * Shift handover notes (B-W2b-49; MES-033; design floor.supervisor "Handover note", floor.signin "the line's handover note if
 * new since your last shift", production.dispatch):
 *
 *   GET  /production/dispatch/handover?lineId&days     a line's notes, newest first, and the shift a note would go to now
 *                                                      (production.dispatch.view; office and the team leader's tablet)
 *   POST /production/dispatch/handover                 write or edit the note of a line and shift, one per shift
 *                                                      (production.dispatch.handover; both; queued offline as
 *                                                      andon.handover.write); an edit names the version it read
 *   GET  /production/dispatch/handover/new             what the person signing in has not seen: the notes of the tablet's
 *                                                      line since their previous session ended (floor.work)
 *
 * The line's day and shift, never a person: who wrote a note stays in the audit log, no answer carries it, and nobody's
 * reading is stored ("Seen" stays on the tablet; the next session starts later than the note, so it does not come back).
 */

const NOTE_SELECT = { id: true, lineId: true, shiftDate: true, shiftLabel: true, topics: true, text: true, createdAt: true, updatedAt: true, version: true, createdById: true } as const satisfies Prisma.HandoverNoteSelect
type NoteRow = Prisma.HandoverNoteGetPayload<{ select: typeof NOTE_SELECT }>

const noteView = (note: NoteRow) => ({
  id: note.id,
  lineId: note.lineId,
  shiftDate: dayOf(note.shiftDate),
  shiftLabel: note.shiftLabel,
  topics: (note.topics as HandoverTopic[]).map((topic) => ({ topic, ...HANDOVER_LOOK[topic] })),
  text: note.text,
  writtenAt: toUtcIso(note.createdAt),
  updatedAt: toUtcIso(note.updatedAt),
  version: note.version,
})

/** The shift a note written at `at` belongs to, on the line's own calendar. */
async function shiftOf(db: Reader, line: LineRow, day: BusinessDate, at: Date): Promise<string> {
  const calendar = (await workingCalendarsFor(db, [{ scope: 'LINE', id: line.id }], { from: plusDays(day, -1), to: plusDays(day, 1) })).get(ownerKey({ scope: 'LINE', id: line.id }))?.calendar
  return shiftLabelAt(calendar ? calendarDayOf(calendar, day).shifts : [], at)
}

async function knownLine(caller: CommandCaller, context: DispatchContext, lineId: string, permission: typeof PRODUCTION_DISPATCH_VIEW | typeof PRODUCTION_DISPATCH_HANDOVER): Promise<{ line: LineRow; site: SiteRow }> {
  const found = await caller.withClient(async (db: Reader) => {
    const line = await lineRowOf(db, lineId)
    return line ? { line, site: await siteRowOf(db, line.siteId) } : null
  })
  if (!found?.site || !may(context, permission, { companyId: found.line.companyId, siteId: found.line.siteId })) throw new NotFoundError('Line not found.')
  return { line: found.line, site: found.site }
}

/** GET /production/dispatch/handover. */
export async function lineHandover(caller: CommandCaller, query: { readonly lineId: string; readonly days?: number | undefined }) {
  const context = contextOf(caller)
  const { line, site } = await knownLine(caller, context, query.lineId, PRODUCTION_DISPATCH_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const shift = await readerOf(caller, context).withClient((db: Reader) => shiftOf(db, line, today, now))
  const days = query.days ?? HANDOVER_LIMITS.listDays
  const notes = await caller.withClient((db: Reader) => db.handoverNote.findMany({ where: { lineId: line.id, shiftDate: { gte: dayColumn(plusDays(today, 1 - days)) } }, select: NOTE_SELECT, orderBy: [{ shiftDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }], take: HANDOVER_LIMITS.listNotes }))
  return {
    line: { id: line.id, code: line.code, name: line.name },
    day: today,
    shift,
    current: notes.find((note) => dayOf(note.shiftDate) === today && note.shiftLabel === shift) ? noteView(notes.find((note) => dayOf(note.shiftDate) === today && note.shiftLabel === shift)!) : null,
    notes: notes.map(noteView),
    mayWrite: may(context, PRODUCTION_DISPATCH_HANDOVER, { companyId: line.companyId, siteId: line.siteId }),
  }
}

export interface HandoverBody {
  readonly lineId: string
  readonly date?: BusinessDate | undefined
  readonly shiftLabel?: string | undefined
  readonly topics: readonly HandoverTopic[]
  readonly text?: string | null | undefined
  /** The version read: an edit of a note that changed since is refused. */
  readonly version?: number | undefined
  /** The tablet's time of a note kept offline (it picks the shift). */
  readonly at?: string | undefined
}

async function lockNote(tx: CommandTx, tenantId: string, lineId: string, day: BusinessDate, shiftLabel: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.handover', ${tenantId}::uuid::text, ${lineId}::uuid::text, ${day}::text, ${shiftLabel}::text), 0))`
}

/** POST /production/dispatch/handover (and the offline queue's andon.handover.write). */
export async function writeHandover(caller: CommandCaller, body: HandoverBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const problems = handoverProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ ...issue, path: `body/${issue.path}` })))
  const { line, site } = await knownLine(caller, context, body.lineId, PRODUCTION_DISPATCH_HANDOVER)
  if (line.status !== 'ACTIVE') refuse(DISPATCH_REFUSALS.LINE_INACTIVE)
  const at = (body.at ? parseInstant(body.at) : null) ?? serverClock.now()
  const day = body.date ?? businessDate(at, site.timezone)
  if (day > businessDate(serverClock.now(), site.timezone)) throw new ValidationError('A note is written in its shift, not ahead of it.', [{ path: 'body/date', message: 'Pick today or an earlier day.' }])
  const shiftLabel = body.shiftLabel?.trim() || (await readerOf(caller, context).withClient((db: Reader) => shiftOf(db, line, day, at)))
  const text = body.text?.trim() || null
  const { result, replayed } = await command(caller, { name: 'production.writeHandoverNote', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockNote(tx, context.tenantId, line.id, day, shiftLabel)
    const stored = await tx.handoverNote.findFirst({ where: { lineId: line.id, shiftDate: dayColumn(day), shiftLabel }, select: NOTE_SELECT })
    const scope = { companyId: line.companyId, siteId: line.siteId }
    let note: NoteRow
    if (stored) {
      if (body.version !== undefined && stored.version !== body.version) refuse(DISPATCH_REFUSALS.STALE)
      const { count } = await tx.handoverNote.updateMany({ where: { id: stored.id, version: stored.version }, data: { topics: [...body.topics], text, version: { increment: 1 }, updatedAt: now } })
      if (count !== 1) refuse(DISPATCH_REFUSALS.STALE)
      note = (await tx.handoverNote.findUnique({ where: { id: stored.id }, select: NOTE_SELECT }))!
      tools.audit({ recordType: 'HandoverNote', recordId: stored.id, ...scope, before: { topics: stored.topics, text: stored.text }, after: { topics: note.topics, text } })
    } else {
      const id = newId()
      note = await tx.handoverNote.create({ data: { id, siteId: line.siteId, lineId: line.id, shiftDate: dayColumn(day), shiftLabel, topics: [...body.topics], text, deviceId: context.audience === 'floor' ? context.deviceId : null, createdAt: now, updatedAt: now, createdById: context.actorId }, select: NOTE_SELECT })
      tools.audit({ recordType: 'HandoverNote', recordId: id, ...scope, after: { lineId: line.id, shiftDate: day, shiftLabel, topics: note.topics, text } })
    }
    tools.emit({ type: 'dispatch.handover_written', subject: line.id, ...scope, payload: { noteId: note.id, siteId: line.siteId, lineId: line.id, shiftDate: day, shiftLabel, topics: [...(note.topics as HandoverTopic[])], by: context.audience === 'floor' ? 'FLOOR' : 'OFFICE' } })
    return { note: noteView(note), created: stored === null }
  })
  return { ...result, replayed }
}

/** GET /production/dispatch/handover/new: the tablet's line, the notes since the person's previous session. */
export async function newHandover(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db: Reader) => {
    const lineId = await deviceLine(db, context.deviceId)
    if (!lineId) return { line: null, since: null, notes: [] }
    const line = await lineRowOf(db, lineId)
    const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { currentSessionId: true } })
    const previous = await db.floorSession.findFirst({ where: { workerId: context.actorId, ...(device?.currentSessionId ? { id: { not: device.currentSessionId } } : {}) }, select: { startedAt: true, endedAt: true, lastSeenAt: true }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] })
    const since = newSince(previous, now)
    const notes = await db.handoverNote.findMany({ where: { lineId, updatedAt: { gt: since }, NOT: { createdById: context.actorId } }, select: NOTE_SELECT, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: HANDOVER_LIMITS.listNotes })
    return { line: line ? { id: line.id, code: line.code, name: line.name } : null, since: toUtcIso(since), notes: notes.map(noteView) }
  })
}
