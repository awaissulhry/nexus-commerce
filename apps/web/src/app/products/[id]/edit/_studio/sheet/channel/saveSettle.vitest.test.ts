/**
 * P2 review (2026-09-30) — the channel sheet's bookkeeping after a save, finding by finding.
 *   1. A row's save settles in place only when EVERY cell it sent was reported patched.
 *   3. A follow-up read that is dropped stays owed and is tried again.
 *   4. A save that touched the shared record asks for the family's readiness, not the coordinate's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FollowUpRead, keepUnsettledCells, rowSettle } from './saveSettle'
import type { ChannelScopePage, ChannelSheetRow, StudioCellValue } from './types'
import type { CellSaveState } from '@/design-system/grid'

const cell = (over: Partial<StudioCellValue>): StudioCellValue => ({
  value: 'x', source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel', pinned: true, follows: false, editable: true,
  linkGroupId: null, mapped: null, writeField: 'attr_x', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true,
  writeBlockedReason: null, ...over,
} as StudioCellValue)
const row = (values: Record<string, StudioCellValue>) => ({ rowId: 'r1', id: 'p1', sku: 'SKU-1', rowKind: 'variant', values } as unknown as ChannelSheetRow)

describe('review 1 — every part of a row save must settle in place', () => {
  const r = row({ variation_theme: cell({ writeField: 'variationTheme' }), subtitle: cell({ writeField: 'attr_subtitle' }) })
  const req = { row: r, cells: [{ colId: 'variation_theme', value: {}, intent: 'set' as const }, { colId: 'subtitle', value: 'B', intent: 'set' as const }] }

  it('a paste of a theme cell and a listing cell: the theme part reports nothing, so the sheet reads', () => {
    const save = rowSettle(req)
    save.onStored({ patched: [r], columns: ['subtitle'] })
    expect(save.inPlace(true)).toBeNull()
  })
  it('every cell reported patched: settled in place, with the rows and columns to repaint', () => {
    const save = rowSettle(req)
    save.onStored({ patched: [r], columns: ['subtitle'] })
    save.onStored({ patched: [r], columns: ['variation_theme'] })
    expect(save.inPlace(true)).toEqual({ rows: new Set([r]), columns: new Set(['subtitle', 'variation_theme']) })
  })
  it('one part asking for a read, or a refused save, reads', () => {
    const save = rowSettle(req)
    save.onStored({ patched: [r], columns: ['subtitle', 'variation_theme'] })
    save.onStored({ read: 'a clear' })
    expect(save.inPlace(true)).toBeNull()
    const other = rowSettle(req)
    other.onStored({ patched: [r], columns: ['subtitle', 'variation_theme'] })
    expect(other.inPlace(false)).toBeNull()
  })
})

describe('review 3 — a dropped follow-up read stays owed', () => {
  const harness = (idle: () => boolean, answers: boolean[]) => {
    const timers: Array<() => void> = []
    let reads = 0
    const follow = new FollowUpRead({
      idle, sequence: () => 1, schedule: (run) => { timers.push(run); return () => timers.splice(timers.indexOf(run), 1) },
      read: async (canApply) => { reads++; return (answers.shift() ?? true) && canApply() },
    })
    return { follow, timers, reads: () => reads }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a read the sheet could not apply (an editor open, a newer write) is owed again and tried again', async () => {
    const h = harness(() => true, [false, true])
    h.follow.owe()
    h.follow.settle()
    await flush()
    expect(h.follow.isOwed).toBe(true)
    expect(h.timers).toHaveLength(1)
    h.timers[0]()
    await flush()
    expect(h.reads()).toBe(2)
    expect(h.follow.isOwed).toBe(false)
  })
  it('a failed fetch is owed again', async () => {
    const timers: Array<() => void> = []
    const follow = new FollowUpRead({ idle: () => true, sequence: () => 1, schedule: (run) => { timers.push(run); return () => {} }, read: () => Promise.reject(new TypeError('offline')) })
    follow.owe()
    follow.settle()
    await flush()
    expect(follow.isOwed).toBe(true)
    expect(timers).toHaveLength(1)
  })
  it('while the sheet is busy nothing is fetched; the read waits for it', async () => {
    let idle = false
    const h = harness(() => idle, [true])
    h.follow.owe()
    h.follow.settle()
    expect(h.reads()).toBe(0)
    idle = true
    h.timers[0]()
    await flush()
    expect(h.reads()).toBe(1)
    expect(h.follow.isOwed).toBe(false)
  })
  it('nothing owed, nothing read', () => {
    const h = harness(() => true, [])
    h.follow.settle()
    expect(h.reads()).toBe(0)
  })
})

describe('review 4 — a save that touched the shared record reads the family readiness', () => {
  it('a master field on the channel sheet touches master; a listing cell does not', () => {
    const r = row({ price: cell({ writeField: 'price', writeTarget: 'master', writeVerb: 'master' }), subtitle: cell({}) })
    expect(rowSettle({ row: r, cells: [{ colId: 'subtitle', value: 'x', intent: 'set' }] }).touchesMaster()).toBe(false)
    expect(rowSettle({ row: r, cells: [{ colId: 'subtitle', value: 'x', intent: 'set' }, { colId: 'price', value: 1, intent: 'set' }] }).touchesMaster()).toBe(true)
  })
  it('a content edit saved to every channel touches master; a pin on this listing does not', () => {
    const acknowledgement = { shared: { label: 'Save to all channels', address: { tier: 'language' } }, pin: { label: 'Pin', address: { tier: 'pin' } }, reach: [] }
    const shared = row({ name: cell({ contentAcknowledgement: acknowledgement as never, contentAddress: { tier: 'language' } as never }) })
    const pinned = row({ name: cell({ contentAcknowledgement: acknowledgement as never, contentAddress: { tier: 'pin' } as never }) })
    expect(rowSettle({ row: shared, cells: [{ colId: 'name', value: 'x', intent: 'set' }] }).touchesMaster()).toBe(true)
    expect(rowSettle({ row: pinned, cells: [{ colId: 'name', value: 'x', intent: 'set' }] }).touchesMaster()).toBe(false)
  })
  it('the channel sheet asks for the family readiness after such a save', () => {
    const src = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(src).toContain('if (save.touchesMaster()) readinessForFamily.current = true')
    expect(src).toMatch(/refreshReadiness\(family \? undefined : \{ coordinate: true \}\)/)
  })
})

describe('the channel sheet uses these rules (the adapter cannot run without a grid)', () => {
  it('settles a row in place only by rowSettle, and owes every other save one follow-up read', () => {
    const src = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(src).toContain('const save = rowSettle(req);')
    expect(src).toContain('onStored: (outcome) => save.onStored(outcome),')
    expect(src).toContain('const inPlace = save.inPlace(result.ok);')
    expect(src).toContain('else if (result.ok) followUp.owe();')
    expect(src).not.toMatch(/needsRead/)
  })
})

/**
 * G1 (2026-10-13) — after any refused cell the quiet read after a save was skipped (`!tracker.hasUnconfirmedChanges`), so
 * variations went on showing the value they inherited before the family's save. The read now waits only for edits on
 * their way, and a refused cell keeps the value it shows (and its mark) through it.
 */
