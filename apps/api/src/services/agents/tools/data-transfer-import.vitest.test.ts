/**
 * MCP full control P9 — `import-catalog` and the import half of `rollback-bulk-operation`, over the isolated import
 * store the wizard's own tests use (catalog-transfer-test/store.ts): the real wizard, planner and apply; a fake database.
 *
 * Proven here: a text source and a public link preview what the wizard would write and write nothing; 501 rows, a
 * private or plain-http link, a missing mapping and a file the wizard refuses are refused (with the wizard's reasons);
 * after approval the run goes through the wizard (upload, review, apply) and writes exactly the preview; when the
 * catalog moved after the person approved, nothing is applied; undo re-imports the "before" record and puts every value
 * back (an inherited one inherits again), and is refused when a value changed since the import, for an import that only
 * created, for a legacy import, and for a job that is not there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importTestStore, fixtureColumns, fixtureFields } from '../../pim/catalog-transfer-test/store.js'
// The wizard's apply queues channel pushes: no Redis here.
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('../../pim/sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn() }))
vi.mock('../../pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('../../pim/mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
// The real safe fetcher refuses private and local addresses without the network; a public link is answered here.
const fetched = vi.hoisted(() => ({ next: null as null | { buffer: Buffer } }))
vi.mock('../../net/safe-fetch.js', async (original) => {
  const actual = await original<typeof import('../../net/safe-fetch.js')>()
  return { ...actual, safeFetch: async (url: string, options: Parameters<typeof actual.safeFetch>[1]) => {
    if (fetched.next) { const answer = fetched.next; fetched.next = null; return { ...answer, contentType: 'text/csv', url: new URL(url) } }
    return actual.safeFetch(url, options)
  } }
})

import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'
import { DATA_TRANSFER_TOOLS } from './data-transfer.tools.js'

const tool = (name: string) => DATA_TRANSFER_TOOLS.find(t => t.name === name)! as Required<Pick<AgentTool, 'handler' | 'execute' | 'undo'>> & AgentTool
const asker: ToolContext = { userId: 'owner', can: () => true, via: 'claude' }
const approver = (approvedPreview: unknown): ToolContext => ({ userId: 'approver', can: () => true, via: 'claude', approvalId: 'ap-1', approvedPreview })

const MAPPING = { skuColumn: 'SKU', market: 'IT', mode: 'update', policy: { shared: 'replace', overrides: 'replace' },
  bindings: [{ source: 'Name', entity: 'Products', field: 'name', format: 'text' }, { source: 'Material', entity: 'Overrides', field: 'material', format: 'text', channel: { value: 'AMAZON' }, accountId: { value: 'account-a' }, marketplace: { value: 'IT' } }] }
const FILE = 'SKU,Name,Material\n000000,Renamed parent,Wool\n000001,Original 1,'

const preview = async (args: Record<string, unknown>, ctx: ToolContext = asker) => tool('import-catalog').handler(args, ctx)
const product = (id: string) => state.store.data.product.get(id)!
const listing = (id: string) => state.store.data.channelListing.get(id)!

/** Ask, approve, run: the way the gate runs it (the approver's run carries the preview the person saw). */
async function imported(args: Record<string, unknown>) {
  const asked = await preview(args)
  expect(asked.ok, asked.error).toBe(true)
  const ran = await tool('import-catalog').execute(args, approver(asked.preview))
  expect(ran.ok, ran.error).toBe(true)
  return { asked, ran }
}

beforeEach(() => {
  state.store = importTestStore({ recordQueries: false }); state.store.seed(3)
  // The undo looks for a bulk job first: there are none in this store.
  state.store.db.bulkActionJob = { findUnique: async () => null }
  fetched.next = null
})

