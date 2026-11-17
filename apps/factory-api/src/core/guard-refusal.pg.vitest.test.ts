import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp } from './app'
import { command, idempotencyKeyFrom } from './command'
import { testAuthenticator, type SessionContext } from './context'
import { DATABASE_RULE_ISSUE, DATABASE_RULE_NEUTRAL } from './errors'
import { defineManifest, defineRoutes } from './manifest'

/**
 * TH-0A Open 3 (threads plan, follow-up of #1527): a rule of the database (a guard trigger) that refuses a write past its
 * command's own check answers 409 in the rule's words — through a portal command, a link command and an office command alike
 * — and an unknown database error stays a 500. Before, TH-0A met the portal's case as a 500 (Prisma P2039 wrapping the
 * guard's check_violation).
 *
 * The app is the real one (buildApp: the error handler, the route manifest, the scoped clients of each audience) on a
 * throwaway database built from the migrations; the routes are commands as every module writes them (`command(request, …)`)
 * whose write meets the threads rule "a message has text or attachments" (…_threads_guards). Run with
 * `node scripts/factory/run-pg-tests.mjs apps/factory-api/src/core/guard-refusal`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const company = newId()
const party = newId()
const officePerson = newId()
const portalPerson = newId()
const quote = newId()
const thread = newId()

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  office: { audience: 'office', tenantId: tenant, actorId: officePerson, grants: [grant(['threads.read', 'threads.post'])] },
  portal: { audience: 'partner', tenantId: tenant, actorId: portalPerson, partyId: party, grants: [grant(['threads.read'])] },
  link: { audience: 'link', tenantId: tenant, linkId: newId(), partyId: party, record: { type: 'Quote', id: quote }, grants: [grant(['threads.read'])] },
}

const admin = async (sql: string, values: unknown[] = []): Promise<void> => {
  await db.admin.query(sql, values)
}

const MANIFEST = defineManifest({
  'POST /test-rule/message': { audiences: ['office', 'partner', 'link'], permission: 'signed-in', scope: 'tenant' },
  'POST /test-rule/unknown': { audiences: ['office', 'partner'], permission: 'signed-in', scope: 'tenant' },
})

/** A command that writes a message with neither text nor attachments: a portal post for a customer, an internal note for the office. */
const routes = defineRoutes('test-rule', MANIFEST, async (instance) => {
  instance.post('/test-rule/message', async (request) => {
    const context = request.factoryContext!
    const customer = context.audience === 'partner' || context.audience === 'link'
    await command(request, { name: 'test.ruleMessage', idempotencyKey: idempotencyKeyFrom(request), input: { customer } }, async ({ tx, now }) => {
      await tx.message.create({
        data: {
          id: newId(),
          threadId: thread,
          partyId: customer ? party : null,
          direction: customer ? 'INBOUND' : 'INTERNAL_NOTE',
          audience: customer ? 'PARTNER' : 'OFFICE',
          channel: customer ? 'PORTAL' : 'APP',
          authorKind: customer ? 'PARTY' : 'USER',
          ...(customer ? {} : { authorId: officePerson }),
          authorName: customer ? 'Berta Becker' : 'Ada Author',
          bodyText: '',
          bodyHtml: null,
          attachmentFileIds: [],
          emailMessageId: null,
          at: now,
          createdAt: now,
        },
        select: { id: true },
      })
      return { written: true }
    })
    return { written: true }
  })
  instance.post('/test-rule/unknown', async (request) => {
    await command(request, { name: 'test.ruleUnknown', input: null }, async ({ tx }) => {
      await tx.$queryRawUnsafe('SELECT 1 / 0')
      return { written: true }
    })
    return { written: true }
  })
})

beforeAll(async () => {
  db = await migratedDatabase('guard_refusal')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'rule-a'])
  await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [company, tenant, 'rule-a-c'])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'BRAND-BETA', 'ORGANISATION', 'Brand Beta GmbH', '{CUSTOMER}')`, [party, tenant, company])
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [officePerson, tenant, 'ada.author@example.com', 'Ada Author', 'ACTIVE'])
  await admin(`INSERT INTO "Thread" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "replyToken") VALUES ($1, $2, $3, $4, 'Quote', $5, $6)`, [
    thread,
    tenant,
    company,
    party,
    quote,
    'abcdefghijklmnopqrstuvwxyz',
  ])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routes: [routes], authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

// A link writes only with an Idempotency-Key (every write gets one here).
const call = (session: string, url: string) => app.inject({ method: 'POST', url, headers: { 'x-test-session': session, 'idempotency-key': newId() }, payload: {} })
const WORDS = 'Message has neither text nor attachments.'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe('TH-0A Open 3: a rule of the database answers 409 in words for every audience', () => {
  it.each([['portal', DATABASE_RULE_NEUTRAL], ['link', DATABASE_RULE_NEUTRAL], ['office', WORDS]])('through a %s command: 409 conflict in words (a customer gets the neutral sentence), no record id, nothing written', async (session, words) => {
    const answer = await call(session, '/test-rule/message')
    expect(answer.statusCode, answer.body).toBe(409)
    const body = answer.json()
    expect(body.error).toMatchObject({ code: 'conflict', message: words, issues: [{ path: DATABASE_RULE_ISSUE, message: words }] })
    // No record id, no area prefix, no SQL or Prisma words reach the caller (the request id is the only id in the answer).
    expect(JSON.stringify(body.error.issues)).not.toMatch(UUID)
    expect(body.error.message).not.toMatch(UUID)
    for (const word of ['threads:', 'check_violation', '23514', 'P2039', 'Database error', 'prisma']) expect(answer.body).not.toContain(word)
    const rows = await db.admin.query('SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1', [thread])
    expect(rows.rows[0].n).toBe(0)
  })

  it.each(['portal', 'office'])('an unknown database error through a %s command stays a logged 500 with the fixed words', async (session) => {
    const answer = await call(session, '/test-rule/unknown')
    expect(answer.statusCode, answer.body).toBe(500)
    expect(answer.json().error).toMatchObject({ code: 'internal_error', message: 'Something went wrong. The error was logged.' })
    expect(answer.json().error.issues).toBeUndefined()
    expect(answer.body).not.toContain('division by zero')
  })
})
