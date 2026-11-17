import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { escCloses, LIST_SHARE, PANE_SHARE, paneWidth, SPLIT_FROM, splitLayout } from './model'
import { SplitPane } from './SplitPane'

/** B-TH-212 — SplitPane: the list and its record side by side from 1024 px (35 : 65), one at a time below; Esc closes the pane. */

describe('SplitPane', () => {
  it('both side by side on a wide screen, one at a time on a narrow one, the list alone with nothing open', () => {
    expect(splitLayout(1440, true)).toBe('split')
    expect(splitLayout(SPLIT_FROM, true)).toBe('split')
    expect(splitLayout(375, true)).toBe('pane')
    expect(splitLayout(1920, false)).toBe('list')
    expect(LIST_SHARE + PANE_SHARE).toBe(100)
  })

  it('the pane is about 65 % of the width (design kit §2: ~838 at 1440, ~1150 at 1920)', () => {
    expect(paneWidth(1374)).toBe(883)
    expect(paneWidth(1854)).toBe(1195)
    expect(paneWidth(375)).toBe(375)
  })

  it('Esc closes the pane, never while typing or in a dialog', () => {
    expect(escCloses({ tagName: 'DIV', inDialog: false })).toBe(true)
    expect(escCloses({ tagName: 'TEXTAREA', inDialog: false })).toBe(false)
    expect(escCloses({ tagName: 'BUTTON', inDialog: true })).toBe(false)
    expect(escCloses({ tagName: 'DIV', isContentEditable: true, inDialog: false })).toBe(false)
  })

  it('draws the list alone, or the list and a named pane with a way back', () => {
    const alone = renderToStaticMarkup(createElement(SplitPane, { list: 'LIST', pane: null, labels: { pane: 'Reading pane', close: 'Back' } }))
    expect(alone).toBe('<div class="fw-split"><div class="fw-split-list">LIST</div></div>')
    const open = renderToStaticMarkup(createElement(SplitPane, { list: 'LIST', pane: 'PANE', labels: { pane: 'Reading pane', close: 'Back' }, onClose: () => undefined }))
    expect(open).toContain('class="fw-split is-open"')
    expect(open).toContain('<section class="fw-split-pane" aria-label="Reading pane">')
    expect(open).toContain('Back')
    expect(open).toContain('PANE')
  })
})
