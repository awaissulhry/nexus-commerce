import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DensityProvider, GridDensityProvider, useDensity, useDensityTokens, useGridDensity, type DensityName } from './density'

/** Prints what a component inside the tree reads: the tier, two of its numbers, and the grid density. */
function Probe() {
  const t = useDensityTokens()
  return createElement('i', null, `${useDensity()}|${t.density} ${t.controlH} ${t.icon}|${useGridDensity()}`)
}
const probe = createElement(Probe)
const html = (node: ReactNode) => renderToStaticMarkup(node)
const page = (value: DensityName, ...children: ReactNode[]) => createElement(DensityProvider, { value, children: createElement(Fragment, null, ...children) })

describe('DensityProvider — the page density', () => {
  it('outside any provider: standard, the console sizes, and no attribute anywhere', () => {
    expect(html(probe)).toBe('<i>standard|standard 30 15|spacious</i>')
  })

  it('switches its subtree: data-density on a display:contents wrapper, and the same tier in the context', () => {
    expect(html(page('floor', probe))).toBe(
      '<div data-density="floor" style="display:contents"><i>floor|floor 56 28|spacious</i></div>',
    )
    expect(html(page('comfortable', probe))).toBe(
      '<div data-density="comfortable" style="display:contents"><i>comfortable|comfortable 44 20|spacious</i></div>',
    )
  })

  it('a nested provider steps back to standard for its own subtree only', () => {
    const tree = page('floor', probe, page('standard', probe))
    expect(html(tree)).toBe(
      '<div data-density="floor" style="display:contents"><i>floor|floor 56 28|spacious</i>' +
        '<div data-density="standard" style="display:contents"><i>standard|standard 30 15|spacious</i></div></div>',
    )
  })

  it('is a separate axis from the grid density: neither provider moves the other', () => {
    const tree = createElement(GridDensityProvider, { value: 'compact', children: page('floor', probe) })
    expect(html(tree)).toBe('<div data-density="floor" style="display:contents"><i>floor|floor 56 28|compact</i></div>')
  })
})
