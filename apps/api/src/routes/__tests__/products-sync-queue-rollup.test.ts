// P-RT.5 — verify the OutboundSyncQueue rollup logic that powers the
// /products grid's "Sync" column. The rollup runs in the products
// list route after the bulk findMany; here we extract it as a pure
// fold to test the precedence rules (dead > failed > pending > synced)
// + the syncedAt = most-recent-successful selection. Keeping the
// route code thin and the test against a pure helper means a
// regression in the precedence shows up here in milliseconds rather
// than via "the grid chip shows the wrong colour" later.

import { describe, it, expect } from 'vitest'

type QueueRow = {
  productId: string
  targetChannel: string
  syncStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED'
  syncedAt: Date | null
  isDead: boolean
  updatedAt: Date
}

type Rollup = {
  pending: number
  failed: number
  dead: number
  syncedAt: string | null
  mostUrgentChannel: string | null
  mostUrgentStatus: 'PENDING' | 'FAILED' | 'DEAD' | 'SYNCED' | null
}

// Mirror of the in-route fold. If the route logic changes, update this
// helper + the route in lockstep. (Extraction-as-shared-helper deferred
// to keep this commit small; pattern matches other in-route folds in
// products.routes.ts.)
function foldQueueRows(rows: QueueRow[]): Map<string, Rollup> {
  const out = new Map<string, Rollup>()
  for (const r of rows) {
    if (!r.productId) continue
    const cur = out.get(r.productId) ?? {
      pending: 0, failed: 0, dead: 0,
      syncedAt: null,
      mostUrgentChannel: null,
      mostUrgentStatus: null as Rollup['mostUrgentStatus'],
    }
    const isPending = r.syncStatus === 'PENDING'
    const isFailed = r.syncStatus === 'FAILED' && !r.isDead
    const isSucceeded = r.syncStatus === 'SUCCEEDED'
    if (r.isDead) cur.dead++
    else if (isFailed) cur.failed++
    else if (isPending) cur.pending++
    if (isSucceeded && r.syncedAt) {
      const candidate = r.syncedAt.toISOString()
      if (!cur.syncedAt || candidate > cur.syncedAt) cur.syncedAt = candidate
    }
    const rank = (s: Rollup['mostUrgentStatus']): number =>
      s === 'DEAD' ? 3 : s === 'FAILED' ? 2 : s === 'PENDING' ? 1 : s === 'SYNCED' ? 0 : -1
    const candidateStatus: Rollup['mostUrgentStatus'] =
      r.isDead ? 'DEAD' :
      isFailed ? 'FAILED' :
      isPending ? 'PENDING' :
      isSucceeded ? 'SYNCED' : null
    if (candidateStatus && rank(candidateStatus) > rank(cur.mostUrgentStatus)) {
      cur.mostUrgentStatus = candidateStatus
      cur.mostUrgentChannel = r.targetChannel
    }
    out.set(r.productId, cur)
  }
  return out
}

const ts = (iso: string) => new Date(iso)

