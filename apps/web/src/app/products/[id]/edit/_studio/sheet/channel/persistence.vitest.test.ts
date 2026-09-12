/**
 * §9.5a — what a channel scope remembers, and the two things it must not.
 */
import { describe, expect, it } from 'vitest'

import { revealDistance } from '../../drawer/revealCell'
import { PERSISTED_STATE_KEYS, channelSurfaceKey, hasPersistedState, pickPersisted } from './persistence'

const fullState = {
  columnOrder: { orderedColIds: ['a', 'b'] },
  columnSizing: { columnSizingModel: [{ colId: 'a', width: 200 }] },
  columnVisibility: { hiddenColIds: ['c'] },
  columnPinning: { leftColIds: ['a'] },
  sort: { sortModel: [{ colId: 'a', sort: 'asc' }] },
  scroll: { top: 0, left: 1227 },
  rowSelection: ['r1', 'r2'],
  filter: { filterModel: { a: {} } },
} as never

describe('the key carries the coordinate', () => {
  /**
   * 🔴 Channels declare different column sets, so one key for all of them lands eBay's widths on
   * Amazon's columns — and a wrong key that has already written entries is worse than no key,
   * because the entries look like preferences someone set.
   */
  it('separates two channels on the same market', () => {
    expect(channelSurfaceKey('EBAY', 'IT')).not.toBe(channelSurfaceKey('AMAZON', 'IT'))
  })

  it('separates two markets on the same channel', () => {
    expect(channelSurfaceKey('AMAZON', 'IT')).not.toBe(channelSurfaceKey('AMAZON', 'DE'))
  })

  it('is stable under case, so a lowercase route param cannot orphan an entry', () => {
    expect(channelSurfaceKey('ebay', 'it')).toBe(channelSurfaceKey('EBAY', 'IT'))
  })

  it('is not master-shaped', () => {
    expect(channelSurfaceKey('EBAY', 'IT')).toBe('product-edit:EBAY:IT')
  })
})

describe('🔴 horizontal scroll and selection are NOT persisted', () => {
  const kept = pickPersisted(fullState)

  it('drops scroll — a restored scroll silently undoes the default view’s ordering', () => {
    // §9.2 puts identity, then required-and-incomplete, then the spine on screen first. Restoring
    // where someone happened to stop lands them past all of it, on every load.
    expect(kept).not.toHaveProperty('scroll')
  })

  it('drops selection — restoring one lets a bulk verb run against a set nobody remembers choosing', () => {
    expect(kept).not.toHaveProperty('rowSelection')
  })

  it('keeps only what the operator set deliberately', () => {
    expect(Object.keys(kept).sort()).toEqual([...PERSISTED_STATE_KEYS].sort())
  })

  it('🔴 is an ALLOW-list: an unknown future key is forgotten, not persisted', () => {
    // An omit-list would silently start storing whatever a new AG version adds — including a new
    // scroll- or selection-shaped key — and stored junk reads as a preference.
    expect(pickPersisted({ ...(fullState as object), somethingNew: { x: 1 } } as never))
      .not.toHaveProperty('somethingNew')
  })

  it('omits an allow-listed key that is absent rather than writing undefined', () => {
    expect(pickPersisted({ sort: { sortModel: [] } } as never)).toEqual({ sort: { sortModel: [] } })
  })
})

describe('an empty state is not a preference', () => {
  it('does not claim state when nothing was kept', () => {
    expect(hasPersistedState(pickPersisted({ scroll: { top: 0, left: 900 } } as never))).toBe(false)
  })

  it('claims it when something was', () => {
    expect(hasPersistedState(pickPersisted(fullState))).toBe(true)
  })
})

describe('#421/#435 — a cell off the LEFT edge scrolls left on the URL path', () => {
  /**
   * The test I withheld at #421 because it would have asserted `0 === 0`: without `cellLeft` /
   * `viewportLeft`, `revealDistance` returned 0 on the reveal branch whatever intent it was given,
   * so "it scrolled left" and "the feature is inert" were the same measurement. AG.1 landed the
   * geometry (`gridScroll.ts` 04:39:37), so the branch can now be exercised for real.
   */
  const geo = { cellLeft: 40, cellRight: 200, viewportLeft: 300, viewportRight: 1660, panelOverlap: 520 }

  it('🔴 returns a NEGATIVE distance for a cell off the left edge under `reveal`', () => {
    const d = revealDistance(geo, 'reveal')
    expect(d).toBeLessThan(0)
  })

  it('returns 0 for the same cell under `uncover` — the default only pushes out from the panel', () => {
    // This is exactly why forwarding the intent mattered: the default answered "nothing to do".
    expect(revealDistance(geo, 'uncover')).toBe(0)
  })

  it('still returns 0 when the cell is comfortably in view', () => {
    expect(revealDistance({ ...geo, cellLeft: 700, cellRight: 860 }, 'reveal')).toBe(0)
  })

  it('🔴 a negative distance must survive the host’s early return', () => {
    // The host used `distance <= 0` and swallowed precisely this case; it is `=== 0` now.
    const d = revealDistance(geo, 'reveal')
    expect(d === 0).toBe(false)
  })
})
