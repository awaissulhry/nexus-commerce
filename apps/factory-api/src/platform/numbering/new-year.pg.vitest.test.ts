import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { DOCUMENT_KINDS, FLOOR_DOCUMENT_KINDS, type DocumentKind } from '@nexus/factory-domain/numbering/kinds'
import { seed as seedCore, type CoreSeed } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedFloorAuth } from '../../../../../packages/factory-db/seed/floor-auth'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../core/command'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../core/context'
import { systemContext } from '../outbox/system'
import { allocateNumber, type IssuedNumber } from './allocate'

/**
 * Every series of the numbering seed past New Year's Eve (B-W2b-F16): the seed makes its yearly series for 2026 only, and
 * the product's year rule (allocateNumber: the first number of a new year makes that year's row from the newest one,
 * starting at 1; design admin.documents "Restarts: Yearly · Never") carries each of them into 2027 by itself — for the
 * office, for the system (the worker, a partner's ship notice) and for a tablet (the floor's document kinds). A series
 * that never resets keeps counting. The clock is passed in: 2026-12-31 at noon, then 23:00 UTC (midnight in Rome).
 *
 * A throwaway PostgreSQL 17 database from the migrations, the runtime login through the scoped clients (row-level
 * security, the numbering guards and the floor's policies are real); seeds _core, auth, floor-auth and numbering of one
 * tenant: company A (plant A1) and company B (plant B1, with its tablet). Run with
 * `node scripts/factory/run-pg-tests.mjs platform/numbering/new-year`.
 */

const LAST_DAY = '2026-12-31T12:00:00.000Z'
const NEW_YEAR = '2026-12-31T23:00:00.000Z'

let db: MigratedDatabase
let database: FactoryDatabase
let seeded: CoreSeed
let companyA: string
let companyB: string
let siteB1: string
let tabletB1: string
let workerB1: string

interface SeriesRow {
  readonly id: string
  readonly kind: DocumentKind
  readonly code: string
  readonly scopeKey: string
  readonly reset: 'YEARLY' | 'NEVER'
  readonly pattern: string
  readonly nextValue: number
  readonly createdById: string | null
}

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const seriesOf = (companyId: string) =>
  admin<SeriesRow>(
    'SELECT id::text AS id, kind::text AS kind, code, "scopeKey", reset::text AS reset, pattern, "nextValue", "createdById"::text AS "createdById" FROM "NumberSeries" WHERE "companyId" = $1 ORDER BY kind, "scopeKey"',
    [companyId],
  )

const all: Grant = { permissions: ['numbering.view'], companies: 'all', sites: 'all', parties: 'all' }
const office = (): RequestContext => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId, grants: [all], requestId: newId() })
const floor = (): RequestContext => ({ audience: 'floor', tenantId: seeded.tenantId, actorId: workerB1, siteId: siteB1, deviceId: tabletB1, grants: [{ ...all, permissions: ['floor.work'] }], requestId: newId() }) as RequestContext
const system = (): RequestContext => systemContext(seeded.tenantId, newId())

/** One number of the company's only series of the kind, in one command of the context, at the instant. */
async function take(context: RequestContext, companyId: string, kind: DocumentKind, instant: string): Promise<IssuedNumber> {
  const { result } = await runCommand(
    callerFor(database, context),
    { name: 'test.numberingNewYear', idempotencyKey: newId(), input: { kind, instant } },
    async (tools) => {
      const recordId = newId()
      const number = await allocateNumber(tools, { companyId, kind }, { type: 'Test', id: recordId })
      tools.audit({ recordType: 'Test', recordId, companyId, after: { number: number.formatted } })
      return number
    },
    { ...COMMAND_SETTINGS, clock: fixedClock(instant) },
  )
  return result
}

/** The number a pattern prints for a value in a year (the seed's patterns: {YYYY}, {N} and {N:width}). */
const printed = (pattern: string, value: number, year: number) =>
  pattern.replace('{YYYY}', String(year)).replace(/\{N(?::(\d+))?\}/, (_match, width?: string) => String(value).padStart(Number(width ?? 1), '0'))

