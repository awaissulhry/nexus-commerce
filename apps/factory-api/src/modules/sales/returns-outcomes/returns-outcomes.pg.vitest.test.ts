import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedApprovals } from '../../../../../../packages/factory-db/seed/approvals'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedService } from '../../../../../../packages/factory-db/seed/service'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Remakes, exchanges and closing a return (B-W2b-346; SAL-298 from the office, SAL-350, SAL-351, SAL-355, SAL-360; lead
 * fix F28) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the floor's column grants and the …_service_safety_w2b_guards triggers — the split, the size exchange, the
 * finish reason — are real), the real app with test sessions. One made-up tenant from the factory-db seeds up to service
 * and approvals (every rule OFF). P1 was shipped one RED 52 of SEED-JKT-02 (sizes 50, 52, 54) and invoiced sample jackets on
 * FT-2026-00001 (made six pieces at 250.00 here, a seed fact). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/returns-outcomes/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

let h: Harness
let app: FastifyInstance

const NS = 'w2b346-returns-outcomes'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const siteA = idIn('site:A1')
const P1 = idIn('party:P1')
const RED_LINE = idIn('production:sales-order:SO-0002:20')
const SAMPLE_LINE = idIn('money:line:FT-2026-00001:1')
const YEAR = String(new Date().getUTCFullYear())
const run = randomBytes(4).toString('hex')

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = (label = 'k'): string => `w2b346-${run}-${label}-${++counter}`

const PEOPLE = { owner: newId(), sales: newId() } as const
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
function templateGrants(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SALES: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'sales.returns.decide', 'sales.returns.receive', 'sales.returns.inspect', 'orders.view', 'orders.manage', 'approvals.view', 'approvals.request', 'money.price']
const office = (permissions: Permission[], actorId = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {}

async function call(session: string, method: Method, url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : ({ raw: response.rawPayload } as Json) }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])
const outcomesOf = async (returnId: string, session = 'sales') => (await ok(session, 'GET', `/sales/returns/${returnId}/outcomes`)).return
const lineRow = (lineId: string) =>
  one<Json>(`SELECT seq, quantity, "receivedQuantity", disposition::text AS disposition, "goodsOutcome"::text AS "goodsOutcome", "creditAmount", "exchangeSize", "parentLineId", "replacementLineId", "creditWithoutReturn" FROM "ReturnLine" WHERE id = $1`, [lineId])
const rmaRow = (returnId: string) => one<Json>(`SELECT status::text AS status, "finishReason"::text AS "finishReason", "statusReason", version FROM "ReturnAuthorisation" WHERE id = $1`, [returnId])
const versionOf = async (returnId: string): Promise<number> => (await rmaRow(returnId)).version as number

/** A new AUTHORISED return of P1 (W2a's route). */
async function newReturn(line: Json, quantity = 1, reasonCode = 'OTHER'): Promise<Json> {
  const made = await ok('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, siteId: siteA, lines: [{ ...line, quantity, reasonCode, ...(reasonCode === 'OTHER' ? { reasonNote: 'Made-up: the customer changed their mind.' } : {}) }] }, 201)
  return made.return
}
/** The dock receives pieces of a line (W2a's route, the floor's tablet). */
const receive = async (returnId: string, lineId: string, quantity: number) =>
  (await ok('dock', 'POST', `/sales/returns/${returnId}/receipts`, { version: await versionOf(returnId), parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId, quantity }] }, 201)).return
const grade = async (returnId: string, lineId: string, gradeCode = 'GOOD', cause = 'NO_FAULT') => ok('dock', 'POST', `/sales/returns/${returnId}/grades`, { version: await versionOf(returnId), lines: [{ lineId, grade: gradeCode, cause }] })

const TYPED_DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '1.8', appearance: 'Scatola di cartone' } as const

