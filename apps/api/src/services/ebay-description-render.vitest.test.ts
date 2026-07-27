/**
 * ED.1 — pure renderer tests: tokens, escaping, galleries (single vs group),
 * specs, policies, the eBay active-content guard, and warnings.
 */
import { describe, it, expect } from 'vitest'
import {
  renderDescriptionTheme,
  renderDescriptionBodyOnly,
  sanitizeEbayHtml,
  BUILT_IN_THEMES,
  BUILT_IN_PREVIOUS,
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
    expect(warnings).toEqual(['token {{body}}/{{mobile_summary}}/{{gallery_hero}} is not allowed inside the description body'])
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
    expect(html).toContain('letter-spacing:.5px;">AIR-M</span>') // {{sku}} footer, label-free
  })

  it('footer {{sku}} is LABEL-FREE — family listings (no sku) render no dangling "Cod. articolo:"', () => {
    // v2.1: group-mode call sites pass no sku, so a hardcoded label would
    // dangle on every family listing. Same pattern as the policy lines.
    expect(xavia).not.toContain('Cod. articolo')
    const { html } = renderDescriptionTheme(xavia, { ...data, sku: undefined })
    expect(html).toContain('letter-spacing:.5px;"></span>') // collapses to invisible empty markup
  })
})

describe('renderDescriptionBodyOnly — raw-mode (unthemed) body-token rendering', () => {
  it('resolves body tokens with no theme wrapper, sanitized', () => {
    const { html, warnings } = renderDescriptionBodyOnly({
      ...base,
      body: '<p>Misure:</p>{{specs_table}}<img src="http://cdn.example.com/a.jpg" />',
    })
    expect(html.startsWith('<p>Misure:</p>')).toBe(true) // no theme wrapper
    expect(html).toContain('Taglia') // live specs table
    expect(html).toContain('src="https://cdn.example.com/a.jpg"') // sanitizer ran
    expect(warnings.some((w) => w.includes('https://'))).toBe(true)
  })

  it('the forbidden-token guard applies in raw mode too', () => {
    const { html, warnings } = renderDescriptionBodyOnly({ ...base, body: 'a {{body}} b' })
    expect(html).toBe('a  b')
    expect(warnings).toEqual(['token {{body}}/{{mobile_summary}}/{{gallery_hero}} is not allowed inside the description body'])
  })
})

