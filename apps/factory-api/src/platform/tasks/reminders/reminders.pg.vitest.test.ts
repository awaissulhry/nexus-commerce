import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { runReminders } from './reminders'

/**
 * Remind me about this (B-W2b-388; COL-041) and My work's reads (COL-035) on the local stack: a throwaway PostgreSQL 17 from the
 * migrations (the runtime login: row-level security and B-W2b-366's Reminder guard are real), the real routes, the real
 * scheduler run (`runReminders`), people with live role assignments. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/tasks/reminders`.
 */

vi.setConfig({ testTimeout: 120_000 })

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let company: string

const PEOPLE = { anna: newId(), bruno: newId(), viewer: newId() } as const
type Person = keyof typeof PEOPLE
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const sessions = new Map<string, SessionContext>()
let serial = 0
async function call(who: Person, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b388-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(who: Person, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

async function person(id: string, key: Person, grant: Grant, roleKey: string): Promise<void> {
  const roleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [tenant.id, roleKey]))[0]!.id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, tenant.id, `${key}@reminders.example.com`, `Person ${key}`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '1 day')`, [newId(), tenant.id, id, roleId])
  sessions.set(key, { audience: 'office', tenantId: tenant.id, actorId: id, grants: [grant] })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const soon = (ms: number) => new Date(Date.now() + ms).toISOString()
const run = () => runReminders({ database: h.database, log: { info() {}, warn() {}, error() {} } as never })
const events = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant.id, type])

beforeAll(async () => {
  h = await startHarness('reminders_w2b388')
  tenant = await addTenant(h, 'reminders-w2b388', 1)
  company = tenant.companies[0]!.id
  await person(PEOPLE.anna, 'anna', grantOf('admin'), 'admin')
  await person(PEOPLE.bruno, 'bruno', grantOf('admin'), 'admin')
  // Home only: no conversation of any record is readable.
  await person(PEOPLE.viewer, 'viewer', { permissions: ['home.view' as Permission], companies: 'all', sites: 'all', parties: 'all' }, 'read_only')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('Remind me about this (COL-041)', () => {
  it('sets a reminder on a record it reads, refuses what the rules refuse, and lists only mine', async () => {
    const set = await ok('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'AT_TIME', remindAt: soon(60 * 60_000), note: '  Supplier promised   a date ' }, 201)
    expect(set.reminder).toMatchObject({ record: { type: 'Company', id: company }, kind: 'AT_TIME', state: 'WAITING', note: 'Supplier promised a date', version: 1, cameBackAt: null, doneAt: null })
    expect(set.reminder.record.label.length).toBeGreaterThan(0)
    expect((await events('reminder.set')).at(-1)!.payload).toMatchObject({ reminderId: set.reminder.id, userId: PEOPLE.anna, kind: 'AT_TIME' })
    // REFUSED: a moment that passed; a time on a reminder that comes back when the record changes.
    const past = await call('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'AT_TIME', remindAt: soon(-60_000) })
    expect(past.status).toBe(400)
    expect(past.body.error.issues).toEqual([{ path: 'body/remindAt', message: 'Choose a moment after now.' }])
    expect((await call('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'ON_CHANGE', remindAt: soon(60_000) })).status).toBe(400)
    // REFUSED: a record whose conversation the person may not read is "not found".
    expect((await call('viewer', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'ON_CHANGE' })).status).toBe(404)
    // Only mine: another person's list is empty, their id is "not found" for me.
    expect((await ok('bruno', 'GET', '/reminders')).items).toEqual([])
    expect((await call('bruno', 'POST', `/reminders/${set.reminder.id}/done`, { version: 1 })).status).toBe(404)
    const mine = await ok('anna', 'GET', `/reminders?recordType=Company&recordId=${company}`)
    expect(mine).toMatchObject({ view: 'OPEN', counts: { waiting: 1, cameBack: 0, done: 0 }, complete: true })
    expect(mine.items.map((item: Json) => item.id)).toEqual([set.reminder.id])
    // A record named by half: refused in words.
    expect((await call('anna', 'GET', `/reminders?recordType=Company`)).status).toBe(400)
    await ok('anna', 'DELETE', `/reminders/${set.reminder.id}?version=1`)
  })

  it('comes back at its time to Today, is done and undone there, and a done one refuses a put-off', async () => {
    const set = await ok('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'AT_TIME', remindAt: soon(1_500), note: 'Call back' }, 201)
    expect((await run()).atTime).toBe(0)
    await wait(1_700)
    expect(await run()).toMatchObject({ atTime: 1, failed: 0 })
    expect((await events('reminder.came_back')).at(-1)!.payload).toMatchObject({ reminderId: set.reminder.id, kind: 'AT_TIME' })
    // A second run brings nothing back again.
    expect((await run()).atTime).toBe(0)
    const today = await ok('anna', 'GET', '/home/today?include=TASKS,MENTIONS,ALERTS')
    const row = today.items.find((item: Json) => item.kind === 'REMINDER')
    expect(row).toMatchObject({ key: `REMINDER:${company}:${set.reminder.id}`, category: 'TASK', record: { type: 'Company', id: company }, words: { sentence: { key: 'REMINDER.BACK_NOTE' }, why: { key: 'why.REMINDER.AT_TIME' } } })
    // Without the person's own rows asked for, W1's answer stays as it was.
    expect((await ok('anna', 'GET', '/home/today')).items.some((item: Json) => item.kind === 'REMINDER')).toBe(false)
    const done = await ok('anna', 'POST', `/reminders/${set.reminder.id}/done`, { version: 2 })
    expect(done.reminder).toMatchObject({ state: 'DONE', version: 3 })
    expect((await ok('anna', 'GET', '/home/today?include=TASKS')).items.some((item: Json) => item.kind === 'REMINDER')).toBe(false)
    // REFUSED: a stale version, and a put-off of a done reminder (in words).
    expect((await call('anna', 'POST', `/reminders/${set.reminder.id}/undo`, { version: 2 })).status).toBe(409)
    const putOff = await call('anna', 'POST', `/reminders/${set.reminder.id}/put-off`, { version: 3, kind: 'ON_CHANGE' })
    expect(putOff.status).toBe(409)
    expect(putOff.body.error.issues).toEqual([{ path: 'reminder/DONE', message: 'This reminder is done: undo it first.' }])
    const undone = await ok('anna', 'POST', `/reminders/${set.reminder.id}/undo`, { version: 3 })
    expect(undone.reminder).toMatchObject({ state: 'CAME_BACK', doneAt: null })
    // Put off: it waits again from now, its came-back cleared.
    const later = await ok('anna', 'POST', `/reminders/${set.reminder.id}/put-off`, { version: 4, kind: 'AT_TIME', remindAt: soon(24 * 3_600_000) })
    expect(later.reminder).toMatchObject({ state: 'WAITING', cameBackAt: null, kind: 'AT_TIME' })
    expect(Date.parse(later.reminder.since)).toBeGreaterThan(Date.parse(set.reminder.since))
    await ok('anna', 'DELETE', `/reminders/${set.reminder.id}?version=5`)
  })

  it('comes back when someone else changes the record — never for its own person\'s change or a read', async () => {
    const set = await ok('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'ON_CHANGE' }, 201)
    await wait(20)
    // Anna's own note on the record: not a change for her reminder.
    await ok('anna', 'POST', `/threads/Company/${company}/notes`, { body: 'My own note' }, 201)
    expect((await run()).onChange).toBe(0)
    // Bruno's note: it comes back.
    await ok('bruno', 'POST', `/threads/Company/${company}/notes`, { body: 'A colleague changed something' }, 201)
    expect(await run()).toMatchObject({ onChange: 1, failed: 0 })
    const back = await ok('anna', 'GET', '/reminders?view=CAME_BACK')
    expect(back.items.map((item: Json) => item.id)).toEqual([set.reminder.id])
    expect(back.items[0]).toMatchObject({ kind: 'ON_CHANGE', state: 'CAME_BACK' })
    await ok('anna', 'DELETE', `/reminders/${set.reminder.id}?version=2`)
  })

  it('finishes and removes several at once, all or none', async () => {
    const a = (await ok('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'ON_CHANGE' }, 201)).reminder
    const b = (await ok('anna', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'AT_TIME', remindAt: soon(3_600_000) }, 201)).reminder
    const theirs = (await ok('bruno', 'POST', '/reminders', { record: { type: 'Company', id: company }, kind: 'ON_CHANGE' }, 201)).reminder
    // REFUSED: another person's reminder in the batch — nothing changes.
    expect((await call('anna', 'POST', '/reminders/bulk', { action: 'DONE', ids: [a.id, theirs.id] })).status).toBe(404)
    expect((await ok('anna', 'GET', '/reminders?view=DONE')).items).toEqual([])
    expect(await ok('anna', 'POST', '/reminders/bulk', { action: 'DONE', ids: [a.id, b.id] })).toMatchObject({ action: 'DONE', changed: 2 })
    // REFUSED: Done again on a done one.
    expect((await call('anna', 'POST', '/reminders/bulk', { action: 'DONE', ids: [a.id] })).status).toBe(409)
    expect(await ok('anna', 'POST', '/reminders/bulk', { action: 'REMOVE', ids: [a.id, b.id] })).toMatchObject({ action: 'REMOVE', changed: 2 })
    expect(await admin(`SELECT count(*)::int AS n FROM "Reminder" WHERE "userId" = $1`, [PEOPLE.anna])).toEqual([{ n: 0 }])
    await ok('bruno', 'DELETE', `/reminders/${theirs.id}?version=1`)
  })
})

describe('My work (COL-035)', () => {
  it('Changed since you looked: my FOLLOWING news, one line per record, until I mark it seen', async () => {
    const insert = (recordId: string, label: string, minutesAgo: number) =>
      admin(
        `INSERT INTO "Notification" (id, "tenantId", "userId", "companyId", category, "eventType", "eventId", "recordType", "recordId", "recordLabel", "messageKey", params, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'FOLLOWING', 'sales_order.status_changed', $5, 'Company', $6, $7, 'notifications.following.changed', '{}'::jsonb, now() - ($8 || ' minutes')::interval, now())`,
        [newId(), tenant.id, PEOPLE.anna, company, newId(), recordId, label, String(minutesAgo)],
      )
    await insert(company, 'Demo company', 30)
    await insert(company, 'Demo company', 5)
    const answer = await ok('anna', 'GET', '/home/following')
    expect(answer.items).toHaveLength(1)
    expect(answer.items[0]).toMatchObject({ key: `Company:${company}`, view: false, listKey: null, messageKey: 'notifications.following.changed', count: 2 })
    expect(answer.items[0].ids).toHaveLength(2)
    // Someone else's news is not mine.
    expect((await ok('bruno', 'GET', '/home/following')).items).toEqual([])
    await ok('anna', 'POST', '/notifications/done', { ids: answer.items[0].ids, done: true })
    expect((await ok('anna', 'GET', '/home/following')).items).toEqual([])
  })

  it('Waiting on others names the mail and link waits for whoever reads conversations', async () => {
    const answer = await ok('anna', 'GET', '/home/waiting-on-others')
    expect(answer.counts.byKind.map((entry: Json) => entry.kind)).toEqual(expect.arrayContaining(['MESSAGE_REPLY', 'LINK_UNOPENED']))
    expect(answer.live.events).toEqual(expect.arrayContaining(['thread.message_posted', 'link.used']))
  })
})
