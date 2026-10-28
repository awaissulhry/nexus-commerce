import { describe, expect, it } from 'vitest'
import { groupOptions } from './group-options'

const opt = (value: string, group?: string) => ({ value, group })

describe('groupOptions', () => {
  it('returns null when no option declares a group, so the caller keeps its flat path', () => {
    expect(groupOptions([opt('a'), opt('b')])).toBeNull()
  })

  it('buckets by group in FIRST-SEEN order, not alphabetically', () => {
    const g = groupOptions([opt('a', 'Zebra'), opt('b', 'Apple'), opt('c', 'Zebra')])!
    expect(g.groups.map((x) => x.name)).toEqual(['Zebra', 'Apple'])
    expect(g.groups[0].options.map((o) => o.value)).toEqual(['a', 'c'])
  })

  it('flat is EXACTLY the rendered order — this is what keyboard nav indexes', () => {
    // interleaved input: grouping must pull 'c' up next to 'a'
    const g = groupOptions([opt('a', 'X'), opt('b', 'Y'), opt('c', 'X'), opt('d', 'Y')])!
    expect(g.flat.map((o) => o.value)).toEqual(['a', 'c', 'b', 'd'])
    // and the flat order must equal a walk of the groups, or ArrowDown desyncs from the eye
    expect(g.flat).toEqual(g.groups.flatMap((x) => x.options))
  })

  it('keeps every option — nothing is dropped by bucketing', () => {
    const input = [opt('a', 'X'), opt('b'), opt('c', 'Y'), opt('d', 'X')]
    const g = groupOptions(input)!
    expect(g.flat).toHaveLength(input.length)
    expect(new Set(g.flat.map((o) => o.value))).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('puts ungrouped options in their own unnamed bucket rather than inventing a heading', () => {
    const g = groupOptions([opt('a'), opt('b', 'X')])!
    expect(g.groups[0].name).toBe('')
    expect(g.groups[0].options.map((o) => o.value)).toEqual(['a'])
  })
})
