/**
 * `FamilyFooterFrame` (2026-10-23) — the row under an open family, shared by Products and Listing readiness. Its words
 * are the ones Products said before the move; its styles are the ones Products' module held, now on DS tokens.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FamilyFooterFrame, type FamilyFooterFrameProps } from './FamilyFooterFrame'

const html = (props: FamilyFooterFrameProps) => renderToStaticMarkup(createElement(FamilyFooterFrame, props))
const web = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const factory = (path: string) => readFileSync(new URL(`../../../../../factory/src/design-system/${path}`, import.meta.url), 'utf8')
const rule = (css: string, selector: string) => new RegExp(`${selector.replace(/[.-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null

describe('FamilyFooterFrame', () => {
  it('a capped family says how many are on screen of how many', () => {
    expect(html({ shown: 10, total: 40 })).toBe(
      '<div class="nds-grid-famfoot"><span class="nds-grid-famfoot-count">Showing <b>10</b> of <b>40</b> variations</span></div>',
    )
  })
  it('a complete family says only its size, singular for one', () => {
    expect(html({ shown: 3, total: 3 })).toContain('<b>3</b> variations</span>')
    expect(html({ shown: 1, total: 1 })).toContain('<b>1</b> variation</span>')
    expect(html({ shown: 0, total: 0 })).toContain('<b>0</b> variations</span>')
  })
  it('takes its own noun', () => {
    expect(html({ shown: 10, total: 12, noun: 'products', nounOne: 'product' })).toContain('Showing <b>10</b> of <b>12</b> products</span>')
    expect(html({ shown: 1, total: 1, noun: 'products', nounOne: 'product' })).toContain('<b>1</b> product</span>')
  })
  it('the extra line is muted like the count, with its hover text; the action comes last', () => {
    const out = html({ shown: 2, total: 2, extra: 'Variation mapping · Not computed', extraTitle: 'Not answered yet.', action: createElement('a', { href: '/products' }, 'Open family') })
    expect(out).toBe(
      '<div class="nds-grid-famfoot"><span class="nds-grid-famfoot-count"><b>2</b> variations</span>'
      + '<span class="nds-grid-famfoot-count" title="Not answered yet.">Variation mapping · Not computed</span><a href="/products">Open family</a></div>',
    )
  })
  it('the styles are on DS tokens and the same in web and Factory', () => {
    expect(web('grid/toolbars/FamilyFooterFrame.tsx')).toBe(factory('grid/toolbars/FamilyFooterFrame.tsx'))
    for (const [app, css] of [['web', web('grid/theme/grid.css')], ['factory', factory('grid/theme/grid.css')]] as const) {
      const frame = rule(css, '.nds-grid-famfoot')
      expect(frame, `${app} .nds-grid-famfoot`).toMatch(/gap: var\(--nds-space-12\)/)
      expect(frame, app).toMatch(/padding: var\(--nds-space-10\) var\(--nds-space-14\)/)
      expect(frame, app).toMatch(/height: 100%/)
      expect(rule(css, '.nds-grid-famfoot-count'), app).toMatch(/color: var\(--nds-text-muted\)/)
    }
  })
})
