import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Amazon sheet gaps — the SSE bridge maps event types EXPLICITLY: a type it does not name reaches no one, whatever the
 * server publishes. The hook opens an EventSource, so it is pinned here by its source (as `publication/eventWiring`):
 * the named listeners, the mapping branches and the invalidation types must all exist, and the stock fact must stay
 * narrow — about 20 stock pages refresh whole grids on 'stock.adjusted'.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const bridge = read('../../../../../lib/sync/use-listing-events.ts')
const channel = read('../../../../../lib/sync/invalidation-channel.ts')
const useMatrix = read('./matrix/useMatrix.ts')

const branchOf = (type: string) => {
  const start = bridge.indexOf(`parsed.type === '${type}'`)
  expect(start).toBeGreaterThan(-1)
  const next = bridge.indexOf('} else if', start)
  return bridge.slice(start, next === -1 ? undefined : next)
}

describe('listing.values_changed and inventory.stock_changed reach the studio', () => {
  it('both are named SSE listener types', () => {
    const named = bridge.slice(bridge.indexOf('const namedTypes'), bridge.indexOf('for (const t of namedTypes)'))
    expect(named).toContain("'listing.values_changed'")
    expect(named).toContain("'inventory.stock_changed'")
  })
  it('listing.values_changed is mapped onto its own invalidation type with the payload in meta', () => {
    const branch = branchOf('listing.values_changed')
    expect(branch).toMatch(/emitInvalidation\(\{\s*type: 'listing\.values_changed'/)
    for (const field of ['productId', 'listings', 'fields']) expect(branch).toContain(`${field}: parsed.${field}`)
  })
  it('🔴 the stock branch emits the NARROW type, never stock.adjusted', () => {
    const branch = branchOf('inventory.stock_changed')
    expect(branch).toMatch(/emitInvalidation\(\{\s*type: 'inventory\.stock_changed'/)
    expect(branch).not.toMatch(/type: 'stock\.adjusted'/)
  })
  it('both are invalidation types', () => {
    expect(channel).toMatch(/\|\s*'listing\.values_changed'/)
    expect(channel).toMatch(/\|\s*'inventory\.stock_changed'/)
  })
})

describe('the Matrix is wired to the live rule', () => {
  it('subscribes through useListingValuesLive and tells the other windows after an applied write', () => {
    expect(useMatrix).toContain('useListingValuesLive({')
    expect(useMatrix).toMatch(/emitInvalidation\(\{ type: 'listing\.values_changed'[^)]*source: 'local'/)
  })
  it('writes name the read\'s account and each cell\'s listing; a conflict says the one sentence', () => {
    expect(useMatrix).toContain('patchMatrix(productId, cells.map((c) => withListing(c, current)), { accountId })')
    expect(useMatrix).toContain('MATRIX_COPY.changedElsewhere')
    expect(useMatrix).not.toContain("'Changed elsewhere — reloaded'")
  })
})
