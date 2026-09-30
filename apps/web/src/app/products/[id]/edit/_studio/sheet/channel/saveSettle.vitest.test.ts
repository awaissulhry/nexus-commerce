/**
 * P2 review (2026-09-30) — the channel sheet's bookkeeping after a save, finding by finding.
 *   1. A row's save settles in place only when EVERY cell it sent was reported patched.
 *   3. A follow-up read that is dropped stays owed and is tried again.
 *   4. A save that touched the shared record asks for the family's readiness, not the coordinate's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FollowUpRead, guardedRead, rowSettle, storedSome } from './saveSettle'
import { commitChannelRow } from './useChannelSheet'
import type { ChannelSheetRow, StudioCellValue } from './types'

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

describe('audit A01 — a quiet read that raced a save never puts the old value back', () => {
  const deferred = () => { let resolve!: (v: boolean) => void; const promise = new Promise<boolean>((r) => { resolve = r }); return { promise, resolve } }
  it('a save that starts or settles while the read is on the wire drops it, and the read is owed instead', async () => {
    let sequence = 1, owed = 0
    const wire = deferred()
    let apply: (() => boolean) | null = null
    const read = guardedRead({ sequence: () => sequence, owe: () => { owed++ },
      read: (canApply) => { apply = canApply; return wire.promise.then((fetched) => fetched && canApply()) } }, () => true)
    sequence++ // the operator's edit on row B settles in place while the formula's sheet read is on the wire
    wire.resolve(true)
    expect(await read).toBe(false)
    expect(apply!()).toBe(false)
    expect(owed).toBe(1)
  })
  it('a read no save raced applies, and owes nothing', async () => {
    let owed = 0
    expect(await guardedRead({ sequence: () => 1, owe: () => { owed++ }, read: async (canApply) => canApply() }, () => true)).toBe(true)
    expect(owed).toBe(0)
  })
  it('a read dropped for its own reason (an editor open) is not owed', async () => {
    let owed = 0
    expect(await guardedRead({ sequence: () => 1, owe: () => { owed++ }, read: async (canApply) => canApply() }, () => false)).toBe(false)
    expect(owed).toBe(0)
  })
  it('every quiet read of the channel sheet goes through the guard, and a settled save moves the sequence', () => {
    const src = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    // Only the guard and the follow-up read call the sheet's `refresh` itself.
    expect(src.match(/\brefresh(Ref\.current)?\(/g)).toEqual(['refreshRef.current(', 'refreshRef.current('])
    expect(src).toContain('writeSeq.current++;')
  })
})

describe('audit A07 — a save the server partly refused still owes the read', () => {
  it('the stored cells of a 200 with errors[] ask for a read, and the adapter owes it', async () => {
    const r = row({ handling: cell({ writeField: 'ebay_handling_time', value: 2 }), stock: cell({ writeField: 'quantity', value: 1 }) })
    ;(r as { listing?: unknown }).listing = { id: 'l1', version: 3 }
    const outcomes: unknown[] = []
    const result = await commitChannelRow({ rowId: r.rowId, row: r, expectedVersion: 1, cells: [{ colId: 'handling', value: 3, intent: 'set' }, { colId: 'stock', value: 5, intent: 'set' }] }, {
      channel: 'EBAY', marketplace: 'IT', columnOf: (key) => ({ key, label: key, kind: 'number' }) as never, onStored: (o) => outcomes.push(o),
      bulkSend: async () => new Response(JSON.stringify({ updated: 1, currentVersion: 4, versionOf: 'channelListing', errors: [{ id: 'p1', field: 'quantity', error: 'No default warehouse' }] })),
    })
    expect(result.ok).toBe(false)
    expect(result.cells).toMatchObject({ handling: { ok: true }, stock: { ok: false } })
    expect(outcomes).toEqual([{ read: 'the answer refused a cell' }])
    expect(storedSome(result)).toBe(true)
    expect(storedSome({ ok: false, cells: { stock: { ok: false } } })).toBe(false)
    const src = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(src).toContain('else if (storedSome(result))')
  })
})

describe('audit A10 — an owed read never gives up while the sheet stays busy', () => {
  it('after the quick retries it keeps waiting, more slowly, and reads once the sheet is idle', async () => {
    let idle = false, reads = 0
    const delays: number[] = []
    let next: (() => void) | null = null
    const follow = new FollowUpRead({ idle: () => idle, sequence: () => 1,
      schedule: (run, ms) => { delays.push(ms); next = () => { next = null; run() }; return () => { next = null } },
      read: async (canApply) => { reads++; return canApply() } })
    follow.owe()
    follow.settle()
    // The operator keeps the Description editor open for minutes.
    for (let i = 0; i < 60; i++) { const run = next!; expect(run).toBeTypeOf('function'); run() }
    expect(reads).toBe(0)
    expect(delays.slice(0, 40).every((ms) => ms === 1500)).toBe(true)
    expect(Math.max(...delays)).toBe(30_000)
    idle = true
    next!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(1)
    expect(follow.isOwed).toBe(false)
  })
})

describe('audit B05 — the family readiness is asked for when the shared-record save SETTLES', () => {
  it('an earlier save\'s readiness timer firing while this save is on the wire cannot use up its family read', () => {
    const src = readFileSync(join(__dirname, 'useChannelSheetAdapter.tsx'), 'utf8')
    const sent = src.indexOf('const result = await commitChannelRow(req,')
    const flagged = src.indexOf('if (save.touchesMaster()) readinessForFamily.current = true')
    expect(sent).toBeGreaterThan(0)
    expect(flagged).toBeGreaterThan(sent)
    expect(src.split('readinessForFamily.current = true')).toHaveLength(2)
  })
})
