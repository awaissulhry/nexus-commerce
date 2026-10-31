import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { REASON_CODE_LISTS, REASON_LISTS } from '@nexus/factory-domain/reasons/lists'
import { BASE_REASONS } from '@nexus/factory-domain/reasons/standard'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Log } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { activeReasonCodes, reasonFor } from './service'
import { standardReasonsCron, standardReasonsForNewTenants } from './standard'

/**
 * The reason lists (B-W2a-18; PLT-116) through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security is real), tenant A from EVERY seed (so codes are used by scans,
 * rework orders, holds, returns and counts) and tenant B bare, as a new tenant is. Made-up words only.
 *   - the pickers (office and floor) read active reasons only, in tile order, of the lists asked;
 *   - the editor reads every list with how often each code is used, the standard codes missing, the floor languages;
 *   - one route family keeps both tables: ReasonCode's lists and ScrapReason's SCRAP and REWORK (words only there);
 *   - writes: a reason at the end of its list, one cell at a time at the version read, many set inactive at once, the
 *     tile order, the standard reasons a list lacks; a code never changes and a reason is never deleted;
 *   - a new tenant's empty lists get the standard reasons (the worker's start and the daily cron), never a list in use;
 *   - keeping the lists needs reasons.manage over every company and site.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/reasons`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'reasons-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `reasons-${Date.now()}-${++serial}`

const A = { tenant: seedUuid(NS, 'tenant'), companyA: seedUuid(NS, 'company:A'), siteA1: seedUuid(NS, 'site:A1'), siteB1: seedUuid(NS, 'site:B1') }
const tenantB = newId()
const companyB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP: Permission[] = ['reasons.view', 'reasons.manage']
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, [grant(KEEP)]),
  viewer: office(A.tenant, [grant(['reasons.view'])]),
  // Keeps reasons for company A only: a list is the whole group's, so it may read but not keep them.
  companyKeeper: office(A.tenant, [grant(KEEP, { companies: [A.companyA], sites: [A.siteA1] })]),
  nobody: office(A.tenant, [grant(['sites.view'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work'], { companies: [A.companyA], sites: [A.siteA1] })] },
  keeperB: office(tenantB, [grant(KEEP)]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key: string | null = idem()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? idem())
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const editor = async (session: string, lists: string) => (await ok(session, 'GET', `/reasons/lists?list=${lists}`)) as { lists: Json[]; languages: string[]; canManage: boolean }
const listOf = async (session: string, list: string) => (await editor(session, list)).lists[0]!
const reasonIn = (view: Json, code: string) => (view.reasons as Json[]).find((reason) => reason.code === code)!
const events = async (tenantId: string, list: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'reason.changed' AND subject = $2 ORDER BY "occurredAt", id`, [tenantId, list])).map((row) => row.payload)
const silent: Log = { info: () => undefined, warn: () => undefined, error: () => undefined }

beforeAll(async () => {
  db = await migratedDatabase('platform_reasons')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  // Plant A1's tablets also speak Romanian; tenant B is bare (a tenant set up today).
  await admin(`UPDATE "Site" SET "floorLocales" = '{it,en,ro}' WHERE id = $1`, [A.siteA1])
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'reasons-b', 'Gruppo Nuovo')`, [tenantB])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'NUOVA', 'Nuova Prova S.r.l.')`, [companyB, tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('reading the lists (PLT-116)', () => {
  it('keeps the domain lists equal to the database enum', async () => {
    const values = (await admin<{ value: string }>(`SELECT unnest(enum_range(NULL::"ReasonList"))::text AS value`)).map((row) => row.value)
    expect(values).toEqual([...REASON_CODE_LISTS])
    const kinds = (await admin<{ value: string }>(`SELECT unnest(enum_range(NULL::"DefectKind"))::text AS value`)).map((row) => row.value)
    expect(kinds).toEqual(['SCRAP', 'REWORK'])
  })

  it('gives a picker the active reasons of the lists asked, in tile order, to the office and the floor alike', async () => {
    const office = (await ok('nobody', 'GET', '/reasons?list=WRITE_OFF,SCRAP')).reasons as Json[]
    expect(office.filter((reason) => reason.list === 'WRITE_OFF').map((reason) => reason.code)).toEqual(BASE_REASONS.WRITE_OFF.map((reason) => reason.code))
    expect(office.filter((reason) => reason.list === 'SCRAP').map((reason) => reason.code)).toEqual(['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'])
    expect(office[0]).toMatchObject({ list: 'WRITE_OFF', code: 'DAMAGED', labelIt: 'Danneggiato', labelEn: 'Damaged', icon: 'alert', colour: '#e5484d', needsDetail: false })
    expect(office.find((reason) => reason.list === 'SCRAP')).toMatchObject({ icon: null, colour: null, labelI18n: {} })
    const floor = (await ok('floor', 'GET', '/reasons?list=PAUSE')).reasons as Json[]
    expect(floor.map((reason) => reason.code)).toEqual(BASE_REASONS.PAUSE.map((reason) => reason.code))
    expect((await ok('keeper', 'GET', '/reasons')).reasons.length).toBeGreaterThan(50)
    expect((await refused('keeper', 'GET', '/reasons?list=WRITE_OFF,DEFECT', undefined, 400)).code).toBe('validation_failed')
  })

  it('shows the editor every list asked with how often each code is used and the tenant\'s other floor languages', async () => {
    const { lists, languages, canManage } = await editor('keeper', 'SCRAP,REWORK,HOLD,RETURN,ADJUSTMENT,PAUSE')
    expect(lists.map((view) => view.list)).toEqual(['SCRAP', 'REWORK', 'HOLD', 'RETURN', 'ADJUSTMENT', 'PAUSE'])
    expect(languages).toEqual(['ro'])
    expect(canManage).toBe(true)
    const [scrap, rework, hold, returns, adjustment, pause] = lists as Json[]
    // W2b (B-W2b-10; MES-125): the scan lists keep icon, colour, other languages and "needs detail" too; OTHER needs detail.
    expect(scrap).toMatchObject({ source: 'SCRAP_REASON', fields: { icon: true, colour: true, languages: true, needsDetail: true }, active: 7, inactive: 0, standardMissing: [] })
    expect(reasonIn(scrap!, 'OTHER')).toMatchObject({ needsDetail: true, icon: null, colour: null, labelI18n: {} })
    expect(reasonIn(scrap!, 'STAIN').usedCount).toBeGreaterThanOrEqual(1)
    expect(reasonIn(scrap!, 'TEAR').usedCount).toBe(0)
    expect(reasonIn(rework!, 'ALIGNMENT').usedCount).toBeGreaterThanOrEqual(1)
    expect(reasonIn(hold!, 'QUALITY_CHECK').usedCount).toBeGreaterThanOrEqual(1)
    expect(reasonIn(returns!, 'WRONG_SIZE').usedCount).toBeGreaterThanOrEqual(1)
    expect(reasonIn(adjustment!, 'COUNT_ERROR').usedCount).toBeGreaterThanOrEqual(1)
    expect(pause).toMatchObject({ source: 'REASON_CODE', fields: { icon: true, colour: true, languages: true, needsDetail: true }, standardMissing: [] })
    expect(reasonIn(pause!, 'OTHER')).toMatchObject({ needsDetail: true, usedCount: 0, active: true, version: 1 })
    // Every list, by default; a viewer reads them, may not keep them; a role without reasons.view never reaches the editor.
    expect((await editor('viewer', REASON_LISTS.join(','))).lists).toHaveLength(13)
    expect((await editor('viewer', 'PAUSE')).canManage).toBe(false)
    expect((await editor('companyKeeper', 'PAUSE')).canManage).toBe(false)
    expect((await refused('nobody', 'GET', '/reasons/lists', undefined, 403)).code).toBe('forbidden')
    expect((await refused('floor', 'GET', '/reasons/lists', undefined, 403)).code).toBe('forbidden')
  })
})

describe('keeping a list', () => {
  it('adds a reason at the end of its list with its words, icon and colour, once per key; a taken code is refused in words', async () => {
    const key = idem()
    const body = { code: 'TOO_LATE', labelIt: 'Arrivato tardi', labelEn: 'Arrived too late', labelI18n: { ro: 'Sosit prea târziu' }, icon: 'clock', colour: '#1F6FDE' }
    const { reason } = await ok('keeper', 'POST', '/reasons/RETURN', body, 201, key)
    expect(reason).toMatchObject({ list: 'RETURN', code: 'TOO_LATE', icon: 'clock', colour: '#1f6fde', labelI18n: { ro: 'Sosit prea târziu' }, needsDetail: false, sortOrder: 60, active: true, usedCount: 0, version: 1 })
    expect((await ok('keeper', 'POST', '/reasons/RETURN', body, 201, key)).reason.id).toBe(reason.id)
    expect(await admin(`SELECT action, after->>'code' AS code FROM "AuditLog" WHERE "recordId" = $1`, [reason.id])).toEqual([{ action: 'reasons.create', code: 'TOO_LATE' }])
    expect((await events(A.tenant, 'RETURN')).at(-1)).toEqual({ list: 'RETURN', change: 'CREATED', codes: ['TOO_LATE'] })
    // Taken (active or not), not a code, not an offered icon or colour; W2b: a scan list keeps an icon, colour and words too.
    expect(await refused('keeper', 'POST', '/reasons/RETURN', { ...body, labelIt: 'Altro testo' }, 409)).toMatchObject({ code: 'conflict', issues: [{ path: 'body/code' }] })
    expect((await refused('keeper', 'POST', '/reasons/RETURN', { ...body, code: 'too late' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/code' })])
    expect((await refused('keeper', 'POST', '/reasons/RETURN', { ...body, code: 'ROCKET', icon: 'rocket', colour: '#000000' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/icon', 'body/colour'])
    expect((await refused('keeper', 'POST', '/reasons/SCRAP', { code: 'BURN', labelIt: 'Bruciatura', labelEn: 'Burn', icon: 'rocket' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/icon' })])
    const burn = (await ok('keeper', 'POST', '/reasons/SCRAP', { code: 'BURN', labelIt: 'Bruciatura', labelEn: 'Burn', icon: 'flame', colour: '#EA580C', labelI18n: { ro: 'Arsură' }, needsDetail: true }, 201)).reason
    expect(burn).toMatchObject({ list: 'SCRAP', code: 'BURN', sortOrder: 100, icon: 'flame', colour: '#ea580c', labelI18n: { ro: 'Arsură' }, needsDetail: true })
    // The scans' own seam reads the same row: the operation screen offers it at once, with its look and words (MES-125).
    expect(await admin(`SELECT kind::text, code, "labelEn", icon, colour, "labelI18n", "needsDetail" FROM "ScrapReason" WHERE id = $1`, [burn.id])).toEqual([{ kind: 'SCRAP', code: 'BURN', labelEn: 'Burn', icon: 'flame', colour: '#ea580c', labelI18n: { ro: 'Arsură' }, needsDetail: true }])
    const tiles = (await ok('floor', 'GET', '/reasons?list=SCRAP')).reasons as Json[]
    expect(tiles.find((tile) => tile.code === 'BURN')).toMatchObject({ list: 'SCRAP', labelIt: 'Bruciatura', labelEn: 'Burn', icon: 'flame', colour: '#ea580c', labelI18n: { ro: 'Arsură' }, needsDetail: true })
  })

  it('edits one cell at a time at the version read: a language merges, null takes it out, a stale version is refused', async () => {
    const pause = await listOf('keeper', 'PAUSE')
    const machine = reasonIn(pause, 'MACHINE')
    const one = (await ok('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: machine.version, labelI18n: { ro: 'Mașină oprită' } })).reason
    expect(one).toMatchObject({ labelI18n: { ro: 'Mașină oprită' }, version: machine.version + 1, labelIt: 'Macchina ferma' })
    const two = (await ok('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: one.version, labelI18n: { ur: 'مشین بند' }, colour: null })).reason
    expect(two).toMatchObject({ labelI18n: { ro: 'Mașină oprită', ur: 'مشین بند' }, colour: null })
    const three = (await ok('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: two.version, labelI18n: { ro: null }, labelEn: '  Machine down ' })).reason
    expect(three).toMatchObject({ labelI18n: { ur: 'مشین بند' }, labelEn: 'Machine down' })
    expect(await refused('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: two.version, labelIt: 'Ferma' }, 409)).toMatchObject({ code: 'conflict' })
    expect((await refused('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: three.version, labelIt: ' ' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/labelIt' })])
    expect((await refused('keeper', 'PATCH', `/reasons/PAUSE/${machine.id}`, { version: three.version, labelI18n: { en: 'x' } }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/labelI18n/en' })])
    // Another list's id is not found in this one; the audit row keeps before and after.
    expect((await refused('keeper', 'PATCH', `/reasons/HOLD/${machine.id}`, { version: three.version, labelIt: 'x' }, 404)).code).toBe('not_found')
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [machine.id])
    expect(audit.at(-1)).toMatchObject({ before: { labelEn: 'Machine stopped', labelI18n: { ro: 'Mașină oprită', ur: 'مشین بند' } }, after: { labelEn: 'Machine down', labelI18n: { ur: 'مشین بند' } } })
    // A scan reason: its words, its active flag; a picker no longer offers it once inactive.
    const tear = reasonIn(await listOf('keeper', 'SCRAP'), 'TEAR')
    expect((await ok('keeper', 'PATCH', `/reasons/SCRAP/${tear.id}`, { version: tear.version, labelIt: 'Strappo', active: false })).reason).toMatchObject({ labelIt: 'Strappo', active: false })
    expect(((await ok('floor', 'GET', '/reasons?list=SCRAP')).reasons as Json[]).map((reason) => reason.code)).not.toContain('TEAR')
    expect((await events(A.tenant, 'SCRAP')).at(-1)).toEqual({ list: 'SCRAP', change: 'EDITED', codes: ['TEAR'] })
  })

  it('sets many inactive at once and active again; inactive ones leave the pickers and are never deleted', async () => {
    const writeOff = await listOf('keeper', 'WRITE_OFF')
    const [lost, expired] = [reasonIn(writeOff, 'LOST'), reasonIn(writeOff, 'EXPIRED')]
    const off = await ok('keeper', 'POST', '/reasons/WRITE_OFF/active', { active: false, reasons: [{ id: lost.id, version: lost.version }, { id: expired.id, version: expired.version }] })
    expect(off.changed).toEqual(['LOST', 'EXPIRED'])
    expect(off.list).toMatchObject({ active: 3, inactive: 2 })
    expect(((await ok('nobody', 'GET', '/reasons?list=WRITE_OFF')).reasons as Json[]).map((reason) => reason.code)).toEqual(['DAMAGED', 'OBSOLETE', 'OTHER'])
    expect((await events(A.tenant, 'WRITE_OFF')).at(-1)).toEqual({ list: 'WRITE_OFF', change: 'DEACTIVATED', codes: ['LOST', 'EXPIRED'] })
    // A version read before is refused at its place; the database itself refuses a delete.
    expect((await refused('keeper', 'POST', '/reasons/WRITE_OFF/active', { active: true, reasons: [{ id: lost.id, version: lost.version }] }, 409)).issues).toEqual([expect.objectContaining({ path: 'body/reasons/0/version' })])
    await expect(admin(`DELETE FROM "ReasonCode" WHERE id = $1`, [lost.id])).rejects.toThrow(/never deleted/)
    const back = await ok('keeper', 'POST', '/reasons/WRITE_OFF/active', { active: true, reasons: [{ id: lost.id, version: lost.version + 1 }, { id: expired.id, version: expired.version + 1 }] })
    expect(back).toMatchObject({ changed: ['LOST', 'EXPIRED'], list: { active: 5, inactive: 0 } })
    // The service other modules call reads the same list.
    const codes = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => activeReasonCodes(client, 'WRITE_OFF'))
    expect([...codes]).toEqual(['DAMAGED', 'EXPIRED', 'OBSOLETE', 'LOST', 'OTHER'])
    const fact = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => reasonFor(client, 'SCRAP', 'TEAR'))
    expect(fact).toMatchObject({ code: 'TEAR', active: false, needsDetail: false })
  })

  it("reorders a list's tiles: every reason named once, each at the version read", async () => {
    const hold = await listOf('keeper', 'HOLD')
    const reversed = [...(hold.reasons as Json[])].reverse()
    const { list } = await ok('keeper', 'POST', '/reasons/HOLD/order', { reasons: reversed.map((reason) => ({ id: reason.id, version: reason.version })) })
    expect((list.reasons as Json[]).map((reason) => [reason.code, reason.sortOrder])).toEqual(reversed.map((reason, index) => [reason.code, (index + 1) * 10]))
    expect((await events(A.tenant, 'HOLD')).at(-1)).toMatchObject({ change: 'REORDERED', codes: reversed.map((reason) => reason.code) })
    const now = list.reasons as Json[]
    expect((await refused('keeper', 'POST', '/reasons/HOLD/order', { reasons: now.slice(1).map((reason) => ({ id: reason.id, version: reason.version })) }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/reasons' })])
    expect((await refused('keeper', 'POST', '/reasons/HOLD/order', { reasons: reversed.map((reason) => ({ id: reason.id, version: reason.version })) }, 409)).code).toBe('conflict')
  })

  it('keeping the lists needs reasons.manage over every company and site', async () => {
    const pause = await listOf('keeper', 'PAUSE')
    const reason = reasonIn(pause, 'BREAK')
    expect((await refused('companyKeeper', 'PATCH', `/reasons/PAUSE/${reason.id}`, { version: reason.version, labelIt: 'x' }, 403)).message).toMatch(/every company and site/)
    expect((await refused('viewer', 'POST', '/reasons/PAUSE', { code: 'X1', labelIt: 'x', labelEn: 'x' }, 403)).code).toBe('forbidden')
    expect((await refused('floor', 'POST', '/reasons/PAUSE/standard', {}, 403)).code).toBe('forbidden')
    expect((await refused('keeper', 'POST', '/reasons/DEFECT', { code: 'X1', labelIt: 'x', labelEn: 'x' }, 400)).code).toBe('validation_failed')
  })
})

describe('a new tenant (W1 leftover: reasons for new tenants were not seeded)', () => {
  it('gives every EMPTY list its standard reasons once, never a list in use; a person adds the missing ones', async () => {
    const bare = await editor('keeperB', REASON_LISTS.join(','))
    expect(bare.lists.every((view: Json) => view.reasons.length === 0 && view.standardMissing.length > 0)).toBe(true)
    expect(bare.languages).toEqual([])
    // Tenant B makes its own pause list first: the job leaves that list alone.
    await ok('keeperB', 'POST', '/reasons/PAUSE', { code: 'TOOLS', labelIt: 'Attrezzi', labelEn: 'Tools' }, 201)
    const first = await standardReasonsForNewTenants({ database, log: silent })
    expect(first).toMatchObject({ seeded: 1, failed: 0, added: REASON_LISTS.reduce((sum, list) => sum + (list === 'PAUSE' ? 0 : list === 'SCRAP' ? 7 : list === 'REWORK' ? 6 : BASE_REASONS[list].length), 0) })
    expect(await standardReasonsForNewTenants({ database, log: silent })).toMatchObject({ seeded: 0, added: 0 })
    const after = await editor('keeperB', 'PAUSE,WRITE_OFF,SCRAP')
    expect((after.lists[0]!.reasons as Json[]).map((reason) => reason.code)).toEqual(['TOOLS'])
    expect(after.lists[0]!.standardMissing).toEqual(BASE_REASONS.PAUSE.map((reason) => reason.code))
    expect((after.lists[1]!.reasons as Json[]).map((reason) => [reason.code, reason.sortOrder])).toEqual(BASE_REASONS.WRITE_OFF.map((reason, index) => [reason.code, (index + 1) * 10]))
    expect(after.lists[2]!.reasons).toHaveLength(7)
    expect((await events(tenantB, 'WRITE_OFF')).at(-1)).toMatchObject({ change: 'STANDARD_ADDED' })
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'reasons.addStandard' AND audience::text = 'SYSTEM'`, [tenantB])).toEqual([{ n: first.added }])
    // "Add the standard reasons": the ones missing, after the list's own; again: nothing to add, nothing written.
    const added = await ok('keeperB', 'POST', '/reasons/PAUSE/standard', {})
    expect(added.added).toEqual(BASE_REASONS.PAUSE.map((reason) => reason.code))
    expect((added.list.reasons as Json[]).map((reason) => reason.code)).toEqual(['TOOLS', ...BASE_REASONS.PAUSE.map((reason) => reason.code)])
    expect(await ok('keeperB', 'POST', '/reasons/PAUSE/standard', {})).toMatchObject({ added: [], list: { standardMissing: [] } })
    expect(standardReasonsCron({ database, log: silent }).name).toBe('reasons.standardForNewTenants')
  })
})
