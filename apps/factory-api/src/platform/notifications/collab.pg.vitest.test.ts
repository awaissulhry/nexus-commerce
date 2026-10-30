import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { textOf } from '../../adapters/ses/fake'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { runDigests } from '../email-out/digest/digest'
import { systemContext } from '../outbox/system'
import { fanOut } from './fan-out'

/**
 * The notification centre, followers, @mentions and tasks (B-W2a-20; PLT-138, PLT-142, COL-006, COL-011, COL-037) on the
 * local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_platform_w2a_guards triggers are real), the real app and routes, people with live role assignments (the fan-out and
 * the assignee rules read them), test sessions holding the same template grants, FAKE SES for the digest. The fan-out
 * runs here as the worker would: on the outbox rows the commands wrote. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/notifications`.
 */

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let companyOne: string
let companyTwo: string

const PEOPLE = { owner: newId(), sales: newId(), reader: newId(), outsider: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, { readonly role: string; readonly only?: 'two' }> = {
  owner: { role: 'owner' },
  sales: { role: 'sales' },
  reader: { role: 'read_only' },
  outsider: { role: 'sales', only: 'two' },
}

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

function grantOf(key: string, companies: Grant['companies']): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE[person], grants: [grantOf(ROLES[person].role, ROLES[person].only ? [companyTwo] : 'all')] })

async function call(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

/** The worker's fan-out over the outbox rows written since the mark (oldest first); how many notifications were made. */
let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [tenant.id, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(tenant.id, `test-${row.id}`)), envelope)
  }
  return made
}
const THREAD_EVENTS = ['thread.user_mentioned', 'thread.message_posted']
const note = (person: Person, body: string, mentions: Person[] = []) => ok(person, 'POST', `/threads/Company/${companyOne}/notes`, { body, mentions: mentions.map((who) => PEOPLE[who]) }, 201)
const notifications = (person: Person, query = '') => ok(person, 'GET', `/notifications${query}`)

