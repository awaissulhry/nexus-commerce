import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Step 2 — the SSE bridge maps event types EXPLICITLY: a type it does not name reaches no one, whatever the server
 * publishes (`use-listing-events.ts`, the `inventory.stock_changed` note). The hook opens an EventSource, so it is
 * pinned here by its source: the named listener, the mapping branch and the invalidation type must all exist.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const bridge = read('../../../../lib/sync/use-listing-events.ts')
const channel = read('../../../../lib/sync/invalidation-channel.ts')

describe('publication.status_changed reaches the studio', () => {
  it('is a named SSE listener type', () => {
    const named = bridge.slice(bridge.indexOf('const namedTypes'), bridge.indexOf('for (const t of namedTypes)'))
    expect(named).toContain("'publication.status_changed'")
  })
  it('is mapped onto the invalidation channel with its destination in meta', () => {
    const branch = bridge.slice(bridge.indexOf("parsed.type === 'publication.status_changed'"))
    expect(branch.slice(0, 700)).toMatch(/emitInvalidation\(\{\s*type: 'publication\.status_changed'/)
    for (const field of ['publicationId', 'productId', 'channel', 'marketplace', 'accountId', 'aliasKey', 'status', 'terminal']) {
      expect(branch.slice(0, 700)).toContain(`${field}: parsed.${field}`)
    }
  })
  it('is an invalidation type', () => {
    expect(channel).toMatch(/\|\s*'publication\.status_changed'/)
  })
})
