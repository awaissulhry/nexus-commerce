import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedHealth } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * PPE for workers (B-W2b-134; QHS-259, QHS-260, QHS-261) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime logins: row-level security and the PPE guards are real: an issue is append-only, a FLOOR_PIN receipt
 * only from a floor session with the person's own worker, a paper one only from the office, a void once), the real app. Tenant
 * A from the factory-db seeds: A1's Cutter (E1: gloves ×2, ear defenders, shoes), Machinist (E2, E3: shoes), B1's Machinist B
 * (EB1: apron); E1's gloves signed by PIN, E2's wrong shoes voided and replaced on paper (scan on file), EB1's apron on paper
 * (no scan). A real tablet at A1 with E2 (the team leader) signed in; E1 receives with their own PIN. Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/safety/ppe`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let people: PeopleSeed
let tablet: Browser

const NS = 'w2b134-ppe'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1'), e1Worker: idOf('worker:A1:operator'), e2Worker: idOf('worker:A1:lead') }
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const PIN = '482913'
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const OFFICER: Permission[] = ['safety.view', 'safety.ppe.manage', 'safety.ppe.issue', 'files.upload']
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER)] },
  costs: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant([...OFFICER, 'money.cost'])] },
  hr: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view', 'people.employees.manage', 'people.leavers.manage', 'safety.view', 'safety.ppe.issue'])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `ppe-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const floorPost = (url: string, body: unknown, idempotencyKey: string | null = key()) => tablet.post(url, body, idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {})
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const gapOf = (gaps: Json, employeeId: string) => gaps.people.find((row: Json) => row.employee.id === employeeId)

