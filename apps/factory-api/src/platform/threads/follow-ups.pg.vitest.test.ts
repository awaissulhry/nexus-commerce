import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { runReminders } from '../tasks/reminders/reminders'
import { ensureThread, writeMessage, type MessageInput } from './threads'

/**
 * B-TH-096 (threads plan TH-9, N16; feature T8-F05): "Remind me in 3 days if no answer" — a reminder (POST /reminders) AT_TIME
 * on a message the person sent to the record's customer is a follow-up: the customer's answer on that conversation stops it by
 * itself (a colleague's note, another customer's answer, someone else's reminder never do); a closed conversation stops it; with
 * no answer it comes back at its time, and still stops when the answer comes after.
 *
 * The local stack: a throwaway PostgreSQL 17 from the migrations (the runtime login; the reminder and threads guards real), the
 * real routes and the reminders' scheduler run, two made-up customers (Brand Alpha, Brand Beta) whose own conversations
 * (their Party records) carry the messages, written through the threads seam as the mail steps write them. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads/follow-ups`.
 */

vi.setConfig({ testTimeout: 120_000 })

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let company: string

const PEOPLE = { anna: newId(), bruno: newId() } as const
type Person = keyof typeof PEOPLE
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const brandA = newId()
const brandB = newId()

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const sessions = new Map<string, SessionContext>()
let serial = 0
async function ok(who: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th096-key-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function person(id: string, key: Person): Promise<void> {
  const roleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'admin'`, [tenant.id]))[0]!.id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, tenant.id, `${key}@follow-ups.example.com`, `Person ${key}`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '1 day')`, [newId(), tenant.id, id, roleId])
  sessions.set(key, { audience: 'office', tenantId: tenant.id, actorId: id, grants: [grantOf('admin')] })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const soon = (ms: number) => new Date(Date.now() + ms).toISOString()
const DAYS_3 = 3 * 86_400_000
const run = () => runReminders({ database: h.database, log: { info() {}, warn() {}, error() {} } as never })

/** One message on a customer's own conversation (its Party record), as the office or the mail step writes it; its id. */
async function message(who: Person, partyId: string, input: Omit<MessageInput, 'author'> & { readonly author?: MessageInput['author'] }): Promise<string> {
  const caller = callerFor(h.database, { audience: 'office', tenantId: tenant.id, actorId: PEOPLE[who], grants: [grantOf('admin')], requestId: newId() })
  const { result } = await command(caller, { name: 'email.send', input: { partyId, direction: input.direction } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Party', id: partyId }, PEOPLE[who])
    return (await writeMessage(tools, thread, { author: { kind: 'USER', id: PEOPLE[who], name: `Person ${who}` }, ...input })).id
  })
  await wait(5)
  return result
}
const ourMail = (who: Person, partyId: string, bodyText: string) => message(who, partyId, { direction: 'OUTBOUND', channel: 'EMAIL', bodyText })
const theirAnswer = (partyId: string, bodyText: string) =>
  message('anna', partyId, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Their buyer' }, bodyText, emailMessageId: `<answer-${newId()}@customer.example>` })
const note = (who: Person, partyId: string, bodyText: string) => message(who, partyId, { direction: 'INTERNAL_NOTE', channel: 'APP', bodyText })

const followUp = async (who: Person, partyId: string, messageId: string, remindAt = soon(DAYS_3)) =>
  (await ok(who, 'POST', '/reminders', { record: { type: 'Party', id: partyId }, messageId, kind: 'AT_TIME', remindAt, note: 'If no answer' }, 201)).reminder as Json
const reminderOf = async (who: Person, id: string): Promise<Json> => {
  const all = [...(await ok(who, 'GET', '/reminders?view=OPEN')).items, ...(await ok(who, 'GET', '/reminders?view=DONE')).items]
  return all.find((item: Json) => item.id === id)
}
const stopAudit = async (id: string) => (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Reminder' AND "recordId" = $1 AND after ? 'followUp'`, [id])).map((row) => row.after.followUp)

beforeAll(async () => {
  h = await startHarness('follow_ups_th096')
  tenant = await addTenant(h, 'follow-ups-th096', 1)
  company = tenant.companies[0]!.id
  await person(PEOPLE.anna, 'anna')
  await person(PEOPLE.bruno, 'bruno')
  for (const [id, code, name] of [
    [brandA, 'BRAND-ALPHA', 'Brand Alpha S.r.l.'],
    [brandB, 'BRAND-BETA', 'Brand Beta GmbH'],
  ] as const) {
    await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{CUSTOMER}')`, [id, tenant.id, company, code, name])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('B-TH-096: a follow-up that stops on a reply', () => {
  const S: Record<string, string> = {}

  it('"Remind me in 3 days if no answer" on a message I sent is a follow-up; a reminder on a note or on a colleague’s mail is not', async () => {
    S.mail = await ourMail('anna', brandA, 'Alpha: can you confirm the colours of AX-100?')
    S.note = await note('anna', brandA, 'Internal: they usually answer on Mondays.')
    const mine = await followUp('anna', brandA, S.mail!)
    expect(mine).toMatchObject({ kind: 'AT_TIME', messageId: S.mail, note: 'If no answer', state: 'WAITING', followUp: true })
    S.followUp = mine.id
    S.onNote = (await followUp('anna', brandA, S.note!)).id
    expect((await reminderOf('anna', S.onNote!)).followUp).toBe(false)
    // Bruno's reminder on Anna's mail: his own reminder of a message he did not send — a plain reminder.
    const brunos = await followUp('bruno', brandA, S.mail!)
    expect(brunos.followUp).toBe(false)
    S.bruno = brunos.id
  })

  it('a colleague’s note and another customer’s answer never stop it', async () => {
    await note('bruno', brandA, 'Internal: I called them, no answer yet.')
    await theirAnswer(brandB, 'Beta: our order is fine.')
    await run()
    expect(await reminderOf('anna', S.followUp!)).toMatchObject({ state: 'WAITING', doneAt: null })
    expect(await stopAudit(S.followUp!)).toEqual([])
  })

  it('the customer’s answer stops it by itself (done, kept, said why); the plain reminders wait on', async () => {
    await theirAnswer(brandA, 'Alpha: yes, the colours are confirmed.')
    await run()
    const stopped = await reminderOf('anna', S.followUp!)
    expect(stopped).toMatchObject({ state: 'DONE', followUp: true })
    expect(stopped.doneAt).not.toBeNull()
    expect(await stopAudit(S.followUp!)).toEqual(['ANSWERED'])
    const changed = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'reminder.changed' AND subject = $2`, [tenant.id, S.followUp])
    expect(changed.map((row) => row.payload.change)).toEqual(['DONE'])
    expect((await reminderOf('anna', S.onNote!)).state).toBe('WAITING')
    expect((await reminderOf('bruno', S.bruno!)).state).toBe('WAITING')
    // The scheduler again: nothing more (stopped once).
    await run()
    expect(await stopAudit(S.followUp!)).toEqual(['ANSWERED'])
  })

  it('with no answer it comes back at its time ("no answer yet"), and still stops when the answer comes after', async () => {
    const mail = await ourMail('anna', brandA, 'Alpha: and the size chart?')
    const late = await followUp('anna', brandA, mail, soon(1_500))
    await wait(1_700)
    await run()
    expect((await reminderOf('anna', late.id)).state).toBe('CAME_BACK')
    await theirAnswer(brandA, 'Alpha: the size chart follows tomorrow.')
    await run()
    expect(await reminderOf('anna', late.id)).toMatchObject({ state: 'DONE' })
    expect(await stopAudit(late.id)).toEqual(['ANSWERED'])
  })

  it('a closed conversation stops it', async () => {
    const mail = await ourMail('anna', brandB, 'Beta: anything else for this season?')
    const closing = await followUp('anna', brandB, mail)
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "Thread" SET status = 'CLOSED' WHERE "recordType" = 'Party' AND "recordId" = $1`, [brandB])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    await run()
    expect((await reminderOf('anna', closing.id)).state).toBe('DONE')
    expect(await stopAudit(closing.id)).toEqual(['CLOSED'])
  })
})
