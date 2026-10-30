import type { Prisma } from '@nexus/factory-db'
import { CALENDARS_MANAGE, CALENDARS_VIEW } from '@nexus/factory-domain/calendars/permissions'
import { segmentProblems, type Segment } from '@nexus/factory-domain/calendars/patterns'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { reachesWholeCompany } from './calendars'
import type { CalendarView, CreatePatternBody, EditPatternBody, PatternView, SaveSegmentsBody, SegmentInput } from './contract'
import { CALENDAR, calendarListWhere, calendarViews, PATTERN, PATTERN_SCOPE_COLUMNS, patternViewOf, patternViews, readPattern, type Client, type PatternRow } from './views'

/**
 * Shift patterns (B-W2a-08; PLN-002; design planning.settings "Shift patterns list: one shift, two shifts, Saturday
 * morning"): a named week of shifts and breaks, tenant-wide (every company's calendars) or one company's. One owner
 * (Planning › Settings): People's roster (W2b) and capacity read the same patterns. A pattern and its segments are
 * saved in ONE command (the database checks at commit that every break lies inside a shift); the rules that would
 * count time twice are factory-domain `calendars/patterns` segmentProblems. Archived, never deleted, and only while no
 * ACTIVE calendar uses it. A pattern reaches every site of its company (every company: tenant-wide), so keeping one
 * needs calendars.manage over all of them.
 */

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller): Actor => actorOf(contextOf(caller))
const createdBy = (context: RequestContext) => (context.audience === 'office' ? context.actorId : null)
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

function mayKeep(who: Actor, companyId: string | null): void {
  if (!reachesWholeCompany(who, CALENDARS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A tenant-wide shift pattern reaches every company: keeping it needs calendars.manage over every company and site.' : "A company's shift pattern reaches all its sites: keeping it needs calendars.manage over every site of the company.")
  }
}

const segmentsOf = (input: readonly SegmentInput[]): Segment[] =>
  input.map((segment) => ({ weekday: segment.weekday, kind: segment.kind, label: segment.label === undefined || segment.label === null || segment.label === '' ? null : segment.label, startMinute: segment.startMinute, endMinute: segment.endMinute }))

function checkSegments(segments: readonly Segment[]): void {
  const problems = segmentProblems(segments)
  if (problems.length > 0) throw new ValidationError('The shifts and breaks are not valid.', prefixed(problems))
}

async function usingCalendars(client: Client, patternId: string): Promise<number> {
  return client.workCalendar.count({ where: { shiftPatternId: patternId, status: 'ACTIVE' } })
}

async function changed(tools: CommandTools, row: PatternRow, change: 'CREATED' | 'EDITED' | 'SEGMENTS_SAVED' | 'ARCHIVED'): Promise<void> {
  tools.emit({
    type: 'calendar.shift_pattern_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: null,
    payload: { patternId: row.id, companyId: row.companyId, code: row.code, change, calendars: await usingCalendars(tools.tx, row.id) },
  })
}

const audited = (row: PatternRow) => ({ companyId: row.companyId, code: row.code, name: row.name, description: row.description, status: row.status })
const auditOf = (row: PatternRow) => ({ recordType: 'ShiftPattern', recordId: row.id, companyId: row.companyId })
const auditedSegments = (segments: readonly Segment[]) => segments.map((segment) => ({ ...segment }))

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function listPatterns(caller: CommandCaller, query: { companyId?: string | undefined; includeArchived?: 'true' | 'false' | undefined }): Promise<PatternView[]> {
  return caller.withClient(async (client) => {
    const rows = await client.shiftPattern.findMany({
      where: {
        AND: [
          scopeWhere(actor(caller), CALENDARS_VIEW, PATTERN_SCOPE_COLUMNS) as Prisma.ShiftPatternWhereInput,
          query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
          query.includeArchived === 'true' ? {} : { status: 'ACTIVE' },
        ],
      },
      select: PATTERN,
      orderBy: [{ code: 'asc' }],
      take: 500,
    })
    return patternViews(client, rows)
  })
}

export async function getPattern(caller: CommandCaller, patternId: string): Promise<{ pattern: PatternView; calendars: CalendarView[] }> {
  return caller.withClient(async (client) => {
    const row = await readPattern(client, actor(caller), patternId)
    const calendars = await client.workCalendar.findMany({ where: { AND: [calendarListWhere(actor(caller)), { shiftPatternId: row.id, status: 'ACTIVE' }] }, select: CALENDAR, orderBy: [{ name: 'asc' }] })
    return { pattern: await patternViewOf(client, row), calendars: await calendarViews(client, calendars) }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

/** calendars.createPattern: a pattern with its shifts and breaks, in one command. */
export async function createPattern(caller: CommandCaller, body: CreatePatternBody, idempotencyKey?: string): Promise<PatternView> {
  const who = actor(caller)
  const companyId = body.companyId ?? null
  if (companyId !== null) {
    const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, status: true } })) : null
    if (!company || !can(who, CALENDARS_VIEW, { companyId })) throw new NotFoundError('The company was not found.')
    if (company.status !== 'ACTIVE') throw new DomainError('invalid_state', 'The company is archived.', [{ path: 'body/companyId', message: 'archived' }])
  }
  mayKeep(who, companyId)
  const segments = segmentsOf(body.segments)
  checkSegments(segments)
  try {
    const { result } = await command(caller, { name: 'calendars.createPattern', idempotencyKey, input: body }, async (tools) => {
      // Inside the work: a repeated Idempotency-Key gets its stored answer before this check.
      if (await tools.tx.shiftPattern.findFirst({ where: { code: body.code }, select: { id: true } })) throw new ConflictError(`The tenant already has a shift pattern ${body.code}.`)
      const id = newId()
      const row = await tools.tx.shiftPattern.create({
        data: { id, companyId, code: body.code, name: body.name, description: body.description ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) },
        select: PATTERN,
      })
      await tools.tx.shiftSegment.createMany({ data: segments.map((segment) => ({ id: newId(), patternId: id, ...segment, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })) })
      tools.audit({ ...auditOf(row), after: { ...audited(row), segments: auditedSegments(segments) } })
      await changed(tools, row, 'CREATED')
      return patternViewOf(tools.tx, row)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`The tenant already has a shift pattern ${body.code}.`)
    throw error
  }
}

