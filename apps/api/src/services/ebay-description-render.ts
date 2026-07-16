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
const CELL_STYLE = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:14px;'

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
  const trs = rows
    .map(
      (a) =>
        `<tr><td style="${CELL_STYLE}color:#6b7280;white-space:nowrap;">${esc(a.name)}</td>` +
        `<td style="${CELL_STYLE}color:#111827;">${esc(a.value)}</td></tr>`,
    )
    .join('')
  return `<table style="border-collapse:collapse;width:100%;max-width:640px;">${trs}</table>`
}

function policiesBlock(p?: DescriptionRenderData['policies']): string {
  if (!p) return ''
  const items: string[] = []
  if (p.shipping) items.push(`<li><strong>Shipping:</strong> ${esc(p.shipping)}</li>`)
  if (p.returns) items.push(`<li><strong>Returns:</strong> ${esc(p.returns)}</li>`)
  if (p.payment) items.push(`<li><strong>Payment:</strong> ${esc(p.payment)}</li>`)
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

/** Resolve every {{token}} in a theme against the listing's render data. */
export function renderDescriptionTheme(themeHtml: string, data: DescriptionRenderData): RenderedDescription {
  const warnings: string[] = []

  const galleryHtml =
    data.mode === 'group'
      ? groupedGallery(data.sharedImages, data.imagesByGroup, warnings)
      : galleryGrid((data.rowImages ?? data.sharedImages).slice(0, MAX_GALLERY_IMAGES))

  const tokens: Record<string, string> = {
    title: esc(data.title ?? ''),
    subtitle: esc(data.subtitle ?? ''),
    body: data.body ?? '',
    sku: esc(data.sku ?? ''),
    brand: esc(data.brand ?? ''),
    market: esc(data.market ?? ''),
    gallery: galleryHtml,
    gallery_shared: galleryGrid(data.sharedImages.slice(0, MAX_GALLERY_IMAGES)),
    specs_table: specsTable(data.aspects),
    policies: policiesBlock(data.policies),
    policy_shipping: esc(data.policies?.shipping ?? ''),
    policy_returns: esc(data.policies?.returns ?? ''),
    policy_payment: esc(data.policies?.payment ?? ''),
  }

  let html = themeHtml.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    if (key in tokens) return tokens[key]
    warnings.push(`unknown token ${whole.trim()} removed`)
    return ''
  })

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

export const BUILT_IN_THEMES: Array<{ name: string; notes: string; html: string }> = [
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
