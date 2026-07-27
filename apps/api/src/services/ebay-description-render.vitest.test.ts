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

describe('renderDescriptionTheme — tokens inside the operator body (v2)', () => {
  it('{{specs_table}} inside the body renders the live table inline', () => {
    const { html, warnings } = renderDescriptionTheme('<div>{{body}}</div>', {
      ...base,
      body: '<p>Misure:</p>{{specs_table}}',
    })
    expect(html).toContain('Misure:')
    expect(html).toContain('Taglia') // live aspects table, rendered in the body
    expect(warnings).toEqual([])
  })

  it('{{policy_shipping}} inside the body renders the live policy name — and feeds the mobile summary (derived from the RESOLVED body)', () => {
    // (trailing word after the token: the summary's word-boundary trim always
    // drops the final word — pre-existing v1 behaviour, not under test here)
    const { html, warnings } = renderDescriptionTheme('{{mobile_summary}}|{{body}}', {
      ...base,
      body: 'Servizio: {{policy_shipping}} incluso',
    })
    const [summary, body] = html.split('|')
    expect(body).toContain('Spedizione 24h')
    expect(summary).toContain('Spedizione 24h')
    expect(warnings).toEqual([])
  })

  it('{{body}}/{{mobile_summary}} inside the body never recurse — stripped with a warning', () => {
    const { html, warnings } = renderDescriptionTheme('<div>{{body}}</div>', {
      ...base,
      body: 'a {{body}} b {{mobile_summary}} c',
    })
    expect(html).toBe('<div>a  b  c</div>')
    expect(warnings).toEqual(['token {{body}}/{{mobile_summary}} is not allowed inside the description body'])
  })

  it('unknown tokens inside the body follow the strip+warn behaviour', () => {
    const { html, warnings } = renderDescriptionTheme('<div>{{body}}</div>', {
      ...base,
      body: 'x {{foo_bar}} y',
    })
    expect(html).toBe('<div>x  y</div>')
    expect(warnings.some((w) => w.includes('foo_bar'))).toBe(true)
  })

  it('token output is inert — one pass only, no nested re-interpolation', () => {
    // sku resolves to a value that LOOKS like a token; it must stay literal.
    const { html, warnings } = renderDescriptionTheme('<div>{{body}}</div>', {
      ...base,
      sku: '{{title}}',
      body: 'ref {{sku}}',
    })
    expect(html).toBe('<div>ref {{title}}</div>')
    expect(warnings).toEqual([])
  })
})

describe('Xavia Pro Clean v2 — info-first layout + clickable accordions', () => {
  const xavia = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Pro Clean')!.html
  const data: DescriptionRenderData = {
    ...base,
    mode: 'group',
    policies: { shipping: 'Spedizione 24h', returns: 'Reso 30 giorni', payment: 'PayPal e carte' },
  }

  it('renders in order: mobile summary → hero title → body → specs → policy sections → gallery LAST', () => {
    const { html, warnings } = renderDescriptionTheme(xavia, data)
    expect(warnings).toEqual([])
    const order = [
      html.indexOf('property="description"'), // hidden schema.org mobile summary
      html.indexOf('<h1'), // hero
      html.indexOf('<strong>HTML</strong>'), // operator body
      html.indexOf('Taglia'), // specs table content — promoted above the sections
      html.indexOf("Spedizione rapida e tracciata dall'Italia"), // policy sections
      html.indexOf('Dettagli prodotto'), // gallery header at the bottom…
      html.indexOf('r1.jpg'), // …with the gallery itself LAST
    ]
    for (const idx of order) expect(idx).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The explicit assertion: gallery html appears AFTER the specs_table content.
    expect(html.indexOf('r1.jpg')).toBeGreaterThan(html.indexOf('Taglia'))
    // Full per-colour sections survive the relocation.
    expect(html).toContain('>Rosso</h3>')
    expect(html).toContain('>Nero</h3>')
  })

  it('all five sections are <details open> accordions with pill summaries — and survive sanitization', () => {
    const { html } = renderDescriptionTheme(xavia, data) // output is post-sanitize
    expect(html.match(/<details open/g)).toHaveLength(5)
    expect(html.match(/<summary /g)).toHaveLength(5)
    for (const label of ['Specifiche', 'Spedizione', 'Resi e diritto di recesso', 'Garanzia', 'Sicurezza prodotto']) {
      expect(html).toContain(`>${label}</summary>`)
    }
  })

  it('is fully token-driven: live policy names inside their sections, {{brand}} hero mark, {{sku}} footer', () => {
    const { html } = renderDescriptionTheme(xavia, data)
    const section = (label: string): string => {
      const start = html.indexOf(`>${label}</summary>`)
      expect(start).toBeGreaterThan(-1)
      return html.slice(start, html.indexOf('</details>', start))
    }
    expect(section('Spedizione')).toContain('Spedizione 24h') // {{policy_shipping}}
    expect(section('Spedizione')).toContain('PayPal e carte') // {{policy_payment}}
    expect(section('Resi e diritto di recesso')).toContain('Reso 30 giorni') // {{policy_returns}}
    expect(html).toContain('letter-spacing:3px;color:#9ca3af;">Xavia</div>') // {{brand}}, not hardcoded
    expect(html).toContain('Cod. articolo: AIR-M') // {{sku}}
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

  it('round-trip: <details open>/<summary> accordions survive verbatim (the v2 clickable sections)', () => {
    const acc =
      '<details open style="margin:18px 0 0;">' +
      '<summary style="display:inline-flex;list-style:none;cursor:pointer;background:#111827;color:#ffffff;">Specifiche</summary>' +
      '<div style="border:1px solid #e5e7eb;"><p>corpo</p></div>' +
      '</details>'
    const { html, warnings } = sanitizeEbayHtml(acc)
    expect(html).toBe(acc)
    expect(warnings).toEqual([])
  })
})