/** A pattern the caller may see and keep (its state is checked inside the command: activeInCommand). */
async function patternToKeep(caller: CommandCaller, patternId: string): Promise<PatternRow> {
  const who = actor(caller)
  const row = await caller.withClient((client) => readPattern(client, who, patternId))
  mayKeep(who, row.companyId)
  return row
}

/** The pattern as the command sees it, after the record guard locked it, ACTIVE (a replay never gets here). */
async function activeInCommand(tools: CommandTools, patternId: string): Promise<PatternRow> {
  const row = await tools.tx.shiftPattern.findUniqueOrThrow({ where: { id: patternId }, select: PATTERN })
  if (row.status !== 'ACTIVE') throw new DomainError('invalid_state', `The shift pattern ${row.code} is archived: it is kept as it was. Make a new pattern.`, [{ path: 'pattern/status', message: 'ARCHIVED' }])
  return row
}

/** calendars.saveSegments: the pattern's shifts and breaks replaced, in one command (checked at commit). */
export async function saveSegments(caller: CommandCaller, patternId: string, body: SaveSegmentsBody, idempotencyKey?: string): Promise<PatternView> {
  const before = await patternToKeep(caller, patternId)
  const segments = segmentsOf(body.segments)
  checkSegments(segments)
  const { result } = await command(
    caller,
    { name: 'calendars.saveSegments', idempotencyKey, input: { patternId, ...body }, record: { type: 'ShiftPattern', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      await activeInCommand(tools, before.id)
      const old = await tools.tx.shiftSegment.findMany({ where: { patternId: before.id }, select: { weekday: true, kind: true, label: true, startMinute: true, endMinute: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] })
      await tools.tx.shiftSegment.deleteMany({ where: { patternId: before.id } })
      await tools.tx.shiftSegment.createMany({ data: segments.map((segment) => ({ id: newId(), patternId: before.id, ...segment, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })) })
      const row = await tools.tx.shiftPattern.update({ where: { id: before.id }, data: { updatedAt: tools.now }, select: PATTERN })
      tools.audit({ ...auditOf(row), action: 'calendars.saveSegments', before: { segments: old }, after: { segments: auditedSegments(segments) }, ...(body.reason ? { reason: body.reason } : {}) })
      await changed(tools, row, 'SEGMENTS_SAVED')
      return patternViewOf(tools.tx, row)
    },
  )
  return result
}

/** calendars.editPattern: the name and the one-line description (the code and company never change). */
export async function editPattern(caller: CommandCaller, patternId: string, body: EditPatternBody, idempotencyKey?: string): Promise<PatternView> {
  const before = await patternToKeep(caller, patternId)
  const { result } = await command(
    caller,
    { name: 'calendars.editPattern', idempotencyKey, input: { patternId, ...body }, record: { type: 'ShiftPattern', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      await activeInCommand(tools, before.id)
      const row = await tools.tx.shiftPattern.update({
        where: { id: before.id },
        data: { ...(body.name === undefined ? {} : { name: body.name }), ...(body.description === undefined ? {} : { description: body.description }), updatedAt: tools.now },
        select: PATTERN,
      })
      tools.audit({ ...auditOf(row), before: audited(before), after: audited(row), ...(body.reason ? { reason: body.reason } : {}) })
      await changed(tools, row, 'EDITED')
      return patternViewOf(tools.tx, row)
    },
  )
  return result
}

/** calendars.archivePattern: only while no ACTIVE calendar uses it (the refusal names them). */
export async function archivePattern(caller: CommandCaller, patternId: string, body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<PatternView> {
  const before = await patternToKeep(caller, patternId)
  const { result } = await command(
    caller,
    { name: 'calendars.archivePattern', idempotencyKey, input: { patternId, ...body }, record: { type: 'ShiftPattern', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      await activeInCommand(tools, before.id)
      // In words before the database's guard refuses it; inside the work, so a replay answers what the archive did.
      const users = await tools.tx.workCalendar.findMany({ where: { shiftPatternId: before.id, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }], take: 50 })
      if (users.length > 0) {
        throw new DomainError(
          'conflict',
          `The shift pattern ${before.code} is used by ${users.length === 1 ? 'a calendar' : `${users.length} calendars`}: give ${users.length === 1 ? 'it' : 'them'} another pattern first.`,
          users.map((calendar) => ({ path: `calendars/${calendar.id}`, message: calendar.name })),
        )
      }
      const row = await tools.tx.shiftPattern.update({ where: { id: before.id }, data: { status: 'ARCHIVED', updatedAt: tools.now }, select: PATTERN })
      tools.audit({ ...auditOf(row), before: audited(before), after: audited(row), ...(body.reason ? { reason: body.reason } : {}) })
      await changed(tools, row, 'ARCHIVED')
      return patternViewOf(tools.tx, row)
    },
  )
  return result
}
