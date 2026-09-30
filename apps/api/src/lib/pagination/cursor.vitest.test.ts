/**
 * MCP.9 — the keyset cursor: a round trip gives the same position, anything altered or foreign is refused (never a
 * crash), page sizes are clamped, and walking a list with ties returns every row exactly once.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  MAX_RESULT_BYTES,
  cursorScope,
  decodeCursor,
  encodeCursor,
  fitPage,
  pageOf,
  pageSize,
  type CursorPosition,
} from './cursor.js'

const scope = cursorScope('listing-issues', { business: 'ws_alpha', channel: 'EBAY' })
const position: CursorPosition = { values: ['SKU-1', 'EBAY', 'IT'], id: 'cl_1' }

const refused = (cursor: unknown, inScope = scope) => {
  try {
    decodeCursor(inScope, cursor as string)
  } catch (error) {
    return error instanceof InvalidCursorError ? error.code : `threw ${String(error)}`
  }
  return 'accepted'
}

describe('MCP.9 — cursor round trip', () => {
  it('decodes to exactly the position it was made from', () => {
    const cursor = encodeCursor(scope, position)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(scope, cursor)).toEqual(position)
    const mixed: CursorPosition = { values: ['Ünïcode ✓', 3.5, true, null], id: 'x' }
    expect(decodeCursor(scope, encodeCursor(scope, mixed))).toEqual(mixed)
  })

  it('no cursor is the first page', () => {
    expect(decodeCursor(scope, undefined)).toBeNull()
    expect(decodeCursor(scope, null)).toBeNull()
    expect(decodeCursor(scope, '')).toBeNull()
  })

  it('the scope ignores key order and undefined filters', () => {
    expect(cursorScope('l', { b: 1, a: 'x', c: undefined })).toBe(cursorScope('l', { a: 'x', b: 1 }))
    expect(cursorScope('l', { a: 'x' })).not.toBe(cursorScope('l', { a: 'y' }))
  })
})

describe('MCP.9 — an altered or foreign cursor is refused, never a crash', () => {
  const cursor = encodeCursor(scope, position)

  it('refuses a cursor with any character changed', () => {
    const outcomes = new Set<string>()
    for (let i = 0; i < cursor.length; i++) {
      const swapped = cursor[i] === 'A' ? 'B' : 'A'
      outcomes.add(refused(cursor.slice(0, i) + swapped + cursor.slice(i + 1)))
    }
    expect([...outcomes]).toEqual(['invalid_arguments'])
  })

  it('refuses a cursor edited to point elsewhere without its check', () => {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const moved = Buffer.from(JSON.stringify({ ...payload, id: 'cl_999' })).toString('base64url')
    expect(refused(moved)).toBe('invalid_arguments')
  })

  it('refuses a cursor from other filters, another list or another business', () => {
    expect(refused(cursor, cursorScope('listing-issues', { business: 'ws_alpha', channel: 'AMAZON' }))).toBe('invalid_arguments')
    expect(refused(cursor, cursorScope('channel-price-stock', { business: 'ws_alpha', channel: 'EBAY' }))).toBe('invalid_arguments')
    expect(refused(cursor, cursorScope('listing-issues', { business: 'ws_bravo', channel: 'EBAY' }))).toBe('invalid_arguments')
  })

  it('refuses garbage of every shape', () => {
    const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
    const good = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const cases: unknown[] = [
      'not a cursor!',
      '====',
      'a'.repeat(MAX_CURSOR_LENGTH + 1),
      b64('{"v":1'),
      b64('null'),
      b64('[1,2,3]'),
      b64(42),
      b64({ ...good, v: 2 }),
      b64({ ...good, k: 'SKU-1' }),
      b64({ ...good, k: [{ nested: true }] }),
      b64({ ...good, k: Array.from({ length: 9 }, () => 'x') }),
      b64({ ...good, id: '' }),
      b64({ ...good, id: 7 }),
      b64({ ...good, s: undefined }),
      12345,
      { cursor: 'object' },
    ]
    expect(cases.map((c) => refused(c))).toEqual(cases.map(() => 'invalid_arguments'))
  })

  it('says what to do next', () => {
    expect(() => decodeCursor(scope, 'xyz')).toThrow(/Call again without cursor/)
  })
})

describe('MCP.9 — page size', () => {
  it('defaults to 25 and clamps to 1…100', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25)
    expect(MAX_PAGE_SIZE).toBe(100)
    expect(pageSize()).toBe(25)
    expect(pageSize(null)).toBe(25)
    expect(pageSize(Number.NaN)).toBe(25)
    expect(pageSize(500)).toBe(100)
    expect(pageSize(100)).toBe(100)
    expect(pageSize(0)).toBe(1)
    expect(pageSize(-4)).toBe(1)
    expect(pageSize(7.9)).toBe(7)
  })
})

describe('MCP.9 — walking a list with ties', () => {
  interface Row { group: string; id: string }
  const order = (a: Row, b: Row) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const positionOf = (row: Row): CursorPosition => ({ values: [row.group], id: row.id })
  const walkScope = cursorScope('walk', {})

  /** What a keyset query does: the rows strictly after the cursor, in order, one more than a page. */
  function read(table: Row[], cursor: string | null, size: number) {
    const after = decodeCursor(walkScope, cursor)
    const sorted = [...table].sort(order)
    const start = after ? sorted.filter((row) => order(row, { group: after.values[0] as string, id: after.id }) > 0) : sorted
    return pageOf(start.slice(0, size + 1), size, walkScope, positionOf)
  }

  // 23 rows in 3 groups of equal sort value: most pages end in the middle of a tie.
  const table: Row[] = Array.from({ length: 23 }, (_, i) => ({ group: ['a', 'b', 'c'][i % 3], id: `id${String(i).padStart(2, '0')}` }))

  it('returns every row exactly once, in order, for every page size', () => {
    for (let size = 1; size <= 9; size++) {
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const page = read(table, cursor, size)
        expect(page.items.length).toBeLessThanOrEqual(size)
        seen.push(...page.items.map((row) => row.id))
        cursor = page.nextCursor
        pages++
      } while (cursor && pages < 100)
      expect({ size, seen }).toEqual({ size, seen: [...table].sort(order).map((row) => row.id) })
      expect(pages).toBe(Math.ceil(table.length / size))
    }
  })

  it('a row added before the cursor between pages neither repeats nor hides a row after it', () => {
    const live = [...table]
    const first = read(live, null, 5)
    live.push({ group: 'a', id: 'id00a' }) // sorts before the first page's last row
    const rest: string[] = []
    let cursor = first.nextCursor
    while (cursor) {
      const page = read(live, cursor, 5)
      rest.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor
    }
    const all = [...first.items.map((row) => row.id), ...rest]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toEqual([...table].sort(order).map((row) => row.id))
  })

  it('the last page has no cursor, and an exact fit does not promise another page', () => {
    expect(read(table.slice(0, 6), null, 6).nextCursor).toBeNull()
    expect(read(table.slice(0, 7), null, 6).nextCursor).not.toBeNull()
    expect(read([], null, 6)).toEqual({ items: [], nextCursor: null })
  })
})

