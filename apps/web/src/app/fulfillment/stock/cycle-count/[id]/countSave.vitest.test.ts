/**
 * Cycle count session — tabbing across items: the counts go one at a time, each item is busy only while its own write is
 * waiting or in flight, no older read shows a counted item as uncounted, and a count's draft stays on screen until a read
 * that includes it. The stub server keeps the counted quantities; a read's snapshot is taken when it reaches the server.
 */
import { describe, expect, it } from 'vitest'
import { countSave } from './countSave'

type Session = Record<string, number | null>
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

function harness() {
  const server = {
    counted: { 'item-a': null, 'item-b': null, 'item-c': null } as Session,
    inFlight: 0,
    maxInFlight: 0,
    heldWrites: [] as Array<() => void>,
    holdWrites: false,
    heldReads: [] as Array<() => void>,
    holdReads: false,
  }
  const screen = {
    session: null as Session | null,
    drafts: {} as Record<string, string>,
    busy: new Set<string>(),
    reads: 0,
  }
  const save = countSave<Session>({
    read: async () => {
      const snapshot = { ...server.counted }
      if (server.holdReads) await new Promise<void>((resolve) => server.heldReads.push(resolve))
      return snapshot
    },
    paint: (session, settled) => {
      screen.reads += 1
      screen.session = session
      for (const { itemId, draft } of settled) if (screen.drafts[itemId] === draft) delete screen.drafts[itemId]
    },
    readFailed: (e) => { throw e },
    busy: (ids) => { screen.busy = new Set(ids) },
  })
  /** The page's blur: a count of one item, through the line. */
  const record = (itemId: string, draft: string, fail = false) => {
    screen.drafts[itemId] = draft
    if (save.held(itemId) === draft) return Promise.resolve()
    return save.write(async () => {
      server.inFlight += 1
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
      if (server.holdWrites) await new Promise<void>((resolve) => server.heldWrites.push(resolve))
      server.inFlight -= 1
      if (fail) throw new Error('HTTP 500')
      server.counted[itemId] = Number(draft)
    }, { itemId, draft })
  }
  /** What the counted input shows: the draft, else the read's count. */
  const shows = (itemId: string) => screen.drafts[itemId] ?? (screen.session?.[itemId] == null ? '' : String(screen.session[itemId]))
  return { server, screen, save, record, shows }
}

describe('cycle count — one save line', () => {
  it('tabbing across items sends one count at a time, and each item is busy only while its own write is', async () => {
    const h = harness()
    h.server.holdWrites = true
    const a = h.record('item-a', '5')
    const b = h.record('item-b', '7')
    await flush()
    expect([...h.screen.busy].sort()).toEqual(['item-a', 'item-b'])
    h.server.heldWrites.shift()!()
    await flush()
    expect([...h.screen.busy]).toEqual(['item-b']) // A settled; B is still in flight and stays disabled
    h.server.heldWrites.shift()!()
    await Promise.all([a, b])
    await flush()
    expect(h.screen.busy.size).toBe(0)
    expect(h.server.maxInFlight).toBe(1)
    expect(h.screen.reads).toBe(1) // one read, after the last count
    expect(h.shows('item-a')).toBe('5')
    expect(h.shows('item-b')).toBe('7')
    expect(h.screen.drafts).toEqual({})
  })

  it('a read that started before a count landed never shows that item as uncounted', async () => {
    const h = harness()
    await h.save.refresh()
    h.server.holdReads = true
    const older = h.save.refresh() // e.g. the Refresh button, before the count lands
    h.server.holdReads = false
    await h.record('item-a', '4')
    await flush()
    expect(h.shows('item-a')).toBe('4')
    h.server.heldReads.shift()!() // the older read answers last: item-a uncounted in its snapshot
    await older
    expect(h.shows('item-a')).toBe('4')
    expect(h.screen.session?.['item-a']).toBe(4)
  })

  it('a draft is never cleared by a read older than its count', async () => {
    const h = harness()
    h.server.holdReads = true
    const older = h.save.refresh()
    h.server.holdReads = false
    const writing = h.record('item-c', '9')
    h.server.heldReads.shift()!() // answers while the count is in flight: dropped
    await older
    expect(h.screen.drafts).toEqual({ 'item-c': '9' })
    await writing
    await flush()
    expect(h.screen.drafts).toEqual({})
    expect(h.shows('item-c')).toBe('9')
  })

  it('a failed count keeps its draft and the line goes on', async () => {
    const h = harness()
    await expect(h.record('item-a', '3', true)).rejects.toThrow('HTTP 500')
    await h.record('item-b', '2')
    await flush()
    expect(h.screen.drafts).toEqual({ 'item-a': '3' })
    expect(h.shows('item-b')).toBe('2')
    expect(h.save.held('item-a')).toBeUndefined() // a blur may send it again
  })

  it('blurring again with the count already held sends nothing', async () => {
    const h = harness()
    h.server.holdWrites = true
    const first = h.record('item-a', '6')
    await h.record('item-a', '6')
    await flush()
    expect(h.server.heldWrites).toHaveLength(1)
    h.server.heldWrites.shift()!()
    await first
  })
})