beforeAll(async () => {
  h = await startHarness('returns_outcomes_w2b346')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedService({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSchedule({ db: h.database, namespace: NS })
  await seedApprovals({ db: h.database, namespace: NS })
  // Seed facts: P1 was invoiced six sample jackets at 250.00; the letterhead the DDT prints (c.c. art. 2250), made up; this
  // year's DDT series with no last date; the FAKE file store's rate.
  await force(`UPDATE "InvoiceLine" SET quantity = 6, "netAmount" = 150000 WHERE id = $1`, [SAMPLE_LINE])
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), T, companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [T])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of [['owner', 'owner'], ['sales', 'sales']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b346-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleIds.get(role)])
  }
  SESSIONS.owner = { audience: 'office', tenantId: T, actorId: PEOPLE.owner, grants: templateGrants('owner') }
  SESSIONS.sales = office(SALES, PEOPLE.sales)
  SESSIONS.desk = office([...SALES, 'shipping.view', 'shipping.ddt.issue'])
  SESSIONS.viewer = office(['sales.returns.view'])
  SESSIONS.dock = { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work' as Permission, 'sales.returns.receive', 'sales.returns.inspect'], companies: [companyA], sites: [siteA], parties: 'all' }] } as SessionContext
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let splitRma: Json
let parentId: string
let childId: string

describe('split lines on a partial receipt (SAL-350) and the credit note of a line credited without its goods (F28)', () => {
  it('the dock splits a line of which part arrived: the line keeps what came, a new line right after it takes the rest', async () => {
    splitRma = await newReturn({ invoiceLineId: SAMPLE_LINE }, 2)
    parentId = splitRma.lines[0].id
    // REFUSED: nothing arrived yet (the RMA is authorised: its pieces change instead).
    expect((await refused('dock', 'POST', `/sales/returns/${splitRma.id}/lines/${parentId}/split`, { version: splitRma.version }, 409)).message).toBe("Nothing arrived yet: before the goods, change line 10's pieces instead.")
    await receive(splitRma.id, parentId, 1)
    // REFUSED: a viewer may not split.
    expect((await refused('viewer', 'POST', `/sales/returns/${splitRma.id}/lines/${parentId}/split`, { version: await versionOf(splitRma.id) }, 403)).code).toBe('forbidden')
    const before = await outcomesOf(splitRma.id)
    expect(before.lines[0]).toMatchObject({ quantity: 2, receivedQuantity: 1, expected: 1, split: { allowed: true, held: null, rest: 1 } })
    const split = await ok('dock', 'POST', `/sales/returns/${splitRma.id}/lines/${parentId}/split`, { version: before.version })
    childId = split.newLine.id
    expect(split).toMatchObject({ line: { id: parentId, seq: 10, quantity: 1 }, newLine: { seq: 11, quantity: 1 } })
    // The dock's view (no price) lists both: the rest still expected.
    expect(split.return.lines.map((line: Json) => [line.seq, line.quantity, line.receivedQuantity, line.expected])).toEqual([
      [10, 1, 1, 0],
      [11, 1, 0, 1],
    ])
    expect(JSON.stringify(split)).not.toMatch(/unitPrice|creditAmount/)
    expect(await lineRow(childId)).toMatchObject({ seq: 11, quantity: 1, receivedQuantity: 0, parentLineId: parentId, disposition: null })
    expect((await events('return.line_split', splitRma.id))[0]?.payload).toEqual({ returnId: splitRma.id, number: splitRma.number, lineId: parentId, newLineId: childId, kept: 1, rest: 1 })
    const outcomes = await outcomesOf(splitRma.id)
    expect(outcomes.lines.find((line: Json) => line.id === parentId)).toMatchObject({ splitLineIds: [childId], split: { allowed: false, held: 'Every piece of line 10 arrived: there is nothing to split off.' } })
    expect(outcomes.lines.find((line: Json) => line.id === childId)).toMatchObject({ parentLineId: parentId, split: { allowed: false, held: 'Nothing of line 11 arrived yet: it waits for its goods as it is.' } })
    // REFUSED: the line is whole now; the new line has nothing received.
    expect((await refused('sales', 'POST', `/sales/returns/${splitRma.id}/lines/${parentId}/split`, { version: outcomes.version }, 409)).message).toBe('Every piece of line 10 arrived: there is nothing to split off.')
    expect((await refused('sales', 'POST', `/sales/returns/${splitRma.id}/lines/${childId}/split`, { version: outcomes.version }, 409)).code).toBe('invalid_state')
  })

  it('the part that arrived is decided; the rest is credited without coming back; ONE credit note credits both (lead fix F28)', async () => {
    await grade(splitRma.id, parentId)
    await ok('sales', 'POST', `/sales/returns/${splitRma.id}/decisions`, { version: await versionOf(splitRma.id), lines: [{ lineId: parentId, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] })
    expect(await lineRow(parentId)).toMatchObject({ disposition: 'CREDIT_ONLY', creditAmount: 25_000 })
    const credited = await ok('sales', 'POST', `/sales/returns/${splitRma.id}/lines/${childId}/credit-without-return`, { version: await versionOf(splitRma.id), creditAmount: 20_000, note: 'Made-up: the second jacket stays with the customer.' })
    expect(credited.credited).toBe(true)
    expect(await lineRow(childId)).toMatchObject({ disposition: 'CREDIT_ONLY', creditAmount: 20_000, creditWithoutReturn: true, receivedQuantity: 0 })
    const made = await ok('owner', 'POST', `/invoicing/returns/${splitRma.id}/credit-notes`, {}, 201)
    expect(made.notCredited).toEqual([])
    expect(made.creditNotes).toHaveLength(1)
    const lines = await admin<Json>(`SELECT "returnLineId", quantity::text AS quantity, "netAmount" FROM "InvoiceLine" WHERE "invoiceId" = $1 ORDER BY seq`, [made.creditNotes[0].id])
    // The received line credits the one piece that came; the line credited without its goods its authorised piece.
    expect(lines).toEqual([
      { returnLineId: parentId, quantity: '1.0000', netAmount: 25_000 },
      { returnLineId: childId, quantity: '1.0000', netAmount: 20_000 },
    ])
  })

  it('closes with a finish reason that fits what happened, in the same update as CLOSED (SAL-360)', async () => {
    const outcomes = await outcomesOf(splitRma.id)
    expect(outcomes.finish).toMatchObject({ held: null, suggested: 'COMPLETED', missingPieces: 0, finishReason: null })
    expect(outcomes.finish.reasons.filter((entry: Json) => entry.allowed).map((entry: Json) => entry.reason)).toEqual(['COMPLETED', 'CREDITED_WITHOUT_RETURN', 'OTHER'])
    expect(paths(await refused('sales', 'POST', `/sales/returns/${splitRma.id}/finish`, { version: outcomes.version, finishReason: 'GOODS_NOT_RECEIVED' }, 400))).toEqual(['body/finishReason'])
    expect(paths(await refused('sales', 'POST', `/sales/returns/${splitRma.id}/finish`, { version: outcomes.version, finishReason: 'OTHER', reason: '  ' }, 400))).toEqual(['body/reason'])
    expect((await refused('viewer', 'POST', `/sales/returns/${splitRma.id}/finish`, { version: outcomes.version, finishReason: 'COMPLETED' }, 403)).code).toBe('forbidden')
    const finished = await ok('sales', 'POST', `/sales/returns/${splitRma.id}/finish`, { version: outcomes.version, finishReason: 'CREDITED_WITHOUT_RETURN' })
    expect(finished.return.finish).toMatchObject({ finishReason: 'CREDITED_WITHOUT_RETURN', held: 'The return is closed already.' })
    expect(await rmaRow(splitRma.id)).toMatchObject({ status: 'CLOSED', finishReason: 'CREDITED_WITHOUT_RETURN', statusReason: 'Credited without the goods coming back' })
    expect((await events('return.finished', splitRma.id))[0]?.payload).toEqual({ returnId: splitRma.id, number: splitRma.number, finishReason: 'CREDITED_WITHOUT_RETURN', from: 'INSPECTED' })
    expect((await events('return.status_changed', splitRma.id)).at(-1)?.payload).toMatchObject({ to: 'CLOSED' })
    expect((await refused('sales', 'POST', `/sales/returns/${splitRma.id}/finish`, { version: finished.return.version, finishReason: 'COMPLETED' }, 409)).code).toBe('invalid_state')
  })
})

describe('a size exchange: the return and a replacement line in the right size (SAL-351)', () => {
  let rma: Json
  let lineId: string
  it('decides the line SIZE_EXCHANGE only with another size of the style', async () => {
    rma = await newReturn({ salesOrderLineId: RED_LINE, size: '52' }, 1, 'WRONG_SIZE')
    lineId = rma.lines[0].id
    await receive(rma.id, lineId, 1)
    // REFUSED: a received line waits for its decision before the close.
    expect((await refused('sales', 'POST', `/sales/returns/${rma.id}/finish`, { version: await versionOf(rma.id), finishReason: 'OTHER', reason: 'Made-up.' }, 409)).message).toMatch(/Decide every received line first \(line 10\)\.$/)
    await grade(rma.id, lineId, 'NEW')
    expect((await outcomesOf(rma.id)).lines[0]).toMatchObject({ size: '52', exchange: { sizes: ['50', '54'], held: null } })
    const decide = async (extra: Json, status: number) => call('sales', 'POST', `/sales/returns/${rma.id}/decisions`, { version: await versionOf(rma.id), lines: [{ lineId, disposition: 'SIZE_EXCHANGE', goodsOutcome: 'QUARANTINE', ...extra }] }).then((answer) => (expect(answer.status, JSON.stringify(answer.body)).toBe(status), answer.body))
    expect(paths((await decide({}, 400)).error)).toEqual(['body/lines/0/exchangeSize'])
    expect((await decide({ exchangeSize: '52' }, 400)).error.message).toBe('Another size than the one that came back (52).')
    expect((await decide({ exchangeSize: '58' }, 400)).error.message).toBe("Size 58 is not one of the style's sizes (50, 52, 54).")
    // A size on another disposition is refused too.
    expect((await call('sales', 'POST', `/sales/returns/${rma.id}/decisions/preview`, { lines: [{ lineId, disposition: 'REPLACE', goodsOutcome: 'QUARANTINE', exchangeSize: '54' }] })).body.problems).toEqual([{ path: 'body/lines/0/exchangeSize', message: 'Only a size exchange names another size.' }])
    const decided = await decide({ exchangeSize: '54' }, 200)
    expect(decided.return.lines[0]).toMatchObject({ disposition: 'SIZE_EXCHANGE', followUp: 'REPLACEMENT_ORDER' })
    expect(await lineRow(lineId)).toMatchObject({ disposition: 'SIZE_EXCHANGE', exchangeSize: '54', goodsOutcome: 'QUARANTINE', creditAmount: 0 })
    expect(decided.return.closeWarnings.map((warning: Json) => warning.code)).toEqual(['REPLACE_WITHOUT_ORDER'])
  })

  it('the replacement order carries the size it is exchanged for, at no price; then it closes COMPLETED', async () => {
    const made = await ok('sales', 'POST', `/sales/returns/${rma.id}/replacement-order`, { version: await versionOf(rma.id) }, 201)
    const orderLine = await one<Json>(`SELECT l.id, l.description, l."unitPrice"::text AS "unitPrice", s.size, s.quantity FROM "SalesOrderLine" l JOIN "SalesOrderLineSize" s ON s."lineId" = l.id WHERE l."orderId" = $1`, [made.order.id])
    expect(orderLine).toMatchObject({ size: '54', quantity: 1, unitPrice: '0.000000', description: `Size exchange for ${rma.number} line 10: size 54 instead of 52, ${rma.lines[0].description}` })
    expect(await lineRow(lineId)).toMatchObject({ replacementLineId: orderLine.id })
    const outcomes = await outcomesOf(rma.id)
    expect(outcomes.lines[0]).toMatchObject({ disposition: 'SIZE_EXCHANGE', exchangeSize: '54', replacementLineId: orderLine.id })
    expect(outcomes.finish.suggested).toBe('COMPLETED')
    expect((await ok('sales', 'POST', `/sales/returns/${rma.id}/finish`, { version: outcomes.version, finishReason: 'COMPLETED' })).warnings).toEqual([])
  })
})

describe('back unchanged after inspection, with the return DDT (SAL-355)', () => {
  let rma: Json
  let lineId: string
  it('decides the inspected line unchanged and issues its return DDT in one command', async () => {
    rma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    lineId = rma.lines[0].id
    await receive(rma.id, lineId, 1)
    // REFUSED: not inspected yet.
    expect((await refused('desk', 'POST', `/sales/returns/${rma.id}/send-back`, { version: await versionOf(rma.id) }, 400)).message).toBe('No line of this return may go back unchanged now.')
    await grade(rma.id, lineId, 'NEW')
    // REFUSED: the DDT needs the permission to issue DDTs; nothing was written.
    expect((await refused('sales', 'POST', `/sales/returns/${rma.id}/send-back`, { version: await versionOf(rma.id), ddt: TYPED_DDT }, 403)).message).toMatch(/shipping\.ddt\.issue/)
    expect(await lineRow(lineId)).toMatchObject({ disposition: null })
    const sent = await ok('desk', 'POST', `/sales/returns/${rma.id}/send-back`, { version: await versionOf(rma.id), note: 'Made-up: nothing wrong found.', ddt: TYPED_DDT })
    expect(sent.decidedLineIds).toEqual([lineId])
    expect(sent.ddt).toMatchObject({ number: expect.stringMatching(new RegExp(`/${YEAR}$`)) })
    expect(await lineRow(lineId)).toMatchObject({ disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER', creditAmount: 0 })
    expect(await rmaRow(rma.id)).toMatchObject({ status: 'INSPECTED' })
    const ddt = await one<Json>(`SELECT reason::text AS reason, "sourceType", "sourceId", lines FROM "Ddt" WHERE id = $1`, [sent.ddt.id])
    expect(ddt).toMatchObject({ reason: 'RETURN', sourceType: 'ReturnAuthorisation', sourceId: rma.id })
    expect((ddt.lines as Json[]).map((line) => line.sourceLineId)).toEqual([lineId])
    expect(sent.return.sendBack).toMatchObject({ allowed: false, ddts: [{ id: sent.ddt.id, number: sent.ddt.number, packages: 1, transportBy: 'SENDER', lineIds: [lineId] }] })
    expect(sent.return.lines[0].sendBack).toMatchObject({ allowed: false, ddtNumber: sent.ddt.number })
    expect((await events('return.sent_back', rma.id))[0]?.payload).toEqual({ returnId: rma.id, number: rma.number, lineIds: [lineId], decidedLineIds: [lineId], ddtId: sent.ddt.id, ddtNumber: sent.ddt.number })
    expect((await events('return.decided', rma.id)).at(-1)?.payload).toMatchObject({ lineIds: [lineId], inspected: true, moveIds: [] })
    // REFUSED: it travels back already.
    expect((await refused('desk', 'POST', `/sales/returns/${rma.id}/send-back`, { version: await versionOf(rma.id), lineIds: [lineId] }, 400)).message).toBe(`Line 10 travels back with DDT ${sent.ddt.number} already.`)
  })

  it('closes RETURNED_UNCHANGED (the reason the facts point to)', async () => {
    const outcomes = await outcomesOf(rma.id)
    expect(outcomes.finish.suggested).toBe('RETURNED_UNCHANGED')
    const finished = await ok('sales', 'POST', `/sales/returns/${rma.id}/finish`, { version: outcomes.version, finishReason: 'RETURNED_UNCHANGED', reason: 'Made-up: back to the customer, nothing wrong.' })
    expect(finished.warnings).toEqual([])
    expect(await rmaRow(rma.id)).toMatchObject({ status: 'CLOSED', finishReason: 'RETURNED_UNCHANGED', statusReason: 'Made-up: back to the customer, nothing wrong.' })
  })
})

describe('a remake asked with photos, from the office (SAL-298)', () => {
  it('marks the RMA’s line with the fit in words, once; the photos are the line’s', async () => {
    const rma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    const lineId = rma.lines[0].id
    expect((await outcomesOf(rma.id)).remake).toMatchObject({ asked: false, held: null })
    expect(paths(await refused('sales', 'POST', `/sales/returns/${rma.id}/remake`, { version: rma.version, lineIds: [lineId], fit: ' ' }, 400))).toEqual(['body/fit'])
    expect((await refused('viewer', 'POST', `/sales/returns/${rma.id}/remake`, { version: rma.version, lineIds: [lineId], fit: 'Made-up: the sleeves are 3 cm long.' }, 403)).code).toBe('forbidden')
    const asked = await ok('sales', 'POST', `/sales/returns/${rma.id}/remake`, { version: rma.version, lineIds: [lineId], fit: 'Made-up: the sleeves are 3 cm long.' })
    expect(asked.return.remake).toMatchObject({ asked: true, via: 'OFFICE', lineIds: [lineId], fit: 'Made-up: the sleeves are 3 cm long.', photos: [{ lineId, count: 0, needed: 2 }] })
    expect(asked.return.lines[0].remake).toBe(true)
    expect((await events('return.remake_asked', rma.id))[0]?.payload).toEqual({ returnId: rma.id, number: rma.number, lineIds: [lineId], via: 'OFFICE' })
    // REFUSED: asked once per return.
    expect((await refused('sales', 'POST', `/sales/returns/${rma.id}/remake`, { version: asked.return.version, lineIds: [lineId], fit: 'Made-up: again.' }, 409)).message).toBe('A remake was asked on this return already.')
    // The customer changed their mind: closed before the goods came (the facts' reason is offered with the others).
    const outcomes = await outcomesOf(rma.id)
    expect(outcomes.finish.reasons.find((entry: Json) => entry.reason === 'COMPLETED')).toMatchObject({ allowed: false })
    await ok('sales', 'POST', `/sales/returns/${rma.id}/finish`, { version: outcomes.version, finishReason: 'CUSTOMER_WITHDREW' })
    expect(await rmaRow(rma.id)).toMatchObject({ status: 'CLOSED', finishReason: 'CUSTOMER_WITHDREW' })
  })

  it('the database keeps a finish reason off a return that is not closed (every login)', async () => {
    const rma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    await expect(admin(`UPDATE "ReturnAuthorisation" SET "finishReason" = 'OTHER' WHERE id = $1`, [rma.id])).rejects.toThrow(/finish/i)
    await ok('sales', 'POST', `/sales/returns/${rma.id}/cancel`, { version: rma.version, reason: 'Made-up: not needed.' })
  })
})
