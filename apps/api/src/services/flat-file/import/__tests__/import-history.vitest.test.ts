/**
 * FF2.8b — Unit tests for import-history.service.ts
 *
 * All tests use a mock prisma — NO real DB is touched.
 * The mock records every call so assertions can verify the exact arguments.
 *
 * Suites:
 *   1. createPreviewRecord — creates with status='PREVIEW', returns id
 *   2. recordApply        — updates with merged apply data (APPLIED / FAILED)
 *   3. getImport          — delegates to findUnique; returns null for missing
 *   4. listImports        — delegates findMany with orderBy createdAt desc
 */

import { describe, it, expect } from 'vitest'
import {
  createPreviewRecord,
  recordApply,
  getImport,
  listImports,
} from '../import-history.service.js'
import type { ImportDiff } from '../diff.js'

// ── Mock helpers ──────────────────────────────────────────────────────────────

/** Minimal ImportDiff for test fixtures (empty but valid). */
function emptyDiff(): ImportDiff {
  return {
    changes: [],
    masterChanges: [],
    deletes: [],
    stats: { adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 },
  }
}

function makeMockPrisma() {
  const calls = {
    creates: [] as any[],
    updates: [] as any[],
    findUniqueCalls: [] as any[],
    findManyCalls: [] as any[],
  }

  let findUniqueReturn: any = null
  let findManyReturn: any[] = []

  const prisma = {
    flatFileImport: {
      create: async (args: any) => {
        calls.creates.push(args)
        // Simulate a created record — return the id that the caller needs.
        return { id: 'mock-id-001' }
      },
      update: async (args: any) => {
        calls.updates.push(args)
        return { id: args.where.id }
      },
      findUnique: async (args: any) => {
        calls.findUniqueCalls.push(args)
        return findUniqueReturn
      },
      findMany: async (args: any) => {
        calls.findManyCalls.push(args)
        return findManyReturn
      },
    },
    _calls: calls,
    _setFindUniqueReturn(v: any) { findUniqueReturn = v },
    _setFindManyReturn(v: any[]) { findManyReturn = v },
  }

  return prisma
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('createPreviewRecord', () => {
  it('creates a record with status PREVIEW and returns the id', async () => {
    const mock = makeMockPrisma()

    const result = await createPreviewRecord(mock, {
      channel: 'AMAZON',
      markets: ['IT'],
      includeMaster: false,
      snapshotId: 'snap-abc',
      filename: 'xavia.xlsx',
      uploadHandle: 'local:xavia.xlsx',
      diff: emptyDiff(),
    })

    expect(result.id).toBe('mock-id-001')
    expect(mock._calls.creates).toHaveLength(1)

    const createArg = mock._calls.creates[0]
    expect(createArg.data.channel).toBe('AMAZON')
    expect(createArg.data.status).toBe('PREVIEW')
    expect(createArg.data.snapshotId).toBe('snap-abc')
    expect(createArg.data.filename).toBe('xavia.xlsx')
    expect(createArg.data.uploadHandle).toBe('local:xavia.xlsx')
    expect(createArg.data.markets).toEqual(['IT'])
    expect(createArg.data.includeMaster).toBe(false)
    // Select: id only
    expect(createArg.select).toEqual({ id: true })
  })

  it('nulls optional fields when omitted', async () => {
    const mock = makeMockPrisma()
    await createPreviewRecord(mock, {
      channel: 'EBAY',
      markets: 'ALL',
      includeMaster: true,
      diff: emptyDiff(),
    })

    const createArg = mock._calls.creates[0]
    expect(createArg.data.snapshotId).toBeNull()
    expect(createArg.data.filename).toBeNull()
    expect(createArg.data.uploadHandle).toBeNull()
    expect(createArg.data.markets).toBe('ALL')
    expect(createArg.data.includeMaster).toBe(true)
  })
})

describe('recordApply', () => {
  it('updates the record with apply data — APPLIED status', async () => {
    const mock = makeMockPrisma()
    const inverseCell = { model: 'Product' as const, sku: 'XAVIA-001', data: { name: 'old' } }

    await recordApply(mock, 'import-xyz', {
      inverseDiff: [inverseCell],
      appliedCount: 5,
      skippedCount: 1,
      failedCount: 0,
      status: 'APPLIED',
      reportHandle: 'local:report-xyz.xlsx',
    })

    expect(mock._calls.updates).toHaveLength(1)
    const updateArg = mock._calls.updates[0]
    expect(updateArg.where).toEqual({ id: 'import-xyz' })
    expect(updateArg.data.status).toBe('APPLIED')
    expect(updateArg.data.appliedCount).toBe(5)
    expect(updateArg.data.skippedCount).toBe(1)
    expect(updateArg.data.failedCount).toBe(0)
    expect(updateArg.data.reportHandle).toBe('local:report-xyz.xlsx')
    expect(updateArg.data.inverseDiff).toEqual([inverseCell])
  })

  it('updates with FAILED status and null reportHandle when not provided', async () => {
    const mock = makeMockPrisma()

    await recordApply(mock, 'import-abc', {
      inverseDiff: [],
      appliedCount: 0,
      skippedCount: 0,
      failedCount: 3,
      status: 'FAILED',
    })

    const updateArg = mock._calls.updates[0]
    expect(updateArg.data.status).toBe('FAILED')
    expect(updateArg.data.failedCount).toBe(3)
    expect(updateArg.data.reportHandle).toBeNull()
  })
})

describe('getImport', () => {
  it('delegates to findUnique and returns the record', async () => {
    const mock = makeMockPrisma()
    const fakeRecord = { id: 'imp-1', channel: 'AMAZON', status: 'PREVIEW' }
    mock._setFindUniqueReturn(fakeRecord)

    const result = await getImport(mock, 'imp-1')

    expect(result).toEqual(fakeRecord)
    expect(mock._calls.findUniqueCalls).toHaveLength(1)
    expect(mock._calls.findUniqueCalls[0].where).toEqual({ id: 'imp-1' })
  })

  it('returns null when not found', async () => {
    const mock = makeMockPrisma()
    mock._setFindUniqueReturn(null)

    const result = await getImport(mock, 'nonexistent')
    expect(result).toBeNull()
  })
})

describe('listImports', () => {
  it('orders by createdAt desc and applies default limit 50', async () => {
    const mock = makeMockPrisma()
    mock._setFindManyReturn([])

    await listImports(mock)

    expect(mock._calls.findManyCalls).toHaveLength(1)
    const arg = mock._calls.findManyCalls[0]
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.take).toBe(50)
    expect(arg.where).toBeUndefined()
  })

  it('applies channel filter when provided', async () => {
    const mock = makeMockPrisma()
    mock._setFindManyReturn([])

    await listImports(mock, { channel: 'EBAY' })

    const arg = mock._calls.findManyCalls[0]
    expect(arg.where).toEqual({ channel: 'EBAY' })
  })

  it('respects a custom limit', async () => {
    const mock = makeMockPrisma()
    mock._setFindManyReturn([])

    await listImports(mock, { limit: 10 })

    const arg = mock._calls.findManyCalls[0]
    expect(arg.take).toBe(10)
  })

  it('returns the records in order', async () => {
    const mock = makeMockPrisma()
    const records = [
      { id: 'a', createdAt: new Date('2026-07-06') },
      { id: 'b', createdAt: new Date('2026-07-05') },
    ]
    mock._setFindManyReturn(records)

    const result = await listImports(mock)
    expect(result).toEqual(records)
  })
})
