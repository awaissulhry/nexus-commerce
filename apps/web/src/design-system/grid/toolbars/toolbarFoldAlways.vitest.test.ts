import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GridToolbarFold } from './GridToolbarFold'

/** Step 4.3 #2 (R-52) — the filters are ALWAYS folded; the trigger names the active one. Static markup (node). */
const chip = createElement('button', { className: 'nds-fchip' }, 'Missing images')
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(GridToolbarFold, { label: 'Filters', ...props } as never, chip))

describe('GridToolbarFold mode="always"', () => {
  it('is a trigger from the first render, with the count of filters that exist', () => {
    const out = html({ mode: 'always', count: 6 })
    expect(out).toContain('nds-toolbar-fold is-folded')
    expect(out).toContain('<span class="nds-toolbar-fold-count">6</span>')
  })
  it('an active filter is named ON the trigger and styled as pressed', () => {
    const out = html({ mode: 'always', count: 6, activeLabel: 'Missing images' })
    expect(out).toContain('nds-toolbar-fold-trigger is-active')
    expect(out).toContain('<span class="nds-toolbar-fold-active">· Missing images</span>')
    expect(out).not.toContain('nds-toolbar-fold-count')
  })
  it('an EMPTY group never becomes a trigger, even when always', () => {
    expect(html({ mode: 'always', count: 0 })).not.toContain('is-folded')
  })
  it('the default (overflow) still renders inline until it has measured an overflow — R-LX-18 unchanged', () => {
    expect(html({ count: 6 })).not.toContain('is-folded')
  })
})
