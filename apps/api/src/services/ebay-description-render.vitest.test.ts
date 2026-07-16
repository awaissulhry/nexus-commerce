/**
 * ED.1 — pure renderer tests: tokens, escaping, galleries (single vs group),
 * specs, policies, the eBay active-content guard, and warnings.
 */
import { describe, it, expect } from 'vitest'
import {
  renderDescriptionTheme,
  sanitizeEbayHtml,
  BUILT_IN_THEMES,
  type DescriptionRenderData,
} from './ebay-description-render.js'

const base: DescriptionRenderData = {
  market: 'IT',
  title: 'Giacca Moto <Air> & Pro',
  subtitle: 'CE AA',
  body: '<p>Corpo <strong>HTML</strong> del venditore</p>',
  sku: 'AIR-M',
  brand: 'Xavia',
  mode: 'single',
  sharedImages: ['https://cdn.example.com/shared1.jpg', 'https://cdn.example.com/shared2.jpg'],
  imagesByGroup: [
    { value: 'Rosso', urls: ['https://cdn.example.com/r1.jpg', 'https://cdn.example.com/shared1.jpg'] },
    { value: 'Nero', urls: ['https://cdn.example.com/n1.jpg'] },
  ],
  rowImages: ['https://cdn.example.com/row1.jpg'],
  aspects: [
    { name: 'Colore', value: 'Rosso' },
    { name: 'Taglia', value: 'M' },
  ],
  policies: { shipping: 'Spedizione 24h', returns: 'Reso 30 giorni' },
}

describe('renderDescriptionTheme — tokens', () => {
  it('escapes text tokens, injects body raw, renders specs + policies', () => {
    const theme = '<h1>{{title}}</h1>{{body}}{{specs_table}}{{policies}}<i>{{market}} {{sku}} {{brand}}</i>'
    const { html, warnings } = renderDescriptionTheme(theme, base)
    expect(html).toContain('Giacca Moto &lt;Air&gt; &amp; Pro') // escaped
    expect(html).toContain('<strong>HTML</strong>') // body raw
    expect(html).toContain('Colore') // specs table
    expect(html).toContain('Spedizione 24h')
    expect(html).toContain('IT AIR-M Xavia')
    expect(warnings).toEqual([])
  })

  it('single mode gallery uses the row images; group mode renders titled colour sections', () => {
    const single = renderDescriptionTheme('{{gallery}}', base)
    expect(single.html).toContain('row1.jpg')
    expect(single.html).not.toContain('<h3') // no sections in single mode

    const group = renderDescriptionTheme('{{gallery}}', { ...base, mode: 'group' })
    expect(group.html).toContain('shared1.jpg') // shared first
    expect(group.html).toContain('>Rosso</h3>')
    expect(group.html).toContain('>Nero</h3>')
    expect(group.html).toContain('r1.jpg')
    // shared image is not repeated inside the Rosso section
    expect(group.html.split('shared1.jpg').length - 1).toBe(1)
  })

  it('strips unknown tokens with a warning', () => {
    const { html, warnings } = renderDescriptionTheme('a {{nope_token}} b', base)
    expect(html).toBe('a  b')
    expect(warnings.some((w) => w.includes('nope_token'))).toBe(true)
  })

  it('all built-in starter themes render without warnings', () => {
    for (const t of BUILT_IN_THEMES) {
      const { warnings } = renderDescriptionTheme(t.html, { ...base, mode: 'group' })
      expect(warnings).toEqual([])
    }
  })
})

describe('sanitizeEbayHtml — active-content guard', () => {
  it('removes scripts/iframes/forms and inline handlers, neutralizes javascript: URLs', () => {
    const dirty =
      '<div onclick="evil()"><script>alert(1)</script><iframe src="https://x"></iframe>' +
      '<a href="javascript:evil()">x</a><form action="/p"><input /></form>ok</div>'
    const { html, warnings } = sanitizeEbayHtml(dirty)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('ok')
    expect(warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('upgrades http:// media to https:// and reports it', () => {
    const { html, warnings } = sanitizeEbayHtml('<img src="http://cdn.example.com/a.jpg" />')
    expect(html).toContain('src="https://cdn.example.com/a.jpg"')
    expect(warnings.some((w) => w.includes('https://'))).toBe(true)
  })

  it('passes clean HTML through unchanged', () => {
    const clean = '<div style="color:#111;"><p>ciao</p><img src="https://c/a.jpg" /></div>'
    const { html, warnings } = sanitizeEbayHtml(clean)
    expect(html).toBe(clean)
    expect(warnings).toEqual([])
  })
})
