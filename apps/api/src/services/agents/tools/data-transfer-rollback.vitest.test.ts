/**
 * MCP full control P9 — `rollback-bulk-operation` on a bulk job, and both P9 tools at the door, against a real
 * PostgreSQL with the production schema and the business-isolation policies (PGlite). No mocked query.
 *
 * Proven here: the preview names what goes back (each product's value now → the value the job replaced); a product
 * changed since the job wrote it refuses the undo; an unfinished, already undone, unsupported or empty job is refused
 * by name; the run is Nexus's bulk rollback (the product is put back, the job marked undone, a second undo refused); a
 * person without the rollback (or import) permission is refused; and (profiles on) another business's job is not found.
 * Run with business profiles off and with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
// The registry loads every tool, and a change tool imports the queues: no Redis here.
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { callTool, executeTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_p9_rollback_bravo'
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(permissions: string[], workspaceId = A): UserPrincipal {
  return {
    kind: 'user', userId: 'u-p9-rollback', label: 'P9 test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    ...(ON ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
const everything = (workspaceId = A) => principal([...Object.values(FEATURES), ...Object.values(FIELDS)], workspaceId)

type Row = Record<string, any>
const call = async (args: Row, who = everything()) => (await callTool(who, 'rollback-bulk-operation', args)).visible as { ok: boolean; error?: string; preview?: Row }

const ids: Record<string, string> = {}

async function job(name: string, data: Row, items: Row[]) {
  const created = await database.client.bulkActionJob.create({
    data: { jobName: name, actionType: 'PRICING_UPDATE', targetProductIds: items.map(i => i.productId).filter(Boolean), targetVariationIds: [], actionPayload: {}, status: 'COMPLETED', totalItems: items.length, completedAt: new Date('2026-09-30T08:00:00Z'), createdBy: 'u-p9-rollback', ...data },
  })
  for (const item of items) await database.client.bulkActionItem.create({ data: { jobId: created.id, status: 'SUCCEEDED', ...item } })
  return created.id
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(A, async () => {
    const product = await database.client.product.create({ data: { sku: 'TEST-SKU-1', name: 'P9 jacket', basePrice: '19.90', totalStock: 7, status: 'ACTIVE' } })
    const other = await database.client.product.create({ data: { sku: 'TEST-SKU-2', name: 'P9 gloves', basePrice: '9.90', totalStock: 3, status: 'ACTIVE' } })
    ids.product = product.id
    ids.other = other.id
    ids.pricing = await job('P9 price rise', {}, [{ productId: product.id, beforeState: { basePrice: 18 }, afterState: { basePrice: 19.9 } }])
    ids.status = await job('P9 to draft', { actionType: 'STATUS_UPDATE' }, [{ productId: other.id, beforeState: { status: 'DRAFT' }, afterState: { status: 'ACTIVE' } }])
    ids.running = await job('P9 still running', { status: 'IN_PROGRESS' }, [])
    ids.undone = await job('P9 already undone', { rollbackJobId: 'rollback-1' }, [])
    ids.sync = await job('P9 listing sync', { actionType: 'LISTING_SYNC' }, [])
    ids.empty = await job('P9 nothing succeeded', {}, [])
  })
  if (ON) {
    const owner = await database.client.userProfile.create({ data: { email: 'p9-rollback-owner@example.test', status: 'active' } })
    await database.client.workspace.create({ data: { id: B, name: 'Bravo rollback business', createdByUserId: owner.id, creationKey: 'p9-rollback-bravo' } })
  }
  if (ON) await inside(B, async () => {
    const product = await database.client.product.create({ data: { sku: 'TEST-SKU-1', name: 'BRAVO jacket', basePrice: '5.00', totalStock: 1 } })
    ids.bravo = await job('BRAVO price rise', {}, [{ productId: product.id, beforeState: { basePrice: 4 }, afterState: { basePrice: 5 } }])
  })
}, 120_000)

afterAll(async () => { await database?.close() })

describe('rollback-bulk-operation — a bulk job', () => {
  it('previews each product: its value now → the value the job replaced', async () => {
    const out = await inside(A, () => call({ jobId: ids.pricing }))
    expect(out.ok, out.error).toBe(true)
    expect(out.preview).toMatchObject({
      action: 'rollback-bulk-operation', kind: 'bulk', jobId: ids.pricing, job: 'P9 price rise', actionType: 'PRICING_UPDATE',
      counts: { productsPutBack: 1, withoutRecord: 0 },
      changes: [{ sku: 'TEST-SKU-1', from: { basePrice: 19.9 }, to: { basePrice: 18 } }],
    })
  })

  it('refuses an unfinished, already undone, unsupported or empty job, and a job that is not there', async () => {
    await inside(A, async () => {
      expect((await call({ jobId: ids.running })).error).toBe('Not undone: the bulk job "P9 still running" is in_progress; only a finished job can be undone.')
      expect((await call({ jobId: ids.undone })).error).toBe('Not undone: the bulk job "P9 already undone" was already undone (job rollback-1).')
      expect((await call({ jobId: ids.sync })).error).toBe('Not undone: a LISTING_SYNC bulk job cannot be undone; price, stock, status and attribute changes can.')
      expect((await call({ jobId: ids.empty })).error).toBe('Not undone: the bulk job "P9 nothing succeeded" changed nothing that can be put back (no item succeeded).')
      expect((await call({ jobId: 'no-such-job' })).error).toBe('Job not found')
    })
  })

  it('refuses when a product changed since the job wrote it', async () => {
    await inside(A, async () => {
      await database.client.product.update({ where: { id: ids.other }, data: { status: 'INACTIVE' } })
      expect((await call({ jobId: ids.status })).error).toBe('Not undone: 1 product changed since the bulk job "P9 to draft" wrote it (TEST-SKU-2). Undo would overwrite those later changes.')
      await database.client.product.update({ where: { id: ids.other }, data: { status: 'ACTIVE' } })
      expect((await call({ jobId: ids.status })).ok).toBe(true)
    })
  })

  it('runs as Nexus\'s bulk rollback after approval: the value is put back, the job marked undone, a second undo refused', async () => {
    await inside(A, async () => {
      const asked = await call({ jobId: ids.status })
      const ran = await executeTool(everything(), 'rollback-bulk-operation', { jobId: ids.status }, { approvalId: 'ap-p9', approvedPreview: asked.preview, via: 'claude' })
      expect(ran.raw.ok, ran.raw.error).toBe(true)
      expect(ran.raw.data).toMatchObject({ jobId: ids.status, succeeded: 1, failed: 0 })
      expect((await database.client.product.findUnique({ where: { id: ids.other } }))!.status).toBe('DRAFT')
      expect((await database.client.bulkActionJob.findUnique({ where: { id: ids.status } }))!.rollbackJobId).toEqual(expect.any(String))
      expect((await call({ jobId: ids.status })).error).toMatch(/^Not undone: the bulk job "P9 to draft" was already undone/)
    })
  })

  it('a person without the rollback permission is refused; one without the import permission cannot import', async () => {
    await inside(A, async () => {
      const noRollback = principal(Object.values(FEATURES).filter(p => p !== FEATURES.bulkRollback))
      await expect(callTool(noRollback, 'rollback-bulk-operation', { jobId: ids.pricing })).rejects.toBeInstanceOf(ToolAccessError)
      const noImport = principal(Object.values(FEATURES).filter(p => p !== FEATURES.productsImport))
      await expect(callTool(noImport, 'import-catalog', { text: 'SKU,Name\nTEST-SKU-1,x', mapping: { skuColumn: 'SKU', market: 'IT', mode: 'update', bindings: [{ source: 'Name', entity: 'Products', field: 'name' }] } }))
        .rejects.toBeInstanceOf(ToolAccessError)
    })
  })

  it.skipIf(!ON)('another business\'s job is not found, and its rows are untouched', async () => {
    const out = await inside(A, () => call({ jobId: ids.bravo }))
    expect(out).toEqual({ ok: false, error: 'Job not found' })
    expect(JSON.stringify(out)).not.toContain('BRAVO')
    const own = await inside(B, () => call({ jobId: ids.bravo }, everything(B)))
    expect(own.ok, own.error).toBe(true)
  })
})