describe('MCP.9 — a page is held under the size limit', () => {
  const sizeScope = cursorScope('size', {})
  const item = (n: number) => ({ id: `id${n}`, text: 'x'.repeat(90) }) // about 110 bytes of JSON each
  const at = (row: { id: string }): CursorPosition => ({ values: [], id: row.id })
  const items = Array.from({ length: 10 }, (_, n) => item(n))

  it('leaves a page under the limit as it is', () => {
    const page = { items, nextCursor: null }
    expect(fitPage(page, sizeScope, at, 10_000)).toEqual({ ...page, cut: 0 })
    expect(MAX_RESULT_BYTES).toBe(50_000)
  })

  it('cuts a page above it, and the cursor starts the next page right after the last item kept', () => {
    const fitted = fitPage({ items, nextCursor: null }, sizeScope, at, 500)
    expect(fitted.items.map((row) => row.id)).toEqual(['id0', 'id1', 'id2', 'id3'])
    expect(fitted.cut).toBe(6)
    expect(JSON.stringify(fitted.items).length).toBeLessThanOrEqual(500)
    expect(decodeCursor(sizeScope, fitted.nextCursor)).toEqual({ values: [], id: 'id3' })
  })

  it('always keeps one item, so following nextCursor always moves on', () => {
    const fitted = fitPage({ items, nextCursor: 'next' }, sizeScope, at, 10)
    expect(fitted.items).toEqual([items[0]])
    expect(decodeCursor(sizeScope, fitted.nextCursor)).toEqual({ values: [], id: 'id0' })
    expect(fitPage({ items: [], nextCursor: null }, sizeScope, at, 10)).toEqual({ items: [], nextCursor: null, cut: 0 })
  })
})