beforeAll(async () => {
  h = await startHarness('collab_w2a20')
  h.clock.set(new Date())
  tenant = await addTenant(h, 'collab-w2a20', 2)
  companyOne = tenant.companies[0]!.id
  companyTwo = tenant.companies[1]!.id
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [tenant.id])).map((row) => [row.key, row.id]))
  for (const [person, { role, only }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, tenant.id, `${person}@collab.example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '1 day')`, [
      newId(),
      tenant.id,
      userId,
      roleIds.get(role),
      only === undefined,
      only === 'two' ? [companyTwo] : [],
    ])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('@mentions (COL-006) and the notification centre (PLT-138)', () => {
  it('a note that mentions a colleague writes a mention row and a follow with it, and tells only them, once even when replayed', async () => {
    mark = new Date()
    const posted = await note('sales', 'Can you check the bank details?', ['reader'])
    const messageId = posted.message.id as string
    expect(await admin(`SELECT "userId", "authorId", "recordType" FROM "MessageMention" WHERE "messageId" = $1`, [messageId])).toEqual([{ userId: PEOPLE.reader, authorId: PEOPLE.sales, recordType: 'Company' }])
    expect(await admin(`SELECT "userId", reason, muted FROM "RecordFollower" WHERE "recordId" = $1`, [companyOne])).toEqual([{ userId: PEOPLE.reader, reason: 'MENTIONED', muted: false }])

    expect(await fanOutSince(THREAD_EVENTS)).toBe(1)
    // A replayed event makes nothing (the command's receipt and the (person, event) key).
    expect(await fanOutSince(THREAD_EVENTS)).toBe(0)
    const rows = await admin(`SELECT "userId", category, "messageKey", anchor, "recordLabel" FROM "Notification" WHERE "tenantId" = $1`, [tenant.id])
    expect(rows).toEqual([{ userId: PEOPLE.reader, category: 'MENTION', messageKey: 'notifications.mentioned', anchor: `message:${messageId}`, recordLabel: 'C1' }])

    const mine = await notifications('reader')
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0]).toMatchObject({ category: 'MENTION', sentence: 'Person sales mentioned you on C1', record: { type: 'Company', id: companyOne, label: 'C1' }, read: false, state: 'OPEN', actor: { id: PEOPLE.sales, name: 'Person sales' } })
    expect(mine.counts).toMatchObject({ unread: 1 })
    expect((mine.counts.tabs as Json[]).find((tab) => tab.tab === 'MENTION')).toEqual({ tab: 'MENTION', unread: 1 })
    expect((await notifications('sales')).items).toEqual([])
    // Another person's notification is not theirs to touch: unknown, unchanged.
    expect(await ok('sales', 'POST', '/notifications/done', { ids: [mine.items[0].id] })).toEqual({ changed: 0, unknown: [mine.items[0].id] })
    expect(await ok('reader', 'GET', '/notifications/counts')).toMatchObject({ unread: 1 })
  })

  it('reads, finishes and snoozes until new activity: a newer note on the record brings it back', async () => {
    const [first] = (await notifications('reader')).items as Json[]
    expect(await ok('reader', 'POST', '/notifications/read', { ids: [first!.id] })).toEqual({ changed: 1, unknown: [] })
    expect(await ok('reader', 'GET', '/notifications/counts')).toMatchObject({ unread: 0 })
    expect(await ok('reader', 'POST', '/notifications/snooze', { ids: [first!.id], until: null })).toMatchObject({ changed: 1 })
    expect((await notifications('reader')).items).toEqual([])
    expect(((await notifications('reader', '?state=SNOOZED')).items as Json[]).map((item) => item.id)).toEqual([first!.id])
    expect((await call('reader', 'POST', '/notifications/snooze', { ids: [first!.id], until: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400)

    mark = new Date()
    await note('sales', 'One more thing on this.', ['reader'])
    expect(await fanOutSince(['thread.user_mentioned'])).toBe(1)
    const open = (await notifications('reader')).items as Json[]
    // The new mention and the snoozed one (woken by it) are both open again; close together they are one group.
    expect(open).toHaveLength(1)
    expect(open[0]!.group.count).toBe(2)
    expect(open[0]!.group.ids).toContain(first!.id)
    expect(await ok('reader', 'POST', '/notifications/done', { ids: open[0]!.group.ids })).toMatchObject({ changed: 2 })
    expect((await notifications('reader')).items).toEqual([])
    expect(((await notifications('reader', '?state=DONE')).items as Json[])[0]!.group.count).toBe(2)
  })
})

describe('followers of a record (COL-011) and quiet defaults (PLT-142)', () => {
  it('follow, mute, unfollow; news of a note reaches the followers who did not mute it, never its author', async () => {
    const followed = await ok('owner', 'PUT', `/threads/Company/${companyOne}/followers/me`, { following: true })
    expect(followed.me).toEqual({ following: true, muted: false, reason: 'CHOSE' })
    expect((followed.followers as Json[]).map((row) => [row.name, row.reason])).toEqual([
      ['Person reader', 'MENTIONED'],
      ['Person owner', 'CHOSE'],
    ])

    mark = new Date()
    await note('sales', 'Status: the bank confirmed.')
    expect(await fanOutSince(THREAD_EVENTS)).toBe(2)
    const following = await admin(`SELECT "userId" FROM "Notification" WHERE category = 'FOLLOWING' AND "tenantId" = $1 ORDER BY "userId"`, [tenant.id])
    expect(following.map((row) => row.userId).sort()).toEqual([PEOPLE.owner, PEOPLE.reader].sort())
    expect((await notifications('owner', '?tab=ALL')).items[0]).toMatchObject({ category: 'FOLLOWING', sentence: 'Person sales wrote a note on C1, which you follow' })

    // Muted: the record's news stops (and nothing follows them again on its own).
    await ok('reader', 'PUT', `/threads/Company/${companyOne}/followers/me`, { following: true, muted: true })
    mark = new Date()
    await note('sales', 'Another status line.')
    expect(await fanOutSince(THREAD_EVENTS)).toBe(1)
    // Close together, the owner's two pieces of news are one group.
    const owner = (await notifications('owner')).items as Json[]
    expect(owner).toHaveLength(1)
    expect(owner[0]!.group.count).toBe(2)
    // A mention of a muted follower still reaches them, and the follow stays muted.
    mark = new Date()
    await note('sales', 'Reader, one question.', ['reader'])
    expect(await fanOutSince(['thread.user_mentioned'])).toBe(1)
    expect((await admin(`SELECT muted FROM "RecordFollower" WHERE "userId" = $1 AND "recordId" = $2`, [PEOPLE.reader, companyOne]))[0]).toEqual({ muted: true })

    const gone = await ok('owner', 'PUT', `/threads/Company/${companyOne}/followers/me`, { following: false })
    expect(gone.me).toEqual({ following: false, muted: false, reason: null })
  })

  it('adds a colleague who may read the record; refuses one who cannot, and a reader who may not write', async () => {
    const added = await ok('sales', 'POST', `/threads/Company/${companyOne}/followers`, { userId: PEOPLE.owner })
    expect((added.followers as Json[]).find((row) => row.userId === PEOPLE.owner)).toMatchObject({ reason: 'CHOSE', addedBy: { id: PEOPLE.sales, name: 'Person sales' } })
    const outsider = await call('sales', 'POST', `/threads/Company/${companyOne}/followers`, { userId: PEOPLE.outsider })
    expect(outsider.status).toBe(400)
    expect(outsider.body.error.issues[0].path).toBe('body/userId')
    expect((await call('reader', 'POST', `/threads/Company/${companyOne}/followers`, { userId: PEOPLE.owner })).status).toBe(403)
    // The outsider (company two only) sees no follower list of company one.
    expect((await call('outsider', 'GET', `/threads/Company/${companyOne}/followers`)).status).toBe(404)
  })
})

describe('tasks on any record (COL-037)', () => {
  let taskId: string
  const today = businessDate(new Date())

  it('makes a task on a record for a colleague who may keep it: they follow the record and are told', async () => {
    const refused = await call('sales', 'POST', '/tasks', { title: 'Check the IBAN', record: { type: 'Company', id: companyOne }, assigneeId: PEOPLE.reader })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues[0].path).toBe('body/assigneeId')
    expect((await call('reader', 'POST', '/tasks', { title: 'Mine' })).status).toBe(403)

    mark = new Date()
    const made = await ok('sales', 'POST', '/tasks', { title: '  Check   the IBAN ', record: { type: 'Company', id: companyOne }, assigneeId: PEOPLE.owner, dueDate: today, dueTime: '16:00', checklist: [{ text: 'Call the bank' }, { text: 'Note it' }] }, 201)
    taskId = made.task.id
    expect(made.task).toMatchObject({ title: 'Check the IBAN', record: { type: 'Company', id: companyOne, label: 'C1' }, assignee: { id: PEOPLE.owner }, status: 'OPEN', tile: 'TODAY', progress: { done: 0, total: 2 }, relation: 'CREATOR', canChange: true })
    expect((await admin(`SELECT reason FROM "RecordFollower" WHERE "userId" = $1 AND "recordId" = $2`, [PEOPLE.owner, companyOne]))[0]).toEqual({ reason: 'CHOSE' })
    expect(await fanOutSince(['task.assigned'])).toBe(1)
    const told = ((await notifications('owner', '?tab=ASSIGNMENT')).items as Json[])[0]
    expect(told).toMatchObject({ category: 'ASSIGNMENT', anchor: `task:${taskId}`, sentence: 'Person sales assigned you the task "Check the IBAN" (C1)' })
  })

  it('shows a record’s tasks to its readers (read only), never to someone outside the record', async () => {
    const list = await ok('reader', 'GET', `/tasks?scope=RECORD&recordType=Company&recordId=${companyOne}`)
    expect(list.items.map((task: Json) => [task.id, task.relation, task.canChange])).toEqual([[taskId, 'RECORD', false]])
    expect((await call('reader', 'POST', `/tasks/${taskId}/status`, { version: 1, status: 'DONE' })).status).toBe(403)
    expect((await call('outsider', 'GET', `/tasks/${taskId}`)).status).toBe(404)
    const mine = await ok('owner', 'GET', '/tasks')
    expect(mine.items.map((task: Json) => task.id)).toEqual([taskId])
    expect((mine.tiles as Json[]).find((tile) => tile.tile === 'TODAY')).toEqual({ tile: 'TODAY', count: 1 })
  })

  it('done, Undo, a stale version refused; ticks the checklist; snoozes an open task only', async () => {
    const task = (await ok('owner', 'GET', `/tasks/${taskId}`)).task
    const ticked = await ok('owner', 'PUT', `/tasks/${taskId}`, { version: task.version, checklist: task.checklist.map((item: Json, index: number) => ({ id: item.id, text: item.text, done: index === 0 })) })
    expect(ticked.task.progress).toEqual({ done: 1, total: 2 })
    expect(ticked.task.checklist[0].doneBy).toEqual({ id: PEOPLE.owner, name: 'Person owner' })
    const stale = await call('owner', 'POST', `/tasks/${taskId}/status`, { version: task.version, status: 'DONE' })
    expect(stale.status).toBe(409)
    const done = await ok('owner', 'POST', `/tasks/${taskId}/status`, { version: ticked.task.version, status: 'DONE' })
    expect(done.task).toMatchObject({ status: 'DONE', closedBy: { id: PEOPLE.owner }, tile: 'DONE_7D' })
    expect((await call('owner', 'POST', `/tasks/${taskId}/snooze`, { version: done.task.version, until: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(409)
    const open = await ok('owner', 'POST', `/tasks/${taskId}/status`, { version: done.task.version, status: 'OPEN' })
    expect(open.task).toMatchObject({ status: 'OPEN', closedAt: null })
    expect((await call('owner', 'POST', `/tasks/${taskId}/snooze`, { version: open.task.version, until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400)
    const snoozed = await ok('owner', 'POST', `/tasks/${taskId}/snooze`, { version: open.task.version, until: new Date(Date.now() + 3_600_000).toISOString() })
    expect(snoozed.task.snoozed).toBe(true)
  })

  it('bulk actions are all or none', async () => {
    const yesterday = businessDate(new Date(Date.now() - 86_400_000))
    const own = await ok('sales', 'POST', '/tasks', { title: 'Mine, late', dueDate: yesterday }, 201)
    const other = await ok('sales', 'POST', '/tasks', { title: 'Mine, no date' }, 201)
    const tiles = (await ok('sales', 'GET', '/tasks')).tiles as Json[]
    expect(tiles.filter((tile) => tile.count > 0)).toEqual([
      { tile: 'OVERDUE', count: 1 },
      { tile: 'NO_DATE', count: 1 },
    ])
    const refused = await call('sales', 'POST', '/tasks/bulk', { action: 'DONE', items: [{ id: own.task.id, version: own.task.version }, { id: other.task.id, version: 99 }] })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/items/1'])
    expect((await ok('sales', 'GET', `/tasks/${own.task.id}`)).task.status).toBe('OPEN')
    const both = await ok('sales', 'POST', '/tasks/bulk', { action: 'SET_DUE', items: [{ id: own.task.id, version: own.task.version }, { id: other.task.id, version: other.task.version }], dueDate: today })
    expect(both.tasks.map((task: Json) => task.dueDate)).toEqual([today, today])
  })

  it('names who may be given a task: on a record (keeps tasks there, reads it), or of their own (keeps tasks) (B-W2a-40)', async () => {
    const names = (answer: Json) => (answer.people as Json[]).map((person) => person.id).sort()
    const onRecord = await ok('sales', 'GET', `/tasks/assignees?recordType=Company&recordId=${companyOne}`)
    expect(names(onRecord)).toEqual([PEOPLE.owner, PEOPLE.sales].sort())
    expect((onRecord.people as Json[]).find((person) => person.id === PEOPLE.sales)).toEqual({ id: PEOPLE.sales, name: 'Person sales', me: true })
    expect(onRecord.complete).toBe(true)
    // Of their own: whoever keeps tasks anywhere (the outsider too); never a read-only person.
    expect(names(await ok('sales', 'GET', '/tasks/assignees'))).toEqual([PEOPLE.owner, PEOPLE.sales, PEOPLE.outsider].sort())
    expect((await call('reader', 'GET', '/tasks/assignees')).status).toBe(403)
    expect((await call('outsider', 'GET', `/tasks/assignees?recordType=Company&recordId=${companyOne}`)).status).toBe(404)
    expect((await call('sales', 'GET', '/tasks/assignees?recordType=Company')).status).toBe(400)
  })
})

describe('the daily digest: the only e-mail, off until the person turns it on (PLT-142)', () => {
  it('sends nothing by default; once turned on, one mail of the person’s own notifications, each delivery logged', async () => {
    expect((await ok('reader', 'GET', '/notifications/digest')).digest).toMatchObject({ on: false, version: 0 })
    const log = { info() {}, warn() {}, error() {} }
    const before = h.ses.mails.length
    expect(await runDigests({ database: h.database, log, runtime: () => h.email })).toEqual({ due: 0, sent: 0, empty: 0, failed: 0 })
    expect(h.ses.mails.length).toBe(before)

    const saved = await ok('reader', 'PUT', '/notifications/digest', { on: true, sendTime: '00:00', weekdays: [1, 2, 3, 4, 5, 6, 7], categories: ['MENTION', 'FOLLOWING'], version: 0 })
    expect(saved.digest).toMatchObject({ on: true, locale: 'en', version: 1 })
    expect((await call('reader', 'PUT', '/notifications/digest', { on: true, sendTime: '00:00', weekdays: [1], categories: ['MENTION'], version: 0 })).status).toBe(400)

    const open = await admin(`SELECT id FROM "Notification" WHERE "userId" = $1 AND "readAt" IS NULL AND "doneAt" IS NULL AND category IN ('MENTION', 'FOLLOWING')`, [PEOPLE.reader])
    expect(open.length).toBeGreaterThan(0)
    expect(await runDigests({ database: h.database, log, runtime: () => h.email })).toEqual({ due: 1, sent: 1, empty: 0, failed: 0 })
    const mail = h.ses.mails.at(-1)!
    expect(mail.to).toEqual(['reader@collab.example.com'])
    expect(mail.templateKey).toBe('notifications.digest')
    expect(textOf(mail.raw)).toContain('Person sales mentioned you on C1')
    const deliveries = await admin(`SELECT d.outcome, d."emailOutboundId", o.status FROM "NotificationDelivery" d JOIN "EmailOutbound" o ON o.id = d."emailOutboundId" WHERE d."tenantId" = $1`, [tenant.id])
    expect(deliveries.length).toBe(open.length)
    expect(deliveries.every((row) => row.outcome === 'SENT' && row.emailOutboundId === mail.outboundId && row.status === 'SENT')).toBe(true)
    // Once a day.
    expect(await runDigests({ database: h.database, log, runtime: () => h.email })).toMatchObject({ due: 0, sent: 0 })
  })
})