describe('G1 — a quiet read lands over a refused cell, and keeps that cell', () => {
  const server = (aliasId: string | null, id: string, values: Record<string, StudioCellValue>) => ({ id, aliasId, values })
  const shown = (rowId: string, values: Record<string, StudioCellValue>) => ({ rowId, values } as unknown as ChannelSheetRow)
  const states: Record<string, CellSaveState> = { 'primary:M::gtin': 'refused', 'primary:L::cost': 'saved' }
  const stateOf = (rowId: string, colId: string) => states[`${rowId}::${colId}`]

  it('keeps the refused cell as shown; every other cell, and every row not on screen, is the read\'s', () => {
    const page = { rows: [
      server(null, 'M', { gtin: cell({ value: null }), manufacturer: cell({ value: 'ParentCo2', inherited: true }) }),
      server(null, 'L', { cost: cell({ value: '9.00' }), manufacturer: cell({ value: 'ParentCo2', inherited: true }) }),
      server('alias-2', 'M', { gtin: cell({ value: null }) }),
    ] } as unknown as ChannelScopePage
    const refusedCell = cell({ value: '123' })
    const next = keepUnsettledCells(page, [
      shown('primary:M', { gtin: refusedCell, manufacturer: cell({ value: null, inherited: true }) }),
      shown('primary:L', { cost: cell({ value: '9' }), manufacturer: cell({ value: null, inherited: true }) }),
    ], stateOf)
    expect(next.rows[0]!.values.gtin).toBe(refusedCell)
    expect(next.rows[0]!.values.manufacturer!.value).toBe('ParentCo2')
    expect(next.rows[1]).toBe(page.rows[1])
    expect(next.rows[2]).toBe(page.rows[2])
  })

  it('the channel and Shared sheets gate their quiet reads on edits still on their way, never on a refused cell', () => {
    const channel = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(channel).not.toMatch(/hasUnconfirmedChanges/)
    expect(channel).toContain('keepUnsettledCells(page, rowsRef.current')
    expect(channel).toContain('idle: () => writerRef.current?.pending === 0 && !tracker.hasOpenChanges')
    expect(channel).toContain('read: (canApply) => quietRefresh(canApply),')
    const master = readFileSync(join(__dirname, '..', 'master', 'useMasterSheet.ts'), 'utf8')
    expect(master).not.toMatch(/hasUnconfirmedChanges/)
    expect(master.match(/hasOpenChanges/g)).toHaveLength(3)
    // The Shared scope's quiet read keeps a refused cell's value (as `keepUnsettledCells` does here).
    expect(master).toContain("if (state && ['refused', 'unknown', 'saving', 'pending'].includes(state) && previous.values[key]) row.values[key] = previous.values[key]")
    // Review of #607, finding 2 — a full read (Reload, "changed elsewhere — refresh") takes the refusal marks with the values.
    expect(master).toContain('for (const row of next.rows) for (const key of Object.keys(row.values)) writer.forgetRefused(row.id, key)')
  })
})

