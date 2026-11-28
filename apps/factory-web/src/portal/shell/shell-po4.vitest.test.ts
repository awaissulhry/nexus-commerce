import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { designScreen } from './fixtures'

/**
 * owb-po4.2 (order workflow plan § 5 "Customer portal": the office's sidebar + sub-sidebar; § 5 F) — the portal frame draws the
 * office's DS rail (AppRail, 66 px, labels on hover or focus) and, for an area of two or more pages, the office's sub-sidebar
 * (WorkspaceSubheader + areaSubNavGroups). Written, not run (Owner rule: checks at the end).
 */

const draw = (id: string, locale: 'it' | 'en' = 'en') => {
  const entry = designScreen.cases.find((item) => item.id === id)!
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
}
const anchors = (html: string): string[] => html.match(/<a\b[^>]*>/g) ?? []
const railRows = (html: string) => anchors(html).filter((tag) => /class="h10-item\b/.test(tag))
const railRow = (html: string, href: string) => railRows(html).find((tag) => tag.includes(`href="${href}"`)) ?? ''

describe('owb-po4.2 — the portal frame on the office’s rail and sub-sidebar', () => {
  it('draws the DS rail, not the composed 240 px one: one row per area in the design’s order, the current one marked, a count named with its noun', () => {
    const html = draw('customer')
    expect(html).toContain('h10-rail')
    expect(html).not.toContain('fw-prail')
    expect(railRows(html).map((tag) => /href="([^"]+)"/.exec(tag)![1])).toEqual([
      '/p/BRAND-ALPHA',
      '/p/BRAND-ALPHA/orders',
      '/p/BRAND-ALPHA/customers',
      '/p/BRAND-ALPHA/catalogue',
      '/p/BRAND-ALPHA/people',
      '/p/BRAND-ALPHA/documents',
      '/p/BRAND-ALPHA/account',
    ])
    expect(railRow(html, '/p/BRAND-ALPHA')).toContain('aria-current="page"')
    expect(railRows(html).filter((tag) => tag.includes('aria-current="page"'))).toHaveLength(1)
    // The one task list's words: "Orders, 2 to confirm" (Orders also counts Production's and Returns', none here), Products' approvals.
    expect(railRow(html, '/p/BRAND-ALPHA/orders')).toContain('aria-label="Orders, 2 to confirm"')
    expect(railRow(html, '/p/BRAND-ALPHA/catalogue')).toContain('aria-label="Products, 1 to approve"')
    expect(railRow(html, '/p/BRAND-ALPHA/people')).toContain('aria-label="People"')
    // The top bar keeps the search ("your PO number works") and the bell.
    expect(html).toContain('your PO number works')
  })

  it('on a page of Orders (Returns & claims): the rail lights Orders, the band carries Orders’ sub-sidebar toggle; no Pages menu any more', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('po4-sub-sidebar', locale)
      expect(railRow(html, '/p/BRAND-ALPHA/orders'), locale).toContain('aria-current="page"')
      expect(railRow(html, '/p/BRAND-ALPHA'), locale).not.toContain('aria-current')
      expect(html, locale).toContain('nds-workspace-subheader')
      expect(html, locale).not.toContain('fw-ppages')
    }
    expect(draw('po4-sub-sidebar', 'en')).toContain('aria-label="Expand pages of orders"')
    expect(draw('po4-sub-sidebar', 'it')).toContain('aria-label="Apri pagine di ordini"')
  })

  it('a card’s page (Waiting for you) keeps Home lit; Home is one page: no sub-sidebar', () => {
    const html = draw('po4-card-page')
    expect(railRow(html, '/p/BRAND-ALPHA')).toContain('aria-current="page"')
    expect(html).not.toContain('nds-workspace-subheader')
  })

  it('keyboard order: top bar → rail → band (its toggle first) → the page → the foot', () => {
    const html = draw('po4-sub-sidebar')
    const at = (needle: string) => html.indexOf(needle)
    expect(at('class="fw-ptop"')).toBeGreaterThan(-1)
    expect(at('class="fw-ptop"')).toBeLessThan(at('h10-rail'))
    expect(at('h10-rail')).toBeLessThan(at('nds-workspace-subheader'))
    expect(at('nds-workspace-subheader')).toBeLessThan(at('id="main-content"'))
    expect(at('id="main-content"')).toBeLessThan(at('class="fw-pfoot"'))
  })

  it('375 px: no rail and no reserved strip on a phone (the bottom bar instead), so nothing pushes the page sideways', () => {
    const css = readFileSync(new URL('./portal-shell.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-pbody {\n  position: relative;\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  padding-left: 66px;\n}')
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'))
    expect(phone).toContain('.fw-pbody {\n    padding-left: 0;\n  }')
    expect(phone).toContain('.fw-pbody > .h10-rail {\n    display: none;\n  }')
    expect(css).not.toMatch(/fw-prail|width: 240px/)
    const view = readFileSync(new URL('./view/PortalShellView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import '@nexus/ui/patterns/shell/app-rail.css'")
    expect(view).not.toContain('PortalRail')
  })
})
