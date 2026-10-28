import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GridSheetStatus } from './GridSheet'

describe('a sheet status source', () => {
  it('draws the live save counts while keeping its row count and child content', () => {
    const markup = renderToStaticMarkup(createElement(GridSheetStatus, {
      rows: 21,
      source: { subscribe: () => () => undefined, getSnapshot: () => ({ pending: 2, saving: true, refused: 1 }) },
      children: 'Review the highlighted cell',
    }))
    expect(markup).toContain('Saving 2 cells')
    expect(markup).toContain('<b>1</b> refused')
    expect(markup).toContain('<b>21</b> rows')
    expect(markup).toContain('Review the highlighted cell')
  })

  it('keeps ordinary prop-driven sheets unchanged', () => {
    const markup = renderToStaticMarkup(createElement(GridSheetStatus, { rows: 1, pending: 1 }))
    expect(markup).toContain('1 unsaved cell')
  })
})
