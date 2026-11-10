import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { completenessOf, type GateItem } from '@nexus/factory-domain/product/release/gate'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedChanges } from '../../../../../../packages/factory-db/seed/changes'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The release gate (B-W2b-231; PRD-190, PRD-191, PRD-197, PRD-232) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and StyleRevision_w2b4_release_scope are real), on the
 * seeds up to the change orders, the measurement specs, the product types and the SMV versions: SEED-JKT-01 revision 1 (DRAFT;
 * label active, certificate cover, a measurement spec not approved, the "Jacket" type requiring gender, HS code and origin, an
 * SMV change waiting) ordered in SEED-SO-0001 (BLK and RED lines in 50–54). Every code and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/release`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'w2b231-release'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')

const OFFICE = [
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'product.routing.view',
  'product.styles.view',
  'product.styles.manage',
  'quotes.view',
  'orders.view',
  'workorders.view',
  'workorders.manage',
  'audit.read',
] as Permission[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(OFFICE),
  // Sees styles, not their BOM: the list's summary and the readers' scope, never the gate's detail.
  sales: office(['product.styles.view', 'quotes.view'] as Permission[]),
  // Reads the BOM and the gate; does not release.
  viewer: office(['product.bom.view', 'product.styles.view'] as Permission[]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `r-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

const one = async <Row = Json>(sql: string, values: unknown[]): Promise<Row> => (await admin<Row>(sql, values))[0]!
const revisionRow = (styleId: string, revision: number) =>
  one<{ id: string; version: number; status: string; releasedColourwayIds: string[]; releasedSizes: string[]; completenessPct: string | null }>(
    'SELECT id, version, status::text AS status, "releasedColourwayIds"::text[] AS "releasedColourwayIds", "releasedSizes", "completenessPct"::text AS "completenessPct" FROM "StyleRevision" WHERE "styleId" = $1 AND revision = $2',
    [styleId, revision],
  )
const eventsOf = (subject: string, type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])
const stateOf = (gate: Json, code: string): string => gate.items.find((item: Json) => item.code === code).state

let jacket = ''
let blk = ''
let red = ''
const gateUrl = (revisionId: string, query = '') => `/product/styles/${jacket}/revisions/${revisionId}/release-gate${query}`
const scopeUrl = (revisionId: string) => `/product/styles/${jacket}/revisions/${revisionId}/release-scope`