describe('classed tokens — {{specs_rows}} / {{gallery_hero}} / {{gallery_groups}}', () => {
  it('{{specs_rows}} emits bare escaped rows — the theme owns the table shell and all styling', () => {
    const { html, warnings } = renderDescriptionTheme('<table><tbody>{{specs_rows}}</tbody></table>', {
      ...base,
      aspects: [{ name: 'Colore', value: 'Rosso & Nero' }],
    })
    expect(html).toBe('<table><tbody><tr><td>Colore</td><td>Rosso &amp; Nero</td></tr></tbody></table>')
    expect(warnings).toEqual([])
  })

  it('{{gallery_hero}} single mode: one input/shot/thumb per row image with generated :checked CSS, first shot checked', () => {
    const urls = ['https://c/a.jpg', 'https://c/b.jpg', 'https://c/c.jpg']
    const { html, warnings } = renderDescriptionTheme('{{gallery_hero}}', { ...base, rowImages: urls })
    expect(html.match(/<input type="radio" name="ebd-shot"/g)).toHaveLength(3)
    expect(html).toContain('id="ebd-s1" checked')
    expect(html.match(/class="shot shot--\d"/g)).toHaveLength(3)
    expect(html.match(/<label class="th--\d"/g)).toHaveLength(3)
    // generated CSS is sized to the ACTUAL count and scoped under .ebd
    expect(html).toContain('.gallery #ebd-s3:checked ~ .stage .shot--3{display:block}')
    expect(html).not.toContain('#ebd-s4')
    expect(warnings).toEqual([])
  })

  it('{{gallery_hero}} edge counts: 0 images → empty string; 1 image → no thumbnail strip', () => {
    expect(renderDescriptionTheme('{{gallery_hero}}', { ...base, rowImages: [], sharedImages: [] }).html).toBe('')
    const one = renderDescriptionTheme('{{gallery_hero}}', { ...base, rowImages: ['https://c/a.jpg'] }).html
    expect(one).toContain('shot--1')
    expect(one).not.toContain('class="thumbs"')
  })

  it('{{gallery_hero}} group mode: shared images drive the stage; first colour group is the fallback; >8 warns and caps', () => {
    const group = renderDescriptionTheme('{{gallery_hero}}', { ...base, mode: 'group' })
    expect(group.html).toContain('shared1.jpg')
    expect(group.html).not.toContain('r1.jpg')

    const noShared = renderDescriptionTheme('{{gallery_hero}}', { ...base, mode: 'group', sharedImages: [] })
    expect(noShared.html).toContain('r1.jpg') // first group's urls

    const many = Array.from({ length: 11 }, (_, i) => `https://c/${i}.jpg`)
    const capped = renderDescriptionTheme('{{gallery_hero}}', { ...base, mode: 'group', sharedImages: many })
    expect(capped.html.match(/<input /g)).toHaveLength(8)
    expect(capped.warnings.some((w) => w.includes('first 8 of 11'))).toBe(true)
  })

  it('{{gallery_groups}} emits one classed section per group, dedups shared, and is empty in single mode', () => {
    const { html, warnings } = renderDescriptionTheme('{{gallery_groups}}', { ...base, mode: 'group' })
    expect(html).toContain('<div class="ggroup"><h3 class="gg-title">Rosso</h3>')
    expect(html).toContain('<h3 class="gg-title">Nero</h3>')
    expect(html).toContain('r1.jpg')
    expect(html).not.toContain('shared1.jpg') // shared image not repeated inside Rosso
    expect(html).not.toContain('style=') // classed markup only — theme CSS owns the look
    expect(warnings).toEqual([])

    expect(renderDescriptionTheme('{{gallery_groups}}', base).html).toBe('')
  })

  it('{{gallery_hero}} generated CSS is scoped under its OWN .gallery wrapper, not .ebd — usable in any theme', () => {
    const { html } = renderDescriptionTheme('<div class="totally-different-wrapper">{{gallery_hero}}</div>', {
      ...base,
      rowImages: ['https://c/a.jpg', 'https://c/b.jpg'],
    })
    expect(html).not.toContain('.ebd ')
    expect(html).toContain('.gallery #ebd-s1:checked')
  })

  it('{{gallery_hero}} is FORBIDDEN inside the body (mints per-render ids a duplicate would collide with)', () => {
    const { html, warnings } = renderDescriptionTheme('<div>{{gallery_hero}}{{body}}</div>', {
      ...base,
      rowImages: ['https://c/a.jpg'],
      body: 'see {{gallery_hero}} above',
    })
    expect(html.match(/id="ebd-s1"/g)).toHaveLength(1) // ONE copy only — theme's, not body's
    expect(warnings).toContain('token {{body}}/{{mobile_summary}}/{{gallery_hero}} is not allowed inside the description body')
  })

  it('LAZY BUILD: a theme that never references specs_rows/gallery_hero/gallery_groups gets zero warnings FROM THOSE TOKENS, however many images exist', () => {
    // Regression for the eager-computation bug: >8 shared images and a >36
    // image group used to fire hero-cap and group-cap warnings even when the
    // theme contains NEITHER token — pure noise for Pro Clean/Nexus themes.
    // (The PRE-EXISTING {{gallery}} token is unconditionally built regardless
    // of use — out of scope here; it has its own, differently-worded warning
    // — "gallery capped", singular, no "group" — so filtering by the new
    // tokens' exact wording keeps this test from conflating the two.)
    const manyShared = Array.from({ length: 11 }, (_, i) => `https://c/s${i}.jpg`)
    const bigGroup = Array.from({ length: 40 }, (_, i) => `https://c/g${i}.jpg`)
    const { html, warnings } = renderDescriptionTheme('<div>{{title}}</div>', {
      ...base,
      mode: 'group',
      sharedImages: manyShared,
      imagesByGroup: [{ value: 'Nero', urls: bigGroup }],
    })
    expect(warnings.some((w) => w.includes('hero gallery'))).toBe(false)
    expect(warnings.some((w) => w.includes('group galleries capped'))).toBe(false)
    expect(html).not.toContain('ebd-s1') // hero never built
  })

  it('a theme that DOES reference gallery_groups via the body still gets it built (lazy scan covers themeHtml AND body)', () => {
    const { html, warnings } = renderDescriptionTheme('<div>{{body}}</div>', {
      ...base,
      mode: 'group',
      body: 'colours: {{gallery_groups}}',
    })
    expect(html).toContain('<h3 class="gg-title">Rosso</h3>')
    expect(warnings).toEqual([])
  })

  it('groupsGallery warns AT MOST ONCE, and never for a budget exhausted only by shared-duplicate/empty groups', () => {
    // Filtered to the NEW function's exact wording ("group galleries capped")
    // — the pre-existing, out-of-scope {{gallery}} token also processes
    // imagesByGroup unconditionally and has its own "gallery capped" warning
    // (no "group"), which would otherwise double-count here.
    const bigGroup = Array.from({ length: 40 }, (_, i) => `https://c/g${i}.jpg`)
    const { warnings: capped } = renderDescriptionTheme('{{gallery_groups}}', {
      ...base,
      mode: 'group',
      sharedImages: [],
      imagesByGroup: [
        { value: 'Nero', urls: bigGroup },
        { value: 'Rosso', urls: ['https://c/g0.jpg', 'https://c/g1.jpg'] }, // real, but budget-exhausted
      ],
    })
    expect(capped.filter((w) => w.includes('group galleries capped'))).toHaveLength(1) // not twice

    const { warnings: falsePositive } = renderDescriptionTheme('{{gallery_groups}}', {
      ...base,
      mode: 'group',
      sharedImages: ['https://c/shared.jpg'],
      imagesByGroup: [
        { value: 'Nero', urls: Array(36).fill('https://c/x.jpg').map((u, i) => `${u}?${i}`) },
        { value: 'Rosso', urls: ['https://c/shared.jpg'] }, // ENTIRELY shared-duplicate — nothing real dropped
      ],
    })
    expect(falsePositive.some((w) => w.includes('group galleries capped'))).toBe(false)
  })

  it('mobile_summary strips <style> TAG CONTENT, not just the tags, so leaked CSS never reaches buyer-facing summary text', () => {
    const { html } = renderDescriptionTheme('{{mobile_summary}}', {
      ...base,
      body: '<style>.x{color:red}</style>Testo reale del prodotto',
    })
    expect(html).not.toContain('color:red')
    expect(html).not.toContain('.x{')
    expect(html).toContain('Testo reale')
  })
})

