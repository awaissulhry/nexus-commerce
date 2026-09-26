/**
 * Two route-level contracts of the import routes (CFI, 2026-09-25):
 *
 * 1. 🔴 Interrupted imports are recovered in EVERY business. With business profiles on (production since
 *    2026-09-16) the 30 s recovery timer ran both recoverers outside any business profile, so both threw "Select a
 *    business profile." and an import interrupted by a restart or deploy was never resumed.
 * 2. The catalog page's preview accepts an empty marketplace ("use the file's marketplace") and stages the job with
 *    the marketplace the reader actually used.
 *
 * The recoverers, the reader and the stager are replaced by recording stubs; the business sweep and the business
 * context are the real ones, over a stubbed `Workspace` table.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { workspaceContext } from '../../lib/workspace-context.js'

const seen = vi.hoisted(() => ({ recoveries: [] as { recoverer: string; workspaceId: string | null }[], failIn: null as string | null, reads: [] as { market: string }[], staged: [] as { market: string }[] }))
vi.mock('../../db.js', () => ({ default: { workspace: { findMany: async () => [{ id: 'ws-a' }, { id: 'ws-b' }] } } }))
vi.mock('./catalog-transfer.service.js', async importOriginal => ({ ...await importOriginal<object>(), recoverCatalogTransfers: async () => {
  const workspaceId = workspaceContext()?.workspaceId ?? null
  seen.recoveries.push({ recoverer: 'catalog-transfers', workspaceId })
  if (workspaceId && workspaceId === seen.failIn) throw new Error(`recovery failed in ${workspaceId}`)
} }))
vi.mock('./catalog-transfer-jobs.js', async importOriginal => ({ ...await importOriginal<object>(),
  recoverTransferJobs: async () => { seen.recoveries.push({ recoverer: 'transfer-jobs', workspaceId: workspaceContext()?.workspaceId ?? null }) },
  stageTransferJob: async (input: { market: string }) => { seen.staged.push({ market: input.market }); return { jobId: 'job-1', state: 'PREVIEWING' } } }))
// PSIE — the product sheet's imports are the third recoverer.
vi.mock('./sheet-transfer/sheet-import.service.js', async importOriginal => ({ ...await importOriginal<object>(),
  recoverSheetImports: async () => { seen.recoveries.push({ recoverer: 'sheet-imports', workspaceId: workspaceContext()?.workspaceId ?? null }) },
}))
vi.mock('./catalog-editor-workbook.js', async importOriginal => ({ ...await importOriginal<object>(),
  readCatalogTransferUpload: async (_buffer: Buffer, _filename: string, input: { market: string }) => { seen.reads.push({ market: input.market }); return { rows: [], issues: [], market: input.market || 'DE' } } }))

const { default: routes, recoverImportsInEveryBusiness } = await import('../../routes/catalog-transfer.routes.js')
const workspacesWere = process.env.NEXUS_WORKSPACES_ENABLED
beforeAll(() => { process.env.NEXUS_WORKSPACES_ENABLED = '1' })
afterAll(() => { if (workspacesWere === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED; else process.env.NEXUS_WORKSPACES_ENABLED = workspacesWere })
afterEach(() => { seen.recoveries.length = 0; seen.failIn = null; seen.reads.length = 0; seen.staged.length = 0; vi.useRealTimers() })

describe('interrupted imports are recovered inside every business', () => {
  it('runs every recoverer once per active business, inside that business', async () => {
    await recoverImportsInEveryBusiness()
    expect(seen.recoveries).toEqual([
      { recoverer: 'catalog-transfers', workspaceId: 'ws-a' }, { recoverer: 'transfer-jobs', workspaceId: 'ws-a' }, { recoverer: 'sheet-imports', workspaceId: 'ws-a' },
      { recoverer: 'catalog-transfers', workspaceId: 'ws-b' }, { recoverer: 'transfer-jobs', workspaceId: 'ws-b' }, { recoverer: 'sheet-imports', workspaceId: 'ws-b' },
    ])
  })

  it('logs one business’s failure with its id and still recovers the rest', async () => {
    seen.failIn = 'ws-a'
    const failures: { workspaceId: string | null; recoverer: string }[] = []
    await recoverImportsInEveryBusiness(undefined, failure => failures.push({ workspaceId: failure.workspaceId, recoverer: failure.recoverer }))
    expect(failures).toEqual([{ workspaceId: 'ws-a', recoverer: 'catalog-transfers' }])
    expect(seen.recoveries.map(r => `${r.recoverer}@${r.workspaceId}`)).toEqual(['catalog-transfers@ws-a', 'transfer-jobs@ws-a', 'sheet-imports@ws-a', 'catalog-transfers@ws-b', 'transfer-jobs@ws-b', 'sheet-imports@ws-b'])
  })

  it('the routes’ 30-second timer does exactly that', async () => {
    vi.useFakeTimers()
    const app = Fastify()
    await app.register(routes, { prefix: '/api' })
    await app.ready()
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(seen.recoveries.map(r => `${r.recoverer}@${r.workspaceId}`)).toEqual(['catalog-transfers@ws-a', 'transfer-jobs@ws-a', 'sheet-imports@ws-a', 'catalog-transfers@ws-b', 'transfer-jobs@ws-b', 'sheet-imports@ws-b'])
    } finally { await app.close() }
  })
})

describe('the catalog preview uses the file’s marketplace when none is chosen', () => {
  const app = Fastify()
  beforeAll(async () => {
    await app.register(multipart)
    await app.register(routes, { prefix: '/api' })
    await app.ready()
  })
  afterAll(() => app.close())
  const boundary = 'cfi-market'
  const post = (market: string) => app.inject({ method: 'POST', url: '/api/catalog-transfer/preview', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nupdate\r\n--${boundary}\r\nContent-Disposition: form-data; name="market"\r\n\r\n${market}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="GALE DE.xlsm"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n--${boundary}--\r\n`) })

  it('hands an empty marketplace to the reader and stages the job with the one the reader used', async () => {
    const response = await post('')
    expect(response.statusCode).toBe(201)
    expect(seen.reads).toEqual([{ market: '' }])
    expect(seen.staged).toEqual([{ market: 'DE' }])
  })

  it('still normalises a chosen marketplace and refuses a malformed one', async () => {
    expect((await post('fr')).statusCode).toBe(201)
    expect(seen.reads).toEqual([{ market: 'FR' }])
    expect(seen.staged).toEqual([{ market: 'FR' }])
    const refused = await post('France')
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toBe('Select a marketplace for the attribute dictionary')
  })
})
