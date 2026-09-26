/**
 * `Button wrap` (2026-09-26) — a link-like button whose label may be one long unbroken token (a SKU) must
 * wrap inside its container. `.nds-btn` is `white-space: nowrap`; measured in a real browser at 390 px, a
 * 63-character SKU link was 642 px wide and pushed its card row past the viewport. Opt-in: no existing
 * button changes.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

const web = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const factory = (path: string) => readFileSync(new URL(`../../../../factory/src/design-system/${path}`, import.meta.url), 'utf8')
const rule = (css: string, selector: string) => new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null

describe('Button wrap', () => {
  it('adds the wrap class only when asked, on a button and on an asChild link', () => {
    expect(renderToStaticMarkup(createElement(Button, { variant: 'link', inline: true, wrap: true }, 'A-VERY-LONG-SKU'))).toMatch(/class="nds-btn link inline wrap"/)
    expect(renderToStaticMarkup(createElement(Button, { variant: 'link', inline: true }, 'x'))).not.toMatch(/\bwrap\b/)
    const link = renderToStaticMarkup(createElement(Button, { asChild: true, variant: 'link', wrap: true }, createElement('a', { href: '/p' }, 'SKU')))
    expect(link).toMatch(/^<a [^>]*class="nds-btn link wrap"[^>]*>SKU<\/a>$/)
    expect(link).toMatch(/href="\/p"/)
  })
  it('the stylesheet lets a wrap button break its label anywhere, in web and in Factory', () => {
    for (const [app, css] of [['web', web('styles/primitives.css')], ['factory', factory('styles/primitives.css')]] as const) {
      const body = rule(css, '.nds-btn.wrap')
      expect(body, `${app} .nds-btn.wrap`).not.toBeNull()
      expect(body, app).toMatch(/white-space:\s*normal/)
      expect(body, app).toMatch(/overflow-wrap:\s*anywhere/)
    }
    // Positive control: the base rule this overrides really is nowrap.
    expect(rule(web('styles/primitives.css'), '.nds-btn')).toMatch(/white-space:\s*nowrap/)
  })
  it('Factory carries the same Button source (mirror)', () => {
    expect(factory('primitives/Button.tsx')).toBe(web('primitives/Button.tsx'))
  })
})