beforeAll(async () => {
  h = await startHarness('w2b134_ppe')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedHealth({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // A real tablet at A1 (the floor's own sign-in): E2's worker (the team leader) signed in; E1 and E2 have a known PIN.
  const pinHash = await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })
  await admin('UPDATE "Worker" SET "pinHash" = $2, "failedPinAttempts" = 0, "pinLockedUntil" = NULL WHERE id = ANY($1::uuid[])', [[T.e1Worker, T.e2Worker], pinHash])
  const owner = await addUser(h, TENANT, { email: `owner-${newId().slice(-6)}@example.test`, role: 'owner' })
  const office = new Browser(h.app)
  const signed = await office.signIn(TENANT.slug, owner.email, owner.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  await stepUp(h, office, await enrolTotp(h, office))
  const made = await office.post('/auth/floor/devices', { siteId: T.siteA1, name: 'Made-up PPE tablet' })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  tablet = new Browser(h.app)
  await tablet.get('/auth/csrf')
  const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  const signIn = await tablet.post('/floor/sign-in', { workerId: T.e2Worker, pin: PIN })
  if (signIn.status !== 200) throw new Error(`floor sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the catalogue (QHS-259; design plant.ppe "Catalogue", "PPE item")', () => {
  it('lists the company’s items; the unit cost only with the cost grain; another company’s items stay out', async () => {
    const list = await ok('officer', 'GET', '/safety/ppe/items')
    expect(list).toMatchObject({ canAdd: true, complete: true, law: { catalogue: 'D.Lgs. 81/2008 art. 77 c.1', receipt: 'D.Lgs. 81/2008 art. 77 c.4' } })
    const gloves = list.items.find((item: Json) => item.code === 'SEED-PPE-GLOVES-CUT')
    expect(gloves).toMatchObject({ category: 'CATEGORY_II', standard: 'EN 388:2016', sizes: ['7', '8', '9', '10'], lifeMonths: 6, inKits: 1, canManage: true })
    expect(gloves).not.toHaveProperty('unitCost')
    expect(gloves.supplier).not.toBeNull()
    expect((await ok('costs', 'GET', '/safety/ppe/items')).items.find((item: Json) => item.code === 'SEED-PPE-GLOVES-CUT').unitCost).toBe(850)
    expect((await ok('companyB', 'GET', '/safety/ppe/items')).items.map((item: Json) => item.code)).toEqual(['SEED-PPE-APRON-B'])
    expect((await ok('viewer', 'GET', '/safety/ppe/items')).canAdd).toBe(false)
    expect((await call('sales', 'GET', '/safety/ppe/items')).statusCode).toBe(403)
    const record = await ok('viewer', 'GET', `/safety/ppe/items/${safety.ppeItemIds.shoes}`)
    expect(record.kits.map((kit: Json) => [kit.code, kit.whenToWear]).sort()).toEqual([
      ['CUT', 'Always on the floor'],
      ['SEW', 'Always on the floor'],
    ])
  })

  it('adds an item (code in capitals, sizes each once), refuses a taken code, a cost without the grain; edits at its version', async () => {
    const added = await ok('officer', 'POST', '/safety/ppe/items', { companyId: T.companyA, code: 'glasses-a', name: 'Made-up glasses', category: 'CATEGORY_II', standard: 'EN 166:2001', sizes: [' S', 'M'], lifeMonths: 12 }, 201)
    expect(added.item).toMatchObject({ code: 'GLASSES-A', sizes: ['S', 'M'], status: 'ACTIVE', version: 1, inKits: 0 })
    expect(await no('officer', 'POST', '/safety/ppe/items', { companyId: T.companyA, code: 'GLASSES-A', name: 'Again', category: 'CATEGORY_I' }, 409)).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect((await call('officer', 'POST', '/safety/ppe/items', { companyId: T.companyA, code: 'COSTLY', name: 'Costly', category: 'CATEGORY_I', unitCost: 100 })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/safety/ppe/items', { companyId: T.companyA, code: 'NOPE', name: 'Nope', category: 'CATEGORY_I' })).statusCode).toBe(403)
    const edited = await ok('costs', 'PATCH', `/safety/ppe/items/${added.item.id}`, { version: 1, name: 'Made-up safety glasses', unitCost: 420 })
    expect(edited).toMatchObject({ changed: true, item: { name: 'Made-up safety glasses', unitCost: 420, version: 2 } })
    expect((await ok('officer', 'PATCH', `/safety/ppe/items/${added.item.id}`, { version: 2, name: 'Made-up safety glasses' })).changed).toBe(false)
    await no('officer', 'PATCH', `/safety/ppe/items/${added.item.id}`, { version: 1, name: 'Late' }, 409)
    expect(await no('officer', 'PATCH', `/safety/ppe/items/${added.item.id}`, { version: 2, sizes: ['S', 's'] }, 400)).toEqual(['body/sizes'])
    // Archive: refused while a kit names it (the gloves are the Cutter's), done for an item no kit names, then restored.
    expect((await no('officer', 'POST', `/safety/ppe/items/${safety.ppeItemIds.gloves}/archive`, { version: 1 }, 409))[0]).toBe('refusal/IN_KIT')
    expect((await ok('officer', 'POST', `/safety/ppe/items/${added.item.id}/archive`, { version: 2 })).item.status).toBe('ARCHIVED')
    expect((await ok('officer', 'POST', `/safety/ppe/items/${added.item.id}/restore`, { version: 3 })).item.status).toBe('ACTIVE')
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'safety.editPpeItem' AND "recordId" = $1 AND after ? 'unitCost' ORDER BY at`, [added.item.id])
    expect(audit[0]!.after.unitCost).toMatchObject({ $money: 'cost', value: 420 })
  })

  it('starts from the common items the company has none of (a code another company holds gets the company’s code)', async () => {
    const first = await ok('officer', 'POST', '/safety/ppe/items/common', { companyId: T.companyB, codes: ['GLOVES-CUT', 'APRON'] })
    expect(first.items.map((item: Json) => item.code).sort()).toEqual(['APRON', 'GLOVES-CUT'])
    const again = await ok('officer', 'POST', '/safety/ppe/items/common', { companyId: T.companyB, codes: ['GLOVES-CUT'] })
    expect(again).toMatchObject({ added: 0, skipped: ['GLOVES-CUT'] })
    const forA = await ok('officer', 'POST', '/safety/ppe/items/common', { companyId: T.companyA, codes: ['APRON'] })
    const codeA = (await admin<{ code: string }>('SELECT code FROM "Company" WHERE id = $1::uuid', [T.companyA]))[0]!.code
    expect(forA.items.map((item: Json) => item.code)).toEqual([`APRON-${codeA.toUpperCase()}`])
    expect((await eventsOf('ppe_item.changed')).length).toBeGreaterThanOrEqual(6)
  })
})

