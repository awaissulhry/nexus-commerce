import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OptionList, nextSelection } from './OptionList'
import { MultiSelect } from './MultiSelect'

/** Step 4.3 #2 (T1) — `minSelected` (a language picker can never drop to none) and MultiSelect's bar tier. */
const opts = [{ value: 'it', label: 'Italian' }, { value: 'de', label: 'German' }, { value: 'fr', label: 'French' }]

describe('nextSelection', () => {
  it('adds, and removes while above the minimum', () => {
    expect(nextSelection(['it'], 'de', 1)).toEqual(['it', 'de'])
    expect(nextSelection(['it', 'de'], 'it', 1)).toEqual(['de'])
  })
  it('never drops below the minimum', () => {
    expect(nextSelection(['it'], 'it', 1)).toEqual(['it'])
  })
  it('minimum 0 is the old toggle (every existing caller)', () => {
    expect(nextSelection(['it'], 'it')).toEqual([])
  })
})

describe('OptionList minSelected', () => {
  const html = (min?: number, value = ['it']) => renderToStaticMarkup(createElement(OptionList, { options: opts, value, onChange: () => {}, minSelected: min }))
  it('the last selected option is announced as locked, and Select all is not offered', () => {
    const out = html(1)
    expect(out).not.toContain('Select all')
    expect(out).toContain('title="At least 1 must stay selected"')
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(1)
  })
  it('with no minimum the markup is what it always was (Select all, nothing locked)', () => {
    const out = html(undefined)
    expect(out).toContain('Select all')
    expect(out).not.toContain('aria-disabled')
  })
})

describe('MultiSelect — the bar tier and its label', () => {
  const html = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(MultiSelect, { options: opts, value: ['it', 'de'], onChange: () => {}, ...extra }))
  it('size="sm" width="auto" put it on the 28px tier with no 160px minimum', () => {
    expect(html({ size: 'sm', width: 'auto' })).toContain('class="nds-ms sm auto"')
  })
  it('formatLabel names the selection', () => {
    expect(html({ formatLabel: (v: string[]) => `Italian +${v.length - 1}` })).toContain('>Italian +1<')
  })
  it('defaults keep today\'s class and label', () => {
    const out = html()
    expect(out).toContain('class="nds-ms"')
    expect(out).toContain('>2 selected<')
    expect(out).toContain('aria-haspopup="listbox"')
  })
})
