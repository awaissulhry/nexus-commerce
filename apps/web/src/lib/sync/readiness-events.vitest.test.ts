import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readinessInvalidation } from './use-listing-events'

/**
 * Listing readiness rebuild §3 — `readiness.updated` ({ rootProductId }) crosses the SSE bridge as its own invalidation
 * type with the family root, so the Listing readiness page re-reads that family alone. The hook opens an EventSource, so
 * its wiring is pinned by its source (as `listingValuesWiring`): a type the bridge does not name reaches no one.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const bridge = read('./use-listing-events.ts')
const channel = read('./invalidation-channel.ts')

describe('readinessInvalidation', () => {
  it('forwards the family root as its own invalidation type, id and meta', () => {
    expect(readinessInvalidation({ rootProductId: 'fam-1' })).toEqual({
      type: 'readiness.updated', id: 'fam-1', meta: { source: 'sse', rootProductId: 'fam-1' },
    })
  })
  it('a payload with no usable root forwards nothing', () => {
    expect(readinessInvalidation({})).toBeNull()
    expect(readinessInvalidation({ rootProductId: '' })).toBeNull()
    expect(readinessInvalidation({ rootProductId: 7 })).toBeNull()
  })
})

describe('the SSE bridge carries readiness.updated', () => {
  it('is a named listener type', () => {
    const named = bridge.slice(bridge.indexOf('const namedTypes'), bridge.indexOf('for (const t of namedTypes)'))
    expect(named).toContain("'readiness.updated'")
  })
  it('its branch emits the mapping, never a Products-list type', () => {
    const start = bridge.indexOf("parsed.type === 'readiness.updated'")
    expect(start).toBeGreaterThan(-1)
    const branch = bridge.slice(start, bridge.indexOf('} else if', start))
    expect(branch).toContain('readinessInvalidation(parsed)')
    expect(branch).toContain('emitInvalidation(invalidation)')
    expect(branch).not.toMatch(/type: '(product|listing|stock)\./)
  })
  it('is an invalidation type', () => {
    expect(channel).toMatch(/\|\s*'readiness\.updated'/)
  })
})
