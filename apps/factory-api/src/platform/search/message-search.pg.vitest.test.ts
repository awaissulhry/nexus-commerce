import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seedUuid, type SeedContext } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../golden-flow/portal/testing/two-brands'
import { systemContext } from '../outbox/system'
import { ensureThread, writeMessage, type MessageInput, type RecordRef } from '../threads/threads'
import type { SearchIndexer } from './indexer'
import { indexEvent, rebuildIndex } from './indexing'
import { loadIndexers } from './registry'

/**
 * B-TH-097 (threads plan TH-9, G11 "search inside messages", office only; wall test T28 and W08/W34; Owner rule 2026-11-16: "One
 * brand must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it
 * all"): message text is in the office's search index. TWO CUSTOMERS — the seed's P1 is Brand Alpha (brand A), P3 Brand Beta
 * (brand B), with the two-brand harness's names — have a shared message and an office note each, with one made-up word in common.
 * The factory finds all four (type=Message; each with the record it opens, one record's thread when asked); a person limited to
 * brand A finds brand A's only, a person limited to brand B brand B's only, a person without threads.read none; messages never
 * mix into the records of the palette; a note about a colleague is never indexed; no amount is ever in an entry; each hit is read
 * again against its thread as it is now. The portal side (no portal search reaches a message) is partner-search.pg's. On a
 * throwaway PostgreSQL 17 database with every base seed. Run with `node scripts/factory/run-pg-tests.mjs platform/search/message-search`.
 */

const NAMESPACE = 'msg-search'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed/', import.meta.url))
const id = (key: string): string => seedUuid(NAMESPACE, key)
const tenantId = id('tenant')
const companyA = id('company:A')
const alpha = id('party:P1')
const beta = id('party:P3')
const WORD = 'zyxquorble'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let indexers: readonly SearchIndexer[]
const written: Record<string, string> = {}
let alphaOrder: string

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const grant = (permissions: readonly Permission[], scope: Partial<Pick<Grant, 'companies' | 'sites' | 'parties'>> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), companyId: companyA, grants })
const VIEWS: Permission[] = ['orders.view', 'parties.view', 'quotes.view', 'sales.inquiries.view']
const SESSIONS: Record<string, SessionContext> = {
  everyBrand: office([grant([...VIEWS, 'threads.read', 'users.view'])]),
  alphaOnly: office([grant([...VIEWS, 'threads.read'], { parties: [alpha] })]),
  betaOnly: office([grant([...VIEWS, 'threads.read'], { parties: [beta] })]),
  noThreads: office([grant(VIEWS)]),
}
const system = () => callerFor(database, systemContext(tenantId, `msg-search-${newId()}`))

