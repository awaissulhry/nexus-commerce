import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The quote screens' reads (B-W1-21 part 2; SCR-030 Home › Approvals, SCR-034 New quote, SCR-037 the PDF before it is
 * sent) on the local stack: a throwaway PostgreSQL 17 from the migrations, the runtime login (row-level security and the
 * column grants are real), the seeds' brand customer P1 and jacket JKT-01 (cost about 291 a piece), so a price of 300 is
 * under the 20 % margin floor and asks an approval. Made-up people and prices only. Run with
 * `node scripts/factory/run-pg-tests.mjs sales`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'quote-screens-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jacket = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const YEAR = businessDate(new Date()).slice(0, 4)
const FAKE_VAT = '12345670009'

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const fromTemplate = (key: string, without: readonly string[] = []): { actorId: string; permissions: Permission[] } => {
  const role = templateOf(key)!
  return { actorId: newId(), permissions: [...role.permissions, ...grainsOf(role.grains.filter((grain) => !without.includes(grain)))] }
}
const PEOPLE = {
  // Asks for the approval (and may approve, but never their own request).
  boss: { actorId: newId(), permissions: ['quotes.view', 'quotes.manage', 'quotes.send', 'quotes.approve', ...grainsOf(['price', 'cost', 'margin'])] as Permission[] },
  finance: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  // An approver without the margin grain: a margin-floor request is not theirs to decide.
  blind: { actorId: newId(), permissions: ['quotes.view', 'quotes.approve', 'money.price'] as Permission[] },
  viewer: { actorId: newId(), permissions: ['quotes.view', 'money.price'] as Permission[] },
}
const NAMES: Record<keyof typeof PEOPLE, string> = { boss: 'Bruno Capo', finance: 'Fiona Conti', sales: 'Sara Vendite', blind: 'Bice Cieca', viewer: 'Vito Visto' }
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: person.actorId, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const queue = (session: string, view: string, quoteId?: string) => ok(session, 'GET', `/sales/quote-approvals?view=${view}${quoteId ? `&quoteId=${quoteId}` : ''}`)

