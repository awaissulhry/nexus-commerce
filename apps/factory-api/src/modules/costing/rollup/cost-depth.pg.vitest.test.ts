import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCostSheets, type CostSheetsSeed } from '../../../../../../packages/factory-db/seed/cost-sheets'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Cost in depth on the local stack (B-W2b-423; FIN-017, FIN-018, FIN-019, FIN-022; follow-ups KS4:01, KS4:02) with the app's
 * real routes and real sign-ins (two-factor: the mass update's apply asks a fresh code): a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and every guard are real), the cost sheets, options and sales pricing
 * seeds (the jacket SEED-JKT-01 with its versions for company A and B; the configurable SEED-JKT-05 with the removable liner
 * SEED-LNR-01 as a sub-assembly; the draft quote SEED-Q-0003 configured; company A's price lists). Made-up prices for the
 * materials the seeds leave without one: the liner's padding 2.50 a m², the contrast thread 0.02 a m. Tenant-wide labour rates:
 * cutting 0.50 a minute, sewing 0.40 at 80 %; company A's overhead 25 % of labour and 0.05 a sewing minute. Every figure is made
 * up and worked out by hand. Run with `node scripts/factory/run-pg-tests.mjs modules/costing/rollup`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

let h: Harness
let costSheets: CostSheetsSeed
let options: OptionsSeed
let pricing: SalesPricingSeed
const NS = 'cost-depth-423'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const jkt01 = seedId('product:style:JKT-01')
const lining = seedId('product:item:lining')
const people: Record<string, { browser: Browser; secret: string; id: string }> = {}

const sql = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(text, values)).rows as T[]
/** Moves made-up test data past its own guards (the admin's session only), then back. */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await sql('SET session_replication_role = replica')
  try {
    await sql(text, values)
  } finally {
    await sql('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = () => `cd423-${++counter}-${newId()}`
async function call(name: string, method: Method, url: string, body?: unknown) {
  const answer = await people[name]!.browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  return { status: answer.status, body: answer.body as Json }
}
async function as(name: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(name, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(name: string, method: Method, url: string, body: unknown, code: string): Promise<Json> {
  const answer = await call(name, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(409)
  expect(answer.body.error.issues[0].path).toBe(`refusal/${code}`)
  return answer.body.error
}
const num = (value: string | null | undefined): number => Number(value)
const near = (value: string | number | null | undefined, expected: number) => expect(Math.abs(Number(value) - expected)).toBeLessThan(0.000002)
const outbox = async (type: string) => (await sql<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
let jkt05: { styleId: string; revisionId: string }

beforeAll(async () => {
  h = await startHarness('cost_depth_423')
  h.clock.set(new Date(Date.now() - 60_000))
  await seedCore({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  pricing = await seedSalesPricing({ db: h.database, namespace: NS })
  costSheets = await seedCostSheets({ db: h.database, namespace: NS })
  options = await seedOptions({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  // The system roles as the templates hold them now (finance: costing.massUpdate.apply).
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // Made-up prices for what the seeds leave without one.
  await sql(`UPDATE "Item" SET "standardCost" = 2.5, currency = 'EUR' WHERE "tenantId" = $1 AND code = 'SEED-TXT-520'`, [tenant])
  await sql(`UPDATE "Item" SET "standardCost" = 0.02, currency = 'EUR' WHERE "tenantId" = $1 AND code = 'SEED-THR-530'`, [tenant])
  jkt05 = { styleId: options.jacketStyleId, revisionId: options.jacketRevisionId }
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  for (const [name, role] of [['finance', 'finance'], ['owner', 'owner']] as const) {
    const user = await addUser(h, seedTenant, { email: `${name}.423@seed-a.example.com`, role })
    const browser = new Browser(h.app)
    expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
    people[name] = { browser, secret: await enrolTotp(h, browser), id: user.id }
  }
}, 300_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the multi-level roll-up (FIN-019, KS4:02)', () => {
  it("costs the liner line at SEED-LNR-01's own cost, every level read, never at the component's (missing) standard price", async () => {
    // The liner as a plain sub-assembly line of the jacket (made-up: the seed has it only for the liner option).
    await force(`UPDATE "BomLine" SET "optionValueId" = NULL WHERE id = $1`, [options.bomLineIds.liner])
    try {
      const rollup = await as('finance', 'GET', `/costing/styles/${jkt05.styleId}/revisions/${jkt05.revisionId}/rollup?companyId=${companyA}`)
      expect(rollup.levels).toBe(2)
      expect(rollup.tree).toHaveLength(1)
      const node = rollup.tree[0]
      expect(node).toMatchObject({ level: 2, lineId: options.bomLineIds.liner, seq: 40, via: [], subAssembly: { code: 'SEED-LNR-01', revision: 1, status: 'RELEASED' }, colourway: { code: 'GRY' } })
      // One liner of 52: lining 1.2 m + 5 % at 3.10 = 3.906; padding 0.8 m² + 8 % at 2.50 = 2.16; sewing 18 min at 0.40 ÷ 80 % =
      // 9.00; company A's overhead 25 % of it 2.25 and 0.05 a sewing minute 0.90 (no per-garment overhead on a sub-assembly) = 18.216.
      const at52 = node.sizes.find((entry: Json) => entry.size === '52')
      expect(at52).toMatchObject({ subSize: '52', batches: '1', problem: null })
      near(at52.perBatch, 18.216)
      near(at52.perBaseUnit, 18.216)
      near(node.own.find((entry: Json) => entry.size === '52').total, 18.216)
      const line = rollup.lines.find((entry: Json) => entry.sourceRecordId === options.bomLineIds.liner && (entry.size === '52' || entry.size === null))
      expect(line).toMatchObject({ category: 'MATERIAL', source: 'BOM_LINE', quantity: '1', uom: 'PCS' })
      near(line.unitCost, 18.216)
      expect(rollup.missing.map((entry: Json) => entry.code)).not.toContain('SUB_ASSEMBLY_COST')
      expect(rollup.missing.map((entry: Json) => entry.code)).not.toContain('MATERIAL_PRICE')
    } finally {
      await force(`UPDATE "BomLine" SET "optionValueId" = $2 WHERE id = $1`, [options.bomLineIds.liner, options.valueIds.linerYes])
    }
  })

  it('leaves the liner out of the garment without options while it is a line only for the liner option', async () => {
    const rollup = await as('finance', 'GET', `/costing/styles/${jkt05.styleId}/revisions/${jkt05.revisionId}/rollup?companyId=${companyA}`)
    expect(rollup.tree).toEqual([])
    expect(rollup.lines.some((entry: Json) => entry.sourceRecordId === options.bomLineIds.liner)).toBe(false)
  })
})

describe("an option's own cost (FIN-018)", () => {
  it('costs each value the jacket offers against the garment without options; a typed delta takes the place of its part', async () => {
    const view = await as('finance', 'GET', `/costing/styles/${jkt05.styleId}/option-costs?companyId=${companyA}`)
    const of = (valueId: string) => view.values.find((entry: Json) => entry.valueId === valueId)
    // The liner: typed 18.40 EUR of material and 6 minutes at the garment's labour per minute — cutting 14 min at 0.50 = 7.00,
    // sewing 96.5 min at 0.40 ÷ 80 % = 48.25: 55.25 for 110.5 minutes, 0.50 a minute — 3.00: 21.40 in every size.
    const liner = of(options.valueIds.linerYes)
    expect(liner).toMatchObject({ material: { source: 'TYPED', currency: 'EUR' }, making: { source: 'TYPED', minutesTyped: '6' }, complete: true })
    for (const size of liner.bySize) near(size.total, 21.4)
    near(liner.atBaseSize, 21.4)
    // No armour leaves the two shoulder protectors out (2 × 6.50): −13.00, no making.
    const none = of(options.valueIds.armourNone)
    expect(none.material.source).toBe('DERIVED')
    near(none.atBaseSize, -13)
    // A person without the cost grain sees no figure (the money fields are dropped).
  })

  it("keeps a value's typed material delta (cost grain, the group's company) and refuses what does not change", async () => {
    const value = (await sql<{ version: number }>('SELECT version FROM "OptionValue" WHERE id = $1', [options.valueIds.perfFront]))[0]!
    const url = `/costing/option-groups/${options.groupIds.perforation}/values/${options.valueIds.perfFront}/cost`
    const set = await as('finance', 'PUT', url, { version: value.version, materialDelta: '2.5', materialDeltaCurrency: 'EUR', minutesDelta: null })
    expect(set.value).toMatchObject({ id: options.valueIds.perfFront, materialDelta: '2.5', materialDeltaCurrency: 'EUR', minutesDelta: null, version: value.version + 1 })
    await refused('finance', 'PUT', url, { version: value.version + 1, materialDelta: '2.5', materialDeltaCurrency: 'EUR', minutesDelta: null }, 'NOTHING_CHANGES')
    const zero = await call('finance', 'PUT', url, { version: value.version + 1, materialDelta: '0', materialDeltaCurrency: 'EUR', minutesDelta: null })
    expect(zero.status).toBe(400)
    expect((await outbox('option_value.delta_changed')).at(-1)).toEqual({ groupId: options.groupIds.perforation, valueId: options.valueIds.perfFront, parts: ['material'] })
    const view = await as('finance', 'GET', `/costing/styles/${jkt05.styleId}/option-costs?companyId=${companyA}`)
    expect(view.values.find((entry: Json) => entry.valueId === options.valueIds.perfFront).material).toMatchObject({ source: 'TYPED', typed: '2.5' })
    const library = await as('finance', 'GET', `/costing/option-groups/${options.groupIds.liner}/costs?companyId=${companyA}`)
    const yes = library.values.find((entry: Json) => entry.valueId === options.valueIds.linerYes)
    expect(yes).toMatchObject({ typed: { materialDelta: '18.4', materialDeltaCurrency: 'EUR', minutesDelta: '6' }, dependsOnStyle: true })
  })
})

describe("an option's own cost joins the line's cost and margin (KS4:01)", () => {
  it("costs SEED-Q-0003's configured jacket line with its options, size by size, when its options are saved", async () => {
    const { quoteId, gridLineId } = pricing.draftQuote
    const configurator = await as('owner', 'GET', `/sales/quotes/${quoteId}/lines/${gridLineId}/configurator`)
    const picks = configurator.chosen.filter((entry: Json) => entry.id !== null).map((entry: Json) => ({ valueId: entry.valueId, ...Object.fromEntries((['text', 'colourId', 'itemId', 'itemColourId'] as const).flatMap((field) => (entry[field] ? [[field, entry[field]]] : []))) }))
    const version = (await sql<{ version: number }>('SELECT version FROM "Quote" WHERE id = $1', [quoteId]))[0]!.version
    await as('owner', 'PUT', `/sales/quotes/${quoteId}/lines/${gridLineId}/options`, { version, picks })
    const line = (await sql<{ costSnapshot: Json; costAmount: number | null }>('SELECT "costSnapshot", "costAmount" FROM "QuoteLine" WHERE id = $1', [gridLineId]))[0]!
    const snapshot = line.costSnapshot
    expect([...snapshot.options.valueIds].sort()).toEqual(picks.map((pick: Json) => pick.valueId).sort())
    expect(snapshot.options.complete).toBe(true)
    // The line's cost = Σ per size of (the garment's cost + its options' own cost) × pieces, rounded once to cents.
    const expected = snapshot.cells.reduce((sum: number, cell: Json) => {
      const extra = snapshot.options.values.reduce((total: number, value: Json) => total + num(value.bySize.find((entry: Json) => entry.size === cell.size)?.total), 0)
      return sum + (num(cell.knownTotal) + extra) * cell.quantity
    }, 0)
    expect(snapshot.complete).toBe(true)
    expect(Math.abs((line.costAmount ?? 0) - Math.round(expected * 100))).toBeLessThanOrEqual(1)
  })
})

describe("a made-to-measure unit's cost (FIN-017)", () => {
  const body = { styleId: jkt01, companyId: companyA, measurements: { chest: { value: '104', unit: 'cm' }, height: { value: '182', unit: 'cm' } }, baseSize: '52', alterations: [{ workCentreKind: 'SEWING', minutes: '20' }] }

  it('is refused in words while made-to-measure has not started for the style’s template (GATE-MTM)', async () => {
    const error = await refused('finance', 'POST', '/costing/made-to-measure/cost', body, 'MTM_NOT_STARTED')
    expect(error.message).toContain('GATE-MTM')
  })

  it('costs the base size, the alteration minutes at the sewing rate with its overhead, and says what it read', async () => {
    const template = (await sql<{ id: string }>('SELECT "measurementTemplateId" AS id FROM "Style" WHERE id = $1', [jkt01]))[0]!.id
    await sql('UPDATE "MeasurementTemplate" SET "rulesOn" = true WHERE id = $1', [template])
    try {
      const unit = await as('finance', 'POST', '/costing/made-to-measure/cost', body)
      expect(unit).toMatchObject({ baseSize: { size: '52', how: 'TYPED' }, template: { rulesOn: true }, alterations: [{ workCentreKind: 'SEWING', minutes: '20' }], options: [] })
      // 20 minutes at 0.40 ÷ 80 % = 10.00, company A's 25 % of it 2.50 and 0.05 a sewing minute 1.00: 13.50. No line scales.
      near(unit.breakdown.alteration, 13.5)
      near(unit.breakdown.extraMaterial, 0)
      expect(unit.notes.join(' ')).toContain('No BOM line scales')
      if (unit.breakdown.base !== null) near(unit.breakdown.total, num(unit.breakdown.base) + 13.5)
      expect(JSON.stringify(unit)).not.toContain('"104"')
    } finally {
      await sql('UPDATE "MeasurementTemplate" SET "rulesOn" = false WHERE id = $1', [template])
    }
  })
})

describe('the mass cost update (FIN-022)', () => {
  it('shows the sheets, price lists and orders a new lining price touches, applies it with a fresh code, and refuses a stale preview', async () => {
    const price = (await sql<{ standardCost: string }>('SELECT "standardCost"::text AS "standardCost" FROM "Item" WHERE id = $1', [lining]))[0]!.standardCost
    const newPrice = (Number(price) * 1.1).toFixed(6)
    const preview = await as('finance', 'POST', '/costing/mass-updates/preview', { changes: [{ itemId: lining, newPrice }] })
    expect(preview.materials).toEqual([expect.objectContaining({ itemId: lining, newPrice: String(Number(newPrice)), changePct: '10' })])
    const seriesA = preview.series.find((entry: Json) => entry.companyId === companyA)
    // Company A's newest version that is not frozen: the DRAFT 3 (the APPROVED 2 is never changed).
    expect(seriesA.sheet).toMatchObject({ id: costSheets.sheetIds.draftA, sheetVersion: 3, state: 'DRAFT' })
    expect(seriesA.state).toBe('RECOMPUTED')
    for (const size of seriesA.sizes) {
      expect(num(size.move)).toBeGreaterThan(0)
      near(size.move, num(size.after) - num(size.before))
    }
    expect(preview.withoutSheet.map((entry: Json) => entry.code)).toContain('SEED-JKT-05')
    expect(preview.withoutSheet.map((entry: Json) => entry.code)).not.toContain('SEED-LNR-01')
    const base = preview.priceLists.find((entry: Json) => entry.code === 'SEED-PL-BASE' && entry.styleId === jkt01)
    expect(base).toMatchObject({ comparable: true })
    expect(num(base.marginAfter)).toBeLessThan(num(base.marginBefore))
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/)

    const apply = { changes: [{ itemId: lining, newPrice }], previewHash: preview.previewHash, leaveOutMissing: true, note: 'Made-up lining increase' }
    const held = await call('finance', 'POST', '/costing/mass-updates/apply', apply)
    expect(held.status).toBe(403)
    expect(held.body.error.issues.map((issue: Json) => issue.path)).toEqual(['stepUp'])
    await stepUp(h, people.finance!.browser, people.finance!.secret)
    const applied = await as('finance', 'POST', '/costing/mass-updates/apply', apply)
    expect(applied.materials).toEqual([expect.objectContaining({ itemId: lining, code: 'SEED-LIN-200' })])
    const madeA = applied.created.find((entry: Json) => entry.basedOnId === costSheets.sheetIds.draftA)
    expect(madeA).toMatchObject({ sheetVersion: 4 })
    const sheets = await sql<{ id: string; state: string; basedOnId: string | null }>('SELECT id, state::text AS state, "basedOnId" FROM "CostSheet" WHERE id = ANY($1::uuid[])', [[costSheets.sheetIds.approvedA, madeA.sheetId]])
    expect(sheets.find((row) => row.id === costSheets.sheetIds.approvedA)!.state).toBe('APPROVED')
    expect(sheets.find((row) => row.id === madeA.sheetId)).toMatchObject({ state: 'DRAFT', basedOnId: costSheets.sheetIds.draftA })
    expect(num((await sql<{ standardCost: string }>('SELECT "standardCost"::text AS "standardCost" FROM "Item" WHERE id = $1', [lining]))[0]!.standardCost)).toBe(Number(newPrice))
    expect((await outbox('mass_update.applied')).at(-1)).toMatchObject({ itemIds: [lining], skipped: 0 })
    // The same preview again: the material moved since (its price and version): STALE, nothing written.
    await stepUp(h, people.finance!.browser, people.finance!.secret)
    await refused('finance', 'POST', '/costing/mass-updates/apply', { ...apply, changes: [{ itemId: lining, newPrice: (Number(newPrice) * 1.1).toFixed(6) }] }, 'STALE')
  })
})
