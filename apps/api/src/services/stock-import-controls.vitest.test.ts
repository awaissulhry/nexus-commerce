/**
 * SC.4 — spreadsheet control columns: cell grammar + export summarizer.
 */
import { describe, it, expect } from 'vitest'
import { parseFollowCell } from './stock-import.service.js'
import { summarizeControlState } from './stock-import-export.js'

describe('SC.4 — parseFollowCell', () => {
  it('accepts the three modes, case-insensitive, EN+IT', () => {
    expect(parseFollowCell('Follow')).toBe('FOLLOW')
    expect(parseFollowCell('segui')).toBe('FOLLOW')
    expect(parseFollowCell('PINNED')).toBe('PINNED')
    expect(parseFollowCell('bloccato')).toBe('PINNED')
    expect(parseFollowCell('Paused')).toBe('PAUSED')
    expect(parseFollowCell('pausa')).toBe('PAUSED')
  })
  it('empty = null (no control requested); junk = undefined (invalid, counted)', () => {
    expect(parseFollowCell('')).toBeNull()
    expect(parseFollowCell('   ')).toBeNull()
    expect(parseFollowCell(undefined)).toBeNull()
    expect(parseFollowCell('banana')).toBeUndefined()
  })
})

describe('SC.4 — summarizeControlState (export round-trip)', () => {
  const l = (follow: boolean, paused = false) => ({ followMasterQuantity: follow, syncPaused: paused })
  it('Paused wins over everything', () => {
    expect(summarizeControlState([l(true), l(false, true)])).toEqual({ follow: 'Paused' })
  })
  it('all pinned → Pinned; mixed → Mixed; all follow → Follow; none → empty', () => {
    expect(summarizeControlState([l(false), l(false)])).toEqual({ follow: 'Pinned' })
    expect(summarizeControlState([l(true), l(false)])).toEqual({ follow: 'Mixed' })
    expect(summarizeControlState([l(true), l(true)])).toEqual({ follow: 'Follow' })
    expect(summarizeControlState([])).toEqual({ follow: '' })
  })
})

describe('SC.4 — takeover guarantee: plain quantity sheets are control no-ops', () => {
  it('rows without follow/buffer cells return undefined before touching anything', async () => {
    const { applyControlColumns } = await import('./stock-import.service.js')
    const plainRow = {
      raw: 'SKU-1', quantity: 7, productId: 'p1', productName: 'X', resolvedSku: 'SKU-1',
      tier: 'EXACT', candidates: [], currentWarehouseQty: 5, wouldBeWarehouseQty: 7,
      currentChannelQty: null, wouldBeChannelQty: null, channelListings: [], warnings: [], error: null,
    } as never
    // No DB is mocked here — if this ever reaches Prisma or follow-master it throws.
    expect(await applyControlColumns([plainRow], 'job-x')).toBeUndefined()
    // Empty-string / whitespace follow cells are "no control requested", not writes.
    expect(await applyControlColumns([{ ...(plainRow as object), follow: '   ' } as never], 'job-x')).toBeUndefined()
  })
})
