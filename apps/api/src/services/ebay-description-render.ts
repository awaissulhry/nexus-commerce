/**
 * ED.1 (eBay dynamic descriptions) — pure theme renderer.
 *
 * A theme is owner-authored HTML with {{tokens}}. Rendering resolves tokens
 * from already-fetched listing data (no DB here), then runs an eBay
 * active-content guard over the WHOLE output: eBay has banned JavaScript in
 * descriptions since 2017 and requires https media, and nothing in the repo
 * sanitized description HTML before this. The guard is an eBay-compliance
 * pass (script/iframe/form strip, on* attribute strip, javascript: URL
 * neutralization, http→https image upgrade) — not a general XSS boundary;
 * themes and bodies are owner-authored.
 *
 * Tokens (unknown ones are stripped and reported as warnings):
 *   {{title}} {{subtitle}} {{body}} {{sku}} {{brand}} {{market}}   text/body
 *   {{gallery}}          mode 'single' → this row's images; 'group' → shared
 *                        gallery + one titled section per image group (colour)
 *   {{gallery_shared}}   shared/common gallery only
 *   {{specs_table}}      two-column table from the row's aspect_* specifics
 *   {{policies}}         shipping/returns/payment names block (when resolved)
 *   {{policy_shipping}} {{policy_returns}} {{policy_payment}}      names only
 */

export interface DescriptionGalleryGroup {
  /** The group key — an image-axis value like "Rosso" (the owner's "groups"). */
  value: string
  urls: string[]
}

export interface DescriptionRenderData {
  market: string
  title: string
  subtitle?: string
  /** Per-market operator body copy (HTML). Inserted raw, sanitized with the output. */
  body: string
  sku?: string
  brand?: string
  mode: 'single' | 'group'
  /** Shared/common gallery (ListingImage rows with no group key). */
  sharedImages: string[]
  /** Per-group (image-axis value) galleries, in display order. */
  imagesByGroup: DescriptionGalleryGroup[]
  /** Resolved images for THIS row (single mode): per-SKU → its group → shared. */
  rowImages?: string[]
  /** Item specifics for {{specs_table}} (already deduped, display order). */
  aspects: Array<{ name: string; value: string }>
  /** Business-policy display names, when the caller has them resolved. */
  policies?: { shipping?: string; returns?: string; payment?: string }
}

export interface RenderedDescription {
  html: string
  warnings: string[]
}

const MAX_GALLERY_IMAGES = 36
const MAX_SPEC_ROWS = 14
const SIZE_WARN_BYTES = 300_000

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const IMG_STYLE = 'max-width:100%;height:auto;border-radius:6px;display:block;'
const CELL_STYLE = 'padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:15px;'

function imgTag(url: string): string {
  return `<img src="${esc(url)}" alt="" style="${IMG_STYLE}" />`
}

