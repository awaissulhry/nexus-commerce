import { describe, expect, it } from 'vitest'

import type { MatrixWriteOutcome } from './contract'
import { afterLiveWrite, refusalLead, refusedRowIds, refusedTooltip, type RefusedMark } from './refusals'

/**
 * A refused Matrix write shows what is SAVED and says WHY (found by the combined end-to-end run, 2026-09-30: a typed
 * Amazon EU quantity refused as "Amazon-managed" kept the typed 8 on screen, its hover said "Pinned at 8 · …", the
 * reason appeared nowhere and "1 refused" led nowhere). The browser check on a private stack is the proof of the
 * wiring; these are the rules it rests on.
 */
const outcome = (o: MatrixWriteOutcome['outcome'], reason?: string): MatrixWriteOutcome =>
  ({ rowId: 'r', coordinateKey: 'AMAZON:EU', cell: 'syncQty', outcome: o, version: 1, ...(reason ? { reason } : {}) })

describe('afterLiveWrite — what the grid holds after the server answered', () => {
  it('🔴 a refusal RESTORES the stored read: the typed value must not stay on screen as if saved', () => {
    expect(afterLiveWrite([outcome('refused', 'Amazon-managed')])).toBe('restore')
  })
  it('anything that moved re-reads the server, a refusal beside it included', () => {
    expect(afterLiveWrite([outcome('applied')])).toBe('reread')
    expect(afterLiveWrite([outcome('conflict')])).toBe('reread')
    expect(afterLiveWrite([outcome('applied'), outcome('refused', 'Amazon-managed')])).toBe('reread')
  })
  it('a no-op changes nothing', () => {
    expect(afterLiveWrite([outcome('noop')])).toBe('none')
    expect(afterLiveWrite([])).toBe('none')
  })
})

describe('the reason is where the person can read it', () => {
  it('🔴 a refused cell\'s hover LEADS with the reason; the cell\'s own words follow', () => {
    expect(refusedTooltip('Amazon-managed', 'Pinned at 7 · Shared by IT DE')).toBe('Amazon-managed · Pinned at 7 · Shared by IT DE')
    expect(refusedTooltip('Amazon-managed', undefined)).toBe('Amazon-managed')
    expect(refusedTooltip(undefined, 'Pinned at 7')).toBe('Pinned at 7')
  })

  const mark = (rowId: string, reason: string | null): RefusedMark => ({ rowId, coordinate: { label: 'Amazon EU · Inventory · IT DE' }, kind: 'syncQty', reason })
  it('🔴 the footer note carries ONE phrased example — where, which cell, and why', () => {
    expect(refusalLead([mark('v1', 'Amazon-managed')])).toBe('Amazon EU · Inventory · IT DE · Qty — Amazon-managed')
    // The first mark WITH a reason is the example; a mark without one never hides it.
    expect(refusalLead([mark('v1', null), mark('v2', 'Amazon-managed')])).toBe('Amazon EU · Inventory · IT DE · Qty — Amazon-managed')
    expect(refusalLead([mark('v1', null)])).toBe('Amazon EU · Inventory · IT DE · Qty')
    expect(refusalLead([])).toBeUndefined()
  })
  it('the note narrows the grid to the rows that hold a refused cell', () => {
    expect([...refusedRowIds([mark('v1', 'a'), mark('v1', 'b'), mark('v3', 'c')])]).toEqual(['v1', 'v3'])
  })
})
