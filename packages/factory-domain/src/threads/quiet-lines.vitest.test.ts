import { describe, expect, it } from 'vitest'
import { feedEventOf, groupQuietLines, QUIET_LINE_BODY, QUIET_LINE_KEYS, quietArgsFit, type FeedRow } from './quiet-lines'

/** owb- po2.3: quiet lines — the keys (G12: a lower-case letter first), the args, the grouping at read time (newest first). */
describe('quiet lines', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 28, 9, minute))
  const quiet = (id: string, minute: number, key = 'quiet.lineAdded', by = 'FACTORY'): FeedRow => ({ id, at: at(minute), eventKey: key, eventArgs: { by } })
  const plain = (id: string, minute: number): FeedRow => ({ id, at: at(minute), eventKey: null, eventArgs: null })

  it('every key starts with a lower-case letter (the guard G12) and has its plain words', () => {
    for (const key of QUIET_LINE_KEYS) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9_-]*([.][A-Za-z0-9_-]+)*$/)
      expect(QUIET_LINE_BODY[key].length).toBeGreaterThan(5)
    }
  })

  it('args are ids and short values only', () => {
    expect(quietArgsFit({ fileId: '0193c0de-0000-7000-8000-000000000001', count: 2 })).toBe(true)
    expect(quietArgsFit({ words: 'x'.repeat(101) })).toBe(false)
    expect(quietArgsFit({ nested: { a: 1 } })).toBe(false)
    expect(quietArgsFit({ Bad: 'x' })).toBe(false)
  })

  it('one side’s lines of one key inside 10 minutes are ONE line; a message between, another side or key, or 11 minutes apart are not', () => {
    const rows = [quiet('q4', 20), quiet('q3', 15), quiet('q2', 12), plain('m1', 11), quiet('q1', 10), quiet('q0', 9, 'quiet.lineAdded', 'CUSTOMER'), quiet('qp', 8, 'quiet.pictureSet')]
    const grouped = groupQuietLines(rows)
    expect([...grouped.dropped].sort()).toEqual(['q2', 'q3'])
    expect(grouped.counts.get('q4')).toBe(3)
    expect(grouped.counts.get('q1')).toBe(1)
    expect(grouped.counts.get('q0')).toBe(1)
    expect(grouped.counts.get('qp')).toBe(1)
    expect(groupQuietLines([quiet('a', 30), quiet('b', 19)]).dropped.size).toBe(0)
  })

  it('the feed’s event: the key, the args, the count; an ordinary message has none', () => {
    expect(feedEventOf({ id: 'q', eventKey: 'quiet.fileShared', eventArgs: { fileId: 'f-1', by: 'FACTORY', bad: { x: 1 } } }, new Map([['q', 2]]))).toEqual({ key: 'quiet.fileShared', args: { fileId: 'f-1', by: 'FACTORY' }, count: 2 })
    expect(feedEventOf({ id: 'm', eventKey: null, eventArgs: null }, new Map())).toBeNull()
    expect(feedEventOf({ id: 'x', eventKey: 'quiet.unknown', eventArgs: {} }, new Map())).toBeNull()
  })
})
