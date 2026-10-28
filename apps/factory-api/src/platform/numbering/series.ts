import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { formatNumber, patternProblem } from '@nexus/factory-domain/numbering/format'
import {
  DEFAULT_SERIES_CODE,
  defaultPattern,
  isFiscalKind,
  kindLabel,
  MAX_NUMBER,
  NO_RESET_SCOPE,
  yearOfScope,
  type NumberKind,
  type NumberReset,
} from '@nexus/factory-domain/numbering/kinds'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '@nexus/factory-domain/numbering/permissions'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { SeriesView } from './contract'

/**
 * The admin side of the series (feature PLT-122, PLAN §2.8 and §4.9): list them, create one (starting at a given
 * number when a paper booklet or the accountant's software used the first ones: R-13), give an unused one another
 * start, and move one past a number after a database restore, so the next document never repeats a number already in
 * the SDI receipts or the DDT archive. Every write goes through command() with its audit row; none ever moves a used
 * counter back (the database refuses it too).
 */

const SELECT = {
  id: true,
  companyId: true,
  kind: true,
  code: true,
  scopeKey: true,
  reset: true,
  pattern: true,
  fiscal: true,
  startValue: true,
  nextValue: true,
  lastIssuedDate: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.NumberSeriesSelect

type SeriesRow = Prisma.NumberSeriesGetPayload<{ select: typeof SELECT }>

const dateText = (date: Date | null): BusinessDate | null => (date === null ? null : date.toISOString().slice(0, 10))
const day = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

export function viewOf(row: SeriesRow): SeriesView {
  const year = yearOfScope(row.scopeKey)
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    code: row.code,
    scopeKey: row.scopeKey,
    year,
    reset: row.reset,
    pattern: row.pattern,
    fiscal: row.fiscal,
    startValue: row.startValue,
    nextValue: row.nextValue,
    nextNumber: row.nextValue <= MAX_NUMBER ? formatNumber(row.pattern, { value: row.nextValue, year }) : null,
    lastIssuedDate: dateText(row.lastIssuedDate),
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** What the audit row records of a series. */
const audited = (row: SeriesRow) => ({
  kind: row.kind,
  code: row.code,
  scopeKey: row.scopeKey,
  pattern: row.pattern,
  startValue: row.startValue,
  nextValue: row.nextValue,
  lastIssuedDate: dateText(row.lastIssuedDate),
})

export interface SeriesFilter {
  readonly companyId?: string | undefined
  readonly kind?: NumberKind | undefined
}

/** The series the caller's numbering.view grants reach, by company, kind, code and newest period first. */
export async function listSeries(client: FactoryClient, actor: Actor, filter: SeriesFilter): Promise<SeriesView[]> {
  const scope = scopeWhere(actor, NUMBERING_VIEW, { company: 'companyId' }) as Prisma.NumberSeriesWhereInput
  const own: Prisma.NumberSeriesWhereInput = {
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
  }
  const rows = await client.numberSeries.findMany({
    where: { AND: [scope, own] },
    orderBy: [{ companyId: 'asc' }, { kind: 'asc' }, { code: 'asc' }, { scopeKey: 'desc' }],
    take: 500,
    select: SELECT,
  })
  return rows.map(viewOf)
}

/** The series' company, read before a write so a caller outside it gets 403 (and 404 for no such series). */
async function companyOf(caller: CommandCaller, seriesId: string): Promise<string> {
  const row = await caller.withClient((client) => client.numberSeries.findUnique({ where: { id: seriesId }, select: { companyId: true } }))
  if (!row) throw new NotFoundError('Number series not found.')
  return row.companyId
}

function mayManage(caller: CommandCaller, companyId: string): void {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (!can(actorOf(context), NUMBERING_MANAGE, { companyId })) throw new ForbiddenError()
}

async function loadRow(tx: CommandTx, id: string): Promise<SeriesRow> {
  const row = await tx.numberSeries.findUnique({ where: { id }, select: SELECT })
  if (!row) throw new NotFoundError('Number series not found.')
  return row
}

export interface CreateSeriesInput {
  readonly companyId: string
  readonly kind: NumberKind
  readonly code?: string | undefined
  readonly reset?: NumberReset | undefined
  readonly year?: number | undefined
  readonly pattern?: string | undefined
  readonly startValue?: number | undefined
}

/** numbering.createSeries: a new series, or a new period of one (a yearly series' next year with its own start). */
export async function createSeries(caller: CommandCaller, input: CreateSeriesInput, idempotencyKey?: string): Promise<SeriesView> {
  mayManage(caller, input.companyId)
  const reset = input.reset ?? 'YEARLY'
  const fiscal = isFiscalKind(input.kind)
  const code = input.code ?? DEFAULT_SERIES_CODE
  const pattern = input.pattern ?? defaultPattern(input.kind, reset)
  const problem = patternProblem(pattern, reset, fiscal)
  if (problem) throw new ValidationError('The pattern is not valid.', [{ path: 'body/pattern', message: problem }])
  if (reset === 'NEVER' && input.year !== undefined) {
    throw new ValidationError('A series that never resets has no year.', [{ path: 'body/year', message: 'Leave it out, or choose a yearly series.' }])
  }
  const startValue = input.startValue ?? 1
  const label = kindLabel(input.kind)

  const { result } = await command(caller, { name: 'numbering.createSeries', idempotencyKey, input }, async ({ tx, audit, now, context }) => {
    const scopeKey = reset === 'NEVER' ? NO_RESET_SCOPE : String(input.year ?? Number.parseInt(businessDate(now, BUSINESS_TIME_ZONE).slice(0, 4), 10))
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { id: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const family = await tx.numberSeries.findMany({ where: { companyId: input.companyId, kind: input.kind, code }, select: { reset: true, scopeKey: true } })
    if (family.some((row) => row.reset !== reset)) {
      throw new ValidationError(`The ${label} series ${code} ${family[0]!.reset === 'YEARLY' ? 'starts again every year' : 'never resets'}; a new period keeps that.`, [
        { path: 'body/reset', message: `Expected ${family[0]!.reset}.` },
      ])
    }
    if (family.some((row) => row.scopeKey === scopeKey)) {
      throw new ConflictError(`The ${label} series ${code} ${scopeKey === NO_RESET_SCOPE ? '' : `for ${scopeKey} `}exists already; set its start or move it past a number instead.`)
    }
    const id = newId()
    const row = await tx.numberSeries.create({
      data: {
        id,
        companyId: input.companyId,
        kind: input.kind,
        code,
        scopeKey,
        reset,
        pattern,
        fiscal,
        startValue,
        nextValue: startValue,
        createdAt: now,
        updatedAt: now,
        createdById: context.audience === 'office' ? context.actorId : null,
      },
      select: SELECT,
    })
    audit({ recordType: 'NumberSeries', recordId: id, companyId: input.companyId, after: audited(row) })
    return viewOf(row)
  })
  return result
}

/** numbering.setStart: another first number for a series that has issued none (and was never moved past one). */
export async function setSeriesStart(caller: CommandCaller, seriesId: string, input: { startValue: number; version: number }, idempotencyKey?: string): Promise<SeriesView> {
  mayManage(caller, await companyOf(caller, seriesId))
  const { result } = await command(
    caller,
    { name: 'numbering.setStart', idempotencyKey, input, record: { type: 'NumberSeries', id: seriesId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const before = await loadRow(tx, seriesId)
      if (before.nextValue !== before.startValue) {
        throw new ConflictError(
          `The ${kindLabel(before.kind)} series ${before.code} has moved on (next number ${before.nextValue}); its start is fixed. Move it past a number instead.`,
        )
      }
      const after = await tx.numberSeries.update({ where: { id: seriesId }, data: { startValue: input.startValue, nextValue: input.startValue }, select: SELECT })
      audit({ recordType: 'NumberSeries', recordId: seriesId, companyId: before.companyId, before: audited(before), after: audited(after) })
      return viewOf(after)
    },
  )
  return result
}

export interface AdvanceInput {
  readonly pastValue: number
  readonly reason: string
  readonly lastIssuedDate?: BusinessDate | undefined
  readonly version: number
}

/**
 * numbering.advance: the series continues after `pastValue` (PLAN §4.9: after any restore, each fiscal series moves
 * past the last number in the SDI receipts and the DDT archive). Only forward: a series already past it is refused.
 */
export async function advanceSeries(caller: CommandCaller, seriesId: string, input: AdvanceInput, idempotencyKey?: string): Promise<SeriesView> {
  mayManage(caller, await companyOf(caller, seriesId))
  const { result } = await command(
    caller,
    { name: 'numbering.advance', idempotencyKey, input, record: { type: 'NumberSeries', id: seriesId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const before = await loadRow(tx, seriesId)
      const nextValue = input.pastValue + 1
      if (nextValue <= before.nextValue) {
        throw new ConflictError(
          `The ${kindLabel(before.kind)} series ${before.code} is already past ${input.pastValue} (next number ${before.nextValue}); a series never moves back.`,
        )
      }
      const known = dateText(before.lastIssuedDate)
      const lastIssuedDate = input.lastIssuedDate !== undefined && (known === null || input.lastIssuedDate > known) ? input.lastIssuedDate : known
      const after = await tx.numberSeries.update({
        where: { id: seriesId },
        data: { nextValue, lastIssuedDate: lastIssuedDate === null ? null : day(lastIssuedDate) },
        select: SELECT,
      })
      audit({ recordType: 'NumberSeries', recordId: seriesId, companyId: before.companyId, before: audited(before), after: audited(after), reason: input.reason })
      return viewOf(after)
    },
  )
  return result
}