describe('kits and gaps (QHS-260; design plant.ppe "Kits per role", "Gaps per person", tiles)', () => {
  it('kits per role: roles × items with when to wear them (read from the role sheets)', async () => {
    const kits = await ok('viewer', 'GET', `/safety/ppe/kits?siteId=${T.siteA1}`)
    const cut = kits.roles.find((role: Json) => role.code === 'CUT')
    expect(cut).toMatchObject({ people: 1 })
    expect(kits.cells.filter((cell: Json) => cell.roleSheetId === cut.id).map((cell: Json) => [kits.items.find((item: Json) => item.id === cell.ppeItemId).code, cell.quantity, cell.whenToWear])).toEqual([
      ['SEED-PPE-GLOVES-CUT', 2, 'At the cutting table'],
      ['SEED-PPE-EAR-DEF', 1, 'At the clicking press'],
      ['SEED-PPE-SHOES', 1, 'Always on the floor'],
    ])
  })

  it('who lacks what: E1 misses the ear defenders and shoes, E3 the shoes; E2 holds the replaced shoes; counts', async () => {
    const gaps = await ok('viewer', 'GET', '/safety/ppe/gaps')
    expect(gaps.body ?? '').not.toMatch(/unitCost/)
    const e1 = gapOf(gaps, people.employeeIds.e1)
    expect(e1).toMatchObject({ role: { code: 'CUT' }, missing: 2 })
    expect(e1.lines.map((line: Json) => [line.item.code, line.held, line.missing])).toEqual([
      ['SEED-PPE-EAR-DEF', 0, 1],
      ['SEED-PPE-SHOES', 0, 1],
    ])
    expect(gapOf(gaps, people.employeeIds.e3).lines.map((line: Json) => line.item.code)).toEqual(['SEED-PPE-SHOES'])
    expect(gapOf(gaps, people.employeeIds.e2)).toBeUndefined()
    const all = await ok('viewer', 'GET', `/safety/ppe/gaps?view=all&siteId=${T.siteA1}`)
    expect(gapOf(all, people.employeeIds.e2).lines[0]).toMatchObject({ held: 1, missing: 0 })
    expect(all.withoutRole).toBeGreaterThanOrEqual(1)
    const counts = await ok('viewer', 'GET', '/safety/ppe/counts')
    expect(counts).toMatchObject({ peopleMissingKit: 2, receiptsNotSigned: 1, itemsBelowMinimum: null, today })
    expect((await ok('companyB', 'GET', '/safety/ppe/counts')).peopleMissingKit).toBe(0)
  })
})

let paperReceipt = ''
let shoesLine = ''

