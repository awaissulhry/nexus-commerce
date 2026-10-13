import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReadTicket, createSaveGate, createSaveQueue, mayReseed } from './po-autosave'

// The PO editors keep their draft in a ref and the save reads it when it is
// sent. These tests drive the queue the same way: `draft` stands for the ref,
// `sent` records what each save put on the wire, and `answer()` lets a save
// come back when the test says so.

function deferred() {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function harness(delayMs = 1500) {
  const draft = { notes: '' }
  const sent: string[] = []
  const pending: Array<(ok: boolean) => void> = []
  let inFlight = 0
  let maxInFlight = 0
  const onIdle = vi.fn()
  const queue = createSaveQueue({
    delayMs,
    onIdle,
    save: async () => {
      sent.push(draft.notes) // read at SEND time
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const answer = deferred()
      pending.push(answer.resolve)
      const ok = await answer.promise
      inFlight -= 1
      return ok
    },
  })
  const answer = async (ok = true) => {
    pending.shift()?.(ok)
    await vi.advanceTimersByTimeAsync(0)
  }
  const type = (notes: string) => {
    draft.notes = notes
    queue.schedule()
  }
  return { draft, sent, queue, answer, type, onIdle, maxInFlight: () => maxInFlight }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('save queue — the last keystroke is sent', () => {
  it('🔴 sends the draft as it is when the timer ends, not as it was when the timer started', async () => {
    const h = harness()
    h.type('a')
    h.type('ab')
    // The edit lands after the timer was (re)started and does not restart it —
    // the old editors sent the draft their timer closure had captured, 'ab'.
    h.draft.notes = 'abc'
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent).toEqual(['abc'])
  })

  it('waits for 1.5 s of quiet after the last edit', async () => {
    const h = harness()
    h.type('a')
    await vi.advanceTimersByTimeAsync(1000)
    h.type('ab')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(h.sent).toEqual(['ab'])
  })
})

describe('save queue — one save at a time', () => {
  it('🔴 an edit during a save waits for it; newer edits replace the waiting one', async () => {
    const h = harness()
    h.type('one')
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent).toEqual(['one'])

    // Two more quiet periods end while 'one' is still on its way.
    h.type('two')
    await vi.advanceTimersByTimeAsync(1500)
    h.type('three')
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent).toEqual(['one'])

    await h.answer()
    // One follow-up, with the newest draft.
    expect(h.sent).toEqual(['one', 'three'])
    await h.answer()
    expect(h.sent).toEqual(['one', 'three'])
    expect(h.maxInFlight()).toBe(1)
    expect(h.queue.busy()).toBe(false)
  })

  it('busy() covers the timer, the waiting save and the save in flight', async () => {
    const h = harness()
    expect(h.queue.busy()).toBe(false)
    h.type('x')
    expect(h.queue.busy()).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.queue.busy()).toBe(true)
    await h.answer()
    expect(h.queue.busy()).toBe(false)
  })

  it('calls onIdle once the last save returns and nothing waits — not while an edit waits', async () => {
    const h = harness()
    h.type('a')
    await vi.advanceTimersByTimeAsync(1500)
    h.type('ab') // the timer runs while 'a' is in flight
    await h.answer()
    expect(h.onIdle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    await h.answer()
    expect(h.onIdle).toHaveBeenCalledTimes(1)
  })

  it('cancel() drops the timer and the waiting save (a conflict reload discards the draft)', async () => {
    const h = harness()
    h.type('a')
    await vi.advanceTimersByTimeAsync(1500)
    h.type('ab')
    await vi.advanceTimersByTimeAsync(1500) // waits behind 'a'
    h.queue.cancel()
    await h.answer(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.sent).toEqual(['a'])
    expect(h.queue.busy()).toBe(false)
  })

  it('a save that throws counts as failed and frees the queue', async () => {
    const queue = createSaveQueue({ delayMs: 10, save: async () => { throw new Error('network') } })
    await expect(queue.flush()).resolves.toBe(false)
    expect(queue.busy()).toBe(false)
  })
})

