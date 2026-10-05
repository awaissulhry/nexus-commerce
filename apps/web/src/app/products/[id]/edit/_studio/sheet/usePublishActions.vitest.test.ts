/**
 * Build shape v2, P8 — the waiting Status and Action values as the sheet holds them: optimistic at once, the
 * compare-and-set from what was READ, refusals and conflicts back to the stored value, one re-read that settles the
 * rest; the one toast of an operation; the waiting mark and its filter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublishActionCell, PublishActionChange, PublishActionWriteResult } from '@nexus/shared/publish-actions'
import {
  PUBLISH_ACTION_EVENT, PublishActionFence, PublishActionsStore, SHOW_ALL_ROWS, SHOW_THESE_ROWS, SKIP_CELL, groupStaged, inactiveStatusMark, isLocalPublishActionWrite, isWaitingCell, newChoiceOf, operationToast,
  optimisticValue, publishActionEventMatches, publishCellKey, sheetWaitingMark, waitingCountsOf, waitingStatusMark, withoutSameNewChoice, type PublishActionWriteOutcome, type StagedPublishCell,
} from './usePublishActions'
import type { PublishActionsRead } from './publishActionsApi'

const T0 = '2026-10-04T08:00:00.000Z'

function cell(listingId: string, over: Partial<PublishActionCell> = {}): PublishActionCell {
  return {
    listingId, productId: `p-${listingId}`, sku: `SKU-${listingId}`, channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '',
    state: 'active', stateReason: null,
    send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: true, reason: null, warning: null },
      { mode: 'full', offered: true, reason: null, warning: null },
      { mode: 'delete', offered: true, reason: null, warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
      { target: 'inactive', offered: true, action: 'pause', reason: null, warning: null, checkedAtSend: null },
      { target: 'ended', offered: false, action: 'end', reason: 'Amazon has no End.', warning: null, checkedAtSend: null },
    ],
    ...over,
  }
}

/** A server whose rows and answers the test controls; every write and read is recorded. */
function server(rows: PublishActionCell[]) {
  let stored = rows
  const writes: Array<{ change: PublishActionChange; listingIds: readonly string[]; expected: Record<string, string | null> }> = []
  let answer: (change: PublishActionChange, ids: readonly string[]) => PublishActionWriteResult | Error = (_, ids) => ({ applied: [...ids], refused: [], conflicts: [] })
  let gate: Promise<void> | null = null
  const store = new PublishActionsStore({
    read: async (): Promise<PublishActionsRead> => ({ rows: stored, readAt: T0 }),
    write: async (change, body) => {
      writes.push({ change, ...body })
      if (gate) await gate
      const result = answer(change, body.listingIds)
      if (result instanceof Error) throw result
      return result
    },
    viewer: () => ({ id: 'u-me', name: 'Awais' }),
    now: () => Date.parse('2026-10-04T10:42:00.000Z'),
  })
  return {
    store, writes,
    setRows: (next: PublishActionCell[]) => { stored = next },
    answer: (fn: typeof answer) => { answer = fn },
    hold: () => { let release!: () => void; gate = new Promise(r => { release = r }); return () => { gate = null; release() } },
  }
}

afterEach(() => vi.useRealTimers())

