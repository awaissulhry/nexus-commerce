import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { currentAddress, keptScopeOf, MESSAGE_TERM, scopeTermOf, tabAddress, tabHref, THREAD_TERM, threadTermOf, withThread, writeSearch, type HistoryTarget } from './address'

/**
 * F-OP-209 (order page plan N4; 11-dock §4; review R-19, RC4, RC5) — ONE writer of `thread=`: the pure address (set or drop the term
 * and the message, keep everything else; a tab's link and an in-page move keep the scope), the scope the narrow view keeps, and the
 * one history writer (fx-12's rule: an address is written only when it differs; a replace, a push only for the narrow view).
 */

const BASE = '/w/DEMO/sales/orders/o1'
const W = '33333333-3333-4333-8333-333333333333'

/** A stand-in window: its address, and every write it got. */
function fakeWindow(address: string) {
  let now = new URL(address, 'https://factory.example.com')
  const writes: Array<{ kind: 'replace' | 'push'; address: string }> = []
  const write = (kind: 'replace' | 'push') => (_data: unknown, _unused: string, url?: string | null) => {
    writes.push({ kind, address: String(url) })
    now = new URL(String(url), now)
  }
  const target: HistoryTarget = {
    location: {
      get pathname() {
        return now.pathname
      },
      get search() {
        return now.search
      },
      get hash() {
        return now.hash
      },
    },
    history: { replaceState: write('replace'), pushState: write('push') },
  }
  return { target, writes }
}

describe('F-OP-209 — withThread sets or drops the term, and nothing else', () => {
  it('applied twice is the same address (no writer can feed another)', () => {
    for (const [address, value] of [
      [`${BASE}?tab=lines`, 'all'],
      [`${BASE}?tab=lines&thread=general`, null],
      [`${BASE}?thread=all&tab=money#invoices`, `wo:${W}`],
      [BASE, 'open'],
    ] as const) {
      const once = withThread(address, value)
      expect(withThread(once, value), address).toBe(once)
    }
  })
  it('keeps every other term and the hash, in their order', () => {
    expect(withThread(`${BASE}?tab=lines&open=r1#still-to-do`, 'general')).toBe(`${BASE}?tab=lines&open=r1&thread=general#still-to-do`)
    expect(withThread(`${BASE}?thread=all&tab=lines`, `project:${W}`)).toBe(`${BASE}?thread=project%3A${W}&tab=lines`)
    expect(withThread(`${BASE}?tab=lines&thread=general`, null)).toBe(`${BASE}?tab=lines`)
    expect(withThread(`${BASE}?thread=general`, null)).toBe(BASE)
  })
  it('drops the message on a move; a line of All of <customer> opens its thread at its message', () => {
    expect(withThread(`${BASE}?tab=lines&thread=all&message=m1`, `wo:${W}`)).toBe(`${BASE}?tab=lines&thread=wo%3A${W}`)
    expect(withThread(`${BASE}?thread=all`, null, { message: 'm7' })).toBe(`${BASE}?message=m7`)
    expect(withThread(`${BASE}?thread=all&message=m1`, 'general', { message: null })).toBe(`${BASE}?thread=general`)
  })
  it('takes a search alone too, and gives the same shape back', () => {
    expect(withThread('?tab=lines', 'all')).toBe('?tab=lines&thread=all')
    expect(withThread('tab=lines&thread=all', null)).toBe('?tab=lines')
    expect(threadTermOf('?tab=lines&thread=all')).toBe('all')
    expect(threadTermOf(`${BASE}?thread=`)).toBeNull()
    expect(threadTermOf(null)).toBeNull()
    expect(THREAD_TERM).toBe('thread')
    expect(MESSAGE_TERM).toBe('message')
  })
  it('a scope is any value but the narrow view\'s `open` and the arrival\'s `new`', () => {
    for (const scope of ['general', 'all', `project:${W}`, `wo:${W}`]) expect(scopeTermOf(scope)).toBe(scope)
    for (const other of ['open', 'new', '', null, undefined]) expect(scopeTermOf(other), String(other)).toBeNull()
  })
})

