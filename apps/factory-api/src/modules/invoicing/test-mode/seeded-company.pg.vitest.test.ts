import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { seedToday } from '@nexus/factory-db/testing'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { callerFor } from '../../../core/command'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { pollSend } from '../sdi/poll'
import { createSdiRuntime, useSdi, type SdiRuntime } from '../sdi/runtime'

/**
 * An e-invoice from a fresh seed (B-W2b-F59): EVERY seed file run in name order, as the seed CLI runs them, on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_money_guards triggers are
 * real), the real office sign-in (finance steps up), the SDI runtime with the FAKE intermediary behind the real gateway. With
 * nothing typed by hand, the seed's immediate TD01 draft (seed/invoice-draft.ts: no date until its issue, so it issues on any
 * day) issues with company A's seeded Partita IVA, RegimeFiscale, registered office with its province and REA, is sent in
 * e-invoice test mode through the company's FAKE connection, and the status poll brings SDI's RC: DELIVERED. Before this step
 * the issue answered 409 with the company's missing data. Dated by today (seedToday()), never by a seeded day. Every company,
 * party and number is made up. Run with `node scripts/factory/run-pg-tests.mjs invoicing/test-mode/seeded`.
 */

let h: Harness
let finance: Browser
let secret: string
let sdi: SdiRuntime

const NS = 'w2bf59-invoice'
const key = (name: string): string => seedUuid(NS, name)
// B-W2b-F59: the seed's draft that issues on ANY day (seed/invoice-draft.ts: an immediate TD01, dated by its issue).
const T = { tenant: key('tenant'), companyA: key('company:A'), draft: `ffffffff${key('invoice-draft:TD01:P1:embroidery').slice(8)}` }
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
async function as(method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method, url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('w2bf59_invoice')
  h.clock.set(new Date())
  const context: SeedContext = { db: h.database, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  sdi = createSdiRuntime({ gateway, fake: new FakeSdi({ answerAfterMs: 0 }) })
  useSdi(sdi)
  const companies = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Company" WHERE "tenantId" = $1 ORDER BY code`, [T.tenant])
  const user = await addUser(h, { id: T.tenant, slug: NS, companies }, { email: 'finance.f59@example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(NS, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
}, 600_000)

afterAll(async () => {
  useSdi(undefined)
  await h?.close()
}, 60_000)

describe('an e-invoice from a fresh seed (B-W2b-F59)', () => {
  it('shows company A ready to invoice, in e-invoice test mode on its FAKE connection', async () => {
    const settings = (await as('GET', '/invoicing/e-invoicing/settings')).companies.find((entry: Json) => entry.companyId === T.companyA)
    expect(settings).toMatchObject({ testMode: true, state: { code: 'TEST' }, connection: { state: 'ACTIVE' } })
    const draft = (await as('GET', `/invoicing/invoices/${T.draft}`)).invoice
    expect(draft).toMatchObject({ status: 'DRAFT', docType: 'TD01' })
  })

  it('issues the seeded draft with no data typed by hand, sends it, and the status poll brings DELIVERED', async () => {
    await stepUp(h, finance, secret)
    const issued = await as('POST', `/invoicing/invoices/${T.draft}/issue`, {})
    expect(issued).toMatchObject({ invoice: { status: 'ISSUED' }, filesPending: false })
    expect(issued.invoice.number).toMatch(new RegExp(`^FT-${seedToday().slice(0, 4)}-\\d{5}$`))
    // Dated by the day of its issue (the seeds' calendar's today, Europe/Rome): never a seeded day.
    expect(issued.invoice.issueDate).toBe(seedToday())
    const [frozen] = await admin<{ seller: Json }>(`SELECT seller FROM "Invoice" WHERE id = $1`, [T.draft])
    expect(frozen!.seller).toMatchObject({ vatNumber: '00000003038', taxRegime: 'RF01', address: { province: 'MI', postcode: '00000' }, rea: { office: 'MI', number: '0000303' } })
    await stepUp(h, finance, secret)
    const sent = await as('POST', `/invoicing/invoices/${T.draft}/sdi/send`, {})
    expect(sent.sdi.sends.at(-1)).toMatchObject({ status: 'SENT' })
    const [send] = await admin<{ id: string }>(`SELECT id FROM "SdiSubmission" WHERE "invoiceId" = $1`, [T.draft])
    expect(await pollSend(sdi, callerFor(h.database, systemContext(T.tenant, newId())), send!.id)).toBe('recorded')
    expect((await as('GET', `/invoicing/invoices/${T.draft}`)).invoice.status).toBe('DELIVERED')
  })
})