describe('usePublishActions store — the shared read (review 2026-10-05, m2)', () => {
  const answer = async (): Promise<PublishActionWriteResult> => ({ applied: ['a'], refused: [], conflicts: [] })
  const viewer = () => ({ id: 'u-me', name: 'Awais' })

  it('a settled write drops the shared reads first (the picker and the mark read again), then reads an answer newer than the write', async () => {
    const reads: Array<{ since?: number }> = []
    const events: string[] = []
    const store = new PublishActionsStore({
      read: async (_signal, options) => { reads.push(options ?? {}); events.push('read'); return { rows: [cell('a')], readAt: T0 } },
      write: answer, viewer, invalidate: () => { events.push('invalidate') },
    })
    await store.load()
    const before = Date.now()
    await store.write({ column: 'send', mode: 'full' }, ['a'])
    expect(events).toEqual(['read', 'invalidate', 'read'])
    expect(reads[0].since).toBeUndefined()
    expect(reads[1].since).toBeGreaterThanOrEqual(before)
    // A lost answer drops them too, and reads back.
    const failing = new PublishActionsStore({
      read: async (_signal, options) => { reads.push(options ?? {}); events.push('read'); return { rows: [cell('a')], readAt: T0 } },
      write: async () => { throw new Error('offline') }, viewer, invalidate: () => { events.push('invalidate') },
    })
    await failing.load()
    events.length = 0
    await failing.write({ column: 'send', mode: 'full' }, ['a'])
    expect(events).toEqual(['invalidate', 'read'])
  })

  it('a write from another tab (an origin no store of this tab has) is never taken for this tab’s own', () => {
    expect(isLocalPublishActionWrite({ type: 'listing.updated', meta: { subtype: PUBLISH_ACTION_EVENT, origin: 'pa-another-tab' } })).toBe(false)
    expect(isLocalPublishActionWrite({ type: 'listing.updated', meta: { subtype: PUBLISH_ACTION_EVENT } })).toBe(false)
    expect(isLocalPublishActionWrite({ type: 'listing.created', meta: { origin: 'pa-x' } })).toBe(false)
  })

  it('asks for the new read before it stops the old one, so a shared read both would use is joined, not started again', async () => {
    const order: string[] = []
    const store = new PublishActionsStore({
      read: signal => { order.push('read'); signal.addEventListener('abort', () => order.push('stop')); return new Promise(() => undefined) },
      write: answer, viewer,
    })
    void store.load()
    void store.load({ since: 1 })
    expect(order).toEqual(['read', 'read', 'stop'])
  })
})

