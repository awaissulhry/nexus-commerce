import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { NumberKind, NumberReset } from '@nexus/factory-domain/numbering/kinds'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandSettings } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { allocateNumber, type IssuedNumber, type SeriesRef } from './allocate'
import { advanceSeries, createSeries, listSeries, setSeriesStart } from './series'

/**
 * allocateNumber() and the series commands on the local stack: a throwaway PostgreSQL 17 database built from the
 * migrations, the runtime login factory_app through the scoped clients, as the API runs. Fixture tenants and companies
 * are written by the admin login. Run with `node scripts/factory/run-pg-tests.mjs apps/factory-api`.
 */

const NOW = '2026-10-28T09:00:00.000Z'
const at = (instant: string): CommandSettings => ({ ...COMMAND_SETTINGS, clock: fixedClock(instant) })

let db: MigratedDatabase
let database: FactoryDatabase
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const userA = newId()

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

beforeAll(async () => {
  db = await migratedDatabase('numbering')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const [tenantId, slug, companyId] of [
    [tenantA, 'num-a', companyA],
    [tenantB, 'num-b', companyB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-c`])
  }
}, 60_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

const manager: Grant = { permissions: ['numbering.manage', 'numbering.view'], companies: 'all', sites: 'all', parties: 'all' }
const office = (tenantId = tenantA): RequestContext => ({ audience: 'office', tenantId, actorId: userA, grants: [manager], requestId: newId() })
const as = (context: RequestContext = office()) => callerFor(database, context)

/** A new series of tenant A's company with its own code, so each test counts from its own start. */
async function newSeries(kind: NumberKind = 'INVOICE', more: { reset?: NumberReset; year?: number; startValue?: number; pattern?: string } = {}) {
  const code = `T${newId().slice(-8).toUpperCase()}`
  const reset = more.reset ?? 'YEARLY'
  const series = await createSeries(as(), { companyId: companyA, kind, code, reset, year: reset === 'YEARLY' ? (more.year ?? 2026) : undefined, pattern: more.pattern, startValue: more.startValue })
  return { ...series, ref: { companyId: companyA, kind, code } satisfies SeriesRef }
}

interface Issue {
  readonly date?: string
  readonly recordId?: string
  /** Fails after the number was taken, inside the transaction: the command rolls back. */
  readonly fail?: boolean
  readonly hold?: () => Promise<void>
  readonly context?: RequestContext
  readonly settings?: CommandSettings
}

/** invoices.issue: the shape of a real issuing command (the number, then the document's audit row). */
async function issue(series: SeriesRef, options: Issue = {}): Promise<IssuedNumber> {
  const recordId = options.recordId ?? newId()
  const context = options.context ?? office()
  const { result } = await runCommand(
    as(context),
    { name: 'invoices.issue', input: { recordId, date: options.date } },
    async (tools) => {
      await options.hold?.()
      const number = await allocateNumber(tools, series, { type: 'Invoice', id: recordId, ...(options.date ? { date: options.date } : {}) })
      tools.audit({ recordType: 'Invoice', recordId, companyId: series.companyId, after: { number: number.formatted } })
      if (options.fail) throw new Error('the PDF store is down')
      return { ...number }
    },
    options.settings ?? at(NOW),
  )
  return result
}

const seriesRow = async (id: string) =>
  (await admin<{ nextValue: number; startValue: number; version: number; lastIssuedDate: string | null }>(
    'SELECT "nextValue", "startValue", version, "lastIssuedDate"::text AS "lastIssuedDate" FROM "NumberSeries" WHERE id = $1',
    [id],
  ))[0]!
const ledger = (seriesId: string) =>
  admin<{ value: number; formatted: string; documentDate: string; recordId: string; requestId: string }>(
    'SELECT value, formatted, "documentDate"::text AS "documentDate", "recordId"::text AS "recordId", "requestId" FROM "NumberAllocation" WHERE "seriesId" = $1 ORDER BY value',
    [seriesId],
  )
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

/** Lets the first `count` callers through only together: they then queue on the series lock at the same moment. */
function together(count: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  return () => {
    arrived++
    if (arrived === count) release()
    return arrived <= count ? all : Promise.resolve()
  }
}

describe('allocateNumber', () => {
  it('gives 50 concurrent commands the numbers 1 to 50: no gap, no duplicate', async () => {
    const series = await newSeries()
    const hold = together(10)
    const issued = await Promise.all(range(1, 50).map(() => issue(series.ref, { hold })))
    expect(issued.map((number) => number.value).sort((a, b) => a - b)).toEqual(range(1, 50))
    expect(new Set(issued.map((number) => number.formatted)).size).toBe(50)
    const rows = await ledger(series.id)
    expect(rows.map((row) => row.value)).toEqual(range(1, 50))
    expect(rows[0]!.formatted).toBe('FT-2026-00001')
    expect(rows[49]!.formatted).toBe('FT-2026-00050')
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 51, version: 51, lastIssuedDate: '2026-10-28' })
  }, 60_000)

  it('leaves no gap when the command rolls back: the next command gets the same number', async () => {
    const series = await newSeries()
    expect((await issue(series.ref)).value).toBe(1)
    const failed = [newId(), newId()]
    for (const recordId of failed) await expect(issue(series.ref, { recordId, fail: true })).rejects.toThrow('the PDF store is down')
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 2, version: 2 })
    expect((await issue(series.ref)).value).toBe(2)
    expect((await ledger(series.id)).map((row) => row.value)).toEqual([1, 2])
    // The rolled-back commands left nothing: no number, no audit row.
    expect(await admin('SELECT 1 FROM "NumberAllocation" WHERE "recordId" = ANY($1::uuid[])', [failed])).toHaveLength(0)
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [failed])).toHaveLength(0)
  })

  it('invoice numbers are progressive, with no gap and never reused, per company, series and year (DPR 633/1972 art. 21)', async () => {
    const series = await newSeries('INVOICE')
    // Concurrent issues, some of which roll back, then later days.
    const hold = together(8)
    const outcomes = await Promise.allSettled(range(1, 24).map((index) => issue(series.ref, { hold, fail: index % 4 === 0, date: '2026-10-28' })))
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(6)
    await issue(series.ref, { date: '2026-10-29' })
    await issue(series.ref, { date: '2026-10-30' })
    // A later number never carries an earlier date.
    await expect(issue(series.ref, { date: '2026-10-29' })).rejects.toThrow(ConflictError)

    const rows = await ledger(series.id)
    expect(rows.map((row) => row.value)).toEqual(range(1, 20))
    expect(new Set(rows.map((row) => row.formatted)).size).toBe(20)
    expect(rows.map((row) => row.documentDate)).toEqual([...rows.map((row) => row.documentDate)].sort())
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 21, lastIssuedDate: '2026-10-30' })

    // An issued number is never changed or removed, not even by the owner (the triggers), and never issued twice.
    await expect(admin('UPDATE "NumberAllocation" SET value = 99 WHERE "seriesId" = $1', [series.id])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "NumberAllocation" WHERE "seriesId" = $1', [series.id])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "NumberAllocation"')).rejects.toThrow(/append-only|cannot truncate/)
    await expect(
      admin(
        `INSERT INTO "NumberAllocation" (id, "tenantId", "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
         SELECT $1, "tenantId", "companyId", "seriesId", kind, value, formatted, "documentDate", 'Invoice', $2, now(), "allocatedById", 'replay' FROM "NumberAllocation" WHERE "seriesId" = $3 AND value = 7`,
        [newId(), newId(), series.id],
      ),
    ).rejects.toThrow(/unique/)
    // And a used counter never moves back, for the runtime login and the owner alike.
    await expect(
      database.withScope({ audience: 'office', tenantId: tenantA, actorId: userA }, (client) =>
        client.$executeRawUnsafe('UPDATE "NumberSeries" SET "nextValue" = 5 WHERE id = $1::uuid', series.id),
      ),
    ).rejects.toThrow(/never moves back/)
    await expect(admin('UPDATE "NumberSeries" SET "nextValue" = 5 WHERE id = $1', [series.id])).rejects.toThrow(/never moves back/)
    await expect(admin(`UPDATE "NumberSeries" SET pattern = 'X-{N}' WHERE id = $1`, [series.id])).rejects.toThrow(/fixed once a number is issued/)
  })

  it('gives each company and series its own counter', async () => {
    const one = await newSeries('INVOICE')
    const two = await newSeries('INVOICE')
    const credit = await newSeries('CREDIT_NOTE', { pattern: 'NC-{N}' })
    expect((await issue(one.ref)).value).toBe(1)
    expect((await issue(one.ref)).value).toBe(2)
    expect((await issue(two.ref)).value).toBe(1)
    expect(await issue(credit.ref)).toMatchObject({ value: 1, formatted: 'NC-1', fiscal: true, kind: 'CREDIT_NOTE' })
  })

  it('rolls a yearly series over on the business date in Europe/Rome, starting at 1, also for concurrent first numbers', async () => {
    const series = await newSeries('INVOICE')
    // 22:59:59 UTC on 31 December is 23:59:59 in Rome: still 2026.
    const lastOf2026 = await issue(series.ref, { settings: at('2026-12-31T22:59:59.000Z') })
    expect(lastOf2026).toMatchObject({ scopeKey: '2026', value: 1, documentDate: '2026-12-31', formatted: 'FT-2026-00001' })
    // 23:00 UTC is midnight in Rome: the first numbers of 2027, ten at once.
    const hold = together(6)
    const firstOf2027 = await Promise.all(range(1, 10).map(() => issue(series.ref, { hold, settings: at('2026-12-31T23:00:00.000Z') })))
    expect(firstOf2027.map((number) => number.value).sort((a, b) => a - b)).toEqual(range(1, 10))
    expect(new Set(firstOf2027.map((number) => number.seriesId))).toEqual(new Set([firstOf2027[0]!.seriesId]))
    expect(firstOf2027[0]).toMatchObject({ scopeKey: '2027', documentDate: '2027-01-01' })
    expect(firstOf2027.map((number) => number.formatted)).toContain('FT-2027-00010')

    const rows = await admin<{ scopeKey: string; nextValue: number; pattern: string; id: string }>(
      'SELECT "scopeKey", "nextValue", pattern, id::text AS id FROM "NumberSeries" WHERE code = $1 ORDER BY "scopeKey"',
      [series.code],
    )
    expect(rows.map(({ scopeKey, nextValue, pattern }) => ({ scopeKey, nextValue, pattern }))).toEqual([
      { scopeKey: '2026', nextValue: 2, pattern: 'FT-{YYYY}-{N:5}' },
      { scopeKey: '2027', nextValue: 11, pattern: 'FT-{YYYY}-{N:5}' },
    ])
    // One audit row for the new year's series, whichever command made it.
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE action = $1 AND "recordId" = $2', ['numbering.rollover', rows[1]!.id])).toHaveLength(1)
    // A late document for 2026 still takes 2026's next number; a year before the first is not invented.
    expect(await issue(series.ref, { date: '2026-12-31', settings: at('2027-01-02T09:00:00.000Z') })).toMatchObject({ scopeKey: '2026', value: 2 })
    await expect(issue(series.ref, { date: '2025-12-31' })).rejects.toThrow(NotFoundError)
  }, 60_000)

  it('starts a series at a given number (the paper booklet\'s hand-over), until it issued one', async () => {
    const series = await newSeries('DDT', { startValue: 143, pattern: '{N}/{YYYY}' })
    expect(series).toMatchObject({ fiscal: true, startValue: 143, nextValue: 143, nextNumber: '143/2026' })
    const moved = await setSeriesStart(as(), series.id, { startValue: 150, version: series.version })
    expect(moved).toMatchObject({ startValue: 150, nextValue: 150, version: series.version + 1 })
    expect(await issue(series.ref)).toMatchObject({ value: 150, formatted: '150/2026' })
    expect((await issue(series.ref)).value).toBe(151)
    const now = await seriesRow(series.id)
    await expect(setSeriesStart(as(), series.id, { startValue: 1, version: now.version })).rejects.toThrow(/its start is fixed/)
    // The next year of a series can be made ahead with its own start.
    const next = await createSeries(as(), { companyId: companyA, kind: 'DDT', code: series.code, reset: 'YEARLY', year: 2027, pattern: '{N}/{YYYY}', startValue: 40 })
    expect(await issue(series.ref, { date: '2027-01-04' })).toMatchObject({ seriesId: next.id, value: 40, formatted: '40/2027' })
  })

  it('moves a series past a number after a restore, and never back', async () => {
    const series = await newSeries('INVOICE')
    await issue(series.ref)
    await issue(series.ref)
    let row = await seriesRow(series.id)
    const advanced = await advanceSeries(as(), series.id, { pastValue: 200, reason: 'restore drill: last SDI receipt FT-2026-00200', lastIssuedDate: '2026-11-03', version: row.version })
    expect(advanced).toMatchObject({ nextValue: 201, nextNumber: 'FT-2026-00201', lastIssuedDate: '2026-11-03' })
    // The date of the last number before the restore holds too.
    await expect(issue(series.ref, { date: '2026-11-02' })).rejects.toThrow(ConflictError)
    expect(await issue(series.ref, { date: '2026-11-03' })).toMatchObject({ value: 201 })

    row = await seriesRow(series.id)
    for (const pastValue of [150, 201]) {
      await expect(advanceSeries(as(), series.id, { pastValue, reason: 'a typo', version: row.version })).rejects.toThrow(/never moves back/)
    }
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 202, version: row.version })
    const [audit] = await admin<{ reason: string; before: { nextValue: number }; after: { nextValue: number } }>(
      `SELECT reason, before, after FROM "AuditLog" WHERE action = 'numbering.advance' AND "recordId" = $1`,
      [series.id],
    )
    expect(audit).toMatchObject({ reason: 'restore drill: last SDI receipt FT-2026-00200', before: { nextValue: 3 }, after: { nextValue: 201 } })
    // A stale version is refused like any edit.
    await expect(advanceSeries(as(), series.id, { pastValue: 300, reason: 'stale', version: row.version - 1 })).rejects.toThrow(/changed since it was read/)
  })

  it('keeps one number per record and kind, and refuses closed, missing or ambiguous series', async () => {
    const series = await newSeries('INVOICE')
    const recordId = newId()
    await issue(series.ref, { recordId })
    await expect(issue(series.ref, { recordId })).rejects.toThrow(/already has invoice number FT-2026-00001/)
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 2 })

    await admin(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE id = $1`, [series.id])
    await expect(issue(series.ref)).rejects.toThrow(InvalidStateError)
    await expect(issue({ companyId: companyA, kind: 'RETURN' })).rejects.toThrow(NotFoundError)
    await expect(issue({ companyId: companyA, kind: 'INVOICE', code: 'NOPE' })).rejects.toThrow(NotFoundError)
    // Without a code: the company's only active series of the kind, or a request to name one.
    const lots = await newSeries('LOT', { reset: 'NEVER', pattern: 'LOT-{N:6}' })
    expect(await issue({ companyId: companyA, kind: 'LOT' })).toMatchObject({ seriesId: lots.id, scopeKey: 'ALL', formatted: 'LOT-000001', fiscal: false })
    await newSeries('LOT', { reset: 'NEVER' })
    await expect(issue({ companyId: companyA, kind: 'LOT' })).rejects.toThrow(ValidationError)
  })

  it('lets a non-fiscal series number documents in any date order', async () => {
    const lots = await newSeries('BATCH', { reset: 'NEVER', pattern: 'BT{N:4}' })
    await issue(lots.ref, { date: '2026-10-30' })
    expect(await issue(lots.ref, { date: '2026-10-01' })).toMatchObject({ value: 2, formatted: 'BT0002', fiscal: false })
  })

  it('stays behind the tenant wall', async () => {
    const series = await newSeries('INVOICE')
    await issue(series.ref)
    // Tenant B sees no series of tenant A's company, so it can neither number from it nor lock it.
    await expect(issue(series.ref, { context: office(tenantB) })).rejects.toThrow(NotFoundError)
    await expect(createSeries(as(office(tenantB)), { companyId: companyA, kind: 'INVOICE', year: 2026 })).rejects.toThrow(NotFoundError)
    await expect(advanceSeries(as(office(tenantB)), series.id, { pastValue: 900, reason: 'other tenant', version: 1 })).rejects.toThrow(NotFoundError)
    const seenByB = await database.withScope({ audience: 'office', tenantId: tenantB, actorId: userA }, (client) => listSeries(client, { audience: 'office', tenantId: tenantB, grants: [manager] }, {}))
    expect(seenByB.map((row) => row.companyId)).not.toContain(companyA)
    expect(await seriesRow(series.id)).toMatchObject({ nextValue: 2 })
  })

  it('issues numbers only in office and system commands', async () => {
    const series = await newSeries('INVOICE')
    const system: RequestContext = { audience: 'system', tenantId: tenantA, actorId: '00000000-0000-7000-8000-000000000000', grants: [], requestId: newId() }
    expect((await issue(series.ref, { context: system })).value).toBe(1)
    const floor: RequestContext = { audience: 'floor', tenantId: tenantA, actorId: userA, siteId: newId(), deviceId: newId(), grants: [], requestId: newId() }
    const outcome = runCommand(as(floor), { name: 'invoices.issue', idempotencyKey: `floor-${newId()}`, input: {} }, async (tools) => {
      await allocateNumber(tools, series.ref, { type: 'Invoice', id: newId() })
      return null
    }, at(NOW))
    await expect(outcome).rejects.toThrow(ApiError)
  })
})
