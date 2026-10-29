import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, isBusinessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { formatNumber, MAX_FISCAL_NUMBER_LENGTH } from '@nexus/factory-domain/numbering/format'
import { isNumberKind, isScanIdKind, isSeriesCode, kindLabel, MAX_NUMBER, scopeKeyFor, yearOfScope, type NumberKind } from '@nexus/factory-domain/numbering/kinds'
import type { CommandTools } from '../../core/command'
import { SYSTEM_ACTOR_ID } from '../../core/context'
import { ApiError } from '../../core/errors'

/**
 * allocateNumber(): the next number of a series for a record, taken inside the issuing command's transaction (plan
 * A1 §2.3, PLAN §2.8; features PLT-122, PLT-123). Call it from a command's work, with the command's tools:
 *
 *   await command(request, { name: 'ddt.issue', input, record: { type: 'Ddt', id, expectedVersion } }, async (tools) => {
 *     const number = await allocateNumber(tools, { companyId, kind: 'DDT' }, { type: 'Ddt', id, date: ddtDate })
 *     await tools.tx.ddt.update({ where: { id }, data: { number: number.formatted, numberValue: number.value } })
 *     tools.audit({ recordType: 'Ddt', recordId: id, companyId, after: { number: number.formatted } })
 *     return { number: number.formatted }
 *   })
 *
 * Gapless and never twice: the series row is locked (SELECT … FOR UPDATE), so concurrent issues wait for each other
 * and each reads the number the one before it left; the counter, the NumberAllocation row and the document commit
 * together with the command, so a command that fails or rolls back consumes no number. The database backs this up: a
 * used counter never moves back (trigger) and a printed number is unique per series period.
 *
 * The period: the calendar year of the record's date (a business date in Europe/Rome; default today's) for a series
 * that resets yearly. The first number of a new year makes that year's row from the series' newest one, starting at 1
 * (an admin can make it earlier with another start, for a paper booklet's hand-over). A fiscal series (invoice,
 * deposit invoice, credit note, DDT) also refuses a date before its last number's date and a number longer than
 * FatturaPA's 20 characters.
 *
 * The series is named by company and kind, and by code when the company keeps several of that kind (sezionali); with
 * no code, the company's only active one. Office and system (worker) commands issue numbers; floor and portal sessions
 * have no grant on the series (a tablet must never move a company's counter, a fiscal one least of all).
 *
 * Document kinds only. The scan-id kinds (BUNDLE, HIDE, GARMENT_SERIAL) have no company series: ONE tenant-wide
 * counter each, taken with allocateScanIds (online, any writing audience, the floor included) and, for a tablet's
 * offline labels, its own number blocks with useScanIds (scan-ids.ts).
 */

export interface SeriesRef {
  readonly companyId: string
  readonly kind: NumberKind
  /** The series code (sezionale). Default: the company's only active series of this kind. */
  readonly code?: string
}

export interface NumberedRecord {
  /** The model name of the record that gets the number (`Invoice`, `Ddt`). */
  readonly type: string
  readonly id: string
  /** The document's business date, `YYYY-MM-DD` (Europe/Rome). Default: the command's day in Europe/Rome. */
  readonly date?: BusinessDate
}

/** The number a record got. */
export interface IssuedNumber {
  readonly seriesId: string
  readonly kind: NumberKind
  readonly code: string
  /** `2026`, or `ALL` for a series that never resets. */
  readonly scopeKey: string
  readonly value: number
  /** As printed on the document. */
  readonly formatted: string
  readonly documentDate: BusinessDate
  readonly fiscal: boolean
}

/** What allocateNumber needs of the command's tools. */
export type AllocationTools = Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit'>

const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

interface LockedSeries {
  readonly id: string
  readonly pattern: string
  readonly fiscal: boolean
  readonly nextValue: number
  readonly lastIssuedDate: string | null
  readonly status: string
}

const day = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

