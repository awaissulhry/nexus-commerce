/**
 * Audit B28 (2026-09-30) — a quiet read replaced EVERY grid row: the rows are cached by the server row object
 * (`withRowIdentity`), and each read decodes new objects, so AG re-rendered all 105 rows of GALE eBay IT after a save
 * that changed one. A read now keeps each row the server returned unchanged as the same object.
 * Measured on the recorded color-variant save (ground truth), padded to the real sheet's 105 rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withRowIdentity } from './rows'
import { keepUnchangedRows } from './useChannelSheet'
import type { ChannelScopePage, StudioRow } from './types'

const CASES: Array<{ name: string; before: StudioRow[]; after: StudioRow[] }> = JSON.parse(readFileSync(join(__dirname, 'savedCellPatch.ground-truth.json'), 'utf8'))
const page = (rows: StudioRow[]) => ({ rows, columns: [], aliases: [], scope: { channel: 'EBAY', marketplace: 'IT' }, meta: { schemaMissing: [], schemaAge: [] } }) as unknown as ChannelScopePage

describe('a quiet read keeps the rows it did not change', () => {
  const c = CASES.find((x) => x.name === 'color-variant')!
  const siblings = Array.from({ length: 103 }, (_, i) => ({ ...structuredClone(c.before[1]), id: `sibling-${i}`, sku: `SKU-S${i}` }))
  const previous = page([...structuredClone(c.before), ...siblings])
  const read = () => page([...structuredClone(c.after), ...structuredClone(siblings)])

  it('105 rows, one variant saved: 103 grid rows keep their object, the 2 the save moved are new', () => {
    const cache = new WeakMap<object, never>()
    const shown = withRowIdentity(previous.rows, [], cache as never)
    const next = keepUnchangedRows(previous, read())
    const grid = withRowIdentity(next.rows, [], cache as never)
    const kept = grid.filter((row, i) => row === shown[i]).length
    expect([grid.length, kept]).toEqual([105, 103])
    expect(next.rows.slice(0, 2)).toEqual(c.after)
  })
  it('a row whose listing, version or any cell moved is replaced', () => {
    const next = read()
    ;(next.rows[5].values as Record<string, { value: unknown }>)[Object.keys(next.rows[5].values)[0]].value = 'changed elsewhere'
    next.rows[6] = { ...next.rows[6], version: (next.rows[6].version ?? 0) + 1 }
    const kept = keepUnchangedRows(previous, next).rows.map((row, i) => row === previous.rows[i])
    expect(kept.slice(2, 8)).toEqual([true, true, true, false, false, true])
  })
  /**
   * Review WP2 #3 — the value setter changes the GRID row (`p.data.values = …`), never the server row it was built from.
   * A save the server answered `unchanged` (re-typing an override's own value, a title equal to the listing's copy while
   * it follows Master) settles nothing in place and asks for this read to correct the optimistic cell. Before: the read
   * equalled the previous SERVER row, so the grid kept its row and its wrong "pinned" / layer label.
   */
  it('a row the grid changed locally is replaced, even when the read equals the last server row', () => {
    const cache = new WeakMap<object, never>()
    const shown = withRowIdentity(previous.rows, [], cache as never)
    const key = Object.keys(shown[4].values)[0]
    shown[4].values = { ...shown[4].values, [key]: { ...shown[4].values[key], pinned: true, follows: false, source: 'channelExplicit' } }
    const next = keepUnchangedRows(previous, read(), (row) => cache.get(row))
    const grid = withRowIdentity(next.rows, [], cache as never)
    expect(grid[4]).not.toBe(shown[4])
    expect(grid[4].values[key]).toEqual(previous.rows[4].values[key])
    // Every row the grid did not touch still keeps its object.
    expect(grid.filter((row, i) => row === shown[i]).length).toBe(102)
  })
  it('a row of another alias is never taken for this one', () => {
    const next = read()
    next.rows[3] = { ...next.rows[3], aliasId: 'alias-2' }
    expect(keepUnchangedRows(previous, next).rows[3]).toBe(next.rows[3])
  })
})
