import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { inquiries as exportSource } from '../inquiries/export-source'

/**
 * B-TH-039 (threads plan G2, L2-G07; O-SAL-INQ-LIST.list / .tiles / .band, O-HOME-TODAY.incoming, O-HOME-APV.list; wall W27/W30,
 * test T30): GET /sales/incoming lists requests, catalogue orders and change requests in ONE paged list, each row checked against
 * its OWN view permission (requests sales.inquiries.view; catalogue orders and change requests orders.view), the tiles counted
 * under the same filters; change requests only of the kinds CHANGE and CANCEL, opening Home › Approvals (agreement T3); the
 * `sales.inquiries` export source reads the same list to its end. Through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations, on the seeds up to the portal's sales (P1: SEED-RQ-0001 SENT, -0002 ACCEPTED as SEED-SO-0002,
 * -0003 REFUSED, a DRAFT that is theirs alone; change requests on SEED-SO-0002 OPEN, SEED-SO-0003 cancel REFUSED, SEED-SO-0001
 * ACCEPTED; requests SEED-INQ-0001 a prospect's NEW, -0002 P3's ASSIGNED, -0003 from a mail NEED_INFO, -0004 P1's QUOTED, -0005 P3's
 * DECLINED, -0006 LOST). Made-up data only. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/incoming`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>

const NS = 'th039-incoming'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const salesTemplate = templateOf('sales')!
const SALES = [...salesTemplate.permissions, ...salesTemplate.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions, parties)] })
const SESSIONS: Record<string, SessionContext> = {
  sales: office(SALES),
  // Reads requests, not orders: the catalogue orders and change requests are not listed, their counts are null.
  requestsOnly: office(['sales.inquiries.view', 'home.view'] as Permission[]),
  // Wall T30: a person limited to one customer lists none of the other's rows of any kind.
  onlyP1: office(SALES, [P1]),
  onlyP3: office(SALES, [P3]),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session, 'x-run': run } })
async function get(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const list = (session: string, query = '') => get(session, `/sales/incoming${query ? `?${query}` : ''}`)
const numbers = (rows: readonly Json[]) => rows.map((row) => row.number)
const ofKind = (rows: readonly Json[], kind: string) => rows.filter((row) => row.kind === kind)

/** Every page of a query, by its cursor (limit rows a page). */
async function allPages(session: string, query: string, limit: number): Promise<Json[]> {
  const rows: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const answer: Json = await list(session, `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(answer.rows.length).toBeLessThanOrEqual(limit)
    rows.push(...answer.rows)
    cursor = answer.next
    if (!cursor) return rows
  }
  throw new Error('more than 100 pages')
}

beforeAll(async () => {
  h = await startHarness('th039_incoming')
  // In the CLI's name order (each seed runs the ones it builds on itself).
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  await seedPortalSales({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('Sales › Incoming over every door (B-TH-039)', () => {
  it('ALL lists every kind: the requests, the catalogue orders sent (never a draft) and the change and cancel requests; newest first', async () => {
    const all = await list('sales', 'tile=ALL')
    const kinds = new Set(all.rows.map((row: Json) => row.kind))
    expect([...kinds].sort()).toEqual(['CATALOGUE_ORDER', 'CHANGE_REQUEST', 'REQUEST'])
    expect(numbers(ofKind(all.rows, 'CATALOGUE_ORDER')).sort()).toEqual(['SEED-RQ-0001', 'SEED-RQ-0002', 'SEED-RQ-0003'])
    for (const number of ['SEED-INQ-0001', 'SEED-INQ-0002', 'SEED-INQ-0003', 'SEED-INQ-0004', 'SEED-INQ-0005', 'SEED-INQ-0006']) expect(numbers(ofKind(all.rows, 'REQUEST'))).toContain(number)
    // A change request is named by its order and opens Home › Approvals (agreement T3); the others open in Incoming's pane.
    const changes = ofKind(all.rows, 'CHANGE_REQUEST')
    expect(changes).toHaveLength(3)
    for (const row of changes) {
      expect(['CHANGE', 'CANCEL']).toContain(row.changeRequest.kind)
      expect(row.opens).toEqual({ place: 'APPROVALS', id: row.id })
      expect(row.number).toBe(row.changeRequest.order.number)
      expect(row.request).toBeNull()
    }
    for (const row of all.rows.filter((entry: Json) => entry.kind !== 'CHANGE_REQUEST')) expect(row.opens).toEqual({ place: 'INCOMING', id: row.id })
    // Newest first (not a queue tile); each row's key is unique.
    const at = all.rows.map((row: Json) => row.receivedAt)
    expect([...at].sort().reverse()).toEqual(at)
    expect(new Set(all.rows.map((row: Json) => row.key)).size).toBe(all.rows.length)
    // The request keeps every cell of its old row (the web reuses them).
    const quoted = all.rows.find((row: Json) => row.number === 'SEED-INQ-0004')
    expect(quoted.request).toMatchObject({ number: 'SEED-INQ-0004', status: 'QUOTED', party: { id: P1 } })
    expect(quoted.stateWords.en).toBe('Quoted')
    const accepted = all.rows.find((row: Json) => row.number === 'SEED-RQ-0002')
    expect(accepted.catalogueOrder).toMatchObject({ status: 'ACCEPTED', customerRef: 'PO-SEED-7002', salesOrder: { number: 'SEED-SO-0002' } })
    expect(all.next).toBeNull()
    expect(all.kinds).toEqual({ REQUEST: ofKind(all.rows, 'REQUEST').length, CATALOGUE_ORDER: 3, CHANGE_REQUEST: 3 })
  })

  it('OPEN (the default) holds what waits for the office, oldest first; each tile counts every kind under the same filters', async () => {
    const open = await list('sales')
    const keys = open.rows.map((row: Json) => `${row.kind}:${row.state}`)
    expect(keys).toContain('CATALOGUE_ORDER:SENT')
    expect(keys).toContain('CHANGE_REQUEST:OPEN')
    expect(open.rows.every((row: Json) => row.open)).toBe(true)
    expect(numbers(open.rows)).not.toContain('SEED-RQ-0002')
    const at = open.rows.map((row: Json) => row.receivedAt)
    expect([...at].sort()).toEqual(at)
    // Every tile's count is the rows that tile lists (one page of 200 holds them all here).
    for (const tile of Object.keys(open.counts)) {
      const rows = (await list('sales', `tile=${tile}`)).rows
      expect(open.counts[tile], tile).toBe(rows.length)
    }
    expect(open.counts.NEW).toBe((await list('sales', 'tile=NEW')).rows.length)
    // The kinds in the tiles of the design.
    const tiles = async (tile: string) => (await list('sales', `tile=${tile}`)).rows.map((row: Json) => `${row.kind}:${row.number}`)
    expect(await tiles('NEW')).toEqual(expect.arrayContaining(['REQUEST:SEED-INQ-0001', 'CATALOGUE_ORDER:SEED-RQ-0001', 'CHANGE_REQUEST:SEED-SO-0002']))
    expect(await tiles('WAITING_CUSTOMER')).toEqual(['REQUEST:SEED-INQ-0003'])
    expect(await tiles('ORDERED')).toContain('CATALOGUE_ORDER:SEED-RQ-0002')
    expect(await tiles('DECLINED')).toEqual(expect.arrayContaining(['REQUEST:SEED-INQ-0005', 'CATALOGUE_ORDER:SEED-RQ-0003', 'CHANGE_REQUEST:SEED-SO-0003']))
    expect(await tiles('NOT_AN_ORDER')).toEqual([])
    expect(await tiles('LOST')).toEqual(['REQUEST:SEED-INQ-0006'])
    // The accepted change (its order changed) waits nowhere: ALL only.
    for (const tile of ['NEW', 'OPEN', 'DECLINED', 'LOST', 'ORDERED', 'QUOTED']) expect(await tiles(tile)).not.toContain('CHANGE_REQUEST:SEED-SO-0001')
  })

  it('WAITING_US: the catalogue order and the change request that wait over a working day are there, with their waiting time', async () => {
    const waiting = await list('sales', 'tile=WAITING_US')
    const sent = waiting.rows.find((row: Json) => row.number === 'SEED-RQ-0001')
    const change = waiting.rows.find((row: Json) => row.kind === 'CHANGE_REQUEST')
    for (const row of [sent, change]) {
      expect(row).toBeDefined()
      expect(row.waiting).toMatchObject({ for: 'US', overdue: true })
      expect(row.waiting.workingMinutes).toBeGreaterThan(480)
    }
    expect(waiting.rows.every((row: Json) => row.waiting.overdue)).toBe(true)
    expect(waiting.complete).toBe(true)
  })

  it('pages to the end by the cursor: every row once, in the same order as one read; a bad cursor is refused in words', async () => {
    for (const tile of ['ALL', 'OPEN']) {
      const one = (await list('sales', `tile=${tile}`)).rows.map((row: Json) => row.key)
      const paged = (await allPages('sales', `tile=${tile}`, 2)).map((row) => row.key)
      expect(paged, tile).toEqual(one)
    }
    const bad = await call('sales', '/sales/incoming?cursor=not-a-cursor')
    expect(bad.statusCode).toBe(400)
    expect(bad.body).toContain('cursor')
  })

  it('the filters: one kind, a customer, the portal door, a request status, a search by number or customer reference', async () => {
    expect(ofKind((await list('sales', 'tile=ALL&kind=CATALOGUE_ORDER')).rows, 'CATALOGUE_ORDER')).toHaveLength(3)
    expect((await list('sales', 'tile=ALL&kind=CATALOGUE_ORDER')).rows.every((row: Json) => row.kind === 'CATALOGUE_ORDER')).toBe(true)
    const p3 = (await list('sales', `tile=ALL&partyId=${P3}`)).rows
    expect(p3.length).toBeGreaterThan(0)
    expect(p3.every((row: Json) => row.party?.id === P3)).toBe(true)
    // A request's status lists requests only; a door other than the portal too.
    expect((await list('sales', 'tile=ALL&status=QUOTED')).rows.map((row: Json) => row.kind)).toEqual(['REQUEST'])
    expect((await list('sales', 'tile=ALL&source=MAIL')).rows.every((row: Json) => row.kind === 'REQUEST')).toBe(true)
    expect(new Set((await list('sales', 'tile=ALL&source=PORTAL')).rows.map((row: Json) => row.kind))).toEqual(new Set(['CATALOGUE_ORDER', 'CHANGE_REQUEST']))
    expect(numbers((await list('sales', 'tile=ALL&q=PO-SEED-7001')).rows)).toEqual(['SEED-RQ-0001'])
    expect(numbers((await list('sales', 'tile=ALL&q=SEED-SO-0003')).rows)).toEqual(['SEED-SO-0003'])
    const prospects = (await list('sales', 'tile=ALL&prospect=true')).rows
    expect(prospects.every((row: Json) => row.kind === 'REQUEST' && row.prospect)).toBe(true)
  })

  it('each row follows its own view right: a reader of requests only lists requests, the other kinds are not counted', async () => {
    const answer = await list('requestsOnly', 'tile=ALL')
    expect(answer.rows.length).toBeGreaterThan(0)
    expect(answer.rows.every((row: Json) => row.kind === 'REQUEST')).toBe(true)
    expect(answer.kinds).toMatchObject({ CATALOGUE_ORDER: null, CHANGE_REQUEST: null })
    expect(JSON.stringify(answer)).not.toMatch(/SEED-RQ-|SEED-SO-/)
    expect(answer.counts.NEW).toBe((await list('requestsOnly', 'tile=NEW')).rows.length)
  })

  it('T30: a person limited to one customer lists, counts and pages none of the other customer’s rows of any kind', async () => {
    // P1 has rows of every kind; a person limited to P3 never reads one of them — nor their numbers, their customer or their counts.
    const p3 = await list('onlyP3', 'tile=ALL')
    expect(p3.rows.length).toBeGreaterThan(0)
    for (const row of p3.rows) expect(row.party === null || row.party.id === P3, row.number).toBe(true)
    const text = JSON.stringify(p3)
    for (const leak of [P1, 'SEED-RQ-', 'SEED-SO-', 'SEED-INQ-0004', 'PO-SEED-']) expect(text, leak).not.toContain(leak)
    expect(p3.kinds).toEqual({ REQUEST: p3.rows.length, CATALOGUE_ORDER: 0, CHANGE_REQUEST: 0 })
    for (const tile of ['NEW', 'WAITING_US', 'OPEN', 'ORDERED', 'DECLINED', 'ALL']) expect((await list('onlyP3', `tile=${tile}`)).rows.every((row: Json) => row.party === null || row.party.id === P3)).toBe(true)
    expect((await allPages('onlyP3', 'tile=ALL', 1)).map((row) => row.key)).toEqual(p3.rows.map((row: Json) => row.key))
    // A filter naming P1 finds nothing for them.
    expect((await list('onlyP3', `tile=ALL&partyId=${P1}`)).rows).toEqual([])
    expect((await list('onlyP3', 'tile=ALL&q=SEED-SO-0002')).rows).toEqual([])
    // And the other way: limited to P1, every kind of P1's, none of P3's requests.
    const p1 = await list('onlyP1', 'tile=ALL')
    expect(new Set(p1.rows.map((row: Json) => row.kind))).toEqual(new Set(['REQUEST', 'CATALOGUE_ORDER', 'CHANGE_REQUEST']))
    for (const row of p1.rows) expect(row.party === null || row.party.id === P1, row.number).toBe(true)
    expect(JSON.stringify(p1)).not.toContain(P3)
    expect(numbers(p1.rows)).not.toContain('SEED-INQ-0002')
  })

  it('the `sales.inquiries` export source reads the same list to its end, page after page (list key unchanged)', async () => {
    expect(exportSource.listKey).toBe('sales.inquiries')
    const caller = callerFor(h.database, completeContext(SESSIONS.onlyP1!, 'th039'))
    const query = exportSource.query(new URLSearchParams('tile=ALL'))
    const rows: Json[] = []
    let cursor: string | null = null
    do {
      const page = await exportSource.read(caller, query, cursor, 2)
      rows.push(...(page.rows as Json[]))
      cursor = page.next
    } while (cursor)
    const screen = (await list('onlyP1', 'tile=ALL')).rows
    expect(rows.map((row) => row.key)).toEqual(screen.map((row: Json) => row.key))
    expect(await exportSource.count!(caller, query)).toBe(screen.length)
    // The cells: the kind, the state in the file's language.
    const words = (code: string) => (exportSource.words!.en as Record<string, string>)[code] ?? code
    const change = rows.find((row) => row.kind === 'CHANGE_REQUEST' && row.state === 'OPEN')!
    expect(exportSource.columns.kind!.value(change, words)).toBe('Change request')
    expect(exportSource.columns.status!.value(change, words)).toBe('Change request · Waiting for our answer')
    expect(JSON.stringify(rows)).not.toContain(P3)
  })
})