describe('usePublishActions store — optimistic, then the server decides', () => {
  it('shows the change at once (who = you, when = now), sends the compare-and-set from what it READ, and settles on the re-read', async () => {
    const s = server([cell('a', { send: { mode: 'full', setAt: T0, setById: 'u-2', setByName: 'Dev Owner', noLongerApplies: null } }), cell('b')])
    await s.store.load()
    const release = s.hold()
    const pending = s.store.write({ column: 'status', target: 'inactive' }, ['a', 'b'])
    // Optimistic: both cells wait for Publish now, set by the viewer.
    expect(s.store.getSnapshot().byListingId.get('a')!.status).toMatchObject({ target: 'inactive', setByName: 'Awais', setById: 'u-me', setAt: '2026-10-04T10:42:00.000Z' })
    // The stored rows are unchanged until the server answers.
    expect(s.store.stored('a')!.status.target).toBeNull()
    // The server stores it; the re-read returns the stored who and when.
    s.setRows([
      cell('a', { status: { target: 'inactive', setAt: '2026-10-04T10:42:01.123Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null },
        send: { mode: 'full', setAt: T0, setById: 'u-2', setByName: 'Dev Owner', noLongerApplies: null } }),
      cell('b', { status: { target: 'inactive', setAt: '2026-10-04T10:42:01.123Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null } }),
    ])
    release()
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: true, applied: ['a', 'b'], refused: [], conflicts: [] })
    expect(s.writes).toEqual([{ change: { column: 'status', target: 'inactive' }, listingIds: ['a', 'b'], expected: { a: null, b: null } }])
    // The exact server `setAt` replaced the optimistic one — the next write's compare-and-set needs it.
    expect(s.store.getSnapshot().byListingId.get('a')!.status.setAt).toBe('2026-10-04T10:42:01.123Z')
    await s.store.write({ column: 'send', mode: 'partial' }, ['a'])
    expect(s.writes[1].expected).toEqual({ a: T0 })
  })

  it('🔴 a row someone else changed first goes BACK to their value; a refused row too; the others stay', async () => {
    const s = server([cell('a'), cell('b'), cell('c')])
    await s.store.load()
    const release = s.hold()
    const pending = s.store.write({ column: 'send', mode: 'full' }, ['a', 'b', 'c'])
    expect([...s.store.getSnapshot().byListingId.values()].map(r => r.send.mode)).toEqual(['full', 'full', 'full'])
    s.answer(() => ({
      applied: ['a'],
      refused: [{ listingId: 'b', sku: 'SKU-b', reason: 'Full update for eBay Inventory listings comes later.' }],
      conflicts: [{ listingId: 'c', sku: 'SKU-c', setByName: 'Dev Owner', setAt: T0 }],
    }))
    // What the server holds after: a stored, c set by someone else to Delete, b unchanged.
    s.setRows([
      cell('a', { send: { mode: 'full', setAt: '2026-10-04T10:42:01.000Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null } }),
      cell('b'),
      cell('c', { send: { mode: 'delete', setAt: T0, setById: 'u-2', setByName: 'Dev Owner', noLongerApplies: null } }),
    ])
    release()
    const outcome = await pending
    expect(outcome.conflicts).toEqual([{ listingId: 'c', sku: 'SKU-c', setByName: 'Dev Owner', setAt: T0 }])
    const after = s.store.getSnapshot().byListingId
    expect(after.get('a')!.send.mode).toBe('full')
    expect(after.get('b')!.send.mode).toBe('partial')
    expect(after.get('c')!.send).toMatchObject({ mode: 'delete', setByName: 'Dev Owner' })
  })

  it('reverts the conflict row even BEFORE the re-read answers (the optimistic value never outlives the refusal)', async () => {
    const s = server([cell('a'), cell('b')])
    await s.store.load()
    s.answer(() => ({ applied: ['a'], refused: [], conflicts: [{ listingId: 'b', sku: 'SKU-b', setByName: 'Dev Owner', setAt: T0 }] }))
    let snapshotAfterAnswer: ReturnType<typeof s.store.getSnapshot> | null = null
    const unsubscribe = s.store.subscribe(() => { if (!snapshotAfterAnswer && s.writes.length && s.store.getSnapshot().byListingId.get('b')!.status.target === null) snapshotAfterAnswer = s.store.getSnapshot() })
    await s.store.write({ column: 'status', target: 'inactive' }, ['a', 'b'])
    unsubscribe()
    expect(snapshotAfterAnswer).not.toBeNull()
    expect(snapshotAfterAnswer!.byListingId.get('a')!.status.target).toBe('inactive')
  })

  it('a failed request reverts every row of the write and reads back what is stored', async () => {
    const s = server([cell('a', { status: { target: 'inactive', setAt: T0, setById: 'u-2', setByName: 'Dev Owner', noLongerApplies: null } })])
    await s.store.load()
    s.answer(() => new Error('Your role cannot end or delete listings, so it cannot set this either.'))
    const outcome = await s.store.write({ column: 'status', target: null }, ['a'])
    expect(outcome).toMatchObject({ ok: false, error: 'Your role cannot end or delete listings, so it cannot set this either.' })
    expect(s.store.getSnapshot().byListingId.get('a')!.status).toMatchObject({ target: 'inactive', setByName: 'Dev Owner' })
  })

  it('writes one after another: the second compare-and-set uses the first write\'s stored setAt', async () => {
    const s = server([cell('a')])
    await s.store.load()
    const first = s.store.write({ column: 'send', mode: 'full' }, ['a'])
    s.setRows([cell('a', { send: { mode: 'full', setAt: '2026-10-04T10:42:05.000Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null } })])
    const second = s.store.write({ column: 'send', mode: 'delete' }, ['a'])
    // Both are on screen at once: the later value wins.
    expect(s.store.getSnapshot().byListingId.get('a')!.send.mode).toBe('delete')
    await Promise.all([first, second])
    expect(s.writes.map(w => w.expected)).toEqual([{ a: null }, { a: '2026-10-04T10:42:05.000Z' }])
  })
})

describe('the optimistic value is the server\'s own decision', () => {
  const viewer = { id: 'u', name: 'Awais' }
  it('Partial update and "no status change" clear; a Status the listing is already in clears too', () => {
    expect(optimisticValue(cell('a'), { column: 'send', mode: 'partial' }, viewer, T0)).toMatchObject({ mode: 'partial', setAt: null })
    expect(optimisticValue(cell('a'), { column: 'status', target: null }, viewer, T0)).toMatchObject({ target: null, setAt: null })
    expect(optimisticValue(cell('a'), { column: 'status', target: 'active' }, viewer, T0)).toMatchObject({ target: null })
  })
  it('a value the row does not offer changes nothing on screen (the server refuses it and says why)', () => {
    expect(optimisticValue(cell('a'), { column: 'status', target: 'ended' }, viewer, T0)).toBeUndefined()
  })
})

describe('the ONE toast of an operation', () => {
  const ok = (change: PublishActionChange, applied: number, refused: Array<[string, string]> = []): PublishActionWriteOutcome => ({
    ok: true, change, requested: [], applied: Array.from({ length: applied }, (_, i) => `l${i}`),
    refused: refused.map(([sku, reason], i) => ({ listingId: `r${i}`, sku, reason })), conflicts: [], error: null,
  })

  it('a fill: "Inactive set on 18 rows. 3 not allowed: …" — server refusals and cells refused before the write, one sentence', () => {
    const toast = operationToast(
      [ok({ column: 'status', target: 'inactive' }, 18, [['GALE-S', 'Amazon has no End.'], ['GALE-M', 'Not possible from this state.']])],
      [{ column: 'status', sku: 'GALE-NEW', reason: 'Not on the channel yet. Publish creates it' }],
    )
    expect(toast).toEqual({
      tone: 'warning', quiet: false,
      message: 'Inactive set on 18 rows. 3 not allowed: GALE-NEW (Not on the channel yet. Publish creates it); GALE-S (Amazon has no End.); GALE-M (Not possible from this state.).',
    })
  })

  it('one cell that simply took its value is quiet — the cell says it', () => {
    expect(operationToast([ok({ column: 'send', mode: 'full' }, 1)], [])).toMatchObject({ quiet: true, tone: 'success', message: 'Full update set on 1 row.' })
  })

  it('a reset of the Status reads as a clear, and a failed write as not saved', () => {
    expect(operationToast([ok({ column: 'status', target: null }, 3)], [])!.message).toBe('Waiting status cleared on 3 rows.')
    const failed: PublishActionWriteOutcome = { ok: false, change: { column: 'send', mode: 'delete' }, requested: ['a'], applied: [], refused: [], conflicts: [], error: 'Your role cannot end or delete listings.' }
    expect(operationToast([failed], [])).toMatchObject({ tone: 'danger', message: 'Delete was not saved: Your role cannot end or delete listings.' })
  })

  it('S11 follow-up — a channel scope names each refused or conflicting listing by its own SKU (the sheet\'s label); unknown ids keep the answer\'s', () => {
    const outcome = { ...ok({ column: 'send', mode: 'delete' }, 1, [['GALE-M', 'Already deleted on Amazon · IT.'], ['GALE-L', 'Nothing to delete yet.']]),
      conflicts: [{ listingId: 'c0', sku: 'GALE-S', setAt: null, setByName: 'Ana' }] }
    const labels: Record<string, string> = { r0: 'GALE-M-IT', c0: 'GALE-S-IT' }
    expect(operationToast([outcome], [], id => labels[id] ?? null)!.message)
      .toBe(operationToast([{ ...outcome, refused: [{ listingId: 'r0', sku: 'GALE-M-IT', reason: 'Already deleted on Amazon · IT.' }, { listingId: 'r1', sku: 'GALE-L', reason: 'Nothing to delete yet.' }],
        conflicts: [{ listingId: 'c0', sku: 'GALE-S-IT', setAt: null, setByName: 'Ana' }] }], [])!.message)
    expect(operationToast([outcome], [], id => labels[id] ?? null)!.message).toContain('GALE-M-IT (Already deleted on Amazon · IT.)')
  })

  it('a paste refused before any write still says so', () => {
    expect(operationToast([], [{ column: 'send', sku: 'GALE-S', reason: 'Pause is a Status: use the Status column' }])).toEqual({
      tone: 'warning', quiet: false, message: 'Action: nothing set. 1 not allowed: GALE-S (Pause is a Status: use the Status column).',
    })
  })
})

describe('the operation fence: one write per column and value', () => {
  it('groups an operation\'s cells (the last value of a cell wins) and refuses rows with no listing', () => {
    const items: StagedPublishCell[] = [
      { column: 'status', listingId: 'a', sku: 'A', input: { change: { column: 'status', target: 'active' } } },
      { column: 'status', listingId: 'a', sku: 'A', input: { change: { column: 'status', target: 'inactive' } } },
      { column: 'status', listingId: 'b', sku: 'B', input: { change: { column: 'status', target: 'inactive' } } },
      { column: 'send', listingId: 'b', sku: 'B', input: { change: { column: 'send', mode: 'full' } } },
      { column: 'send', listingId: null, sku: 'NEW', input: { change: { column: 'send', mode: 'full' } } },
      { column: 'send', listingId: 'c', sku: 'C', input: { refused: 'Pause is a Status: use the Status column' } },
    ]
    expect(groupStaged(items)).toEqual({
      writes: [
        { change: { column: 'status', target: 'inactive' }, listingIds: ['a', 'b'] },
        { change: { column: 'send', mode: 'full' }, listingIds: ['b'] },
      ],
      refused: [
        { column: 'send', sku: 'NEW', reason: 'Not on the channel yet. Publish creates it' },
        { column: 'send', sku: 'C', reason: 'Pause is a Status: use the Status column' },
      ],
    })
  })

  it('holds cells until the grid says the operation ended, then flushes ONCE on the next turn', () => {
    vi.useFakeTimers()
    const flushed: StagedPublishCell[][] = []
    const fence = new PublishActionFence(items => flushed.push(items))
    const item = (id: string): StagedPublishCell => ({ column: 'status', listingId: id, sku: id, input: { change: { column: 'status', target: 'inactive' } } })
    fence.begin()
    fence.stage(item('a')); fence.stage(item('b'))
    vi.advanceTimersByTime(10)
    expect(flushed).toEqual([])
    fence.end()
    fence.stage(item('c'))
    vi.advanceTimersByTime(0)
    expect(flushed.map(batch => batch.map(i => i.listingId))).toEqual([['a', 'b', 'c']])
    // A fence that never closes opens itself.
    fence.begin(); fence.stage(item('d'))
    vi.advanceTimersByTime(2999)
    expect(flushed).toHaveLength(1)
    // (+1: a 0 ms timer made inside a fake-timer tick is due 1 ms later.)
    vi.advanceTimersByTime(2)
    expect(flushed.map(batch => batch.map(i => i.listingId))).toEqual([['a', 'b', 'c'], ['d']])
  })
})

describe('the waiting mark and the inactive chip — each a filter', () => {
  const waiting = [
    cell('a', { status: { target: 'inactive', setAt: T0, setById: 'u', setByName: 'A', noLongerApplies: null } }),
    cell('b', { status: { target: 'inactive', setAt: T0, setById: 'u', setByName: 'A', noLongerApplies: null }, send: { mode: 'full', setAt: T0, setById: 'u', setByName: 'A', noLongerApplies: null } }),
    // Outgrown: not waiting (Publish skips it).
    cell('c', { state: 'paused', status: { target: 'inactive', setAt: T0, setById: 'u', setByName: 'A', noLongerApplies: 'Already inactive.' } }),
    cell('d'),
  ]

  it('counts the values Publish will send, and the mark presses into a filter of those rows', () => {
    const counts = waitingCountsOf(waiting)
    expect(counts).toEqual({ full: 1, delete: 0, active: 0, inactive: 2, ended: 0, relist: 0, created: 0, createdInactive: 0, leftOut: 0 })
    expect(waiting.map(isWaitingCell)).toEqual([true, true, false, false])
    const toggle = vi.fn()
    const mark = waitingStatusMark(counts, false, toggle)!
    expect(mark).toMatchObject({ tone: 'info', label: '3 waiting for Publish', actionLabel: SHOW_THESE_ROWS, selected: false })
    expect(mark.detail).toBe('2 inactive · 1 full update. Nothing is sent until you press Publish.')
    mark.onSelect!()
    expect(toggle).toHaveBeenCalledOnce()
    expect(waitingStatusMark(counts, true, toggle)).toMatchObject({ actionLabel: SHOW_ALL_ROWS, selected: true })
  })

  it('turns danger when an End or a Delete waits (a danger mark never folds), and is absent when nothing waits', () => {
    expect(waitingStatusMark({ full: 0, delete: 1, active: 0, inactive: 0, ended: 0 }, false, () => {})!.tone).toBe('danger')
    expect(waitingStatusMark({ full: 0, delete: 0, active: 0, inactive: 0, ended: 1 }, false, () => {})!.tone).toBe('danger')
    expect(waitingStatusMark(waitingCountsOf([cell('x')]), false, () => {})).toBeNull()
  })

  it('"3 inactive" names the destination and filters', () => {
    expect(inactiveStatusMark(3, 'Amazon · IT', false, () => {})).toMatchObject({
      tone: 'warning', label: '3 inactive', actionLabel: SHOW_THESE_ROWS,
      detail: '3 listings on Amazon · IT are inactive: buyers cannot buy them here. The listings and their content stay.',
    })
    expect(inactiveStatusMark(0, 'Amazon · IT', false, () => {})).toBeNull()
  })
})

describe('which events make the sheet read again', () => {
  const ids = new Set(['fam', 'child'])
  const dest = { channel: 'AMAZON', marketplace: 'IT' }
  it('a waiting value changed in this family by another sheet or tab — not this sheet\'s own write', () => {
    expect(publishActionEventMatches({ type: 'listing.updated', id: 'fam', meta: { subtype: 'listing.publish_action_changed', productId: 'fam' } }, ids, dest, 'me')).toBe(true)
    expect(publishActionEventMatches({ type: 'listing.updated', id: 'fam', meta: { subtype: 'listing.publish_action_changed', productId: 'fam', origin: 'me' } }, ids, dest, 'me')).toBe(false)
    expect(publishActionEventMatches({ type: 'listing.updated', id: 'other', meta: { subtype: 'listing.publish_action_changed', productId: 'other' } }, ids, dest, 'me')).toBe(false)
    expect(publishActionEventMatches({ type: 'listing.updated', id: 'fam', meta: { subtype: 'listing.synced', productId: 'fam' } }, ids, dest, 'me')).toBe(false)
  })
  it('a Publish on this destination moved (it clears waiting values and changes the live state)', () => {
    expect(publishActionEventMatches({ type: 'publication.status_changed', id: 'pub', meta: { productId: 'fam', channel: 'AMAZON', marketplace: 'IT' } }, ids, dest, 'me')).toBe(true)
    expect(publishActionEventMatches({ type: 'publication.status_changed', id: 'pub', meta: { productId: 'fam', channel: 'EBAY', marketplace: 'IT' } }, ids, dest, 'me')).toBe(false)
  })
})

describe('delete and relist (simplify) — a row Nexus deleted is a row not on the channel', () => {
  const deletion = { at: '2026-10-04T06:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD12345', relistChosenAt: null }
  const words = 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.'
  const gone = (id: string, over: Partial<PublishActionCell> = {}) => cell(id, {
    state: 'not_listed', stateReason: words, deleted: { ...deletion, sentence: 'Deleted on Amazon · IT on 4 Oct.' },
    create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed', noRecord: false, sentence: words },
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.', warning: null },
    ],
    statusOptions: (['active', 'inactive', 'not_listed'] as const).map(target => ({ target, offered: true, action: null, reason: null, warning: null, checkedAtSend: null })),
    ...over,
  })
  const viewer = { id: 'u-me', name: 'Awais' }

  it('Status Active on it is a choice (it waits, with who and when); its Action takes nothing (Full update stores nothing, the rest the server refuses)', () => {
    expect(optimisticValue(gone('a'), { column: 'status', target: 'active' }, viewer, T0)).toEqual({ target: 'active', setAt: T0, setById: 'u-me', setByName: 'Awais', noLongerApplies: null })
    expect(optimisticValue(gone('a'), { column: 'send', mode: 'full' }, viewer, T0)).toEqual({ mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null })
    expect(optimisticValue(gone('a'), { column: 'send', mode: 'partial' }, viewer, T0)).toBeUndefined()
    expect(optimisticValue(gone('a'), { column: 'send', mode: 'delete' }, viewer, T0)).toBeUndefined()
  })

  it('its choice follows this sheet\'s own Status at once (it lists it again), and cleared it goes back to Not listed in the delete\'s words', async () => {
    const s = server([gone('a')])
    await s.store.load()
    const gateOpen = s.hold()
    const pending = s.store.write({ column: 'status', target: 'active' }, ['a'])
    expect(s.store.getSnapshot().byListingId.get('a')!.create).toMatchObject({ target: 'active', source: 'own', sentence: 'Publish lists it again, whole, and it sells.' })
    s.setRows([gone('a', { status: { target: 'active', setAt: '2026-10-04T10:42:00.000Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null },
      create: { target: 'active', source: 'own', defaultTarget: 'not_listed', noRecord: false, sentence: 'Publish lists it again, whole, and it sells.' } })])
    gateOpen()
    await pending
    expect(s.writes[0]).toMatchObject({ change: { column: 'status', target: 'active' }, listingIds: ['a'], expected: { a: null } })
    const gateClear = s.hold()
    const clearing = s.store.write({ column: 'status', target: null }, ['a'])
    expect(s.store.getSnapshot().byListingId.get('a')!.create).toMatchObject({ target: 'not_listed', source: 'default', sentence: words })
    gateClear()
    await clearing
  })

  it('counts: a deleted row left off waits for nothing (not even a value set before the delete); one its Status lists again counts as "listed again"', () => {
    const before = gone('a', { status: { target: 'inactive', setAt: T0, setById: 'u-me', setByName: 'Awais', noLongerApplies: 'Set before the delete on 4 Oct.' } })
    const again = gone('b', { status: { target: 'active', setAt: T0, setById: 'u-me', setByName: 'Awais', noLongerApplies: null },
      create: { target: 'active', source: 'own', defaultTarget: 'not_listed', noRecord: false, sentence: 'Publish lists it again, whole, and it sells.' } })
    const live = cell('c', { status: { target: 'inactive', setAt: T0, setById: 'u-me', setByName: 'Awais', noLongerApplies: null } })
    expect([before, again, live].map(isWaitingCell)).toEqual([false, true, true])
    const counts = waitingCountsOf([before, again, live])
    expect(counts).toEqual({ full: 0, delete: 0, active: 0, inactive: 1, ended: 0, relist: 1, created: 0, createdInactive: 0, leftOut: 0 })
    expect(waitingStatusMark(counts, false, () => {})).toMatchObject({ tone: 'info', label: '2 waiting for Publish', detail: '1 inactive · 1 listed again. Nothing is sent until you press Publish.' })
    expect(sheetWaitingMark({ full: 0, delete: 0, active: 0, inactive: 0, ended: 0, relist: 2 })).toEqual({ label: '2 waiting for Publish', detail: '2 listed again', danger: false })
  })
})

// ── New listings (Owner 2026-10-04) ───────────────────────────────────────────────────────────────────────────────

const NEW_ID = 'new:p-g:AMAZON:IT:acc:'
const NEW_OPTIONS: PublishActionCell['statusOptions'] = [
  { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish creates it and it sells.' },
  { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish creates it, but buyers cannot buy it yet.' },
  { target: 'not_listed', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish leaves it out.' },
]
function newCell(listingId: string, over: Partial<PublishActionCell> = {}): PublishActionCell {
  return cell(listingId, {
    productId: 'p-g', sku: 'GALE', state: 'not_listed',
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: listingId.startsWith('new:'), sentence: 'Publish creates it and it sells.' },
    sendOptions: [
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Nothing to delete yet. To leave it out, set Status to Not listed.', warning: null },
    ],
    statusOptions: NEW_OPTIONS,
    ...over,
  })
}

describe('new listings — a row not on the channel yet', () => {
  it('a Status choice is stored as chosen (even the default) and its choice follows at once; Action values store nothing', () => {
    const viewer = { id: 'u-me', name: 'Awais' }
    const row = newCell('l-1')
    expect(optimisticValue(row, { column: 'status', target: 'active' }, viewer, T0)).toMatchObject({ target: 'active', setAt: T0 })
    expect(optimisticValue(row, { column: 'status', target: 'not_listed' }, viewer, T0)).toMatchObject({ target: 'not_listed' })
    expect(optimisticValue(row, { column: 'status', target: 'ended' }, viewer, T0)).toBeUndefined()
    expect(optimisticValue(row, { column: 'send', mode: 'partial' }, viewer, T0)).toBeUndefined()
    expect(optimisticValue(row, { column: 'send', mode: 'full' }, viewer, T0)).toEqual({ mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null })
  })

  it('a row with no listing: the write sends its new: id (expected null), the toast says what started, and the re-read brings the real row under the same product key', async () => {
    const s = server([newCell(NEW_ID)])
    await s.store.load()
    expect(s.store.getSnapshot().byProductKey.get(publishCellKey('p-g', ''))?.listingId).toBe(NEW_ID)
    s.answer((_, ids) => ({ applied: [...ids], refused: [], conflicts: [], leftOut: null,
      started: { sentence: 'Started Amazon · IT for GALE and 6 variations.', listingIds: ['l-real'], rows: [{ id: NEW_ID, listingId: 'l-real' }] } }))
    const release = s.hold()
    const pending = s.store.write({ column: 'status', target: 'inactive' }, [NEW_ID])
    // At once: the new row shows the choice as its own.
    expect(s.store.getSnapshot().byListingId.get(NEW_ID)!.create).toMatchObject({ target: 'inactive', source: 'own' })
    s.setRows([newCell('l-real', { status: { target: 'inactive', setAt: '2026-10-04T10:42:01.000Z', setById: 'u-me', setByName: 'Awais', noLongerApplies: null },
      create: { target: 'inactive', source: 'own', defaultTarget: 'active', noRecord: false, sentence: 'Publish creates it, but buyers cannot buy it yet.' } })])
    release()
    const outcome = await pending
    expect(s.writes[0]).toMatchObject({ change: { column: 'status', target: 'inactive' }, listingIds: [NEW_ID], expected: { [NEW_ID]: null } })
    expect(outcome.started?.rows).toEqual([{ id: NEW_ID, listingId: 'l-real' }])
    const after = s.store.getSnapshot()
    expect(after.byListingId.has(NEW_ID)).toBe(false)
    expect(after.byProductKey.get(publishCellKey('p-g', ''))).toMatchObject({ listingId: 'l-real', create: { target: 'inactive', source: 'own' } })
    const toast = operationToast([outcome], [])!
    expect(toast.message).toBe('Inactive set on 1 row. Started Amazon · IT for GALE and 6 variations.')
    expect(toast.quiet).toBe(false)
  })

  it('counts: a choice made on a new row is a new listing (Inactive said apart), Not listed is left out; the default waits for nothing', () => {
    const own = (target: 'active' | 'inactive' | 'not_listed', id: string) => newCell(id, {
      status: { target, setAt: T0, setById: 'u-me', setByName: 'Awais', noLongerApplies: null },
      create: { target, source: 'own', defaultTarget: 'active', noRecord: false, sentence: '' } })
    const rows = [own('active', 'a'), own('inactive', 'b'), own('active', 'c'), own('not_listed', 'd'), newCell('e')]
    expect(rows.map(newChoiceOf)).toEqual(['active', 'inactive', 'active', 'not_listed', null])
    expect(rows.map(isWaitingCell)).toEqual([true, true, true, true, false])
    const counts = waitingCountsOf(rows)
    expect(counts).toMatchObject({ active: 0, inactive: 0, created: 3, createdInactive: 1, leftOut: 1 })
    expect(sheetWaitingMark(counts)).toEqual({ label: '4 waiting for Publish', detail: '3 new listings (1 inactive) · 1 left out', danger: false })
  })

  it('a Shared-scope write that left markets out says so; a skipped cell (Full update on a new row) is never written', () => {
    const outcome: PublishActionWriteOutcome = { ok: true, change: { column: 'status', target: 'inactive' }, requested: ['a'], applied: ['a'], refused: [], conflicts: [], error: null,
      leftOut: { count: 1, sentence: '1 market without a listing was left out: set it in its own sheet.' } }
    expect(operationToast([outcome], [])!.message).toBe('Inactive set on 1 row. 1 market without a listing was left out: set it in its own sheet.')
    const { writes, refused } = groupStaged([{ column: 'send', listingId: 'a', sku: 'GALE', input: SKIP_CELL }])
    expect(writes).toEqual([])
    expect(refused).toEqual([])
  })

  it('a Status a new row already holds is never written (a paste, a fill or Action ▾ of the same choice)', () => {
    const row = newCell(NEW_ID)
    expect(withoutSameNewChoice(row, { change: { column: 'status', target: 'active' } })).toEqual(SKIP_CELL)
    expect(withoutSameNewChoice(row, { change: { column: 'status', target: 'inactive' } })).toEqual({ change: { column: 'status', target: 'inactive' } })
    // A listed row keeps today's rule (the same value clears a waiting change).
    expect(withoutSameNewChoice(cell('x'), { change: { column: 'status', target: 'active' } })).toEqual({ change: { column: 'status', target: 'active' } })
  })
})