describe('issue on paper and void (QHS-261; design plant.ppe "Issue PPE", "Issues and receipts", "Void an issue")', () => {
  it('records the paper receipt (one receipt for the lines), refuses a size the item has not, another company’s item, a future date', async () => {
    const lines = [
      { ppeItemId: safety.ppeItemIds.earDefenders, quantity: 1, reason: 'NEW' },
      { ppeItemId: safety.ppeItemIds.shoes, size: '41', quantity: 1, reason: 'NEW' },
    ]
    expect(await no('officer', 'POST', '/safety/ppe/issues', { employeeId: people.employeeIds.e1, lines: [{ ...lines[1], size: '50' }] }, 400)).toEqual(['body/lines/0/size'])
    expect(await no('officer', 'POST', '/safety/ppe/issues', { employeeId: people.employeeIds.e1, lines: [{ ppeItemId: safety.ppeItemIds.apron, size: 'M', quantity: 1, reason: 'NEW' }] }, 400)).toEqual(['body/lines/0/ppeItemId'])
    expect(await no('officer', 'POST', '/safety/ppe/issues', { employeeId: people.employeeIds.e1, lines, issuedAt: new Date(Date.now() + 86_400_000).toISOString() }, 409)).toEqual(['refusal/IN_FUTURE', 'body/issuedAt'])
    expect((await call('viewer', 'POST', '/safety/ppe/issues', { employeeId: people.employeeIds.e1, lines })).statusCode).toBe(403)
    const answer = await ok('officer', 'POST', '/safety/ppe/issues', { employeeId: people.employeeIds.e1, lines }, 201)
    paperReceipt = answer.receipt.id
    expect(answer.scan).toEqual({ recordType: 'PpeIssue', recordId: paperReceipt, companyId: T.companyA })
    expect(answer.receipt).toMatchObject({ method: 'PAPER', state: 'NOT_SIGNED', units: 2, issuedBy: { kind: 'USER' }, signature: null, scan: null })
    expect(answer.receipt.lines.map((line: Json) => [line.item.code, line.size, line.receiptId])).toEqual([
      ['SEED-PPE-EAR-DEF', null, paperReceipt],
      ['SEED-PPE-SHOES', '41', paperReceipt],
    ])
    shoesLine = answer.receipt.lines[1].id
    expect((await ok('viewer', 'GET', '/safety/ppe/counts')).receiptsNotSigned).toBe(2)
    expect(gapOf(await ok('viewer', 'GET', '/safety/ppe/gaps'), people.employeeIds.e1)).toBeUndefined()
    const [event] = await eventsOf('ppe.issued')
    expect(event).toMatchObject({ receiptId: paperReceipt, employeeId: people.employeeIds.e1, units: 2, method: 'PAPER', via: 'OFFICE' })
    expect(JSON.stringify(event)).not.toMatch(/Seed|Made-up|"41"|size/)
    // The scan uploaded as a file of the receipt (here: a copy of a seeded file row) signs it.
    await admin(
      `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "scanStatus", "availableAt", "retainUntil", "createdAt", "updatedAt")
       SELECT $1::uuid, "tenantId", "companyId", 'PpeIssue', $2::uuid, kind, 'Made-up signed receipt.pdf', "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey" || '-copy', status, visibility, "scanStatus", "availableAt", "retainUntil", now(), now()
         FROM "StoredFile" WHERE "recordType" = 'PpeIssue' AND "originalName" = 'Seed signed PPE receipt.pdf' LIMIT 1`,
      [newId(), paperReceipt],
    )
    const record = await ok('viewer', 'GET', `/safety/ppe/receipts/${shoesLine}`)
    expect(record).toMatchObject({ receipt: { id: paperReceipt, state: 'SIGNED_PAPER', scan: { name: 'Made-up signed receipt.pdf' } }, statement: null, verified: false })
    expect((await ok('viewer', 'GET', '/safety/ppe/counts')).receiptsNotSigned).toBe(1)
  })

  it('voids a wrong line with the reason (once); the receipt stays with the void mark; the gap is back', async () => {
    const voided = await ok('officer', 'POST', `/safety/ppe/issues/${shoesLine}/void`, { reason: 'Wrong size: 42 instead (made-up).' })
    const line = voided.receipt.lines.find((entry: Json) => entry.id === shoesLine)
    expect(line.voided).toMatchObject({ reason: 'Wrong size: 42 instead (made-up).' })
    expect(line.canVoid).toBe(false)
    expect(voided.receipt).toMatchObject({ id: paperReceipt, state: 'SIGNED_PAPER', units: 1 })
    expect(await no('officer', 'POST', `/safety/ppe/issues/${shoesLine}/void`, { reason: 'Again' }, 409)).toEqual(['refusal/VOIDED_ALREADY'])
    expect(await no('officer', 'POST', `/safety/ppe/issues/${line.voided.voidId}/void`, { reason: 'A void' }, 409)).toEqual(['refusal/NOT_AN_ISSUE'])
    expect(gapOf(await ok('viewer', 'GET', '/safety/ppe/gaps'), people.employeeIds.e1).lines.map((entry: Json) => entry.item.code)).toEqual(['SEED-PPE-SHOES'])
    const issues = await ok('viewer', 'GET', `/safety/ppe/issues?employeeId=${people.employeeIds.e1}&view=voided`)
    expect(issues.issues.map((entry: Json) => entry.id)).toEqual([shoesLine])
    // A filter that holds some of a receipt's lines still names the whole receipt (its id, scan and state).
    expect(issues.issues[0].receipt).toMatchObject({ id: paperReceipt, state: 'SIGNED_PAPER' })
    const shoes = await ok('viewer', 'GET', `/safety/ppe/issues?ppeItemId=${safety.ppeItemIds.shoes}&employeeId=${people.employeeIds.e1}`)
    expect(shoes.issues.map((entry: Json) => [entry.id, entry.receipt.id])).toEqual([[shoesLine, paperReceipt]])
    expect(await eventsOf('ppe_issue.voided')).toEqual([{ issueId: shoesLine, voidId: line.voided.voidId, receiptId: paperReceipt, employeeId: people.employeeIds.e1 }])
    // The register is append-only for every login: the database refuses changing an issue.
    await expect(admin('UPDATE "PpeIssue" SET quantity = 2 WHERE id = $1::uuid', [shoesLine])).rejects.toThrow(/never changed/)
  })
})