beforeAll(async () => {
  db = await migratedDatabase('release_gate')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedInstructions({ db: database, namespace: NS })
  await seedSizesDepth({ db: database, namespace: NS })
  await seedStylesDepth({ db: database, namespace: NS })
  await seedChanges({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  jacket = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
  blk = (await one<{ id: string }>('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket, 'BLK'])).id
  red = (await one<{ id: string }>('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket, 'RED'])).id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the release gate of a draft (PRD-190, PRD-232)', () => {
  it('answers every item with its words and "Fix", and a completeness score from the same list', async () => {
    const rev1 = await revisionRow(jacket, 1)
    const { gate } = await ok('viewer', 'GET', gateUrl(rev1.id))
    expect(gate).toMatchObject({ checked: true, releasable: true, heldBy: null, mayRelease: false, revision: { revision: 1, status: 'DRAFT' }, style: { code: 'SEED-JKT-01' } })
    expect(gate.items.map((item: Json) => item.code)).toEqual(['BOM', 'ROUTING', 'SMV', 'MATERIALS', 'PRICES', 'LABEL', 'CERTIFICATE', 'MEASUREMENTS', 'ATTRIBUTES', 'CHANGE_ORDERS', 'SCOPE', 'DRIFT'])
    expect(['BOM', 'ROUTING', 'LABEL', 'CERTIFICATE', 'CHANGE_ORDERS', 'SCOPE'].map((code) => stateOf(gate, code))).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'OK'])
    expect([stateOf(gate, 'MEASUREMENTS'), stateOf(gate, 'ATTRIBUTES'), stateOf(gate, 'DRIFT')]).toEqual(['WARNING', 'WARNING', 'NOT_REQUIRED'])
    expect(gate.items.find((item: Json) => item.code === 'ATTRIBUTES')).toMatchObject({ fix: 'type', message: "Product type SEED-PT-JKT requires gender, HS code, country of origin: fill them in the style's details." })
    expect(gate.items.find((item: Json) => item.code === 'MEASUREMENTS').findings.map((finding: Json) => finding.code)).toEqual(['SPEC_NOT_APPROVED'])
    // The score is the share of the scored items that are done.
    expect(gate.completenessPct).toBe(completenessOf(gate.items as GateItem[]))
    expect(Number(gate.completenessPct)).toBeLessThan(100)
    expect(gate.effects).toEqual(["Revision 1 becomes the style's current revision: every new work order uses it.", 'The style becomes active: it can be sold.'])
    expect(gate.scope).toMatchObject({ planned: { whole: true, words: 'every colourway and size' }, waiting: null })
    // Who may not read a BOM does not read its gate either; the styles list's summary is theirs (item words, no finding).
    await no('sales', 'GET', gateUrl(rev1.id), undefined, 403)
    const jacket2 = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])).id
    const summary = await ok('sales', 'GET', `/product/release-gate?styleIds=${jacket},${jacket2}`)
    expect(summary.styles.map((row: Json) => [row.code, row.revision?.status ?? null, row.checked, row.completenessPct])).toEqual([
      ['SEED-JKT-01', 'DRAFT', true, gate.completenessPct],
      ['SEED-JKT-02', 'RELEASED', false, null],
    ])
    expect(summary.styles[0]).toMatchObject({ blockers: 0, warnings: gate.warnings.length, first: { state: 'WARNING', fix: expect.any(String) } })
    expect(Object.keys(summary.styles[0])).not.toContain('items')
  })

  it('previews "Release only some colourways or sizes" and refuses a scope that cannot be made, in words', async () => {
    const rev1 = await revisionRow(jacket, 1)
    let { gate } = await ok('manager', 'GET', gateUrl(rev1.id, `?colourwayIds=${blk}&sizes=50,52`))
    expect(gate.scope.asked).toMatchObject({ colourwayIds: [blk], sizes: ['50', '52'], whole: false, words: 'BLK in 50, 52' })
    expect(gate.scope.waiting).toBe('RED and size 54')
    expect(gate.items.find((item: Json) => item.code === 'CERTIFICATE').message).toContain('(2 cells)')
    expect(gate.mayRelease).toBe(true)
    gate = (await ok('manager', 'GET', gateUrl(rev1.id, '?sizes=50,58'))).gate
    expect(gate).toMatchObject({ releasable: false, heldBy: "Size 58 is not in the style's range (50–54)." })
    expect(gate.blockers.map((blocker: Json) => [blocker.code, blocker.cell.field])).toEqual([['SCOPE_SIZE_OUTSIDE', 'sizes/1']])
  })
})

describe('release only some colourways or sizes (PRD-191), the release event (PRD-197)', () => {
  it('plans the scope on the draft; the release keeps it, stores the score and says both in style.revision_released', async () => {
    let rev1 = await revisionRow(jacket, 1)
    let error = await no('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [blk], sizes: ['50', '58'] }, 400)
    expect(error.issues).toEqual([{ path: 'body/sizes/1', message: "Size 58 is not in the style's range (50–54)." }])
    error = await no('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version + 7, colourwayIds: [blk], sizes: ['50', '52'] }, 409)
    await no('viewer', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [blk], sizes: ['50', '52'] }, 403)

    const { gate: planned } = await ok('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [blk], sizes: ['52', '50'] })
    expect(planned.scope.planned).toMatchObject({ colourwayIds: [blk], sizes: ['50', '52'], words: 'BLK in 50, 52' })
    expect(planned.effects.at(-1)).toBe('It is released for BLK in 50, 52; RED and size 54 wait for a later release of revision 1.')
    rev1 = await revisionRow(jacket, 1)
    expect(rev1).toMatchObject({ status: 'DRAFT', releasedColourwayIds: [blk], releasedSizes: ['50', '52'], completenessPct: null })
    expect((await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [rev1.id, 'product.release.planScope'])).length).toBe(1)

    // W1's release route asks the same gate: the draft's scope is released with it, the score stored once.
    const released = (await ok('manager', 'POST', `/product/styles/${jacket}/revisions/${rev1.id}/release`, { version: rev1.version })).bom
    expect(released.revision.status).toBe('RELEASED')
    const row = await revisionRow(jacket, 1)
    expect(row).toMatchObject({ releasedColourwayIds: [blk], releasedSizes: ['50', '52'] })
    expect(row.completenessPct).not.toBeNull()
    expect(Number(row.completenessPct)).toBe(Number(planned.completenessPct))
    const events = await eventsOf(jacket, 'style.revision_released')
    expect(events.at(-1)!.payload).toMatchObject({ revisionId: rev1.id, revision: 1, obsoletedRevisionId: null, releasedColourwayIds: [blk], releasedSizes: ['50', '52'], widened: false })
    expect(Number(events.at(-1)!.payload.completenessPct)).toBe(Number(row.completenessPct))
    const audit = await one<{ after: Json }>('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [rev1.id, 'product.release.gate'])
    expect(audit.after).toMatchObject({ revision: 1, releasedColourwayIds: [blk], releasedSizes: ['50', '52'] })
    expect(audit.after.warnings.map((warning: Json) => warning.code)).toEqual(expect.arrayContaining(['SPEC_NOT_APPROVED', 'ATTRIBUTE_MISSING']))

    // The frozen revision's gate: its stored score and what it is released for; not checked again.
    const { gate } = await ok('viewer', 'GET', gateUrl(rev1.id))
    expect(gate).toMatchObject({ checked: false, releasable: false, completenessPct: planned.completenessPct, scope: { planned: { words: 'BLK in 50, 52' } } })
    expect(gate.items.map((item: Json) => item.code)).toEqual(['SCOPE', 'CERTIFICATE'])
  })

  it('the readers see what is released; a work order of a cell that waits is refused at its release check, in words', async () => {
    const { released } = await ok('sales', 'GET', `/product/styles/${jacket}/release-scope`)
    expect(released).toMatchObject({ revision: { revision: 1 }, scope: { words: 'BLK in 50, 52', whole: false }, waiting: 'RED and size 54' })
    expect(released.cells.map((cell: Json) => `${cell.colourway} ${cell.size}`)).toEqual(['BLK 50', 'BLK 52'])

    // The styles list's column: the released revision with its score at release (sales reads it, without the BOM).
    const summary = await ok('sales', 'GET', `/product/release-gate?styleIds=${jacket}`)
    expect(summary.styles.map((row: Json) => [row.code, row.revision?.status ?? null, row.checked])).toEqual([['SEED-JKT-01', 'RELEASED', false]])
    expect(Number(summary.styles[0].completenessPct)).toBe(Number((await revisionRow(jacket, 1)).completenessPct))

    // SEED-SO-0001's RED line (50, 52, 54) on a work order of revision 1: CELLS refuses every RED cell (not released yet).
    const redLine = await one<{ id: string }>(
      'SELECT l.id FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = $2 AND l."colourwayId" = $3',
      [T, 'SEED-SO-0001', red],
    )
    const { workOrder } = await ok('manager', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: redLine.id }] }, 201)
    let check = await ok('manager', 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    const cells = (answer: Json) => answer.checks.find((entry: Json) => entry.code === 'CELLS')
    expect(cells(check)).toMatchObject({ state: 'BLOCKED', message: expect.stringContaining('not released yet: revision 1 is released for BLK in 50, 52 only.') })
    expect(cells(check).problems.map((problem: Json) => problem.path.endsWith('/scope'))).toEqual([true, true, true])

    // A later release of the same revision for every colourway and size (PRD-191): the work order's cells pass.
    const rev1 = await revisionRow(jacket, 1)
    let error = await no('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [red], sizes: ['50', '52'] }, 400)
    expect(error.issues[0]).toEqual({ path: 'body/colourwayIds', message: 'Revision 1 is released for BLK in 50, 52: a later release only adds colourways or sizes, so BLK stays released.' })
    error = await no('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [blk], sizes: ['50', '52'] }, 400)
    expect(error.issues[0].message).toBe('Revision 1 is released for BLK in 50, 52 already: add a colourway or a size, or release it for all of them.')
    const { gate } = await ok('manager', 'PUT', scopeUrl(rev1.id), { version: rev1.version, colourwayIds: [], sizes: [] })
    expect(gate.scope.planned).toMatchObject({ whole: true })
    const widened = await revisionRow(jacket, 1)
    expect(widened).toMatchObject({ status: 'RELEASED', releasedColourwayIds: [], releasedSizes: [], completenessPct: rev1.completenessPct })
    expect((await eventsOf(jacket, 'style.revision_released')).at(-1)!.payload).toMatchObject({ revisionId: rev1.id, releasedColourwayIds: [], releasedSizes: [], widened: true, obsoletedRevisionId: null })
    check = await ok('manager', 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    expect(cells(check).state).toBe('OK')
    // The database keeps it: a released revision never narrows again.
    await expect(admin(`UPDATE "StyleRevision" SET "releasedSizes" = ARRAY['50'] WHERE id = $1`, [rev1.id])).rejects.toThrow(/only widens/)
  })
})
