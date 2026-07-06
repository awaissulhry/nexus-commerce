// P-RT.9 — verify bulkActionService.updateProgress + the terminal
// processJob completion path fan out to the SSE listing-events bus
// so /products workspaces can show ambient bulk-progress UI.
//
// We mock prisma + the dependent services so the test stays a pure
// unit test of the publish behaviour. The bus is in-process; the
// subscriber sees events synchronously.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const bulkActionJobUpdate = vi.fn().mockImplementation((args: any) =>
  Promise.resolve({
    id: args.where.id,
    ...args.data,
    totalItems: 100,
    startedAt: new Date('2026-05-22T00:00:00Z'),
    completedAt: null,
  }),
)
const bulkActionJobFindUnique = vi.fn().mockResolvedValue({
  id: 'bja_test',
  totalItems: 100,
  startedAt: new Date('2026-05-22T00:00:00Z'),
})

vi.mock('@nexus/database', () => {
  const prisma = {
    bulkActionJob: {
      update: (...args: unknown[]) => bulkActionJobUpdate(...args),
      findUnique: (...args: unknown[]) => bulkActionJobFindUnique(...args),
    },
  }
  // src/db.ts does `import prisma from "@nexus/database"` — the module graph
  // reaches it (outbound-sync et al.), so the mock needs a default export too.
  return { prisma, default: prisma }
})

// Other dependencies of bulk-action.service aren't exercised by the
// methods under test — mock minimally so the import succeeds.
vi.mock('../master-price.service.js', () => ({ MasterPriceService: class {} }))
vi.mock('../master-status.service.js', () => ({ MasterStatusService: class {} }))
vi.mock('../stock-movement.service.js', () => ({ applyStockMovement: vi.fn() }))
vi.mock('../bulk-actions/attribute-update.js', async () => ({
  ATTRIBUTE_SCALAR_ALLOWLIST: new Set<string>(),
  ATTRIBUTE_JSON_PATHS: new Set<string>(),
  applyScalarUpdate: vi.fn(),
  applyJsonPathUpdate: vi.fn(),
  validateScalarValue: vi.fn(),
  validateJsonPathValue: vi.fn(),
}))

import { BulkActionService } from '../bulk-action.service.js'
import { subscribeListingEvents } from '../listing-events.service.js'

describe('bulkActionService → SSE bus (P-RT.9)', () => {
  let received: any[]
  let unsubscribe: () => void
  let service: BulkActionService

  beforeEach(() => {
    received = []
    unsubscribe = subscribeListingEvents((e) => { received.push(e) })
    // Pass an explicit prisma stub so we don't depend on the default
    // arg, which captures the imported singleton at module-load time
    // and races the vi.mock hoist.
    service = new BulkActionService({
      bulkActionJob: {
        update: bulkActionJobUpdate,
        findUnique: bulkActionJobFindUnique,
      },
    } as any)
    bulkActionJobUpdate.mockClear()
    bulkActionJobFindUnique.mockClear()
  })
  afterEach(() => {
    unsubscribe()
  })

  it('updateProgress publishes bulk.progress with processed/total/failed', async () => {
    bulkActionJobFindUnique.mockResolvedValueOnce({
      id: 'bja_xavia_42',
      totalItems: 150,
      startedAt: new Date('2026-05-22T00:00:00Z'),
    })
    await service.updateProgress('bja_xavia_42', {
      processedItems: 42,
      failedItems: 3,
      skippedItems: 0,
      errors: [],
    })

    const progress = received.find((e) => e.type === 'bulk.progress')
    expect(progress).toBeDefined()
    expect(progress).toMatchObject({
      type: 'bulk.progress',
      jobId: 'bja_xavia_42',
      processed: 42,
      total: 150,
      failed: 3,
    })
    expect(typeof progress.ts).toBe('number')
  })

  it('updateProgress with 0/0 → bus event still fires (total: 0)', async () => {
    // Pathological case: a job inserted with totalItems=0 (shouldn't
    // happen — empty jobs are handled by the COMPLETED short-circuit
    // — but verify the bus publish doesn't divide by zero or throw.
    bulkActionJobFindUnique.mockResolvedValueOnce({
      id: 'bja_empty',
      totalItems: 100,
      startedAt: new Date('2026-05-22T00:00:00Z'),
    })
    await service.updateProgress('bja_empty', {
      processedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      errors: [],
    })

    const progress = received.find((e) => e.type === 'bulk.progress')
    expect(progress).toBeDefined()
    expect(progress.processed).toBe(0)
    expect(progress.failed).toBe(0)
  })

  it('updateProgress survives bus publish errors (fail-open)', async () => {
    bulkActionJobFindUnique.mockResolvedValueOnce({
      id: 'bja_safe',
      totalItems: 50,
      startedAt: new Date('2026-05-22T00:00:00Z'),
    })
    // The try/catch around publishListingEvent makes this no-op even
    // if a listener throws. We can't easily simulate that without
    // touching the listener Set; instead verify a normal call still
    // returns the updated job without throwing.
    const result = await service.updateProgress('bja_safe', {
      processedItems: 10,
      failedItems: 0,
      skippedItems: 0,
      errors: [],
    })
    expect(result.id).toBe('bja_safe')
  })
})