describe('F-OP-209 — a tab\'s link and an in-page move keep the scope (RC4)', () => {
  it('tabHref: the tab and the scope only; never open, new, a message or another term', () => {
    expect(tabHref(BASE, 'lines', '')).toBe(`${BASE}?tab=lines`)
    expect(tabHref(BASE, 'lines', 'tab=money&thread=all')).toBe(`${BASE}?tab=lines&thread=all`)
    expect(tabHref(BASE, 'money', `?thread=wo:${W}&message=m1&open=r1`)).toBe(`${BASE}?tab=money&thread=wo%3A${W}`)
    for (const value of ['open', 'new']) expect(tabHref(BASE, 'files', `thread=${value}`), value).toBe(`${BASE}?tab=files`)
    expect(tabHref(BASE, 'lines', null)).toBe(`${BASE}?tab=lines`)
  })
  it('tabAddress: the tab set, every other term kept, the scope kept, open / new / message dropped; a section to scroll to', () => {
    expect(tabAddress(BASE, '?tab=overview&thread=all&open=r1', 'lines')).toBe(`${BASE}?tab=lines&thread=all&open=r1`)
    expect(tabAddress(BASE, '?thread=open&tab=overview&message=m1', 'changes', { anchor: 'still-to-do' })).toBe(`${BASE}?tab=changes#still-to-do`)
    expect(tabAddress(BASE, 'thread=new', 'lines')).toBe(`${BASE}?tab=lines`)
    expect(tabAddress(BASE, '', 'money', { anchor: 'margin' })).toBe(`${BASE}?tab=money#margin`)
  })
  it('below 1280 px an in-page move drops the term: the page gives way to the tab (the frame keeps the scope)', () => {
    expect(tabAddress(BASE, '?tab=overview&thread=general', 'lines', { narrow: true })).toBe(`${BASE}?tab=lines`)
    expect(tabAddress(BASE, '?tab=overview&thread=open', 'changes', { narrow: true, anchor: 'still-to-do' })).toBe(`${BASE}?tab=changes#still-to-do`)
  })
  it('a move applied twice is the same address', () => {
    const once = tabAddress(BASE, '?tab=overview&thread=all', 'lines')
    expect(tabAddress(BASE, once.slice(once.indexOf('?')), 'lines')).toBe(once)
  })
})

describe('F-OP-209 — the narrow view keeps its scope (this page mount only)', () => {
  it('a scope in the address is kept; `open` is This order\'s own; no term docked is This order', () => {
    expect(keptScopeOf(null, 'all', 'stacked')).toBe('all')
    expect(keptScopeOf('all', 'open', 'stacked')).toBeNull()
    expect(keptScopeOf('all', null, 'docked')).toBeNull()
    expect(keptScopeOf('general', `wo:${W}`, 'docked')).toBe(`wo:${W}`)
  })
  it('no term below 1280 px is the view closed: the scope stays, so the Thread button opens the view on it again', () => {
    expect(keptScopeOf('all', null, 'stacked')).toBe('all')
    expect(keptScopeOf('general', 'new', 'stacked')).toBe('general')
    // The frame opens the narrow view on the kept scope (a push: Back closes it), else on This order's `open`.
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain("setThread(keptScope.current ?? 'open', { push: true })")
    expect(frame).toContain('keptScope.current = keptScopeOf(keptScope.current, term, mode)')
  })
})

describe('F-OP-209 — the one history writer (fx-12: only a different address; a replace, a push only for the narrow view)', () => {
  it('the same address: nothing written', () => {
    const { target, writes } = fakeWindow(`${BASE}?tab=lines&thread=all`)
    expect(writeSearch(`${BASE}?tab=lines&thread=all`, {}, target)).toBe(false)
    expect(writeSearch(withThread(currentAddress(target), 'all'), {}, target)).toBe(false)
    expect(writes).toEqual([])
  })
  it('a different address: a replace by default; a push only when asked (the narrow view opening)', () => {
    const { target, writes } = fakeWindow(`${BASE}?tab=lines`)
    expect(writeSearch(withThread(currentAddress(target), 'general'), {}, target)).toBe(true)
    expect(writeSearch(withThread(currentAddress(target), 'open'), { push: true }, target)).toBe(true)
    expect(writes).toEqual([
      { kind: 'replace', address: `${BASE}?tab=lines&thread=general` },
      { kind: 'push', address: `${BASE}?tab=lines&thread=open` },
    ])
    // Five picks of the same scope: one write.
    for (let pick = 0; pick < 5; pick += 1) writeSearch(withThread(currentAddress(target), 'open'), {}, target)
    expect(writes).toHaveLength(2)
  })
  it('keeps the hash now when the address names none; outside a browser it writes nothing', () => {
    const { target, writes } = fakeWindow(`${BASE}?tab=money#invoices`)
    writeSearch(`${BASE}?tab=money&thread=all`, {}, target)
    expect(writes).toEqual([{ kind: 'replace', address: `${BASE}?tab=money&thread=all#invoices` }])
    expect(writeSearch(`${BASE}?tab=money`, {}, null)).toBe(false)
    expect(currentAddress(null)).toBe('')
  })
})

describe('F-OP-209 — the sources: ONE writer', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('the frame writes `thread=` through setThread only (no direct history call; the arrival cleans through the same writer)', () => {
    const frame = read('./RecordFrame.tsx')
    expect(frame).toContain('writeSearch(withThread(currentAddress(), value, { message: options.message ?? null }), { push: options.push === true })')
    expect(frame).not.toMatch(/window\.history\.(replaceState|pushState)\(/)
    expect(frame).toContain('...(hasThread ? { setThread } : {})')
    expect(frame).toContain('readonly setThread?: (value: string | null, options?: SetThreadOptions) => void')
  })
  it('the order dock has no router.replace: its pick goes through the frame', () => {
    const dock = read('../../sales/orders/record/dock/OrderDock.tsx')
    expect(dock).not.toContain('router.replace')
    expect(dock).toContain('frame?.setThread?.(scopeValueOf(next, narrow), { message: messageId })')
  })
})