describe('G2/G3 — both sheets record an edit with its state and keep it only when it is stored', () => {
  it('passes the edit\'s outcome to the history, and replays an inherited "before" through the reset', () => {
    for (const file of [join(__dirname, 'useChannelSheetAdapter.tsx'), join(__dirname, '..', 'master', 'useMasterSheetAdapter.tsx')]) {
      const src = readFileSync(file, 'utf8')
      expect(src).toMatch(/onOutcome: undo\.edit\(|const onOutcome = undo\.edit\(/)
      expect(src).toMatch(/stateBefore\(e\.oldValue, (e\.data|row), colId!?, takeEditPrior\(/)
      expect(src).toContain('useSheetUndo(writer, getGridApi, { tracker, resetCell: resetCellBack })')
      expect(src).toContain('writer.set(rowId, colId, null, { row, intent: before.intent, onOutcome });')
      expect(src).not.toMatch(/undo\.record\(/)
      // Review of #607, finding 4 — an edit dropped while formulas loaded, and a refused (or unanswered) formula save,
      // tell the history the cell shows a value the server does not hold.
      expect(src.match(/undo\.unsaved\(/g)).toHaveLength(3)
      expect(src).toMatch(/'refused', reason \?\? HELD_EDIT_DROPPED\);\s*\/\/[^\n]*\n\s*undo\.unsaved\(/)
    }
    // Review of #607, finding 1 — a channel list position reads its list's other positions before recording a list reset.
    expect(readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')).toContain('listPositions(row, colId, ')
  })
})
