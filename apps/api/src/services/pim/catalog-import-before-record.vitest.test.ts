/**
 * MCP full control P9 — the import's "before" record (Owner, choice A, 2026-10-02): each record an import applies keeps
 * what it replaced, in its import row (`ImportJobRow.beforeState`), so a whole import can be undone.
 *
 * Only a record that wrote something has one: an unchanged, excluded, refused or failed record keeps none, and a
 * record the import created says so (undo cannot delete it). Everything else the import does is held byte for byte by
 * catalog-import-golden.vitest.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importTestStore, fixtureColumns, fixtureFields } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import { applyTransferJob, readTransferJob, stageTransferJob, transferJobStatus } from './catalog-transfer-jobs.js'
import { TRANSFER_BEFORE_KIND } from './catalog-transfer-before.js'

const row = (patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Products', sku: '000000', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'New shared', ...patch })
const settle = async (id: string, states: string[]) => {
  let result: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>
  await vi.waitFor(async () => { result = (await readTransferJob(id, 'owner'))!; expect(states).toContain(result.job.status) }, { timeout: 30_000, interval: 10 })
  return transferJobStatus(result!)
}
const imported = async (rows: TransferRow[], mode: 'update' | 'upsert' = 'update', meanwhile?: () => void) => {
  const staged = await stageTransferJob({ rows, issues: [], mode, market: 'IT', filename: 'before.csv', userId: 'owner' })
  const review = await settle(staged.jobId, ['QUEUED', 'INVALID'])
  meanwhile?.()
  await applyTransferJob(staged.jobId, 'owner', review.reviewToken!, { readyOnly: review.state === 'INVALID' })
  await settle(staged.jobId, ['COMPLETED', 'PARTIAL', 'FAILED'])
  return [...state.store.data.importJobRow.values()].filter(r => r.jobId === staged.jobId).sort((a, b) => a.rowIndex - b.rowIndex)
}
/** The import row of one product (or, with `listing`, of one of its listings). */
const bySku = (rows: Array<Record<string, any>>, sku: string, listing = false) =>
  rows.find(r => r.parsedValues?.target?.identity?.sku === sku && (r.parsedValues.target.identity.entity !== 'Products') === listing)!

describe('the import before record', () => {
  beforeEach(() => { state.store = importTestStore({ recordQueries: false }); state.store.seed(3) })

  it('an applied record keeps the values it replaced, cell by cell, beside the values it wrote', async () => {
    const rows = await imported([
      row({ sku: '000000', value: 'Renamed parent' }),
      row({ sku: '000002', field: 'description', value: 'A new description' }),
      row({ sku: '000000', entity: 'Overrides', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', field: 'material', value: 'Wool' }),
    ])
    expect(bySku(rows, '000000').beforeState).toEqual({
      kind: TRANSFER_BEFORE_KIND, created: false,
      identity: { entity: 'Products', sku: '000000', channel: '', accountId: '', marketplace: '', aliasKey: '' },
      cells: [{ entity: 'Products', sku: '000000', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', before: 'Original 0', beforeState: 'stored', after: 'Renamed parent', afterState: 'stored' }],
    })
    expect(bySku(rows, '000002').beforeState.cells).toEqual([expect.objectContaining({ field: 'description', before: null, beforeState: 'inherited', after: 'A new description', afterState: 'stored' })])
    expect(bySku(rows, '000000', true).beforeState).toEqual({
      kind: TRANSFER_BEFORE_KIND, created: false,
      identity: { entity: 'Listings', sku: '000000', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', aliasKey: '' },
      cells: [{ entity: 'Overrides', sku: '000000', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', aliasKey: '', locale: '', field: 'material', before: 'Protected cotton', beforeState: 'stored', after: 'Wool', afterState: 'stored' }],
    })
    // What it wrote is what the catalog holds now.
    expect(state.store.data.product.get('p0')!.name).toBe('Renamed parent')
  })

  it('an unchanged record keeps none; a created one says it was created', async () => {
    const rows = await imported([
      row({ sku: '000001', value: 'Original 1' }),
      row({ sku: '000777', value: 'Brand new' }),
      row({ sku: '000777', field: 'family', value: 'coats' }),
    ], 'upsert')
    expect(bySku(rows, '000001').status).toBe('SUCCESS')
    expect(bySku(rows, '000001').beforeState ?? null).toBeNull()
    const created = bySku(rows, '000777').beforeState
    expect(created).toMatchObject({ kind: TRANSFER_BEFORE_KIND, created: true, identity: { entity: 'Products', sku: '000777' } })
    expect(created.cells.map((c: { field: string; before: unknown }) => [c.field, c.before])).toEqual(expect.arrayContaining([['name', null]]))
  })

  it('a refused or failed record keeps none: nothing of it was written', async () => {
    const rows = await imported([
      row({ sku: '000001', value: 'Variant renamed' }),
      row({ sku: '999999', value: 'Unknown' }),
    ], 'update', () => {
      // Saved by someone between the review and the apply: this record fails at apply.
      const moved = state.store.data.product.get('p1')!
      state.store.data.product.set('p1', { ...moved, name: 'Saved meanwhile', version: moved.version + 1 })
    })
    expect(bySku(rows, '000001').status).toBe('FAILED')
    expect(bySku(rows, '000001').beforeState ?? null).toBeNull()
    const refused = rows.find(r => r.status === 'INVALID')!
    expect(refused.beforeState ?? null).toBeNull()
  })
})