export async function allocateNumber(tools: AllocationTools, series: SeriesRef, record: NumberedRecord): Promise<IssuedNumber> {
  const { tx, context, now } = tools
  if (context.audience !== 'office' && context.audience !== 'system') {
    throw new ApiError('internal_error', `Numbers are issued by office and system commands; the ${context.audience} audience has no grant on the series.`)
  }
  const { companyId, kind } = series
  if (!isUuid(companyId)) throw new NotFoundError('Company not found.')
  if (!isNumberKind(kind)) throw new ApiError('internal_error', `allocateNumber(): ${JSON.stringify(kind)} is not a number kind.`)
  if (isScanIdKind(kind)) throw new ApiError('internal_error', `allocateNumber(): ${kind} is a scan-id kind with one tenant-wide counter; take it with allocateScanIds (platform/numbering/scan-ids).`)
  if (series.code !== undefined && !isSeriesCode(series.code)) throw new ValidationError('The series code is not valid.', [{ path: 'series', message: 'Expected 1 to 16 capitals, digits or hyphens.' }])
  if (!RECORD_TYPE.test(record.type) || !isUuid(record.id)) throw new ApiError('internal_error', 'allocateNumber() needs the record\'s model name and id.')
  const date = record.date ?? businessDate(now, BUSINESS_TIME_ZONE)
  if (!isBusinessDate(date)) throw new ValidationError('The document date is not valid.', [{ path: 'date', message: 'Expected a calendar day written YYYY-MM-DD.' }])
  const tenantId = context.tenantId
  const actorId = context.audience === 'system' ? SYSTEM_ACTOR_ID : context.actorId
  const label = kindLabel(kind)

  const code = series.code ?? (await onlyActiveCode(tools, companyId, kind))
  const newest = await tx.numberSeries.findFirst({
    where: { companyId, kind, code },
    orderBy: { scopeKey: 'desc' },
    select: { reset: true, scopeKey: true, pattern: true, fiscal: true, status: true },
  })
  if (!newest) throw new NotFoundError(`This company has no ${label} series ${code}; an admin sets it up under numbering.`)
  const scopeKey = scopeKeyFor(newest.reset, date)

  if (newest.reset === 'YEARLY' && scopeKey > newest.scopeKey) {
    // The first number of a new year: that year's row, from the newest one. Two first numbers at once both insert;
    // the second waits on the unique key and inserts nothing, then both queue on the row lock below.
    if (newest.status !== 'ACTIVE') throw new InvalidStateError(`The ${label} series ${code} is closed; it issues no numbers for ${scopeKey}.`)
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "NumberSeries" ("id", "companyId", "kind", "code", "scopeKey", "reset", "pattern", "fiscal", "startValue", "nextValue", "createdAt", "updatedAt", "createdById")
      VALUES (${newId()}::uuid, ${companyId}::uuid, ${kind}::"NumberKind", ${code}, ${scopeKey}, 'YEARLY'::"NumberReset", ${newest.pattern}, ${newest.fiscal}, 1, 1, ${now}, ${now}, ${actorId}::uuid)
      ON CONFLICT ("tenantId", "companyId", "kind", "code", "scopeKey") DO NOTHING
      RETURNING "id"::text AS "id"`
    for (const row of created) {
      tools.audit({
        action: 'numbering.rollover',
        recordType: 'NumberSeries',
        recordId: row.id,
        companyId,
        after: { kind, code, scopeKey, pattern: newest.pattern, startValue: 1, from: newest.scopeKey },
      })
    }
  }

  const [locked] = await tx.$queryRaw<LockedSeries[]>`
    SELECT "id"::text AS "id", "pattern", "fiscal", "nextValue", "lastIssuedDate"::text AS "lastIssuedDate", "status"::text AS "status"
    FROM "NumberSeries"
    WHERE "tenantId" = ${tenantId}::uuid AND "companyId" = ${companyId}::uuid AND "kind" = ${kind}::"NumberKind" AND "code" = ${code} AND "scopeKey" = ${scopeKey}
    FOR UPDATE`
  if (!locked) throw new NotFoundError(`This company has no ${label} series ${code} for ${scopeKey}.`)
  if (locked.status !== 'ACTIVE') throw new InvalidStateError(`The ${label} series ${code} ${scopeKey} is closed; it issues no more numbers.`)
  if (locked.fiscal && locked.lastIssuedDate !== null && date < locked.lastIssuedDate) {
    // Progressive numbering (DPR 633/1972 art. 21): a later number never carries an earlier date.
    throw new ConflictError(`The last ${label} number of series ${code} is dated ${locked.lastIssuedDate}; a document dated ${date} cannot take the next number.`)
  }
  const value = locked.nextValue
  if (value > MAX_NUMBER) throw new ConflictError(`The ${label} series ${code} ${scopeKey} has issued its last number; open a new series.`)
  const formatted = formatNumber(locked.pattern, { value, year: yearOfScope(scopeKey) })
  if (locked.fiscal && formatted.length > MAX_FISCAL_NUMBER_LENGTH) {
    throw new ConflictError(`The ${label} number ${formatted} is longer than ${MAX_FISCAL_NUMBER_LENGTH} characters; open a series with a shorter pattern.`)
  }

  const existing = await tx.numberAllocation.findFirst({ where: { recordType: record.type, recordId: record.id, kind }, select: { formatted: true } })
  if (existing) throw new ConflictError(`This ${record.type} already has ${label} number ${existing.formatted}.`)

  await tx.numberAllocation.create({
    data: {
      id: newId(),
      companyId,
      seriesId: locked.id,
      kind,
      value,
      formatted,
      documentDate: day(date),
      recordType: record.type,
      recordId: record.id,
      allocatedAt: now,
      allocatedById: actorId,
      requestId: context.requestId,
    },
    select: { id: true },
  })
  const lastIssuedDate = locked.lastIssuedDate !== null && locked.lastIssuedDate > date ? locked.lastIssuedDate : date
  const { count } = await tx.numberSeries.updateMany({
    where: { id: locked.id, nextValue: value },
    data: { nextValue: value + 1, lastIssuedDate: day(lastIssuedDate), version: { increment: 1 } },
  })
  if (count !== 1) throw new ApiError('internal_error', 'allocateNumber(): the locked series changed under its lock.')

  return { seriesId: locked.id, kind, code, scopeKey, value, formatted, documentDate: date, fiscal: locked.fiscal }
}

/** The code of the company's only active series of a kind; several or none is the caller's mistake to fix. */
async function onlyActiveCode({ tx }: AllocationTools, companyId: string, kind: NumberKind): Promise<string> {
  const rows = await tx.numberSeries.findMany({ where: { companyId, kind, status: 'ACTIVE' }, select: { code: true }, distinct: ['code'], orderBy: { code: 'asc' } })
  const label = kindLabel(kind)
  if (rows.length === 0) throw new NotFoundError(`This company has no active ${label} series; an admin sets it up under numbering.`)
  if (rows.length > 1) {
    throw new ValidationError(`This company has several ${label} series; name the one to use.`, [{ path: 'series', message: `One of ${rows.map((row) => row.code).join(', ')}.` }])
  }
  return rows[0]!.code
}