describe('Xavia Modernist — operator design, token-driven, sanitizer-proof', () => {
  const modernist = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!.html
  const data: DescriptionRenderData = {
    ...base,
    mode: 'group',
    policies: { shipping: 'Spedizione 24h', returns: 'Reso 30 giorni', payment: 'PayPal e carte' },
  }

  it('renders group mode with zero warnings; the interactive widgets SURVIVE sanitization (output is post-sanitize)', () => {
    const { html, warnings } = renderDescriptionTheme(modernist, data)
    expect(warnings).toEqual([])
    expect(html).toContain('XAVIA_LOGO') // the operator logo in the brand bar
    expect(html).toContain('<input type="radio" name="ebd-shot"') // radio-swap hero intact
    expect(html).toContain('<style>') // theme CSS + generated gallery CSS intact
    expect(html).toContain('@import') // Archivo webfont intact
    expect(html).toContain('<tr><td>Colore</td><td>Rosso</td></tr>') // {{specs_rows}} in the .spectbl shell
    expect(html).toContain('<h3 class="gg-title">Rosso</h3>') // Colori section
    expect(html).toContain('Spedizione 24h') // live policy names in the tabs
    expect(html).toContain('property="description"') // hidden mobile summary
  })

  it('hero stage is square (1/1), not the design demo\'s 4/5 — Xavia photography is shot square', () => {
    expect(modernist).toContain('aspect-ratio:1/1')
    expect(modernist).not.toContain('aspect-ratio:4/5')
  })

  it('no CE-certification/marking claim anywhere (operator correction 2026-07-27: the product itself is not what is certified)', () => {
    expect(modernist).not.toContain('Certificato')
    expect(modernist).not.toContain('I prodotti sono certificati')
    expect(modernist).not.toContain('La certificazione specifica')
    expect(modernist).not.toContain('Marcatura CE')
    expect(modernist).not.toMatch(/marcatura <b>CE<\/b>/)
    expect(modernist).not.toContain('EN 17092')
  })

  it('accent is the fluo orange, not the design demo red; no demo content leaks (Northvane/Loro Piana/price)', () => {
    expect(modernist).toContain('--accent:    #ff6600')
    expect(modernist).not.toContain('#ec3013')
    expect(modernist).not.toMatch(/NORTHVANE|Loro Piana|\$489|class="price"/)
    expect(modernist).toContain('--img-tone: none') // product colours must read true
  })

  it('degrades honestly: no policies + no sku + no brand → empty muted lines, never dangling labels', () => {
    const { html, warnings } = renderDescriptionTheme(modernist, {
      ...data,
      sku: undefined,
      brand: undefined,
      policies: undefined,
    })
    expect(warnings).toEqual([])
    expect(html).toContain('<p class="foot-sku"></p>')
    expect(html).not.toMatch(/Cod\.|articolo:/)
  })

  it('ALL FAQ items start open (not just the first) — eBay VI freezes iframe height, so a closed→open reflow can clip content', () => {
    const { html } = renderDescriptionTheme(modernist, data)
    // A verbatim CSS comment ("/* ── 8 · FAQ accordion (<details>) ── */")
    // also contains the literal substring "<details>", so real FAQ items are
    // counted by the pattern that can only match an actual element: a details
    // tag immediately followed by its <summary> (comments never are).
    expect(html.match(/<details[^>]*>\s*<summary/g)).toHaveLength(3) // certification Q&A removed 2026-07-27
    expect(html).not.toMatch(/<details>\s*<summary/) // none bare/closed — every match above is "open"
  })

  it(':has()-less fallback keeps the default policy tab visible even where the verbatim :has() rule is dropped', () => {
    const { html } = renderDescriptionTheme(modernist, data)
    expect(html).toContain('.ebd .tabpanel--1{ display:block; }')
    expect(html).toContain('.ebd .tabwrap:has(.tabpanel:target) .tabpanel--1:not(:target){ display:none; }')
  })

  it('section-toggle contract extends to the two XAVIA-added sections (no-body/no-colours)', () => {
    expect(modernist).toContain('.ebd.no-body .sec--body')
    expect(modernist).toContain('.ebd.no-colours .sec--colours')
  })

  it('theme notes explicitly sanction every content omission and flag the known Google Fonts + Shopify-CDN dependencies', () => {
    const notes = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!.notes
    expect(notes).toMatch(/Key features/i)
    expect(notes).toMatch(/GDPR/i)
    expect(notes).toMatch(/Shopify/i)
  })
})