beforeAll(async () => {
  db = await migratedDatabase('numbering_new_year')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  seeded = await seedCore({ db: database, namespace: 'newyear-a' })
  await seedAuth({ db: database, namespace: 'newyear-a' })
  const floorSeed = await seedFloorAuth({ db: database, namespace: 'newyear-a' })
  await seedNumbering({ db: database, namespace: 'newyear-a' })
  const siteA1 = seeded.sites.find((site) => site.code === 'A1')!
  const siteB = seeded.sites.find((site) => site.code === 'B1')!
  companyA = siteA1.companyId
  companyB = siteB.companyId
  siteB1 = siteB.id
  tabletB1 = floorSeed.deviceIds[1]!
  // The seed's plants in order (A1, B1): a cutting tablet each, then an operator and a lead each.
  workerB1 = floorSeed.workerIds[2]!
}, 120_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

describe('number series after 2026: every series the seed makes numbers on 2027-01-01', () => {
  it('the seed makes its yearly series for 2026 and the rest for all time; every one is a document kind', async () => {
    const rows = await seriesOf(companyA)
    expect(rows.length).toBeGreaterThan(20)
    for (const row of rows) {
      expect(DOCUMENT_KINDS).toContain(row.kind)
      expect(row.scopeKey).toBe(row.reset === 'YEARLY' ? '2026' : 'ALL')
    }
    expect(rows.map((row) => row.kind)).toEqual(expect.arrayContaining(['NCR', 'CAPA', 'MAINTENANCE_JOB', 'CUT_ORDER', 'CUT_TICKET', 'INVOICE', 'DDT', 'HOLD']))
  })

  it("the office: a 2026 number on New Year's Eve, then the first of 2027 from 1 (a new row of the year), or the next of a series that never resets", async () => {
    const before = await seriesOf(companyA)
    for (const row of before) {
      const last = await take(office(), companyA, row.kind, LAST_DAY)
      expect(last, row.kind).toMatchObject({ seriesId: row.id, scopeKey: row.scopeKey, value: row.nextValue, formatted: printed(row.pattern, row.nextValue, 2026), documentDate: '2026-12-31' })
      const first = await take(office(), companyA, row.kind, NEW_YEAR)
      if (row.reset === 'YEARLY') {
        expect(first, row.kind).toMatchObject({ scopeKey: '2027', value: 1, formatted: printed(row.pattern, 1, 2027), documentDate: '2027-01-01' })
        expect(first.seriesId, row.kind).not.toBe(row.id)
      } else {
        expect(first, row.kind).toMatchObject({ seriesId: row.id, scopeKey: 'ALL', value: row.nextValue + 1, documentDate: '2027-01-01' })
      }
    }
    // Each yearly series has its 2027 row now, made by the office's command, the same pattern, one number taken.
    const after = await seriesOf(companyA)
    for (const row of before.filter((series) => series.reset === 'YEARLY')) {
      expect(after.find((series) => series.kind === row.kind && series.scopeKey === '2027'), row.kind).toMatchObject({ code: row.code, pattern: row.pattern, nextValue: 2, createdById: seeded.actorId })
    }
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE action = $1 AND "companyId" = $2', ['numbering.rollover', companyA])).toHaveLength(before.filter((series) => series.reset === 'YEARLY').length)
  })

  it("a tablet opens 2027 of its own company's floor kinds; the system (the worker, a partner's ship notice) opens the rest", async () => {
    const before = await seriesOf(companyB)
    const floorKinds = FLOOR_DOCUMENT_KINDS as readonly string[]
    for (const row of before) {
      const onTheFloor = floorKinds.includes(row.kind)
      const first = await take(onTheFloor ? floor() : system(), companyB, row.kind, NEW_YEAR)
      if (row.reset === 'YEARLY') expect(first, row.kind).toMatchObject({ scopeKey: '2027', value: 1, formatted: printed(row.pattern, 1, 2027) })
      else expect(first, row.kind).toMatchObject({ seriesId: row.id, value: row.nextValue })
    }
    const after = await seriesOf(companyB)
    for (const row of before.filter((series) => series.reset === 'YEARLY')) {
      const year = after.find((series) => series.kind === row.kind && series.scopeKey === '2027')
      // The ledger names the tablet for a floor kind, never the worker signed in on it.
      expect(year?.createdById, row.kind).toBe(floorKinds.includes(row.kind) ? tabletB1 : SYSTEM_ACTOR_ID)
    }
  })
})
