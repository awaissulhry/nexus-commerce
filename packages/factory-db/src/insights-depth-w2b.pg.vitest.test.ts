import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { factDailyKey, factHourlyKey, seed as seedInsightsDepth, type InsightsDepthSeed } from '../seed/insights-depth'
import { seed as seedPortalAuth } from '../seed/portal-auth'
import { seed as seedRoles } from '../seed/roles'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The metric layer (W2b-6, schema wave 57/57, B-W2b-381, …_insights_depth_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and its scopes:
 *   - KPI versions: born DRAFT, made from a lower version of the same key with what changed; DRAFT → ACTIVE → SUPERSEDED |
 *     RETIRED, one ACTIVE per key; an ACTIVE version changes only by its end; a past one is frozen; only a DRAFT is deleted;
 *     the words in Italian and English, records that are tables, measure keys, an office owner, a MONEY unit with its grain;
 *     never a wages or pay grain;
 *   - KPI uses: of a KPI in force, never changed;
 *   - dashboard layouts: an office person's, the panels' shape;
 *   - the morning e-mail: a company's switch OFF by default, on with when and by whom, never deleted; a person's digest on
 *     with when and by whom, its time, zone, weekdays, language and sections; marked sent only forward, only while it is on
 *     and its company's switch is on;
 *   - alert routes: one office role or one office person, a place that exists and is never wider than the rule's; never
 *     changed;
 *   - facts: a line with its site, exactly one number, the company's currency with an amount, today at the latest, a whole
 *     hour of the site's clock with its day, rebuilt only forward; no person column.
 * The refusals are check_violation (23514) in words, the unique keys' 23505, the foreign keys' 23503, or the grants'
 * permission denied.
 */

const NS = 'w2b-381-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: InsightsDepthSeed
let roleIds: Readonly<Record<string, string>>
let partnerUserId: string

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA1: key('site:A1'),
  siteB1: key('site:B1'),
  lineA1: key('site:A1:line:L1'),
  lineB1: key('site:B1:line:L1'),
  member: key('user:member'),
  invited: key('user:invited'),
  holdRule: key('alerts:rule:HOLD_TOO_LONG'),
  lateRule: key('alerts:rule:ORDER_LATE_RISK'),
  customerP1: key('party:P1'),
  supplierP2: key('party:P2'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const set = (table: string, id: string, assignments: string, ...values: unknown[]) => run(`UPDATE "${table}" SET ${assignments} WHERE id = $1::uuid`, id, ...values)
const HOUR = 3_600_000
/** Today's business day in Rome, less `days`. */
const romeDay = (days = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - days * 24 * HOUR))

const words = {
  nameIt: 'Indicatore di prova',
  nameEn: 'Test indicator',
  definitionIt: 'Un indicatore inventato per una prova.',
  definitionEn: 'A made-up indicator for a test.',
  formulaIt: 'a ÷ b × 100',
  formulaEn: 'a ÷ b × 100',
}
/** A DRAFT version of a KPI (a fresh key unless given), owned by the planner. */
async function draft(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(
    await insert('KpiDefinition', {
      id,
      kpiKey: `test.kpi_${id.slice(0, 8)}`,
      kpiVersion: 1,
      ...words,
      sourceRecords: ['SalesOrderLine'],
      measureKeys: ['orders.lines_due'],
      ownerRoleId: roleIds['planner'],
      unit: 'PERCENT',
      ...extra,
    }),
  ).toBe(1)
  return id
}
const activate = (id: string) => set('KpiDefinition', id, `state = 'ACTIVE', "activatedAt" = now(), "activatedById" = $2::uuid`, a.actorId)
const endAs = (id: string, state: 'SUPERSEDED' | 'RETIRED') => set('KpiDefinition', id, `state = $2::"KpiState", "endedAt" = now(), "endedById" = $3::uuid`, state, a.actorId)
const keyOf = async (id: string): Promise<string> => String((await admin(`SELECT "kpiKey" FROM "KpiDefinition" WHERE id = $1`, [id]))[0]!.kpiKey)

/** A daily fact of company A (a value unless the number is given). */
async function fact(extra: Record<string, unknown> = {}, number: Record<string, unknown> = { value: '7' }): Promise<string> {
  const id = randomUUID()
  const siteId = 'siteId' in extra ? (extra.siteId as string | null) : null
  const lineId = 'lineId' in extra ? (extra.lineId as string | null) : null
  const day = (extra.day as string | undefined) ?? romeDay(1)
  const measureKey = (extra.measureKey as string | undefined) ?? `test.measure_${id.slice(0, 8)}`
  const companyId = (extra.companyId as string | undefined) ?? A.companyA
  expect(
    await insert('FactDaily', {
      id,
      companyId,
      siteId,
      lineId,
      day,
      measureKey,
      key: factDailyKey(companyId, siteId, lineId, day, measureKey),
      ...number,
      rebuiltAt: new Date(Date.now() - 60_000).toISOString(),
      ...extra,
    }),
  ).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('insightsdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  // It runs the auth, roles, alerts and parties seeds itself.
  s = await seedInsightsDepth({ db: factory, namespace: NS })
  roleIds = (await seedRoles({ db: factory, namespace: NS })).roleIds
  partnerUserId = (await seedPortalAuth({ db: factory, namespace: NS })).userIds.p1Buyer
  // Run twice: every seed is idempotent.
  await seedInsightsDepth({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row; no company\'s morning e-mail is switched on, no digest went out', async () => {
    const [counts] = await admin(
      `SELECT (SELECT count(*)::int FROM "KpiDefinition" WHERE "tenantId" = $1::uuid) AS kpis,
              (SELECT count(*)::int FROM "KpiDefinition" WHERE "tenantId" = $1::uuid AND state = 'ACTIVE') AS active,
              (SELECT count(*)::int FROM "KpiUse" WHERE "tenantId" = $1::uuid) AS uses,
              (SELECT count(*)::int FROM "DashboardLayout" WHERE "tenantId" = $1::uuid) AS layouts,
              (SELECT count(*)::int FROM "DigestSetting" WHERE "tenantId" = $1::uuid) AS digests,
              (SELECT count(*)::int FROM "DigestSetting" WHERE "tenantId" = $1::uuid AND "lastSentAt" IS NOT NULL) AS sent,
              (SELECT count(*)::int FROM "InsightsSettings" WHERE "tenantId" = $1::uuid) AS settings,
              (SELECT count(*)::int FROM "InsightsSettings" WHERE "tenantId" = $1::uuid AND "digestMailOn") AS "switchedOn",
              (SELECT count(*)::int FROM "AlertRoute" WHERE "tenantId" = $1::uuid) AS routes,
              (SELECT count(*)::int FROM "FactDaily" WHERE "tenantId" = $1::uuid) AS daily,
              (SELECT count(*)::int FROM "FactHourly" WHERE "tenantId" = $1::uuid) AS hourly`,
      [a.tenantId],
    )
    expect(counts).toEqual({ kpis: 8, active: 4, uses: 5, layouts: 2, digests: 2, sent: 0, settings: 2, switchedOn: 0, routes: 4, daily: 19, hourly: 3 })
    expect(s.factDailyIds).toHaveLength(19)
    const states = await admin(`SELECT "kpiVersion", state::text FROM "KpiDefinition" WHERE "tenantId" = $1::uuid AND "kpiKey" = 'delivery.otif' ORDER BY "kpiVersion"`, [a.tenantId])
    expect(states).toEqual([
      { kpiVersion: 1, state: 'SUPERSEDED' },
      { kpiVersion: 2, state: 'ACTIVE' },
      { kpiVersion: 3, state: 'DRAFT' },
    ])
  })
})

describe('KPI definitions (ANA-012, ANA-070)', () => {
  it('are written as a DRAFT, with a dotted key and a number from 1', async () => {
    await expect(draft({ state: 'ACTIVE', activatedAt: new Date().toISOString(), activatedById: a.actorId })).rejects.toThrow(/is written as a DRAFT, then activated/)
    await expect(draft({ kpiKey: 'OTIF' })).rejects.toThrow(/a KPI's key is a dotted key of lower-case words/)
    await expect(draft({ kpiVersion: 0 })).rejects.toThrow(/are numbered from 1/)
  })

  it('say their name, definition and formula in Italian and in English', async () => {
    await expect(draft({ nameEn: ' ' })).rejects.toThrow(/its name in Italian and in English/)
    await expect(draft({ nameIt: 'two\nlines' })).rejects.toThrow(/its name in Italian and in English, 1 to 120 characters on one line/)
    await expect(draft({ definitionIt: '  ' })).rejects.toThrow(/says what it means in plain words, in Italian and in English/)
    await expect(draft({ formulaEn: 'x'.repeat(1001) })).rejects.toThrow(/gives its formula in words, in Italian and in English, 1 to 1000/)
  })

  it('name records that are tables and measure keys, each once, an office owner role, and the grain of a money unit', async () => {
    await expect(draft({ sourceRecords: [] })).rejects.toThrow(/names 1 to 20 records it is computed from/)
    await expect(draft({ sourceRecords: ['SalesOrderLine', 'NoSuchTable'] })).rejects.toThrow(/each a table of the database/)
    await expect(draft({ sourceRecords: ['Shipment', 'Shipment'] })).rejects.toThrow(/each once/)
    await expect(draft({ measureKeys: ['Orders'] })).rejects.toThrow(/names up to 30 facts it reads, each a measure key/)
    await expect(draft({ ownerRoleId: roleIds['operator'] })).rejects.toThrow(/owned by an office role that is not archived/)
    await expect(draft({ unit: 'MONEY' })).rejects.toThrow(/counts money: it names the grain its value needs/)
    expect(await draft({ unit: 'MONEY', grain: 'COST', measureKeys: [] })).toBeTruthy()
  })

  it('never carry a wages or pay grain: a KPI never measures a person', async () => {
    await expect(draft({ unit: 'MONEY', grain: 'PAY' })).rejects.toThrow(/invalid input value for enum "KpiGrain"/)
    await expect(draft({ unit: 'MONEY', grain: 'WAGES' })).rejects.toThrow(/invalid input value for enum "KpiGrain"/)
  })

  it('are made from a lower version of the same KPI, saying what changed', async () => {
    const v1 = await draft()
    const kpiKey = await keyOf(v1)
    await expect(draft({ kpiKey, kpiVersion: 2, basedOnId: v1 })).rejects.toThrow(/says what changed .* exactly when it is made from an earlier version/)
    await expect(draft({ kpiKey, kpiVersion: 2, changeNote: 'Nothing to compare with.' })).rejects.toThrow(/exactly when it is made from an earlier version/)
    await expect(draft({ kpiKey: `${kpiKey}_other`, kpiVersion: 2, basedOnId: v1, changeNote: 'Another KPI.' })).rejects.toThrow(/made from a version of the same KPI with a lower number/)
    const v3 = await draft({ kpiKey, kpiVersion: 3, basedOnId: v1, changeNote: 'Counts partial lines.' })
    await expect(draft({ kpiKey, kpiVersion: 2, basedOnId: v3, changeNote: 'Back.' })).rejects.toThrow(/with a lower number/)
    await expect(insert('KpiDefinition', { id: randomUUID(), kpiKey, kpiVersion: 3, ...words, sourceRecords: ['Shipment'], ownerRoleId: roleIds['planner'], unit: 'COUNT' })).rejects.toThrow(/KpiDefinition_tenantId_kpiKey_kpiVersion_key|duplicate key/)
  })

  it('move DRAFT → ACTIVE → SUPERSEDED or RETIRED, one ACTIVE per key; an ACTIVE version changes only by its end', async () => {
    const v1 = await draft()
    const kpiKey = await keyOf(v1)
    await expect(set('KpiDefinition', v1, `state = 'ACTIVE'`)).rejects.toThrow(/names when and by whom it was activated exactly from ACTIVE on/)
    await expect(endAs(v1, 'RETIRED')).rejects.toThrow(/moves DRAFT → ACTIVE → SUPERSEDED or RETIRED \(not DRAFT → RETIRED\)/)
    expect(await activate(v1)).toBe(1)
    await expect(set('KpiDefinition', v1, `"nameEn" = 'Renamed'`)).rejects.toThrow(/is in force: it is never edited \(a change is a new version\)/)
    await expect(set('KpiDefinition', v1, `state = 'DRAFT', "activatedAt" = NULL, "activatedById" = NULL`)).rejects.toThrow(/not ACTIVE → DRAFT/)
    await expect(set('KpiDefinition', v1, `"kpiVersion" = 9`)).rejects.toThrow(/the key, the number, the version it was made from and the creation .* never change/)
    const v2 = await draft({ kpiKey, kpiVersion: 2, basedOnId: v1, changeNote: 'A new rule.' })
    await expect(activate(v2)).rejects.toThrow(/KpiDefinition_one_active|duplicate key/)
    expect(await endAs(v1, 'SUPERSEDED')).toBe(1)
    expect(await activate(v2)).toBe(1)
    await expect(set('KpiDefinition', v1, `"nameEn" = 'Renamed'`)).rejects.toThrow(/is no longer in force \(SUPERSEDED\): it changes no more/)
    await expect(set('KpiDefinition', v2, `state = 'RETIRED', "endedAt" = now() - interval '2 days', "endedById" = $2::uuid`, a.actorId)).rejects.toThrow(/not before it was activated/)
    expect(await endAs(v2, 'RETIRED')).toBe(1)
  })

  it('are deleted only as a DRAFT; never truncated', async () => {
    const v1 = await draft()
    expect(await run(`DELETE FROM "KpiDefinition" WHERE id = $1::uuid`, v1)).toBe(1)
    await expect(run(`DELETE FROM "KpiDefinition" WHERE id = $1::uuid`, s.kpiIds.otifV2)).rejects.toThrow(/was in force \(ACTIVE\): it explains old numbers and is never deleted/)
    await expect(admin(`DELETE FROM "KpiDefinition" WHERE id = $1`, [s.kpiIds.otifV1])).rejects.toThrow(/was in force \(SUPERSEDED\)/)
    await expect(admin(`TRUNCATE "KpiDefinition"`)).rejects.toThrow(/TRUNCATE on "KpiDefinition" is refused/)
  })
})

describe('KPI uses (ANA-070)', () => {
  const use = (kpiKey: string, usedIn: string, useKey: string, extra: Record<string, unknown> = {}) =>
    insert('KpiUse', { id: randomUUID(), kpiKey, usedIn, useKey, key: `kpiuse:${kpiKey}:${usedIn}:${useKey}`, ...extra })

  it('name a KPI in force and their reader by its key', async () => {
    await expect(use('purchasing.supplier_on_time', 'DASHBOARD', 'buyer')).rejects.toThrow(/reads a KPI that is in force \(an ACTIVE version of purchasing\.supplier_on_time\)/)
    await expect(use('sales.quotes_sent', 'REPORT', 'sales.open-orders')).rejects.toThrow(/reads a KPI that is in force/)
    await expect(use('production.wip_value', 'DASHBOARD', 'plant manager')).rejects.toThrow(/names its reader by its key/)
    await expect(use('production.wip_value', 'DASHBOARD', 'plant-manager', { key: 'kpiuse:production.wip_value:DASHBOARD:finance' })).rejects.toThrow(/the key of use .* is kpiuse:<kpiKey>:<usedIn>:<useKey>/)
    expect(await use('production.wip_value', 'DASHBOARD', 'plant-manager')).toBe(1)
    await expect(use('production.wip_value', 'DASHBOARD', 'plant-manager')).rejects.toThrow(/KpiUse_tenantId_key_key|duplicate key/)
  })

  it('are added or removed, never changed', async () => {
    const [first] = s.useIds
    await expect(set('KpiUse', first!, `"useKey" = 'planner'`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "KpiUse" SET "useKey" = 'planner' WHERE id = $1`, [first])).rejects.toThrow(/is added or removed, never changed/)
    expect(await run(`DELETE FROM "KpiUse" WHERE id = $1::uuid`, s.useIds[4])).toBe(1)
  })
})

describe('dashboard layouts (ANA-002)', () => {
  const panels = [
    { id: 'numbers', hidden: false, width: 'FULL' },
    { id: 'trends', hidden: true, width: 'HALF' },
  ]
  const layout = (userId: string, dashboardKey: string, extra: Record<string, unknown> = {}) =>
    insert('DashboardLayout', { id: randomUUID(), userId, dashboardKey, key: `dashboard:${userId}:${dashboardKey}`, panels, ...extra })

  it('are an office person\'s, one per dashboard, with 1 to 40 panels of a known width, each id once', async () => {
    await expect(layout(partnerUserId, 'sales')).rejects.toThrow(/is an office person's arrangement/)
    await expect(layout(A.invited, 'Plant Manager')).rejects.toThrow(/names its dashboard by its key/)
    await expect(layout(A.invited, 'planner', { key: `dashboard:${A.member}:planner` })).rejects.toThrow(/the key of layout .* is dashboard:<userId>:<dashboardKey>/)
    await expect(layout(A.invited, 'planner', { panels: [] })).rejects.toThrow(/lists 1 to 40 panels in order/)
    await expect(layout(A.invited, 'planner', { panels: [panels[0], panels[0]] })).rejects.toThrow(/each id once/)
    await expect(layout(A.invited, 'planner', { panels: [{ id: 'numbers', hidden: false, width: 'WIDE' }] })).rejects.toThrow(/HALF \| TWO_THIRDS \| FULL/)
    await expect(layout(A.invited, 'planner', { panels: [{ id: 'numbers', hidden: false, width: 'FULL', colour: 'red' }] })).rejects.toThrow(/lists 1 to 40 panels/)
    expect(await layout(A.invited, 'planner')).toBe(1)
    await expect(layout(A.invited, 'planner')).rejects.toThrow(/DashboardLayout_tenantId_key_key|duplicate key/)
  })

  it('are saved again with new panels, removed to go back; the person and the dashboard never change', async () => {
    const { owner, member } = s.layoutIds
    expect(await set('DashboardLayout', owner, `panels = $2::jsonb`, JSON.stringify([{ id: 'by-company', hidden: false, width: 'FULL' }]))).toBe(1)
    await expect(set('DashboardLayout', owner, `"dashboardKey" = 'finance'`)).rejects.toThrow(/the person, the dashboard and the key of layout .* never change/)
    expect(await run(`DELETE FROM "DashboardLayout" WHERE id = $1::uuid`, member)).toBe(1)
  })
})

describe('the morning e-mail (ANA-032; the Owner\'s rule of 11-13)', () => {
  it('a company\'s switch is OFF by default, on with when and by whom, never deleted', async () => {
    const { companyA } = s.settingsIds
    await expect(set('InsightsSettings', companyA, `"digestMailOn" = true`)).rejects.toThrow(/switched on with when and by whom, set exactly while on/)
    await expect(set('InsightsSettings', companyA, `"digestMailOn" = true, "digestMailOnAt" = now() + interval '1 day', "digestMailOnById" = $2::uuid`, a.actorId)).rejects.toThrow(/not in the future/)
    expect(await set('InsightsSettings', companyA, `"digestMailOn" = true, "digestMailOnAt" = now(), "digestMailOnById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(set('InsightsSettings', companyA, `"digestMailOnById" = $2::uuid`, A.member)).rejects.toThrow(/while the morning e-mail of company .* is on, when and by whom it was switched on never change/)
    await expect(set('InsightsSettings', companyA, `"companyId" = $2::uuid`, A.companyB)).rejects.toThrow(/the company and the key of settings .* never change/)
    expect(await set('InsightsSettings', companyA, `"digestMailOn" = false, "digestMailOnAt" = NULL, "digestMailOnById" = NULL`)).toBe(1)
    await expect(run(`DELETE FROM "InsightsSettings" WHERE id = $1::uuid`, companyA)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "InsightsSettings" WHERE id = $1`, [companyA])).rejects.toThrow(/are switched off, never deleted/)
    await expect(admin(`TRUNCATE "InsightsSettings"`)).rejects.toThrow(/TRUNCATE on "InsightsSettings" is refused/)
  })

  const digest = (userId: string, extra: Record<string, unknown> = {}) => insert('DigestSetting', { id: randomUUID(), userId, key: `digest:${userId}`, ...extra })

  it('a person\'s digest: an office person\'s, never sent at first; its time, zone, weekdays, language and sections', async () => {
    await expect(digest(partnerUserId)).rejects.toThrow(/is an office person's morning e-mail/)
    await expect(digest(A.invited, { lastSentAt: new Date().toISOString() })).rejects.toThrow(/is set before it first goes out/)
    await expect(digest(A.invited, { key: 'digest:someone' })).rejects.toThrow(/the key of digest .* is digest:<userId>/)
    await expect(digest(A.invited, { enabled: true })).rejects.toThrow(/turned on with when and by whom, set exactly while on/)
    await expect(digest(A.invited, { sendTime: '7:30' })).rejects.toThrow(/at a time of day HH:MM/)
    await expect(digest(A.invited, { timeZone: 'Mars/Olympus' })).rejects.toThrow(/keeps the clock of a known time zone/)
    await expect(digest(A.invited, { weekdays: [5, 1] })).rejects.toThrow(/ISO weekdays 1 \(Monday\) to 7 \(Sunday\), ascending, each once/)
    await expect(digest(A.invited, { weekdays: [] })).rejects.toThrow(/ISO weekdays/)
    await expect(digest(A.invited, { locale: 'de' })).rejects.toThrow(/written in Italian \(it\) or English \(en\)/)
    await expect(digest(A.invited, { sections: [] })).rejects.toThrow(/lists at least one section, each once/)
    await expect(digest(A.invited, { sections: ['LATE', 'LATE'] })).rejects.toThrow(/each once/)
    expect(await digest(A.invited, { companyId: A.companyB, timeZone: 'America/New_York', weekdays: [1, 3, 5], locale: 'en', sections: ['ALERTS'] })).toBe(1)
  })

  it('goes out only while it is on and its company\'s switch is on; marked sent only forward', async () => {
    const { owner, member } = s.digestIds
    const { companyA, companyB } = s.settingsIds
    const sent = (id: string, at = 'now()') => set('DigestSetting', id, `"lastSentAt" = ${at}`)
    // The owner's group digest is on, but no company's switch is (the seed).
    await expect(sent(owner)).rejects.toThrow(/goes out only while its company's morning e-mail is switched on \(OFF by default/)
    // The member's digest (company A) is off.
    await expect(sent(member)).rejects.toThrow(/goes out only while it is on/)
    expect(await set('InsightsSettings', companyB, `"digestMailOn" = true, "digestMailOnAt" = now(), "digestMailOnById" = $2::uuid`, a.actorId)).toBe(1)
    // A group digest needs any company switched on; the member's (company A) needs company A's.
    expect(await sent(owner, `now() - interval '1 hour'`)).toBe(1)
    expect(await set('DigestSetting', member, `enabled = true, "enabledAt" = now(), "enabledById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(sent(member)).rejects.toThrow(/its company's morning e-mail is switched on/)
    expect(await set('InsightsSettings', companyA, `"digestMailOn" = true, "digestMailOnAt" = now(), "digestMailOnById" = $2::uuid`, a.actorId)).toBe(1)
    expect(await sent(member)).toBe(1)
    await expect(sent(owner, `now() - interval '2 hours'`)).rejects.toThrow(/the last time digest .* went out only moves forward/)
    await expect(sent(owner, `now() + interval '1 hour'`)).rejects.toThrow(/did not go out in the future/)
    await expect(set('DigestSetting', owner, `"enabledById" = $2::uuid`, A.member)).rejects.toThrow(/while digest .* is on, when and by whom it was turned on never change/)
    await expect(set('DigestSetting', owner, `"userId" = $2::uuid`, A.invited)).rejects.toThrow(/the person and the key of digest .* never change/)
    // Off again: the switches back off, the member's digest off; nothing goes out.
    for (const id of [companyA, companyB]) expect(await set('InsightsSettings', id, `"digestMailOn" = false, "digestMailOnAt" = NULL, "digestMailOnById" = NULL`)).toBe(1)
    await expect(sent(owner)).rejects.toThrow(/switched on/)
    expect(await set('DigestSetting', member, `enabled = false, "enabledAt" = NULL, "enabledById" = NULL`)).toBe(1)
    expect(await run(`DELETE FROM "DigestSetting" WHERE id = $1::uuid`, member)).toBe(1)
  })
})

describe('alert routes (ANA-041)', () => {
  const route = (ruleId: string, scope: string, scopeId: string, to: { roleId?: string; userId?: string }, extra: Record<string, unknown> = {}) =>
    insert('AlertRoute', {
      id: randomUUID(),
      ruleId,
      scope,
      scopeId,
      ...to,
      key: `route:${ruleId}:${scope}:${scopeId}${to.roleId ? `:role:${to.roleId}` : ''}${to.userId ? `:user:${to.userId}` : ''}`,
      ...extra,
    })

  it('tell the holders of one office role or one office person, exactly one', async () => {
    await expect(route(A.lateRule, 'COMPANY', A.companyA, {})).rejects.toThrow(/tells the holders of one office role or one office person, exactly one/)
    await expect(route(A.lateRule, 'COMPANY', A.companyA, { roleId: roleIds['sales'], userId: A.member })).rejects.toThrow(/exactly one/)
    await expect(route(A.lateRule, 'COMPANY', A.companyA, { roleId: roleIds['operator'] })).rejects.toThrow(/an office role that is not archived/)
    await expect(route(A.lateRule, 'COMPANY', A.companyA, { userId: partnerUserId })).rejects.toThrow(/an office person who is invited or active/)
    await expect(route(A.lateRule, 'COMPANY', A.companyA, { roleId: roleIds['sales'] }, { key: `route:${A.lateRule}:COMPANY:${A.companyA}:role:x` })).rejects.toThrow(/the key of route .* is route:<ruleId>:<scope>:<scopeId>/)
  })

  it('name a place that exists: a company, a site, a line, a customer', async () => {
    await expect(route(A.lateRule, 'SITE', A.companyA, { roleId: roleIds['sales'] })).rejects.toThrow(/names a site that does not exist/)
    await expect(route(A.lateRule, 'CUSTOMER', A.supplierP2, { roleId: roleIds['sales'] })).rejects.toThrow(/names a customer that does not exist \(a customer: a party we sell to, or a brand\)/)
    expect(await route(A.lateRule, 'LINE', A.lineB1, { userId: A.invited })).toBe(1)
    await expect(route(A.lateRule, 'LINE', A.lineB1, { userId: A.invited })).rejects.toThrow(/AlertRoute_tenantId_key_key|duplicate key/)
  })

  it('never widen their rule\'s place', async () => {
    // The hold rule looks at company A's plant A1.
    await expect(route(A.holdRule, 'COMPANY', A.companyA, { roleId: roleIds['production_manager'] })).rejects.toThrow(/never widens its rule's place: the rule looks at site/)
    await expect(route(A.holdRule, 'SITE', A.siteB1, { roleId: roleIds['production_manager'] })).rejects.toThrow(/never widens its rule's place: the rule looks at company/)
    await expect(route(A.holdRule, 'LINE', A.lineB1, { roleId: roleIds['production_manager'] })).rejects.toThrow(/never widens its rule's place/)
    expect(await route(A.holdRule, 'LINE', A.lineA1, { roleId: roleIds['production_manager'] })).toBe(1)
    expect(await route(A.holdRule, 'CUSTOMER', A.customerP1, { roleId: roleIds['production_manager'] })).toBe(1)
  })

  it('are added or removed, never changed', async () => {
    const { holdQuality, latePlannerB } = s.routeIds
    await expect(set('AlertRoute', holdQuality, `"roleId" = $2::uuid`, roleIds['sales'])).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "AlertRoute" SET "roleId" = $2 WHERE id = $1`, [holdQuality, roleIds['sales']])).rejects.toThrow(/is added or removed, never changed/)
    expect(await run(`DELETE FROM "AlertRoute" WHERE id = $1::uuid`, latePlannerB)).toBe(1)
  })
})

describe('facts (ANA-069)', () => {
  it('a line names its site; exactly one number; the company\'s currency exactly with an amount', async () => {
    await expect(fact({ lineId: A.lineA1 })).rejects.toThrow(/of a line names the line's site/)
    await expect(fact({}, {})).rejects.toThrow(/holds exactly one number/)
    await expect(fact({}, { value: '1', costAmount: 100, currency: 'EUR' })).rejects.toThrow(/holds exactly one number/)
    await expect(fact({}, { costAmount: 100 })).rejects.toThrow(/names the company's currency \(EUR\) exactly with an amount/)
    await expect(fact({}, { priceAmount: 100, currency: 'USD' })).rejects.toThrow(/names the company's currency \(EUR\)/)
    await expect(fact({}, { value: '3', currency: 'EUR' })).rejects.toThrow(/exactly with an amount/)
    expect(await fact({ siteId: A.siteA1, lineId: A.lineA1 }, { marginAmount: -2500, currency: 'EUR' })).toBeTruthy()
  })

  it('of a place of the company, a measure key, today at the latest, with its key', async () => {
    await expect(fact({ siteId: A.siteB1 })).rejects.toThrow(/FactDaily_tenantId_companyId_siteId_fkey|foreign key/)
    await expect(fact({ siteId: A.siteA1, lineId: A.lineB1 })).rejects.toThrow(/FactDaily_tenantId_siteId_lineId_fkey|foreign key/)
    await expect(fact({ measureKey: 'Output' })).rejects.toThrow(/names its measure by a dotted key/)
    await expect(fact({ day: romeDay(-2) })).rejects.toThrow(/is of a day that has begun \(today at the latest on the clock of Europe\/Rome\)/)
    await expect(fact({ key: `fact:${A.companyA}:all:all:2026-01-01:test.x` })).rejects.toThrow(/the key of fact .* is fact:<companyId>/)
    expect(await fact({ day: romeDay(0) })).toBeTruthy()
  })

  it('are rebuilt in place: the numbers change, rebuiltAt only forward, the place, day and measure never', async () => {
    const id = await fact()
    expect(await set('FactDaily', id, `value = 9, "rebuiltAt" = now()`)).toBe(1)
    await expect(set('FactDaily', id, `"rebuiltAt" = now() - interval '1 day'`)).rejects.toThrow(/is rebuilt forward in time/)
    await expect(set('FactDaily', id, `day = day - 1`)).rejects.toThrow(/the place, the day and the measure of fact .* never change/)
    await expect(set('FactDaily', id, `value = NULL, "costAmount" = 10, currency = 'EUR'`)).resolves.toBe(1)
    expect(await run(`DELETE FROM "FactDaily" WHERE id = $1::uuid`, id)).toBe(1)
  })

  it('per hour: a whole hour of the site\'s clock that has begun, with the day it belongs to', async () => {
    const hourly = (hourStart: Date, extra: Record<string, unknown> = {}) =>
      insert('FactHourly', {
        id: randomUUID(),
        companyId: A.companyA,
        siteId: A.siteA1,
        lineId: A.lineA1,
        hourStart: hourStart.toISOString(),
        day: '2026-11-12',
        measureKey: 'production.output_pieces',
        key: factHourlyKey(A.companyA, A.siteA1, A.lineA1, hourStart, 'production.output_pieces'),
        value: '5',
        rebuiltAt: new Date(Date.now() - 60_000).toISOString(),
        ...extra,
      })
    // 11:30 in Rome is no whole hour; a future hour has not begun; 23:00 UTC on the 12th is the 13th in Rome.
    await expect(hourly(new Date('2026-11-12T10:30:00.000Z'))).rejects.toThrow(/starts at a whole hour of the clock of Europe\/Rome that has begun/)
    await expect(hourly(new Date(Math.ceil(Date.now() / HOUR) * HOUR + HOUR))).rejects.toThrow(/that has begun/)
    await expect(hourly(new Date('2026-11-12T23:00:00.000Z'))).rejects.toThrow(/names the business day its hour belongs to on the clock of Europe\/Rome/)
    await expect(hourly(new Date('2026-11-12T22:00:00.000Z'), { key: 'facth:x' })).rejects.toThrow(/the key of fact .* is facth:<companyId>/)
    expect(await hourly(new Date('2026-11-12T22:00:00.000Z'))).toBe(1)
    await expect(hourly(new Date('2026-11-12T22:00:00.000Z'))).rejects.toThrow(/FactHourly_tenantId_key_key|duplicate key/)
    const [first] = s.factHourlyIds
    await expect(set('FactHourly', first!, `"hourStart" = "hourStart" + interval '1 hour'`)).rejects.toThrow(/the place, the hour and the measure of fact .* never change/)
  })

  it('hold no personal data: no person column, only company, site and line', async () => {
    const columns = await admin(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('FactDaily', 'FactHourly') AND column_name ~* '(worker|employee|user|person|actor|operator)'`,
    )
    expect(columns).toEqual([])
  })
})