describe('sanitizeEbayHtml — CSS-only interactivity passes untouched', () => {
  it('radio inputs, labels and <style> blocks round-trip byte-exact (the Modernist widgets)', () => {
    const widget =
      '<style>.ebd #s1:checked ~ .stage .shot--1{display:block}</style>' +
      '<input type="radio" name="shot" id="s1" checked>' +
      '<label class="th--1" for="s1"><img src="https://c/a.jpg" alt=""></label>' +
      '<a href="#tab-ship">Spedizione</a>'
    const { html, warnings } = sanitizeEbayHtml(widget)
    expect(html).toBe(widget)
    expect(warnings).toEqual([])
  })

  it('inputs INSIDE a form are still removed with the form (active content)', () => {
    const { html } = sanitizeEbayHtml('ok<form action="/x"><input type="text"></form>')
    expect(html).toBe('ok')
  })
})

describe('BUILT_IN_PREVIOUS — Xavia Pro Clean upgrade chain', () => {
  it('carries BOTH shipped versions (v1, v2) so unedited rows on either auto-upgrade to current', () => {
    const chain = BUILT_IN_PREVIOUS['Xavia Pro Clean']
    expect(chain).toHaveLength(2)
    const current = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Pro Clean')!.html
    // frozen v2 is the current html with ONLY the footer label edit reversed
    expect(chain[1]).toContain('Cod. articolo: {{sku}}')
    expect(chain[1]).not.toBe(current)
    expect(chain[1].replace('Cod. articolo: {{sku}}', '{{sku}}')).toBe(current)
    // no frozen entry equals the live html (an equal entry would mask real edits)
    for (const prev of chain) expect(prev).not.toBe(current)
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