beforeAll(async () => {
  db = await migratedDatabase('quote_screens')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'QUOTE', 'MAIN', $4, 'YEARLY', 'Q-{YYYY}-{N:4}', false)`, [newId(), tenant, companyA, YEAR])
  for (const [key, person] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [person.actorId, tenant, `${key}@seed-a.example.com`, NAMES[key as keyof typeof PEOPLE]])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

let quote: Json

describe('the next number, shown before a quote is made (New quote)', () => {
  it('is the series next value as printed; it takes nothing', async () => {
    expect(await ok('sales', 'GET', `/sales/quote-numbers/next?companyId=${companyA}`)).toEqual({ number: `Q-${YEAR}-0001` })
    expect(await ok('sales', 'GET', `/sales/quote-numbers/next?companyId=${companyA}`)).toEqual({ number: `Q-${YEAR}-0001` })
    // quotes.manage only (a viewer makes no quote): refused by the manifest.
    expect((await call('viewer', 'GET', `/sales/quote-numbers/next?companyId=${companyA}`)).statusCode).toBe(403)
    quote = (await ok('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    expect(quote.number).toBe(`Q-${YEAR}-0001`)
    expect(await ok('sales', 'GET', `/sales/quote-numbers/next?companyId=${companyA}`)).toEqual({ number: `Q-${YEAR}-0002` })
  })
})

describe('the approvals queue (SCR-030): never the requester, a margin-floor request only with the margin grain', () => {
  it('lists the request for the approvers who may decide it, and says why to everyone else', async () => {
    quote = (await ok('boss', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }], unitPrice: '300' }, 201)).quote
    expect(quote.current.marginFloorBreached).toBe(true)
    expect(quote.canAskApproval).toBe(true)
    quote = (await ok('boss', 'POST', `/sales/quotes/${quote.id}/approval`, { version: quote.version, note: 'Nuovo cliente, primo ordine.' })).quote

    // The requester: nothing waits for them; their own request is in "mine", held OWN_REQUEST, with their name.
    const own = await queue('boss', 'waiting')
    expect(own.approvals).toEqual([])
    expect(own.counts).toMatchObject({ waiting: 0, mine: 1, decided: 0, capped: false })
    const [mine] = (await queue('boss', 'mine')).approvals
    expect(mine).toMatchObject({ quoteId: quote.id, number: quote.number, status: 'PENDING', reasons: ['MARGIN_FLOOR'], requestNote: 'Nuovo cliente, primo ordine.', mayDecide: false, held: 'OWN_REQUEST', current: true, revision: 1, quoteVersion: quote.version })
    expect(mine.askedBy).toEqual({ id: PEOPLE.boss.actorId, name: 'Bruno Capo', you: true })
    expect(mine.partyName).not.toBe('')

    // Finance (approve, every grain): it waits for them, with the money.
    const finance = await queue('finance', 'waiting')
    expect(finance.counts).toMatchObject({ waiting: 1, mine: 0 })
    expect(finance.approvals).toHaveLength(1)
    expect(finance.approvals[0]).toMatchObject({ mayDecide: true, held: null, askedBy: { name: 'Bruno Capo', you: false }, netAmount: 180000, marginFloorPct: '20' })
    expect(typeof finance.approvals[0].marginPct).toBe('string')

    // An approver without the margin grain: not theirs (held NEEDS_MARGIN), and no margin figure at all.
    const blind = await queue('blind', 'waiting')
    expect(blind.approvals).toEqual([])
    expect(blind.counts.waiting).toBe(0)
    const [seen] = (await queue('blind', 'all', quote.id)).approvals
    expect(seen).toMatchObject({ held: 'NEEDS_MARGIN', mayDecide: false, netAmount: 180000 })
    expect('marginPct' in seen).toBe(false)
    expect('marginFloorPct' in seen).toBe(false)

    // Sales sees it (quotes.view) but holds no quotes.approve: NO_RIGHT.
    const [sales] = (await queue('sales', 'all')).approvals
    expect(sales).toMatchObject({ held: 'NO_RIGHT', mayDecide: false })
  })

  it('a decision moves it to "decided" for both sides, with the decider by name', async () => {
    const answer = await ok('finance', 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: quote.version, note: 'Va bene così.' })
    quote = answer.quote
    expect((await queue('finance', 'waiting')).approvals).toEqual([])
    const decided = await queue('finance', 'decided')
    expect(decided.counts.decided).toBe(1)
    expect(decided.approvals[0]).toMatchObject({ status: 'APPROVED', decidedBy: { name: 'Fiona Conti', you: true }, decisionNote: 'Va bene così.', held: 'NOT_WAITING' })
    const [mine] = (await queue('boss', 'mine')).approvals
    expect(mine).toMatchObject({ status: 'APPROVED', decidedBy: { id: PEOPLE.finance.actorId, name: 'Fiona Conti', you: false } })
    expect((await queue('boss', 'decided')).counts).toMatchObject({ decided: 1, mine: 0 })
  })
})

describe('the PDF before it is sent (SCR-037) and the names on the versions', () => {
  it('renders the current version with the sample banner, inline, in the language asked; stores nothing', async () => {
    const files = async () => (await admin<{ n: string }>('SELECT count(*)::text AS n FROM "StoredFile" WHERE "recordId" = $1', [quote.id]))[0]!.n
    const before = await files()
    for (const language of ['it', 'en']) {
      const response = await call('sales', 'GET', `/sales/quotes/${quote.id}/preview?language=${language}`)
      expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
      expect(response.headers['content-type']).toBe('application/pdf')
      expect(String(response.headers['content-disposition'])).toMatch(/^inline; filename=/)
      expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }
    expect(await files()).toBe(before)
  })

  it('says what the PDF still needs, in words (a quote without a validity)', async () => {
    quote = (await ok('boss', 'POST', `/sales/quotes/${quote.id}/reopen`, { version: quote.version })).quote
    quote = (await ok('boss', 'PATCH', `/sales/quotes/${quote.id}`, { version: quote.version, validUntil: null })).quote
    const response = await call('sales', 'GET', `/sales/quotes/${quote.id}/preview`)
    expect(response.statusCode).toBe(409)
    expect(response.json().error.issues.length).toBeGreaterThan(0)
  })

  it('names who made each version', async () => {
    const answer = await ok('sales', 'GET', `/sales/quotes/${quote.id}/versions`)
    expect(answer.people).toEqual([{ id: PEOPLE.boss.actorId, name: 'Bruno Capo' }])
    expect(answer.versions[0].createdById).toBe(PEOPLE.boss.actorId)
  })
})
