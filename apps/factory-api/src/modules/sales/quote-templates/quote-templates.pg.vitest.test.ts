import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesPricing } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Quote templates (B-W2b-294; SAL-144, SAL-252) through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and B-W2b-280's QuoteTemplate guards are real), on the seeds up to the
 * sales pricing (company A's "Seed season order" and the tenant's "Seed sample request", SEED-Q-0003 started from the first;
 * the brand P1 = SEED-C1 with its private-label jackets SEED-JKT-01 and -02, the German customer P3 = SEED-C2; the private rider
 * R1 joins P1's team here). Every word and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quote-templates`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'w2b294-templates'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const JKT01 = idOf('product:style:JKT-01')
const JKT01_BLK = idOf('product:colourway:JKT-01:BLK')
const JKT01_RED = idOf('product:colourway:JKT-01:RED')

const roleOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions, companies)] })
const SESSIONS: Record<string, SessionContext> = {
  sales: office(roleOf('sales')),
  // Sales of company A only: its templates, never one of every company.
  salesA: office(roleOf('sales'), [companyA]),
  // Sales without the price grain: reads templates, never a line's price.
  noPrice: office(roleOf('sales').filter((name) => name !== 'money.price')),
  planner: office(roleOf('planner')),
  // Reads quotes, keeps no template.
  viewer: office(['quotes.view'] as Permission[]),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const events = async (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [T, type, subject])

let seeded: Awaited<ReturnType<typeof seedSalesPricing>>
let made: Json

beforeAll(async () => {
  h = await startHarness('quote_templates')
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedSalesPricing({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the templates list and record (SAL-144, SAL-252)', () => {
  it("lists a company's templates and every company's, with their sections and how often they were used", async () => {
    const { templates, mayCreate } = await ok('sales', 'GET', '/sales/quote-templates')
    expect(mayCreate).toBe(true)
    const season = templates.find((row: Json) => row.id === seeded.templateIds.season)
    expect(season).toMatchObject({ name: 'Seed season order', companyId: companyA, company: { id: companyA }, acceptanceMode: 'SIGN_AND_PAY', incoterm: 'EXW', shipComplete: true, sections: ['Jackets', 'Fees'], lineCount: 3, used: 1 })
    expect(templates.find((row: Json) => row.id === seeded.templateIds.samples)).toMatchObject({ companyId: null, company: null })
    // A quote of company B starts only from its own templates and every company's.
    const forB = (await ok('sales', 'GET', `/sales/quote-templates?companyId=${companyB}`)).templates.map((row: Json) => row.id)
    expect(forB).toContain(seeded.templateIds.samples)
    expect(forB).not.toContain(seeded.templateIds.season)
    expect((await ok('viewer', 'GET', '/sales/quote-templates')).mayCreate).toBe(false)
    await no('planner', 'GET', '/sales/quote-templates', undefined, 403)
  })

  it('shows a template with its lines; the price only with the price grain', async () => {
    const { template } = await ok('sales', 'GET', `/sales/quote-templates/${seeded.templateIds.season}`)
    expect(template).toMatchObject({ validityDays: 45, depositPct: '30', depositKind: 'ACCONTO', incotermPlace: 'Seedville', mayManage: true })
    expect(template.lines.map((line: Json) => [line.seq, line.kind, line.section, line.style.code, line.pieces])).toEqual([
      [10, 'SIZE_GRID', 'Jackets', 'SEED-JKT-01', 8],
      [20, 'SIZE_GRID', 'Jackets', 'SEED-JKT-05', 0],
      [30, 'FEE', 'Fees', 'SEED-JKT-05', 0],
    ])
    expect(template.lines[2]).toMatchObject({ feeKind: 'DEVELOPMENT', unitPrice: '500' })
    const blind = (await ok('noPrice', 'GET', `/sales/quote-templates/${seeded.templateIds.season}`)).template
    expect('unitPrice' in blind.lines[2]).toBe(false)
  })
})

describe('keeping templates (quotes.templates.manage)', () => {
  it('makes a template of company A with sections, a line whose colourway is chosen at use and a fee', async () => {
    const body = {
      companyId: companyA,
      name: 'Made-up team kit',
      validityDays: 20,
      acceptanceMode: 'SIGN_AND_PAY',
      depositPct: '40',
      depositKind: 'ACCONTO',
      incoterm: 'fca',
      incotermPlace: 'Seedville warehouse',
      shipComplete: false,
      termsText: 'Made-up terms for a team kit.',
      termsVersion: 'kit-1',
      lines: [
        { seq: 10, section: 'Jackets', styleId: JKT01, colourwayId: JKT01_BLK, sizes: { '50': 1, '52': 2 }, unitPrice: '410' },
        { seq: 20, section: 'Jackets', styleId: JKT01, description: 'Second colour, chosen with the team' },
        { seq: 30, section: 'Fees', kind: 'FEE', feeKind: 'TOOLING', styleId: JKT01, unitPrice: '120', description: 'Made-up embroidery set-up' },
      ],
    }
    made = (await ok('sales', 'POST', '/sales/quote-templates', body, 201)).template
    expect(made).toMatchObject({ companyId: companyA, incoterm: 'FCA', acceptanceMode: 'SIGN_AND_PAY', depositPct: '40', status: 'ACTIVE', used: 0, sections: ['Jackets', 'Fees'], version: 1 })
    expect(made.lines.map((line: Json) => [line.seq, line.kind, line.colourwayId, line.pieces])).toEqual([
      [10, 'SIZE_GRID', JKT01_BLK, 3],
      [20, 'SIZE_GRID', null, 0],
      [30, 'FEE', null, 0],
    ])
    expect((await events('quote_template.changed', made.id)).map((row) => row.payload)).toEqual([{ templateId: made.id, companyId: companyA, change: 'MADE', fields: ['name', 'lines'] }])
    const audit = await one(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [made.id])
    expect(audit.action).toBe('quotes.templates.create')
  })

  it('refuses in words: paying without a deposit, an unknown Incoterm, a fee without its kind, a size the style lacks', async () => {
    const base = { companyId: companyA, name: 'Made-up refused' }
    expect((await no('sales', 'POST', '/sales/quote-templates', { ...base, acceptanceMode: 'SIGN_AND_PAY' }, 400)).issues[0]).toMatchObject({ path: 'body/acceptanceMode', message: 'Sign and pay the deposit: the quote must ask a deposit first.' })
    expect((await no('sales', 'POST', '/sales/quote-templates', { ...base, incoterm: 'XYZ', incotermPlace: 'Milano' }, 400)).issues[0].message).toContain('not an Incoterms 2020 rule')
    expect((await no('sales', 'POST', '/sales/quote-templates', { ...base, lines: [{ seq: 10, kind: 'FEE', styleId: JKT01, unitPrice: '5' }] }, 400)).issues[0].message).toContain('A fee line says what it charges for')
    expect((await no('sales', 'POST', '/sales/quote-templates', { ...base, lines: [{ seq: 10, styleId: JKT01, colourwayId: JKT01_BLK, sizes: { '60': 1 } }] }, 400)).issues[0].message).toBe('SEED-JKT-01 has no size 60.')
    // A template of every company needs a grant over every company; the planner keeps none.
    await no('salesA', 'POST', '/sales/quote-templates', { companyId: null, name: 'Made-up for all' }, 403)
    await no('planner', 'POST', '/sales/quote-templates', base, 403)
  })

  it('changes its terms at its version, replaces its lines, archives and restores it', async () => {
    let template = (await ok('sales', 'PATCH', `/sales/quote-templates/${made.id}`, { version: made.version, name: 'Made-up team kit 2027', validityDays: 25, incoterm: null })).template
    expect(template).toMatchObject({ name: 'Made-up team kit 2027', validityDays: 25, incoterm: null, incotermPlace: null, version: 2 })
    expect((await no('sales', 'PATCH', `/sales/quote-templates/${made.id}`, { version: made.version, validityDays: 30 }, 409)).code).toBe('conflict')
    template = (await ok('sales', 'PUT', `/sales/quote-templates/${made.id}/lines`, { version: template.version, lines: [made.lines[0], { seq: 20, section: 'Jackets', styleId: JKT01, colourwayId: null, sizes: null }].map(({ id: _id, style: _style, colourway: _colourway, pieces: _pieces, kind, feeKind, ...line }: Json) => ({ ...line, kind, feeKind })) })).template
    expect(template.lines.map((line: Json) => line.seq)).toEqual([10, 20])
    template = (await ok('sales', 'POST', `/sales/quote-templates/${made.id}/archive`, { version: template.version })).template
    expect(template.status).toBe('ARCHIVED')
    expect((await no('sales', 'PATCH', `/sales/quote-templates/${made.id}`, { version: template.version, validityDays: 30 }, 409)).message).toContain('archived')
    made = (await ok('sales', 'POST', `/sales/quote-templates/${made.id}/restore`, { version: template.version })).template
    expect(made.status).toBe('ACTIVE')
    expect((await events('quote_template.changed', made.id)).map((row) => row.payload.change)).toEqual(['MADE', 'CHANGED', 'LINES', 'ARCHIVED', 'RESTORED'])
  })
})

describe('a quote started from a template', () => {
  it('copies the terms, the lines in their sections and the pieces picked; leaves out what it cannot take, in words', async () => {
    const season = seeded.templateIds.season
    const { template } = await ok('sales', 'GET', `/sales/quote-templates/${season}`)
    const started = await ok('sales', 'POST', `/sales/quote-templates/${season}/quote`, { companyId: companyA, partyId: P1, customerRef: 'RFQ-KIT-1' }, 201)
    const today = businessDate(new Date())
    expect(started.quote).toMatchObject({ partyId: P1, customerRef: 'RFQ-KIT-1', status: 'DRAFT', current: { validUntil: addDays(today, 45), depositPct: '30', depositKind: 'ACCONTO' } })
    // B-W2b-302: line 30, the template's 500.00 DEVELOPMENT fee, is a FEE line of the quote (B-W2b-330's fees), after the goods.
    expect(started.quote.lines.map((line: Json) => [line.seq, line.kind, line.colourwayId, line.quantity])).toEqual([[10, 'SIZE_GRID', JKT01_BLK, 8], [20, 'FEE', expect.any(String), 1]])
    // Line 20 has no colourway and no pieces yet.
    expect(started.leftOut.map((entry: Json) => entry.seq)).toEqual([20])
    const fee = await one(`SELECT "feeKind"::text AS kind, section, "unitPrice"::text AS price FROM "QuoteLine" WHERE "versionId" = $1 AND kind = 'FEE'`, [started.quote.current.id])
    expect([fee.kind, fee.section, Number(fee.price)]).toEqual(['DEVELOPMENT', 'Fees', 500])
    const row = await one(`SELECT q."templateId", v.incoterm, v."incotermPlace", v."shipComplete", v."acceptanceMode"::text AS mode, l.section FROM "Quote" q JOIN "QuoteVersion" v ON v."quoteId" = q.id JOIN "QuoteLine" l ON l."versionId" = v.id WHERE q.id = $1 AND l.kind = 'SIZE_GRID'`, [started.quote.id])
    expect(row).toEqual({ templateId: season, incoterm: 'EXW', incotermPlace: 'Seedville', shipComplete: true, mode: 'SIGN_AND_PAY', section: 'Jackets' })
    const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.fromTemplate' AND "recordId" = $1`, [started.quote.id])
    expect(audit.after).toMatchObject({ templateId: season, lines: 2 })
    expect((await ok('sales', 'GET', `/sales/quote-templates/${season}`)).template.used).toBe(template.used + 1)
    // A colourway and pieces picked for the open line: it becomes a line too (the template's own price when it has one).
    const picked = await ok('sales', 'POST', `/sales/quote-templates/${made.id}/quote`, { companyId: companyA, partyId: P1, lines: [{ templateLineId: made.lines[1].id, colourwayId: JKT01_RED, sizes: { '54': 2 } }] }, 201)
    expect(picked.quote.lines.map((line: Json) => [line.colourwayId, line.quantity, line.unitPrice])).toEqual([[JKT01_BLK, 3, '410'], [JKT01_RED, 2, expect.any(String)]])
    expect(picked.leftOut).toEqual([])
  })

  it("leaves out another customer's private-label style; a rider of the brand's team takes it; another company's template is refused", async () => {
    const forP3 = await ok('sales', 'POST', `/sales/quote-templates/${made.id}/quote`, { companyId: companyA, partyId: P3, lines: [{ templateLineId: made.lines[1].id, skip: true }] }, 201)
    expect(forP3.quote.lines).toEqual([])
    expect(forP3.leftOut.map((entry: Json) => entry.reason)).toEqual(['Left out when the quote was made.', expect.stringContaining("SEED-JKT-01 is another customer's private-label style")])
    // A private rider joins P1's team (B-W2b-290's riders): the team's kit is theirs to buy.
    const R1 = (await one(`UPDATE "Party" SET "teamPartyId" = $2 WHERE "tenantId" = $1 AND code = 'SEED-R1' RETURNING id`, [T, P1])).id
    const forRider = await ok('sales', 'POST', `/sales/quote-templates/${made.id}/quote`, { companyId: companyA, partyId: R1, lines: [{ templateLineId: made.lines[1].id, skip: true }] }, 201)
    expect(forRider.quote.lines.length).toBe(1)
    expect((await no('sales', 'POST', `/sales/quote-templates/${made.id}/quote`, { companyId: companyB, partyId: P1 }, 400)).issues[0].path).toBe('body/companyId')
    await no('planner', 'POST', `/sales/quote-templates/${made.id}/quote`, { companyId: companyA, partyId: P1 }, 403)
  })
})

describe('a quote saved as a template', () => {
  it('keeps its lines, sections, fee and terms; a price typed by hand stays with its line', async () => {
    const { template } = await ok('sales', 'POST', '/sales/quote-templates/from-quote', { quoteId: seeded.draftQuote.quoteId, name: 'Made-up from SEED-Q-0003' }, 201)
    expect(template).toMatchObject({ companyId: companyA, acceptanceMode: 'SIGN_AND_PAY', incoterm: 'EXW', incotermPlace: 'Seedville', shipComplete: true })
    expect(template.lines.map((line: Json) => [line.kind, line.section, line.feeKind])).toEqual([
      ['SIZE_GRID', 'Jackets', null],
      ['FEE', 'Fees', 'DEVELOPMENT'],
    ])
    // SEED-Q-0003's jacket was priced by hand (no list price): its price stays; the fee keeps its own.
    expect(template.lines.map((line: Json) => [line.sizes, line.unitPrice])).toEqual([
      [{ '50': 2, '52': 4, '54': 2 }, '470'],
      [null, '500'],
    ])
  })
})