function galleryGrid(urls: string[]): string {
  if (urls.length === 0) return ''
  const cells = urls
    .map((u) => `<div style="flex:1 1 220px;max-width:320px;">${imgTag(u)}</div>`)
    .join('')
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cells}</div>`
}

/** Group-mode gallery: shared images first, then one titled section per group. */
function groupedGallery(shared: string[], groups: DescriptionGalleryGroup[], warnings: string[]): string {
  let budget = MAX_GALLERY_IMAGES
  const take = (urls: string[]): string[] => {
    const out = urls.slice(0, Math.max(0, budget))
    budget -= out.length
    if (out.length < urls.length) warnings.push(`gallery capped at ${MAX_GALLERY_IMAGES} images`)
    return out
  }
  const parts: string[] = []
  const sharedTaken = take(shared)
  if (sharedTaken.length > 0) parts.push(galleryGrid(sharedTaken))
  for (const g of groups) {
    if (budget <= 0) break
    const urls = take(g.urls.filter((u) => !shared.includes(u)))
    if (urls.length === 0) continue
    parts.push(
      `<h3 style="margin:18px 0 8px;font-size:16px;color:#111827;">${esc(g.value)}</h3>${galleryGrid(urls)}`,
    )
  }
  return parts.join('\n')
}

function specsTable(aspects: Array<{ name: string; value: string }>): string {
  const rows = aspects.filter((a) => a.name && a.value).slice(0, MAX_SPEC_ROWS)
  if (rows.length === 0) return ''
  // Typography v2: 15px cells, subtle zebra striping, 600-weight label column.
  const trs = rows
    .map(
      (a, i) =>
        `<tr${i % 2 === 1 ? ' style="background:#f9fafb;"' : ''}>` +
        `<td style="${CELL_STYLE}color:#6b7280;font-weight:600;white-space:nowrap;">${esc(a.name)}</td>` +
        `<td style="${CELL_STYLE}color:#111827;">${esc(a.value)}</td></tr>`,
    )
    .join('')
  return `<table style="border-collapse:collapse;width:100%;max-width:640px;">${trs}</table>`
}

/** Section labels in the MARKET'S language — an eBay IT buyer must never see
 *  'Shipping:'/'Returns:' (market purity applies to description content too).
 *  Falls back to English for markets without a dictionary. */
const SECTION_LABELS: Record<string, { shipping: string; returns: string; payment: string; specs: string; features: string }> = {
  IT: { shipping: 'Spedizione', returns: 'Resi', payment: 'Pagamento', specs: 'Specifiche', features: 'Caratteristiche' },
  ES: { shipping: 'Envío', returns: 'Devoluciones', payment: 'Pago', specs: 'Especificaciones', features: 'Características' },
  DE: { shipping: 'Versand', returns: 'Rückgabe', payment: 'Zahlung', specs: 'Spezifikationen', features: 'Merkmale' },
  FR: { shipping: 'Livraison', returns: 'Retours', payment: 'Paiement', specs: 'Spécifications', features: 'Caractéristiques' },
}
export function sectionLabels(market?: string): { shipping: string; returns: string; payment: string; specs: string; features: string } {
  const m = String(market ?? '').toUpperCase().replace(/^EBAY[_-]/, '').slice(0, 2)
  return SECTION_LABELS[m] ?? { shipping: 'Shipping', returns: 'Returns', payment: 'Payment', specs: 'Specifications', features: 'Features' }
}

function policiesBlock(p?: DescriptionRenderData['policies'], market?: string): string {
  if (!p) return ''
  const L = sectionLabels(market)
  const items: string[] = []
  if (p.shipping) items.push(`<li><strong>${L.shipping}:</strong> ${esc(p.shipping)}</li>`)
  if (p.returns) items.push(`<li><strong>${L.returns}:</strong> ${esc(p.returns)}</li>`)
  if (p.payment) items.push(`<li><strong>${L.payment}:</strong> ${esc(p.payment)}</li>`)
  if (items.length === 0) return ''
  return `<ul style="list-style:none;padding:0;margin:0;font-size:13px;color:#374151;">${items.join('')}</ul>`
}

/**
 * eBay active-content guard. Strips tags/attributes eBay rejects or that
 * would be dead weight (script/iframe/object/embed/form/link/meta/base,
 * on* handlers, javascript: URLs) and upgrades http:// media to https://
 * (eBay requires secure content). Returns warnings for everything touched.
 */
export function sanitizeEbayHtml(input: string): { html: string; warnings: string[] } {
  const warnings: string[] = []
  let html = input

  // eBay error 21919490: any http:// resource in the description fails the
  // listing. Our images are https (Cloudinary/eBay-hosted) — an http:// src is
  // always a stale/hand-typed link. Upgrade in place + warn (never silent).
  if (/\s(src|href)\s*=\s*(["'])http:\/\//i.test(html)) {
    html = html.replace(/(\s(?:src|href)\s*=\s*["'])http:\/\//gi, '$1https://')
    warnings.push('upgraded http:// resources to https:// (eBay rejects non-secure content, error 21919490)')
  }

  const paired = /<\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi
  if (paired.test(html)) {
    warnings.push('removed active-content tags (eBay rejects scripts/iframes/forms)')
    html = html.replace(paired, '')
  }
  const lone = /<\/?\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi
  if (lone.test(html)) {
    if (!warnings.some((w) => w.startsWith('removed active-content'))) {
      warnings.push('removed active-content tags (eBay rejects scripts/iframes/forms)')
    }
    html = html.replace(lone, '')
  }
  const handlers = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
  if (handlers.test(html)) {
    warnings.push('removed inline event handlers (on*= attributes)')
    html = html.replace(handlers, '')
  }
  const jsUrl = /(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi
  if (jsUrl.test(html)) {
    warnings.push('neutralized javascript: URLs')
    html = html.replace(jsUrl, '$1="#"')
  }
  const httpMedia = /(src\s*=\s*["'])http:\/\//gi
  if (httpMedia.test(html)) {
    warnings.push('upgraded http:// media URLs to https:// (eBay requires secure content)')
    html = html.replace(httpMedia, '$1https://')
  }
  return { html, warnings }
}

/** Tokens FORBIDDEN inside the operator's body copy: {{body}} would recurse
 *  into itself and {{mobile_summary}} derives FROM the body. Stripped with a
 *  warning instead of recursing. */
const BODY_FORBIDDEN_TOKENS = new Set(['body', 'mobile_summary'])
const BODY_FORBIDDEN_WARNING = 'token {{body}}/{{mobile_summary}} is not allowed inside the description body'

/** Resolve every {{token}} in a theme against the listing's render data. */
export function renderDescriptionTheme(themeHtml: string, data: DescriptionRenderData): RenderedDescription {
  const warnings: string[] = []

  const galleryHtml =
    data.mode === 'group'
      ? groupedGallery(data.sharedImages, data.imagesByGroup, warnings)
      : galleryGrid((data.rowImages ?? data.sharedImages).slice(0, MAX_GALLERY_IMAGES))

  // Tokens resolvable everywhere — INCLUDING inside the operator's body copy
  // (the flat-file description column), so a body containing {{specs_table}}
  // or {{policy_shipping}} always renders live data at push time.
  const baseTokens: Record<string, string> = {
    title: esc(data.title ?? ''),
    subtitle: esc(data.subtitle ?? ''),
    sku: esc(data.sku ?? ''),
    brand: esc(data.brand ?? ''),
    market: esc(data.market ?? ''),
    gallery: galleryHtml,
    gallery_shared: galleryGrid(data.sharedImages.slice(0, MAX_GALLERY_IMAGES)),
    specs_table: specsTable(data.aspects),
    policies: policiesBlock(data.policies, data.market),
    policy_shipping: esc(data.policies?.shipping ?? ''),
    policy_returns: esc(data.policies?.returns ?? ''),
    policy_payment: esc(data.policies?.payment ?? ''),
  }

  const interpolate = (input: string, map: Record<string, string>, forbidden?: Set<string>): string =>
    input.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) => {
      const key = name.toLowerCase()
      if (forbidden?.has(key)) {
        if (!warnings.includes(BODY_FORBIDDEN_WARNING)) warnings.push(BODY_FORBIDDEN_WARNING)
        return ''
      }
      if (key in map) return map[key]
      warnings.push(`unknown token ${whole.trim()} removed`)
      return ''
    })

  // ONE interpolation pass over the body, BEFORE the theme pass. Replacement
  // strings are never rescanned (String.replace semantics), so token output is
  // inert — no nested re-interpolation is possible.
  const bodyResolved = interpolate(data.body ?? '', baseTokens, BODY_FORBIDDEN_TOKENS)

  const tokens: Record<string, string> = {
    ...baseTokens,
    body: bodyResolved,
    // eBay mobile summary (the ONLY lever over what the app shows before "see
    // full description"): plain text, ≤800 chars INCLUDING markup — we render
    // title + de-tagged RESOLVED body (so body tokens reflect live data here
    // too), truncated at a word boundary to stay well under.
    mobile_summary: esc(
      `${data.title ?? ''} — ${bodyResolved.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`
        .slice(0, 640).replace(/\s\S*$/, ''),
    ),
  }

  let html = interpolate(themeHtml, tokens)

  const sanitized = sanitizeEbayHtml(html)
  html = sanitized.html
  warnings.push(...sanitized.warnings)

  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > SIZE_WARN_BYTES) {
    warnings.push(`rendered description is large (${Math.round(bytes / 1024)} KB) — consider fewer images`)
  }
  return { html, warnings }
}

// ── Built-in starter themes (owner-editable via the themes CRUD) ─────────────

// ── "Xavia Pro Clean" v1 (seeded 2026-07-27, c1b355354) — FROZEN ────────────
// Byte-exact copy of the html the v1 seed wrote to the DB. ensureBuiltInThemes
// compares an existing row against BUILT_IN_PREVIOUS to recognize an UNEDITED
// seeded row and auto-upgrade it; any operator-edited copy is never touched.
// NEVER edit these constants — they are a historical record, not a design.
const XPC_V1_FONT = `-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`
const xpcV1Tab = (label: string, body: string) => `
  <div style="margin:18px 0 0;">
    <div style="display:inline-block;background:#111827;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:.3px;padding:8px 18px;border-radius:10px 10px 0 0;">${label}</div>
    <div style="border:1px solid #e5e7eb;border-radius:0 10px 10px 10px;padding:16px 18px;font-size:15px;line-height:1.6;color:#374151;background:#ffffff;">${body}</div>
  </div>`

const XAVIA_PRO_CLEAN_V1_HTML = `<div vocab="https://schema.org/" typeof="Product" style="display:none;"><span property="description">{{mobile_summary}}</span></div>
<div style="font-family:${XPC_V1_FONT};max-width:920px;margin:0 auto;color:#111827;font-size:16px;line-height:1.6;">
  <div style="text-align:center;padding:6px 0 2px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:2.5px;color:#9ca3af;">XAVIA RACING</div>
    <h1 style="font-size:23px;margin:6px 0 2px;font-weight:700;">{{title}}</h1>
    <p style="margin:0 0 6px;color:#6b7280;font-size:15px;">{{subtitle}}</p>
  </div>
  <div style="margin:14px 0;">{{body}}</div>
  <div style="margin:18px 0;">{{gallery}}</div>
  ${xpcV1Tab('Specifiche', '{{specs_table}}')}
  ${xpcV1Tab('Spedizione', `<p style="margin:0;">Spedizione rapida e tracciata dall'Italia. {{policy_shipping}}</p>`)}
  ${xpcV1Tab('Resi e diritto di recesso', `<p style="margin:0;">Hai il diritto di recedere dall'acquisto entro <strong>14 giorni</strong> dalla consegna, senza doverne indicare il motivo, ai sensi del Codice del Consumo. Il prodotto va restituito integro, non utilizzato e nella confezione originale. {{policy_returns}}</p>`)}
  ${xpcV1Tab('Garanzia', `<p style="margin:0;">Tutti i nostri prodotti sono coperti dalla <strong>garanzia legale di conformità di 2 anni</strong> prevista dalla normativa europea.</p>`)}
  ${xpcV1Tab('Sicurezza prodotto', `<p style="margin:0;">Abbigliamento tecnico motociclistico con marcatura <strong>CE</strong>. Verifica sempre l'etichetta del prodotto per la certificazione specifica (es. EN 17092) e le istruzioni di manutenzione.</p>`)}
  <div style="text-align:center;margin:26px 0 4px;padding-top:14px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;letter-spacing:1.5px;">XAVIA — PROTEZIONE E STILE</div>
</div>`

// ── "Xavia Pro Clean" v2 (operator-approved overhaul, 2026-07-27) ───────────
// Typography v2 (refined system stack — eBay strips webfonts, so modern =
// treatment, not fonts) + information-first layout (specs promoted above the
// policy sections, gallery moved to the BOTTOM — the PDP gallery already shows
// the product) + REAL clickable accordions: <details open>/<summary>, which
// sanitizeEbayHtml verifiably preserves. Every section carries the `open`
// attribute so if any engine (or a future eBay filter) drops details/summary
// the content degrades to always-visible stacked sections — nothing hidden.
// Fully token-driven: every content-bearing region renders live data at push
// time ({{brand}} hero mark, per-section {{policy_*}} names, {{sku}} footer);
// the only hardcoded prose is the legally-reviewed Italian copy (D10 — DRAFT,
// verbatim from v1, do not reword) and the brand tagline. Policy tokens sit on
// label-free muted lines so an unresolved name collapses to an invisible empty
// <p> instead of a dangling label. Still: all styling inline, single column
// ≤920px, hidden schema.org mobile summary, NO outbound links, NO http://
// resources, NO EU ODR reference (platform retired 2025-07-20).
const XPC_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI Variable Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`
// Accordion: summary styled as the v1 tab-look pill. inline-flex + list-style:
// none hides the disclosure marker in modern engines; older WebKit keeps its
// default marker (accepted — ::-webkit-details-marker can't be styled inline).
const xpcSection = (label: string, body: string) => `
  <details open style="margin:18px 0 0;">
    <summary style="display:inline-flex;align-items:center;list-style:none;cursor:pointer;background:#111827;color:#ffffff;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;padding:9px 18px;border-radius:10px 10px 0 0;">${label}</summary>
    <div style="border:1px solid #e5e7eb;border-radius:0 10px 10px 10px;padding:16px 18px;font-size:16px;line-height:1.65;color:#374151;background:#ffffff;">${body}</div>
  </details>`
const XPC_MUTED_LINE = 'color:#6b7280;font-size:14px;'

const XAVIA_PRO_CLEAN_HTML = `<div vocab="https://schema.org/" typeof="Product" style="display:none;"><span property="description">{{mobile_summary}}</span></div>
<div style="font-family:${XPC_FONT};max-width:920px;margin:0 auto;color:#111827;font-size:16px;line-height:1.65;">
  <div style="text-align:center;padding:6px 0 2px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:3px;color:#9ca3af;">{{brand}}</div>
    <h1 style="font-size:27px;margin:8px 0 2px;font-weight:700;letter-spacing:-0.02em;">{{title}}</h1>
    <p style="margin:0 0 6px;color:#6b7280;font-size:15px;">{{subtitle}}</p>
  </div>
  <div style="margin:14px 0;color:#374151;">{{body}}</div>
  ${xpcSection('Specifiche', '{{specs_table}}')}
  ${xpcSection('Spedizione', `<p style="margin:0;">Spedizione rapida e tracciata dall'Italia.</p><p style="margin:8px 0 0;${XPC_MUTED_LINE}">{{policy_shipping}}</p><p style="margin:2px 0 0;${XPC_MUTED_LINE}">{{policy_payment}}</p>`)}
  ${xpcSection('Resi e diritto di recesso', `<p style="margin:0;">Hai il diritto di recedere dall'acquisto entro <strong>14 giorni</strong> dalla consegna, senza doverne indicare il motivo, ai sensi del Codice del Consumo. Il prodotto va restituito integro, non utilizzato e nella confezione originale.</p><p style="margin:8px 0 0;${XPC_MUTED_LINE}">{{policy_returns}}</p>`)}
  ${xpcSection('Garanzia', `<p style="margin:0;">Tutti i nostri prodotti sono coperti dalla <strong>garanzia legale di conformità di 2 anni</strong> prevista dalla normativa europea.</p>`)}
  ${xpcSection('Sicurezza prodotto', `<p style="margin:0;">Abbigliamento tecnico motociclistico con marcatura <strong>CE</strong>. Verifica sempre l'etichetta del prodotto per la certificazione specifica (es. EN 17092) e le istruzioni di manutenzione.</p>`)}
  <h2 style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#111827;margin:28px 0 10px;padding-top:18px;border-top:1px solid #e5e7eb;">Dettagli prodotto</h2>
  <div style="margin:0 0 18px;">{{gallery}}</div>
  <div style="text-align:center;margin:26px 0 4px;padding-top:14px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;letter-spacing:1.5px;">XAVIA — PROTEZIONE E STILE<br /><span style="font-size:11px;letter-spacing:.5px;">Cod. articolo: {{sku}}</span></div>
</div>`

export const BUILT_IN_THEMES: Array<{ name: string; notes: string; html: string }> = [
  {
    name: 'Xavia Pro Clean',
    notes:
      'v2 flagship (2026-07-27): info-first layout — specs before the policy sections, gallery at the bottom under "Dettagli prodotto"; clickable <details> accordions (all start open, degrade to always-visible); refined system-stack typography. ' +
      'Fully token-driven — every section renders live data at push time; nothing content-bearing is hardcoded except the legally-reviewed copy (D10). ' +
      'Token choices: {{policies}} unused (would duplicate the per-section {{policy_shipping}}/{{policy_returns}}/{{policy_payment}}); {{gallery_shared}} unused ({{gallery}} already includes shared + per-colour sections); {{market}} unused (no visual role). ' +
      '⚠ Italian legal copy is DRAFT pending operator sign-off (D10) — do not set as default until approved.',
    html: XAVIA_PRO_CLEAN_HTML,
  },
  {
    name: 'Nexus Clean',
    notes: 'Minimal single-column: title, body, gallery, specs, policies.',
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:0 auto;color:#111827;">
  <h1 style="font-size:22px;margin:0 0 4px;">{{title}}</h1>
  <p style="margin:0 0 16px;color:#6b7280;font-size:14px;">{{subtitle}}</p>
  <div style="font-size:15px;line-height:1.55;">{{body}}</div>
  <div style="margin:20px 0;">{{gallery}}</div>
  <h2 style="font-size:17px;margin:20px 0 8px;">Specifications</h2>
  {{specs_table}}
  <div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e7eb;">{{policies}}</div>
</div>`,
  },
  {
    name: 'Nexus Gallery Pro',
    notes: 'Gallery-first: hero gallery with per-group sections above the copy.',
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:960px;margin:0 auto;color:#111827;">
  <h1 style="font-size:24px;margin:0 0 12px;text-align:center;">{{title}}</h1>
  <div style="margin:0 0 24px;">{{gallery}}</div>
  <div style="font-size:15px;line-height:1.6;max-width:760px;margin:0 auto;">{{body}}</div>
  <div style="max-width:760px;margin:24px auto 0;">
    <h2 style="font-size:17px;margin:0 0 8px;">Details</h2>
    {{specs_table}}
    <div style="margin-top:18px;">{{policies}}</div>
  </div>
</div>`,
  },
  {
    name: 'Nexus Classic Two-Column',
    notes: 'Table-safe two-column: gallery left, copy + specs right.',
    html: `<table style="width:100%;max-width:980px;margin:0 auto;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#111827;"><tr>
  <td style="width:46%;vertical-align:top;padding:0 14px 0 0;">{{gallery}}</td>
  <td style="vertical-align:top;">
    <h1 style="font-size:21px;margin:0 0 6px;">{{title}}</h1>
    <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">{{subtitle}}</p>
    <div style="font-size:14px;line-height:1.55;">{{body}}</div>
    <h2 style="font-size:16px;margin:16px 0 6px;">Specifications</h2>
    {{specs_table}}
    <div style="margin-top:14px;">{{policies}}</div>
  </td>
</tr></table>`,
  },
]

/**
 * Byte-exact html of every PREVIOUS shipped version of a built-in theme, keyed
 * by theme name. ensureBuiltInThemes auto-upgrades an existing seeded row ONLY
 * when its stored html equals one of these strings — proof the operator never
 * edited it. Edited copies (and same-named custom themes) are never touched.
 * Append here whenever a built-in theme's html changes; never rewrite entries.
 */
export const BUILT_IN_PREVIOUS: Record<string, string[]> = {
  'Xavia Pro Clean': [XAVIA_PRO_CLEAN_V1_HTML],
}