describe('import-catalog — the preview', () => {
  it('a text source: what the wizard would write, before → after, and nothing written', async () => {
    const out = await preview({ text: FILE, mapping: MAPPING })
    expect(out.ok, out.error).toBe(true)
    const p = out.preview as Record<string, any>
    expect(p.source).toMatchObject({ kind: 'text', rows: 2, columns: ['SKU', 'Name', 'Material'] })
    expect(p.counts).toEqual({ productsCreated: 0, productsChanged: 1, listingsCreated: 0, listingsChanged: 1, valuesChanged: 2, valuesAlreadyTheSame: 1, valuesLeftAsTheyAre: 1 })
    expect(p.changes).toEqual([
      { sku: '000000', where: 'product', field: 'name', from: { name: 'Original 0' }, to: { name: 'Renamed parent' } },
      { sku: '000000', where: 'AMAZON IT listing', account: 'account-a', field: 'material', from: { material: 'Protected cotton' }, to: { material: 'Wool' } },
    ])
    expect(p.basis).toEqual({ source: expect.any(String), mapping: expect.any(String), plan: expect.any(String) })
    expect(product('p0').name).toBe('Original 0')
    expect(state.store.data.importJob.size + state.store.data.bulkOperation.size + state.store.data.importJobRow.size).toBe(0)
  })

  it('a public https link is read through the safe fetcher', async () => {
    fetched.next = { buffer: Buffer.from(FILE) }
    const out = await preview({ url: 'https://supplier.example.test/catalog.csv', mapping: MAPPING })
    expect(out.ok, out.error).toBe(true)
    expect((out.preview as Record<string, any>).source).toMatchObject({ kind: 'link', file: 'catalog.csv', link: 'https://supplier.example.test/catalog.csv', rows: 2 })
  })

  it('refuses 501 rows, a private or plain-http link, both or neither source, and no mapping', async () => {
    const big = `SKU,Name\n${Array.from({ length: 501 }, (_, i) => `TEST-SKU-${i},Name ${i}`).join('\n')}`
    expect((await preview({ text: big, mapping: MAPPING })).error).toBe('Not imported: the file has 501 rows; Claude imports at most 500 at a time. Split it, or import it in Nexus (Products › Import).')
    expect((await preview({ url: 'https://127.0.0.1/catalog.csv', mapping: MAPPING })).error).toBe('Not imported: the link was refused — Source URL must resolve to a public internet address.')
    expect((await preview({ url: 'https://localhost/catalog.csv', mapping: MAPPING })).error).toBe('Not imported: the link was refused — Source URL must resolve to a public internet address.')
    expect((await preview({ url: 'http://supplier.example.test/catalog.csv', mapping: MAPPING })).error).toBe('Not imported: use a public https link.')
    expect((await preview({ text: FILE, url: 'https://supplier.example.test/c.csv', mapping: MAPPING })).error).toMatch(/^Not imported: give the file either as text or as a public https link/)
    expect((await preview({ text: FILE })).error).toMatch(/^Not imported: give the column mapping, or the id of a saved mapping/)
    expect((await preview({ text: FILE, savedMappingId: 'nope' })).error).toBe('Saved mapping not found')
  })

  it('passes the wizard\'s own refusals through, by row — never naming a SKU the business may not have', async () => {
    const out = await preview({ text: 'SKU,Name\n999999,Unknown\n,No SKU', mapping: MAPPING })
    expect(out.error).toBe("Not imported: Nexus's import refuses 2 values of this file — row 3 (sku): A stable SKU is required; no row-number or name matching is used; "
      + 'row 2 (name): This record does not exist; Update never creates an unknown SKU or listing. Correct the file and ask again.')
    expect(out.error).not.toContain('999999')
    expect((await preview({ text: FILE, mapping: { ...MAPPING, skuColumn: 'Code' } })).error).toBe('Not imported: The file is missing SKU column "Code"')
    expect((await preview({ text: 'SKU,Name\n000001,Original 1', mapping: MAPPING })).error).toBe('Not imported: the file changes nothing here — 1 value already read like this, 1 left as they are.')
  })

  it('a saved mapping of the person stands in for the mapping', async () => {
    const saved = await state.store.db.scheduledImport.create({ data: { name: 'Mine', source: 'upload', sourceUrl: '', targetEntity: 'catalog-source-v1', columnMapping: { kind: 'catalog-source-v1', ...MAPPING }, enabled: false, createdBy: 'owner' } })
    expect((await preview({ text: FILE, savedMappingId: saved.id })).ok).toBe(true)
    // Another person's saved mapping is not theirs to use.
    expect((await preview({ text: FILE, savedMappingId: saved.id }, { ...asker, userId: 'someone-else' })).error).toBe('Saved mapping not found')
  })
})

describe('import-catalog — the run, after a person approves', () => {
  it('goes through the wizard and writes exactly the preview; each record keeps its "before" record', async () => {
    const { ran } = await imported({ text: FILE, mapping: MAPPING })
    const jobId = (ran.data as { jobId: string }).jobId
    expect(ran.data).toMatchObject({ jobId, state: 'COMPLETED', receipt: { saved: 2, failed: 0 } })
    expect(ran.change).toEqual({ before: { jobId, file: 'claude-import.csv', records: 2 }, after: { jobId, changedSince: [] } })
    expect(product('p0').name).toBe('Renamed parent')
    expect(listing('p0-account-a').overrideData).toMatchObject({ material: 'Wool' })
    // The wizard's own records: the uploaded source, the reviewed job (run by the approver), its rows.
    expect([...state.store.data.importJob.values()].map(j => [j.targetEntity, j.createdBy])).toEqual([['catalog-source-input-v1', 'approver'], ['catalog-transfer-v2', 'approver']])
    expect([...state.store.data.importJobRow.values()].filter(r => r.jobId === jobId && r.beforeState).length).toBe(2)
  })

  it('the approver\'s run re-checks: a value moved after approval → nothing applied', async () => {
    const asked = await preview({ text: FILE, mapping: MAPPING })
    state.store.data.product.set('p0', { ...product('p0'), name: 'Saved meanwhile', version: product('p0').version + 1 })
    const ran = await tool('import-catalog').execute({ text: FILE, mapping: MAPPING }, approver(asked.preview))
    expect(ran).toEqual({ ok: false, error: 'Not imported: the file, its mapping or what it changes moved since this was approved. Ask again for a fresh review.' })
    expect(state.store.data.bulkOperation.size).toBe(0)
    expect(listing('p0-account-a').overrideData).toMatchObject({ material: 'Protected cotton' })
  })
})