describe('receive PPE on the floor (QHS-261; design floor.training "Receive PPE": badge → items → the person’s PIN)', () => {
  let floorReceipt = ''

  it('the tablet shows who receives and their missing kit, the items without a cost', async () => {
    const items = await tablet.get('/safety/floor/ppe/items')
    expect(items.status, JSON.stringify(items.body)).toBe(200)
    expect(JSON.stringify(items.body)).not.toMatch(/unitCost|supplier/)
    expect(items.body.items.map((item: Json) => item.code)).toContain('SEED-PPE-SHOES')
    const person = await floorPost('/safety/floor/ppe/person', { workerId: T.e1Worker }, null)
    expect(person.status, JSON.stringify(person.body)).toBe(200)
    expect(person.body).toMatchObject({ role: { code: 'CUT' } })
    expect(person.body.kit.find((line: Json) => line.ppeItemId === safety.ppeItemIds.shoes)).toMatchObject({ held: 0, missing: 1 })
  })

  it('a wrong PIN counts on the person; their own PIN signs: one FLOOR_PIN receipt handed over by the team leader', async () => {
    const lines = [{ ppeItemId: safety.ppeItemIds.shoes, size: '42', quantity: 1, reason: 'NEW' }]
    expect((await floorPost('/safety/floor/ppe/receive', { workerId: T.e1Worker, pin: '000000', lines })).status).toBe(401)
    expect((await admin<{ failedPinAttempts: number }>('SELECT "failedPinAttempts" FROM "Worker" WHERE id = $1::uuid', [T.e1Worker]))[0]!.failedPinAttempts).toBe(1)
    expect((await floorPost('/safety/floor/ppe/receive', { workerId: T.e1Worker, pin: PIN, lines }, null)).status).toBe(400)
    const bad = await floorPost('/safety/floor/ppe/receive', { workerId: T.e1Worker, pin: PIN, lines: [{ ...lines[0], size: '50' }] })
    expect(bad.status).toBe(400)
    const signed = await floorPost('/safety/floor/ppe/receive', { workerId: T.e1Worker, pin: PIN, lines })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    floorReceipt = signed.body.receipt.id
    expect(signed.body.receipt).toMatchObject({ units: 1, worker: { id: T.e1Worker }, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const [row] = await admin<Json>('SELECT method::text AS method, "signedByWorkerId"::text AS signer, "issuedByWorkerId"::text AS giver, "issuedById", "clientEventId", "signatureSha256" FROM "PpeIssue" WHERE id = $1::uuid', [floorReceipt])
    expect(row).toMatchObject({ method: 'FLOOR_PIN', signer: T.e1Worker, giver: T.e2Worker, issuedById: null, signatureSha256: signed.body.receipt.sha256 })
    expect(row!.clientEventId).toMatch(/\.1$/)
    expect((await admin<{ failedPinAttempts: number }>('SELECT "failedPinAttempts" FROM "Worker" WHERE id = $1::uuid', [T.e1Worker]))[0]!.failedPinAttempts).toBe(0)
    // The office reads it: verified (the SHA-256 is of exactly these lines in the person's language), the giver behind the gate.
    const record = await ok('viewer', 'GET', `/safety/ppe/receipts/${floorReceipt}`)
    expect(record).toMatchObject({ verified: true, receipt: { method: 'FLOOR_PIN', state: 'SIGNED_PIN', issuedBy: { kind: 'WORKER', hidden: true, name: null }, signature: { workerId: T.e1Worker } } })
    expect(record.statement).toMatch(/Ho ricevuto/)
    expect(gapOf(await ok('viewer', 'GET', '/safety/ppe/gaps'), people.employeeIds.e1)).toBeUndefined()
    expect((await eventsOf('ppe.issued')).at(-1)).toMatchObject({ receiptId: floorReceipt, method: 'FLOOR_PIN', via: 'FLOOR' })
  })

  it('the receipt as a PDF; kept once for a PIN receipt (the same contents: the same document), never for a paper one', async () => {
    const pdf = await call('viewer', 'GET', `/safety/ppe/receipts/${floorReceipt}/pdf?language=en`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/)
    const kept = await ok('officer', 'POST', `/safety/ppe/receipts/${floorReceipt}/pdf`, {})
    expect(kept).toMatchObject({ made: true, document: { version: 1, language: 'it' } })
    expect((await ok('officer', 'POST', `/safety/ppe/receipts/${floorReceipt}/pdf`, {})).made).toBe(false)
    expect(await no('officer', 'POST', `/safety/ppe/receipts/${paperReceipt}/pdf`, {}, 409)).toEqual(['refusal/PAPER_RECEIPT'])
    expect((await ok('viewer', 'GET', `/safety/ppe/receipts/${floorReceipt}`)).receipt.document).toMatchObject({ version: 1 })
    // The kept PDF is no paper scan: the paper count is unchanged.
    expect((await ok('viewer', 'GET', '/safety/ppe/counts')).receiptsNotSigned).toBe(1)
  })

  it('the person’s PPE card: their kit, every receipt with its void marks', async () => {
    const card = await ok('viewer', 'GET', `/safety/ppe/people/${people.employeeIds.e1}`)
    expect(card).toMatchObject({ employee: { id: people.employeeIds.e1 }, role: { code: 'CUT' }, returned: null })
    expect(card.kit.every((line: Json) => line.missing === 0)).toBe(true)
    expect(card.receipts.map((receipt: Json) => receipt.method)).toEqual(['FLOOR_PIN', 'PAPER', 'FLOOR_PIN'])
  })
})

describe('the leaver step "PPE returned" links to the issue (B-W2b-26)', () => {
  it('lists what the person holds; done naming one of their issues, never a voided one', async () => {
    const started = await ok('hr', 'POST', `/people/employees/${people.employeeIds.e2}/leaving`, { lastWorkingDay: addDays(today, 20), ppeReturn: true }, 201)
    const caseId = started.leaver.id
    const held = await ok('hr', 'GET', `/people/leavers/${caseId}/ppe`)
    expect(held.held.map((entry: Json) => [entry.code, entry.units])).toEqual([['SEED-PPE-SHOES', 1]])
    expect(held.step).toMatchObject({ status: 'OPEN' })
    expect(held.canManage).toBe(true)
    const step = held.step
    expect(await no('hr', 'POST', `/people/leavers/${caseId}/steps/${step.id}/ppe-returned`, { version: step.version, issueId: safety.issueIds.e2Voided }, 409)).toEqual(['refusal/NOT_HELD', 'body/issueId'])
    const other = started.leaver.steps.find((entry: Json) => entry.kind !== 'PPE_RETURNED')
    expect((await no('hr', 'POST', `/people/leavers/${caseId}/steps/${other.id}/ppe-returned`, { version: other.version, issueId: held.held[0].issueIds[0] }, 409))[0]).toBe('refusal/NOT_PPE_STEP')
    const done = await ok('hr', 'POST', `/people/leavers/${caseId}/steps/${step.id}/ppe-returned`, { version: step.version, issueId: held.held[0].issueIds[0] })
    expect(done.leaver.steps.find((entry: Json) => entry.id === step.id)).toMatchObject({ status: 'DONE', recordType: 'PpeIssue', recordId: held.held[0].issueIds[0] })
    expect((await ok('viewer', 'GET', `/safety/ppe/people/${people.employeeIds.e2}`)).returned).toMatchObject({ caseId, status: 'DONE', issueId: held.held[0].issueIds[0] })
    expect((await call('viewer', 'POST', `/people/leavers/${caseId}/steps/${step.id}/ppe-returned`, { version: 2, issueId: held.held[0].issueIds[0] })).statusCode).toBe(403)
  })
})