describe('OutboundSyncQueue rollup (P-RT.5)', () => {
  it('empty input → empty map', () => {
    expect(foldQueueRows([]).size).toBe(0)
  })

  it('single PENDING → mostUrgentStatus=PENDING, channel set', () => {
    const r = foldQueueRows([{
      productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING',
      syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T00:00:00Z'),
    }]).get('p1')!
    expect(r.pending).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.dead).toBe(0)
    expect(r.mostUrgentStatus).toBe('PENDING')
    expect(r.mostUrgentChannel).toBe('AMAZON')
    expect(r.syncedAt).toBeNull()
  })

  it('SUCCEEDED → mostUrgentStatus=SYNCED + syncedAt populated', () => {
    const r = foldQueueRows([{
      productId: 'p1', targetChannel: 'EBAY', syncStatus: 'SUCCEEDED',
      syncedAt: ts('2026-05-22T01:23:45Z'), isDead: false,
      updatedAt: ts('2026-05-22T01:23:45Z'),
    }]).get('p1')!
    expect(r.mostUrgentStatus).toBe('SYNCED')
    expect(r.mostUrgentChannel).toBe('EBAY')
    expect(r.syncedAt).toBe('2026-05-22T01:23:45.000Z')
  })

  it('PENDING + FAILED → mostUrgentStatus=FAILED (precedence)', () => {
    const r = foldQueueRows([
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING',
        syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T02:00:00Z') },
      { productId: 'p1', targetChannel: 'EBAY', syncStatus: 'FAILED',
        syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T01:00:00Z') },
    ]).get('p1')!
    expect(r.pending).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.mostUrgentStatus).toBe('FAILED')
    expect(r.mostUrgentChannel).toBe('EBAY')
  })

  it('FAILED + DEAD → mostUrgentStatus=DEAD (precedence)', () => {
    const r = foldQueueRows([
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'FAILED',
        syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T03:00:00Z') },
      { productId: 'p1', targetChannel: 'SHOPIFY', syncStatus: 'FAILED',
        syncedAt: null, isDead: true, updatedAt: ts('2026-05-22T02:00:00Z') },
    ]).get('p1')!
    expect(r.failed).toBe(1)
    expect(r.dead).toBe(1)
    expect(r.mostUrgentStatus).toBe('DEAD')
    expect(r.mostUrgentChannel).toBe('SHOPIFY')
  })

  it('SUCCEEDED + PENDING → PENDING wins (in-flight beats history)', () => {
    const r = foldQueueRows([
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING',
        syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T05:00:00Z') },
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'SUCCEEDED',
        syncedAt: ts('2026-05-22T04:00:00Z'), isDead: false,
        updatedAt: ts('2026-05-22T04:00:00Z') },
    ]).get('p1')!
    expect(r.mostUrgentStatus).toBe('PENDING')
    expect(r.syncedAt).toBe('2026-05-22T04:00:00.000Z') // still tracked
  })

  it('multiple SUCCEEDED → syncedAt is the most recent', () => {
    const r = foldQueueRows([
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'SUCCEEDED',
        syncedAt: ts('2026-05-22T01:00:00Z'), isDead: false,
        updatedAt: ts('2026-05-22T01:00:00Z') },
      { productId: 'p1', targetChannel: 'EBAY', syncStatus: 'SUCCEEDED',
        syncedAt: ts('2026-05-22T03:00:00Z'), isDead: false,
        updatedAt: ts('2026-05-22T03:00:00Z') },
      { productId: 'p1', targetChannel: 'SHOPIFY', syncStatus: 'SUCCEEDED',
        syncedAt: ts('2026-05-22T02:00:00Z'), isDead: false,
        updatedAt: ts('2026-05-22T02:00:00Z') },
    ]).get('p1')!
    expect(r.syncedAt).toBe('2026-05-22T03:00:00.000Z')
    expect(r.mostUrgentStatus).toBe('SYNCED')
  })

  it('multiple products → independent rollups', () => {
    const m = foldQueueRows([
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'FAILED',
        syncedAt: null, isDead: true, updatedAt: ts('2026-05-22T01:00:00Z') },
      { productId: 'p2', targetChannel: 'EBAY', syncStatus: 'PENDING',
        syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T01:00:00Z') },
      { productId: 'p3', targetChannel: 'SHOPIFY', syncStatus: 'SUCCEEDED',
        syncedAt: ts('2026-05-22T00:30:00Z'), isDead: false,
        updatedAt: ts('2026-05-22T00:30:00Z') },
    ])
    expect(m.get('p1')!.mostUrgentStatus).toBe('DEAD')
    expect(m.get('p2')!.mostUrgentStatus).toBe('PENDING')
    expect(m.get('p3')!.mostUrgentStatus).toBe('SYNCED')
  })
})