describe('undoing an import — rollback-bulk-operation re-imports the "before" record', () => {
  const undo = (jobId: string, ctx: ToolContext = asker) => tool('rollback-bulk-operation').handler({ jobId }, ctx)

  it('undo-change asks rollback-bulk-operation; the undo puts every value back through the wizard', async () => {
    const { ran } = await imported({ text: 'SKU,Name,Material,Description\n000000,Renamed parent,Wool,\n000002,,,A child description', mapping: { ...MAPPING, bindings: [...MAPPING.bindings, { source: 'Description', entity: 'Products', field: 'description', format: 'text' }] } })
    const change = ran.change!
    expect(product('p2').description).toBe('A child description')
    // The change is still as the import wrote it, and its undo is a request of rollback-bulk-operation.
    expect(await tool('import-catalog').undo.current(change)).toEqual(change.after)
    const request = tool('import-catalog').undo.request(change)
    expect(request).toEqual({ tool: 'rollback-bulk-operation', args: { jobId: (change.after as { jobId: string }).jobId } })
    const asked = await undo((change.after as { jobId: string }).jobId)
    expect(asked.ok, asked.error).toBe(true)
    const p = asked.preview as Record<string, any>
    expect(p).toMatchObject({ kind: 'import', counts: { valuesPutBack: 3, products: 2, listings: 1, createdProductsKept: 0, createdListingsKept: 0 } })
    expect(p.changes).toEqual(expect.arrayContaining([
      { sku: '000000', where: 'product', field: 'name', from: { name: 'Renamed parent' }, to: { name: 'Original 0' } },
      { sku: '000002', where: 'product', field: 'description', from: { description: 'A child description' }, to: { description: null }, toInherited: true },
    ]))
    const done = await tool('rollback-bulk-operation').execute({ jobId: (change.after as { jobId: string }).jobId }, approver(asked.preview))
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ state: 'COMPLETED', undoJobId: expect.any(String) })
    expect(product('p0').name).toBe('Original 0')
    expect(product('p2').description ?? null).toBeNull()
    expect(listing('p0-account-a').overrideData).toMatchObject({ material: 'Protected cotton' })
  })

  it('refused when a value changed since the import wrote it (undo would overwrite it)', async () => {
    const { ran } = await imported({ text: FILE, mapping: MAPPING })
    const jobId = (ran.data as { jobId: string }).jobId
    state.store.data.product.set('p0', { ...product('p0'), name: 'Edited later', version: product('p0').version + 1 })
    expect(await tool('import-catalog').undo.current(ran.change!)).toEqual({ jobId, changedSince: ['000000 name'] })
    expect((await undo(jobId)).error).toBe('Not undone: 1 value of the import "claude-import.csv" changed since it wrote them (000000 name). Undo would overwrite those later changes.')
  })

  it('refused for an import that only created, a legacy import, a missing job, and without the import permission', async () => {
    const { ran } = await imported({ text: 'SKU,Name,Family\n000777,Brand new,coats', mapping: { ...MAPPING, mode: 'upsert', bindings: [MAPPING.bindings[0], { source: 'Family', entity: 'Products', field: 'family', format: 'text' }] } })
    const jobId = (ran.data as { jobId: string }).jobId
    expect((await undo(jobId)).error).toBe('Not undone: the import "claude-import.csv" only created 1 product or listing; undo cannot delete them. Delete them in Nexus if they should go.')
    expect((await undo(jobId, { ...asker, can: () => false })).error).toBe('Not undone: undoing an import re-imports values, which needs the catalog import permission.')
    const legacy = await state.store.db.importJob.create({ data: { jobName: 'Old wizard file', fileKind: 'csv', targetEntity: 'product', createdBy: 'owner' } })
    expect((await undo(legacy.id)).error).toBe('Not undone: the import "Old wizard file" was not made by Nexus\'s catalog import, so it kept no record of the values it replaced. Change them back in Nexus.')
    expect((await undo('missing')).error).toBe('Job not found')
  })
})
