/**
 * MCP full control P5 — image-library, saved-views, job-history and product-search's savedViewId, run through the one
 * door (call-tool.ts) against a real PostgreSQL with the production schema and the business-isolation policies
 * (PGlite). No mocked query.
 *
 * Proven here: photos of a deleted product are left out and folders, tags and usage narrow; a page walk has nothing
 * twice and nothing missed; saved views are the caller's own plus shared ones (a teammate's private view is not
 * found, and a working layout is not a view); product-search applies a products view; job history is per kind,
 * imports are the caller's own, a job's download and source address never show, a person shows by name and never by
 * e-mail; a bad kind is a wrongly made call; a missing permission is refused; and (profiles on) another business's
 * rows never show. Run with business profiles off and with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// The registry loads every tool, and a change tool imports the queues: no Redis here.
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { TRANSFER_JOB_KIND } from '../../pim/catalog-transfer-jobs.js'
import { TRANSFER_JOB_KIND as TOOLS_TRANSFER_KIND } from './platform-library.tools.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_p5_library_bravo'
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const ME = 'u-p5-library-me'
const TEAMMATE = 'u-p5-library-mate'
const DAY = 86_400_000
const at = (daysAgo: number) => new Date(Date.UTC(2026, 8, 20) - daysAgo * DAY)

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(permissions: string[], workspaceId = A, userId = ME): UserPrincipal {
  return {
    kind: 'user',
    userId,
    label: 'P5 test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    ...(ON ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
const everything = (workspaceId = A, userId = ME) => principal([...Object.values(FEATURES), ...Object.values(FIELDS)], workspaceId, userId)

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: Row }

async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<Answer> {
  return (await callTool(who, tool, args)).visible as Answer
}

async function refusal(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()) {
  try {
    await callTool(who, tool, args)
    return null
  } catch (error) {
    if (error instanceof ToolAccessError) return error.code
    throw error
  }
}

async function walk(tool: string, args: Record<string, unknown>, limit: number) {
  const items: Row[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    pages++
  } while (cursor && pages < 50)
  return { items, pages }
}

const ids: Record<string, string> = {}

async function seed(workspaceId: string, mark: string) {
  await inside(workspaceId, async () => {
    const db = database.client
    const live = await db.product.create({ data: { sku: `${mark}-TEST-SKU-1`, name: `${mark} live jacket`, basePrice: '10.00', status: 'ACTIVE' } })
    const other = await db.product.create({ data: { sku: `${mark}-TEST-SKU-3`, name: `${mark} draft jacket`, basePrice: '10.00', status: 'DRAFT' } })
    const gone = await db.product.create({ data: { sku: `${mark}-TEST-SKU-2`, name: `${mark} gone jacket`, basePrice: '10.00', deletedAt: at(1) } })
    await db.productImage.create({ data: { productId: live.id, url: 'https://img.example.test/live.jpg', alt: `${mark} live photo`, type: 'MAIN', createdAt: at(9) } })
    await db.productImage.create({ data: { productId: gone.id, url: 'https://img.example.test/gone.jpg', alt: `${mark} gone photo`, type: 'MAIN', createdAt: at(8) } })
    const folder = await db.assetFolder.create({ data: { name: `${mark} Shoot` } })
    const tag = await db.tag.create({ data: { name: `${mark} Lifestyle` } })
    for (let n = 1; n <= 4; n++) {
      const asset = await db.digitalAsset.create({
        data: {
          label: `${mark} asset ${n}`, type: 'image', mimeType: 'image/jpeg', sizeBytes: 1000 * n, storageId: `${mark}-s${n}`,
          url: `https://img.example.test/${mark}-${n}.jpg`, folderId: n <= 3 ? folder.id : null,
          metadata: n === 1 ? { width: 1600, height: 1600, qualityWarnings: ['too small'] } : { width: 2000, height: 2000 }, createdAt: at(n),
        },
      })
      if (n <= 2) await db.assetTag.create({ data: { assetId: asset.id, tagId: tag.id } })
      if (n === 1) await db.assetUsage.create({ data: { assetId: asset.id, scope: 'product', productId: live.id, role: 'main' } })
    }
    // Saved views: mine (with an alert), a teammate's private one, a teammate's shared sheet view, a legacy template,
    // and my working layout (not a view).
    const mine = await db.savedView.create({ data: { userId: ME, surface: 'products', name: `${mark} Active jackets`, filters: { search: 'jacket', status: ['ACTIVE'] } } })
    await db.savedViewAlert.create({ data: { savedViewId: mine.id, userId: ME, name: 'Fewer than 5', comparison: 'LT', threshold: '5', lastCount: 1 } })
    await db.savedViewAlert.create({ data: { savedViewId: mine.id, userId: TEAMMATE, name: 'Mate alert', comparison: 'GT', threshold: '9' } })
    const privateView = await db.savedView.create({ data: { userId: TEAMMATE, surface: 'products', name: `${mark} Mate private`, filters: { search: 'gone' } } })
    const sheet = await db.savedView.create({ data: { userId: TEAMMATE, surface: 'product-edit:views:EBAY', name: `${mark} Mate sheet`, filters: { v: 2, kind: 'columns', columns: ['brand', 'color'] }, shared: true } })
    await db.savedView.create({ data: { userId: 'default-user', surface: 'products', name: `${mark} Template`, filters: { stockLevel: 'out' } } })
    await db.savedView.create({ data: { userId: ME, surface: 'product-edit:layout:EBAY', name: 'Current layout', filters: { v: 3 } } })
    // Jobs: my import and transfer, a teammate's import, two exports, three bulk jobs.
    const imported = await db.importJob.create({ data: { jobName: `${mark} spring import`, fileKind: 'csv', targetEntity: 'product', source: 'url', sourceUrl: 'https://user:secret@files.example.test/a.csv', filename: 'spring.csv', status: 'APPLIED', totalRows: 2, successRows: 1, failedRows: 1, createdBy: ME, createdAt: at(3) } })
    await db.importJobRow.create({ data: { jobId: imported.id, rowIndex: 1, parsedValues: { sku: `${mark}-TEST-SKU-1`, costPrice: '4.20' }, status: 'SUCCESS' } })
    await db.importJobRow.create({ data: { jobId: imported.id, rowIndex: 2, parsedValues: { sku: `${mark}-TEST-SKU-9` }, status: 'FAILED', errorMessage: 'Unknown SKU' } })
    await db.importJob.create({ data: { jobName: `${mark} mate import`, fileKind: 'csv', targetEntity: 'product', createdBy: TEAMMATE, createdAt: at(2) } })
    const transfer = await db.importJob.create({ data: { jobName: `${mark} catalog import`, fileKind: 'xlsx', targetEntity: TRANSFER_JOB_KIND, createdBy: ME, createdAt: at(1) } })
    await db.exportJob.create({ data: { jobName: `${mark} price export`, format: 'csv', targetEntity: 'product', status: 'COMPLETED', rowCount: 10, columns: [{ id: 'sku', label: 'SKU' }], artifactBase64: 'U0tVCg==', createdAt: at(4) } })
    await db.exportJob.create({ data: { jobName: `${mark} stock export`, format: 'xlsx', targetEntity: 'inventory', status: 'FAILED', errorMessage: 'Too many rows', createdAt: at(2) } })
    await db.userProfile.upsert({ where: { id: ME }, update: {}, create: { id: ME, email: 'p5-me@example.test', displayName: 'Paola Rossi', status: 'active' } })
    await db.userProfile.upsert({ where: { id: TEAMMATE }, update: {}, create: { id: TEAMMATE, email: 'p5-mate@example.test', displayName: '', status: 'active' } })
    const bulk = []
    for (const [n, status, by] of [[1, 'COMPLETED', ME], [2, 'FAILED', TEAMMATE], [3, 'PENDING', 'schedule:nightly']] as const) {
      bulk.push(await db.bulkActionJob.create({ data: { jobName: `${mark} bulk ${n}`, actionType: 'PRICING_UPDATE', actionPayload: { operation: 'percent', value: 5 }, status, totalItems: 2, createdBy: by, createdAt: at(n) } }))
    }
    await db.bulkActionItem.create({ data: { jobId: bulk[0].id, productId: live.id, status: 'SUCCEEDED', beforeState: { costPrice: '4.20' } } })
    if (mark === 'ALPHA') Object.assign(ids, { folder: folder.id, tag: tag.id, mine: mine.id, privateView: privateView.id, sheet: sheet.id, imported: imported.id, transfer: transfer.id, bulk: bulk[0].id, other: other.id })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seed(A, 'ALPHA')
  if (ON) {
    const owner = await database.client.userProfile.create({ data: { email: 'p5-library-owner@example.test', status: 'active' } })
    await database.client.workspace.create({ data: { id: B, name: 'Bravo library business', createdByUserId: owner.id, creationKey: 'p5-library-bravo' } })
    await seed(B, 'BRAVO')
  }
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('image-library', () => {
  it('lists the library and the product photos newest first; a deleted product’s photo is left out; the first page shows folders and tags', async () => {
    const first = await call('image-library', {})
    expect(first.ok, first.error).toBe(true)
    expect(first.data!.items.map((item: Row) => item.label)).toEqual(['ALPHA asset 1', 'ALPHA asset 2', 'ALPHA asset 3', 'ALPHA asset 4', 'ALPHA live photo'])
    expect(JSON.stringify(first)).not.toContain('gone photo')
    expect(first.data!.items[0]).toMatchObject({ source: 'library', width: 1600, usedBy: 1, uploadCheckWarnings: true })
    expect(first.data!.items[4]).toMatchObject({ source: 'product photo', productSku: 'ALPHA-TEST-SKU-1' })
    expect(first.data!.folders).toEqual([{ id: ids.folder, name: 'ALPHA Shoot', parentId: null, files: 3 }])
    expect(first.data!.tags).toEqual([{ id: ids.tag, name: 'ALPHA Lifestyle', files: 2 }])
  })

  it('pages, and narrows by folder, tags, usage, type and search', async () => {
    const { items, pages } = await walk('image-library', {}, 2)
    expect(pages).toBe(3)
    expect(new Set(items.map((item) => item.id)).size).toBe(5)
    expect((await call('image-library', { folderId: ids.folder })).data!.items).toHaveLength(3)
    expect((await call('image-library', { folderId: 'unfiled' })).data!.items.map((item: Row) => item.label)).toEqual(['ALPHA asset 4'])
    expect((await call('image-library', { tagIds: [ids.tag] })).data!.items).toHaveLength(2)
    expect((await call('image-library', { usage: 'orphaned' })).data!.items).toHaveLength(3)
    expect((await call('image-library', { type: 'video' })).data!.items).toEqual([])
    expect((await call('image-library', { search: 'gone' })).data!.items).toEqual([])
    expect(await refusal('image-library', { type: 'hologram' })).toBe('invalid_arguments')
    expect(await refusal('image-library', {}, principal([FEATURES.aiRun, FEATURES.productsView]))).toBe('forbidden')
  })
})

describe('saved-views and product-search savedViewId', () => {
  it('my views and the shared ones; a teammate’s private view and my working layout are not listed; only my alerts', async () => {
    const answer = await call('saved-views', {})
    expect(answer.ok, answer.error).toBe(true)
    const byName = Object.fromEntries(answer.data!.items.map((view: Row) => [view.name, view]))
    expect(Object.keys(byName).sort()).toEqual(['ALPHA Active jackets', 'ALPHA Mate sheet', 'ALPHA Template'])
    expect(byName['ALPHA Active jackets']).toMatchObject({ owned: true, filters: { search: 'jacket', status: ['ACTIVE'] }, alerts: [{ name: 'Fewer than 5', when: 'LT', threshold: 5, lastCount: 1 }] })
    expect(byName['ALPHA Mate sheet']).toMatchObject({ owned: false, sharedBy: 'a team member', sharedWithBusiness: true, columns: 2 })
    expect(byName['ALPHA Template']).toMatchObject({ owned: false, sharedBy: 'a shared template' })
    expect((await call('saved-views', { surface: 'products' })).data!.items).toHaveLength(2)
    expect(JSON.stringify(answer)).not.toContain('@example.test')
  })

  it('product-search applies a products view; a teammate’s private view is not found; a sheet view is refused in words', async () => {
    const all = await call('product-search', {})
    expect(all.data!.products.map((p: Row) => p.sku).sort()).toEqual(['ALPHA-TEST-SKU-1', 'ALPHA-TEST-SKU-3'])
    const viewed = await call('product-search', { savedViewId: ids.mine })
    expect(viewed.ok, viewed.error).toBe(true)
    expect(viewed.data).toMatchObject({ savedView: 'ALPHA Active jackets', count: 1, products: [expect.objectContaining({ sku: 'ALPHA-TEST-SKU-1' })] })
    expect(await call('product-search', { savedViewId: ids.privateView })).toEqual({ ok: false, error: 'Saved view not found' })
    // The teammate reads their own private view (control).
    expect((await call('product-search', { savedViewId: ids.privateView }, everything(A, TEAMMATE))).ok).toBe(true)
    expect(await call('product-search', { savedViewId: ids.sheet })).toMatchObject({ ok: false, error: expect.stringContaining('not a products filter') })
    expect(await call('product-search', { savedViewId: 'no-such-view' })).toEqual({ ok: false, error: 'Saved view not found' })
  })
})

describe('the tools load no channel service', () => {
  it('the transfer kind the tools write out is the catalog transfer\'s own', () => {
    expect(TOOLS_TRANSFER_KIND).toBe(TRANSFER_JOB_KIND)
  })
})

describe('job-history', () => {
  it('imports and transfers are my own; a job and its first rows; never the source address', async () => {
    const imports = await call('job-history', { kind: 'import' })
    expect(imports.data!.items.map((job: Row) => job.name)).toEqual(['ALPHA spring import'])
    expect(imports.data!.items[0]).toMatchObject({ source: 'url', file: 'spring.csv', rows: { total: 2, succeeded: 1, failed: 1, skipped: 0 } })
    expect((await call('job-history', { kind: 'transfer' })).data!.items.map((job: Row) => job.name)).toEqual(['ALPHA catalog import'])
    const one = await call('job-history', { kind: 'import', jobId: ids.imported })
    expect(one.data!.firstRows).toEqual([
      { row: 1, status: 'SUCCESS', sku: 'ALPHA-TEST-SKU-1', error: null },
      { row: 2, status: 'FAILED', sku: 'ALPHA-TEST-SKU-9', error: 'Unknown SKU' },
    ])
    expect(JSON.stringify(one)).not.toContain('secret')
    expect(await call('job-history', { kind: 'transfer', jobId: ids.imported })).toEqual({ ok: false, error: 'Job not found' })
    expect(await call('job-history', { kind: 'import', jobId: ids.imported }, everything(A, TEAMMATE))).toEqual({ ok: false, error: 'Job not found' })
  })

  it('exports without their file; bulk jobs page newest first with who ran them, never an e-mail; status words', async () => {
    const exports = await call('job-history', { kind: 'export' })
    expect(exports.data!.items.map((job: Row) => [job.name, job.status])).toEqual([['ALPHA stock export', 'FAILED'], ['ALPHA price export', 'COMPLETED']])
    expect(JSON.stringify(exports)).not.toContain('U0tVCg')
    const { items, pages } = await walk('job-history', { kind: 'bulk' }, 1)
    expect(pages).toBe(3)
    expect(items.map((job) => [job.name, job.by])).toEqual([['ALPHA bulk 1', 'Paola Rossi'], ['ALPHA bulk 2', 'a team member'], ['ALPHA bulk 3', 'Schedule']])
    expect((await call('job-history', { kind: 'bulk', status: 'terminal' })).data!.items).toHaveLength(2)
    expect((await call('job-history', { kind: 'bulk', status: 'active' })).data!.items.map((job: Row) => job.name)).toEqual(['ALPHA bulk 3'])
    const job = await call('job-history', { kind: 'bulk', jobId: ids.bulk })
    expect(job.data).toMatchObject({ job: { name: 'ALPHA bulk 1', change: { operation: 'percent', value: 5 } }, firstItems: [{ sku: 'ALPHA-TEST-SKU-1', status: 'SUCCEEDED' }] })
    expect(JSON.stringify(job)).not.toContain('4.20')
  })

  it('a changed cursor, a bad kind and a missing permission are refused', async () => {
    const first = await call('job-history', { kind: 'bulk', limit: 1 })
    expect(await call('job-history', { kind: 'export', limit: 1, cursor: first.data!.nextCursor })).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    expect(await refusal('job-history', { kind: 'everything' })).toBe('invalid_arguments')
    expect(await refusal('job-history', { kind: 'bulk' }, principal([FEATURES.aiRun]))).toBe('forbidden')
  })
})

describe.runIf(ON)('another business', () => {
  it('its library, views and jobs never show, and its ids are not found', async () => {
    for (const [tool, args] of [
      ['image-library', {}], ['saved-views', {}], ['job-history', { kind: 'import' }], ['job-history', { kind: 'export' }],
      ['job-history', { kind: 'bulk' }], ['job-history', { kind: 'transfer' }],
    ] as const) {
      expect(JSON.stringify(await call(tool, args))).not.toContain('BRAVO')
      expect(JSON.stringify(await call(tool, args, everything(B)))).toContain('BRAVO')
    }
    const bravoView = await inside(B, () => database.client.savedView.findFirst({ where: { userId: ME, surface: 'products' }, select: { id: true } }))
    expect(bravoView).toBeTruthy()
    expect(await call('product-search', { savedViewId: bravoView!.id })).toEqual({ ok: false, error: 'Saved view not found' })
    expect((await call('product-search', { savedViewId: bravoView!.id }, everything(B))).ok).toBe(true)
  })
})
