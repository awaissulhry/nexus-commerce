/**
 * The shared page header (112 pages) and the "Updated" freshness box (49 pages) read the app's theme.
 *
 * Both were coloured with Tailwind's semantic text/border classes, which read `rgb(var(--text-primary) / 1)`.
 * tokens.css redefines those names as whole colours, so the value was invalid and the text fell back to the
 * inherited black: #000 on #020617 (1.04:1) in the app's dark mode, measured on /customers. They now read
 * --nds-* tokens from their own stylesheets. Held here: no Tailwind colour class is back on either component,
 * and every token their stylesheets read is defined for every page (tokens-global.css, which the root layout
 * loads) and flipped by `.dark` where the DS flips it — never a platform alias, never a literal colour.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PageHeader from './PageHeader'
import FreshnessIndicator from '../filters/FreshnessIndicator'

const HERE = import.meta.dirname
const read = (path: string) => readFileSync(path, 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const headerCss = stripComments(read(join(HERE, 'page-header.css')))
const freshnessCss = stripComments(read(join(HERE, '..', 'filters', 'freshness-indicator.css')))
const tokensGlobal = stripComments(read(join(HERE, '..', '..', 'design-system', 'styles', 'tokens-global.css')))

/** Tailwind classes that colour text, fills or borders through the colliding aliases or raw palettes. */
const TAILWIND_COLOUR = /\b(text|bg|border)-(primary|secondary|tertiary|default|subtle|strong|white|black|slate-\d+|rose-\d+|amber-\d+)\b|hover:(text|border)-/

describe('the shared page header', () => {
  const html = renderToStaticMarkup(createElement(PageHeader, {
    title: 'Customers',
    description: 'Customer-360 view',
    breadcrumbs: [{ label: 'Home', href: '/' }, { label: 'Customers' }],
    actions: createElement('button', { type: 'button' }, 'Export CSV'),
  }))

  it('renders its parts with its own classes, and no Tailwind colour class', () => {
    expect(html).toContain('<h1 class="app-pagehdr-title">Customers</h1>')
    expect(html).toContain('<p class="app-pagehdr-desc">Customer-360 view</p>')
    expect(html).toContain('<nav class="app-pagehdr-crumbs" aria-label="Breadcrumb">')
    expect(html).toContain('<span class="app-pagehdr-crumb-current">Customers</span>')
    expect(html).toContain('class="app-pagehdr-actions"')
    expect(html).not.toMatch(TAILWIND_COLOUR)
  })

  it('description falls back to subtitle, as before', () => {
    const withSubtitle = renderToStaticMarkup(createElement(PageHeader, { title: 'T', subtitle: 'From subtitle' }))
    expect(withSubtitle).toContain('<p class="app-pagehdr-desc">From subtitle</p>')
  })
})

describe('the "Updated" freshness box', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(FreshnessIndicator, { lastFetchedAt: Date.now() - 5_000, ...props } as never))

  it('fresh, stale and failed each take a tone class, and no Tailwind colour class', () => {
    const fresh = render({})
    expect(fresh).toMatch(/<span[^>]* class="app-freshness"[^>]*>.*Updated \ds ago/)
    expect(render({ lastFetchedAt: Date.now() - 120_000, onRefresh: () => undefined })).toContain('class="app-freshness is-stale"')
    expect(render({ error: true })).toContain('class="app-freshness is-error"')
    for (const html of [fresh, render({ error: true }), render({ loading: true })]) expect(html).not.toMatch(TAILWIND_COLOUR)
  })
})

describe('what their stylesheets read', () => {
  const read = (css: string) => [...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(tokensGlobal)?.[1] ?? ''
  const definedAtRoot = new Set([...rootBlock.matchAll(/(--nds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

  it.each([['page-header.css', headerCss], ['freshness-indicator.css', freshnessCss]])('%s: DS tokens only, each defined for every page', (_name, css) => {
    const tokens = read(css)
    expect(tokens.length).toBeGreaterThan(5)
    expect(tokens.filter((t) => !t.startsWith('--nds-'))).toEqual([])
    expect(tokens.filter((t) => !definedAtRoot.has(t))).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/rgb\(/)
  })

  it('the colours they read are the ones `.dark` flips (control: the dark block is read)', () => {
    const dark = /\.dark, \.dark body[^{]*\{([^}]*)\}/.exec(tokensGlobal)?.[1] ?? ''
    for (const token of ['--nds-text', '--nds-text-2', '--nds-surface', '--nds-border', '--nds-warning-text', '--nds-danger-text']) {
      expect(dark, token).toMatch(new RegExp(`${token}\\s*:`))
    }
  })
})