describe('save queue — Apply waits for the pending save', () => {
  it('🔴 flush() sends the edit still on its timer now and resolves when it is saved', async () => {
    const h = harness()
    h.type('last edit')
    let applied = false
    const apply = h.queue.flush().then((ok) => {
      applied = ok
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent).toEqual(['last edit']) // no 1.5 s wait
    expect(applied).toBe(false)
    await h.answer()
    await apply
    expect(applied).toBe(true)
  })

  it('🔴 flush() during a save waits for it AND for a follow-up with the newest draft', async () => {
    const h = harness()
    h.type('a')
    await vi.advanceTimersByTimeAsync(1500)
    h.type('ab')
    let done = false
    const apply = h.queue.flush().then(() => {
      done = true
    })
    await h.answer()
    expect(h.sent).toEqual(['a', 'ab'])
    expect(done).toBe(false)
    await h.answer()
    await apply
    expect(done).toBe(true)
  })

  it('flush() resolves false when the save failed, so Apply stops', async () => {
    const h = harness()
    h.type('x')
    const apply = h.queue.flush()
    await vi.advanceTimersByTimeAsync(0)
    await h.answer(false)
    await expect(apply).resolves.toBe(false)
  })
})

describe('mayReseed — our own echo never wipes typing', () => {
  it('🔴 the echo of our own save carries the version it returned: not newer, no re-seed', () => {
    expect(mayReseed({ serverVersion: 6, knownVersion: 6, unsaved: false })).toBe(false)
  })

  it('🔴 a newer server copy waits while an edit waits, a save runs, or the draft is unsaved', () => {
    expect(mayReseed({ serverVersion: 7, knownVersion: 6, unsaved: true })).toBe(false)
  })

  it('a newer server copy (a peer change) replaces a draft with nothing unsaved', () => {
    expect(mayReseed({ serverVersion: 7, knownVersion: 6, unsaved: false })).toBe(true)
  })

  it('🔴 an older copy (a refresh that left before our save returned) never re-seeds or rolls the version back', () => {
    expect(mayReseed({ serverVersion: 5, knownVersion: 6, unsaved: false })).toBe(false)
  })

  it('after a conflict the server copy is taken from the conflict version on, unsaved or not', () => {
    expect(mayReseed({ serverVersion: 9, knownVersion: 6, unsaved: true, conflictVersion: 9 })).toBe(true)
    expect(mayReseed({ serverVersion: 6, knownVersion: 6, unsaved: true, conflictVersion: 9 })).toBe(false)
  })

  it('🔴 walk-through: save v5→v6, keep typing, the v6 echo arrives — the typing stays', async () => {
    const h = harness()
    let known = 5
    const queue = createSaveQueue({
      delayMs: 1500,
      save: async () => {
        h.sent.push(h.draft.notes)
        known = 6 // the version this save returned
        return true
      },
    })
    h.draft.notes = 'hello'
    queue.schedule()
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent).toEqual(['hello'])

    h.draft.notes = 'hello wor' // typing on
    queue.schedule()
    // po.updated → refresh → the v6 copy, with notes 'hello'.
    expect(mayReseed({ serverVersion: 6, knownVersion: known, unsaved: queue.busy() })).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent).toEqual(['hello', 'hello wor'])
    // Even once idle, the echo is not newer.
    expect(mayReseed({ serverVersion: 6, knownVersion: known, unsaved: queue.busy() })).toBe(false)
  })
})

describe('read ticket — an older answer never overwrites a newer one', () => {
  it('🔴 only the newest read may set the page', async () => {
    const ticket = createReadTicket()
    let page = 'initial'
    const read = async (answer: Promise<string>) => {
      const t = ticket.take()
      const value = await answer
      if (ticket.isLatest(t)) page = value
    }
    const slow = deferred()
    const fast = deferred()
    const first = read(slow.promise.then(() => 'v5 (read before the save)'))
    const second = read(fast.promise.then(() => 'v6 (read after the save)'))
    fast.resolve(true)
    await second
    slow.resolve(true)
    await first
    expect(page).toBe('v6 (read after the save)')
  })
})

describe('save gate — a status transition waits for the draft\'s pending save', () => {
  // A DRAFT PO at version 7. The editor's save sends the version it knows and
  // bumps the server's; the transition bumps it too. This mirrors the page:
  // handleTransition awaits saveGate.flush() and stops when it is false.
  function page(saveOk = true) {
    const server = { version: 7, notes: '', log: [] as string[] }
    const draft = { notes: '' }
    let known = 7
    const queue = createSaveQueue({
      delayMs: 1500,
      save: async () => {
        if (draft.notes === server.notes) return true
        if (!saveOk) {
          server.log.push('save failed')
          return false
        }
        if (known !== server.version) {
          server.log.push(`409 (sent ${known}, server ${server.version})`)
          return false
        }
        server.notes = draft.notes
        server.version += 1
        known = server.version
        server.log.push(`save v${known - 1}→v${known}`)
        return true
      },
    })
    const gate = createSaveGate()
    const unregister = gate.register(queue)
    const transition = async (name: string) => {
      if (!(await gate.flush())) return false
      server.version += 1
      server.log.push(`${name} → v${server.version}`)
      return true
    }
    return { server, draft, queue, gate, unregister, transition }
  }

  it('🔴 type "ship by sea", Submit within 1.5 s: the save goes first with v7, then the transition — the text is kept', async () => {
    const p = page()
    p.draft.notes = 'ship by sea'
    p.queue.schedule()
    await vi.advanceTimersByTimeAsync(500)
    await expect(p.transition('submit-for-review')).resolves.toBe(true)
    expect(p.server.log).toEqual(['save v7→v8', 'submit-for-review → v9'])
    expect(p.server.notes).toBe('ship by sea')
    // The old timer does not fire a second save afterwards.
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.server.log).toHaveLength(2)
  })

  it('🔴 the transition is not sent when the last edit could not be saved', async () => {
    const p = page(false)
    p.draft.notes = 'ship by sea'
    p.queue.schedule()
    await expect(p.transition('approve')).resolves.toBe(false)
    expect(p.server.log).toEqual(['save failed'])
    expect(p.server.version).toBe(7)
  })

  it('with no edit waiting the transition goes straight through', async () => {
    const p = page()
    await expect(p.transition('approve')).resolves.toBe(true)
    expect(p.server.log).toEqual(['approve → v8'])
  })

  it('with no editor mounted (a sent PO) the gate is open; unregister only removes its own queue', async () => {
    const gate = createSaveGate()
    await expect(gate.flush()).resolves.toBe(true)
    const first = createSaveQueue({ delayMs: 10, save: async () => false })
    const second = createSaveQueue({ delayMs: 10, save: async () => true })
    const unregisterFirst = gate.register(first)
    gate.register(second) // a remount registered before the old cleanup ran
    unregisterFirst()
    await expect(gate.flush()).resolves.toBe(true) // still the second editor
  })
})