/** Messages written as the office and the email steps write them, then indexed as the worker would (one event at a time). */
async function write(record: RecordRef, messages: Record<string, MessageInput>): Promise<void> {
  const { result } = await command(system(), { name: 'test.messages', input: { record } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, null)
    const ids: Record<string, string> = {}
    for (const [key, input] of Object.entries(messages)) ids[key] = (await writeMessage(tools, thread, input)).id
    return ids
  })
  Object.assign(written, result)
  for (const row of await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = ANY($2::text[])`, [tenantId, Object.values(result)])) {
    const envelope: EventEnvelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    await indexEvent(system(), indexers, envelope)
  }
}
/** The seed's office person writes (a USER author has an id: the threads guard). */
const OFFICE_ACTOR = id('actor')
const note = (bodyText: string): MessageInput => ({ direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: OFFICE_ACTOR, name: 'Made-up Office' }, bodyText })
const shared = (direction: 'OUTBOUND' | 'INBOUND', bodyText: string): MessageInput => ({ direction, channel: 'EMAIL', author: direction === 'OUTBOUND' ? { kind: 'USER', id: OFFICE_ACTOR, name: 'Made-up' } : { kind: 'PARTY', id: null, name: 'Made-up' }, bodyText })

async function search(session: string, query: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url: `/search?${query}`, headers: { 'x-test-session': session } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const messages = (session: string, more = '') => search(session, `q=${WORD}&type=Message&limit=50${more}`)
const ids = (answer: Json): string[] => answer.results.map((row: Json) => row.recordId).sort()

beforeAll(async () => {
  db = await migratedDatabase('search_messages')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  const context: SeedContext = { db: database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  await admin('DELETE FROM "SearchEntry"')
  indexers = await loadIndexers(fileURLToPath(new URL('../..', import.meta.url)))
  await rebuildIndex(system(), indexers, { recordTypes: null, key: `msg-search-rebuild-${newId()}` })
  alphaOrder = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [tenantId, 'SEED-SO-0001']))[0]!.id
  const colleague = (await admin<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND audience = \'OFFICE\' ORDER BY id LIMIT 1', [tenantId]))[0]!.id
  await write({ type: 'SalesOrder', id: alphaOrder }, {
    alphaShared: shared('OUTBOUND', `Made-up: the ${WORD} lining arrives on Friday, at € 45,00 each.`),
    alphaNote: note(`Made-up office note: ${WORD} is late for ${BRAND_ALPHA.tradeName}.`),
  })
  await write({ type: 'Party', id: beta }, {
    betaShared: shared('INBOUND', `Made-up: ${BRAND_BETA.message} Also the ${WORD} rain covers.`),
    betaNote: note(`Made-up office note: ${WORD} covers for ${BRAND_BETA.tradeName}, 1200 EUR in all.`),
  })
  // A note about a person: whoever reads threads must never find it (the User record's thread gate).
  await write({ type: 'User', id: colleague }, { colleagueNote: note(`Made-up: a ${WORD} remark about a colleague.`) })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-TH-097: search inside messages (office only)', () => {
  it('the factory finds every brand’s messages, each with the record it opens; never a note about a person', async () => {
    const answer = await messages('everyBrand')
    expect(ids(answer)).toEqual([written.alphaShared, written.alphaNote, written.betaShared, written.betaNote].sort())
    expect(answer.results.find((row: Json) => row.recordId === written.alphaShared)).toMatchObject({ recordType: 'Message', title: 'SEED-SO-0001', record: { type: 'SalesOrder', id: alphaOrder }, status: 'OUTBOUND' })
    expect(answer.results.find((row: Json) => row.recordId === written.betaNote)).toMatchObject({ record: { type: 'Party', id: beta }, status: 'INTERNAL_NOTE' })
    expect(ids(answer)).not.toContain(written.colleagueNote)
    expect((await admin('SELECT id FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', ['Message', written.colleagueNote])).length).toBe(0)
  })

  it('T28: a person limited to brand A finds brand A’s messages only; limited to brand B, brand B’s only; without threads.read, none', async () => {
    const alphaAnswer = await messages('alphaOnly')
    expect(ids(alphaAnswer)).toEqual([written.alphaShared, written.alphaNote].sort())
    expect(alphaAnswer.results.flatMap((row: Json) => findMarkers(row, fixtureMarkers(BRAND_BETA)))).toEqual([])
    expect(alphaAnswer.counts).toEqual([{ recordType: 'Message', count: 2 }])
    const betaAnswer = await messages('betaOnly')
    expect(ids(betaAnswer)).toEqual([written.betaShared, written.betaNote].sort())
    expect(betaAnswer.results.flatMap((row: Json) => findMarkers(row, fixtureMarkers(BRAND_ALPHA)))).toEqual([])
    expect((await messages('noThreads')).results).toEqual([])
  })

  it('messages never mix into the records of the palette or of every type: only when asked', async () => {
    const answer = await search('everyBrand', `q=${WORD}&limit=50`)
    expect(answer.results.filter((row: Json) => row.recordType === 'Message')).toEqual([])
    expect(answer.counts.filter((entry: Json) => entry.recordType === 'Message')).toEqual([])
  })

  it('"Search in the thread": with its record, one record’s messages only', async () => {
    expect(ids(await messages('everyBrand', `&recordType=SalesOrder&recordId=${alphaOrder}`))).toEqual([written.alphaShared, written.alphaNote].sort())
    expect(ids(await messages('betaOnly', `&recordType=SalesOrder&recordId=${alphaOrder}`))).toEqual([])
    expect(ids(await messages('everyBrand', `&recordType=Party&recordId=${beta}`))).toEqual([written.betaShared, written.betaNote].sort())
  })

  it('never holds an amount: the prices typed in a message are not in its entry', async () => {
    const entries = await admin<{ recordId: string; searchText: string; subtitle: string | null }>('SELECT "recordId", "searchText", subtitle FROM "SearchEntry" WHERE "recordType" = \'Message\' AND "recordId" = ANY($1::uuid[])', [[written.alphaShared, written.betaNote]])
    expect(entries.length).toBe(2)
    for (const entry of entries) {
      expect(entry.searchText.split(' ')).not.toContain('45,00')
      expect(entry.searchText.split(' ')).not.toContain('1200')
      expect(entry.subtitle ?? '').not.toMatch(/€|EUR|45,00|1200/)
    }
  })

  it('each hit is read again against its thread now: a thread that took brand B since is never brand A’s hit', async () => {
    const inquiry = (await admin<{ id: string }>('SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = $2', [tenantId, 'SEED-INQ-0001']))[0]!.id
    await write({ type: 'Inquiry', id: inquiry }, { prospectNote: note(`Made-up: the prospect asked for ${WORD} jackets.`) })
    // Indexed while the request had no customer (an entry every limit reaches): alpha sees it, then it becomes brand B's.
    expect(ids(await messages('alphaOnly'))).toContain(written.prospectNote)
    await admin('UPDATE "Thread" SET "partyId" = $2 WHERE "recordType" = \'Inquiry\' AND "recordId" = $1', [inquiry, beta])
    expect(ids(await messages('alphaOnly'))).not.toContain(written.prospectNote)
    expect(ids(await messages('betaOnly'))).toContain(written.prospectNote)
  })
})
