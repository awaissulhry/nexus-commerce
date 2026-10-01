import { describe, it, expect } from 'vitest'
import { widthsAsDefaults } from './columnWidths'

describe('widthsAsDefaults', () => {
  it('hands a column\'s width to AG as its default only, so a rebuild never resets the operator\'s width', () => {
    const out = widthsAsDefaults([{ colId: 'a', width: 135 }, { colId: 'b' }, { colId: 'c', width: 90, initialWidth: 120 }])
    expect(out).toEqual([{ colId: 'a', initialWidth: 135 }, { colId: 'b' }, { colId: 'c', initialWidth: 120 }])
  })

  it('does the same inside a language group', () => {
    const out = widthsAsDefaults([{ groupId: 'language:name', children: [{ colId: 'name@it', width: 200 }] }])
    expect(out).toEqual([{ groupId: 'language:name', children: [{ colId: 'name@it', initialWidth: 200 }] }])
  })
})
