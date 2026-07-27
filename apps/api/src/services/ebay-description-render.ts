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
 *   {{mobile_summary}}   plain-text schema.org summary derived FROM the
 *                        resolved body (title + de-tagged body, ≤640 chars)
 *   {{gallery}}          mode 'single' → this row's images; 'group' → shared
 *                        gallery + one titled section per image group (colour)
 *   {{gallery_shared}}   shared/common gallery only
 *   {{specs_table}}      two-column table from the row's aspect_* specifics
 *   {{policies}}         shipping/returns/payment names block (when resolved)
 *   {{policy_shipping}} {{policy_returns}} {{policy_payment}}      names only
 *
 * CLASSED tokens — no inline styles; they emit semantic class-based markup so
 * a theme's own <style> block fully controls the look (built for the operator's
 * Modernist design, usable by any theme). Built LAZILY — only when the token
 * actually appears in the theme markup or the raw body — so a theme/body that
 * never references one pays no cost and gets none of its warnings:
 *   {{specs_rows}}       bare <tr><td>name</td><td>value</td></tr> rows — the
 *                        theme owns the <table>/<thead> shell
 *   {{gallery_hero}}     CSS-only radio-swap gallery (inputs + .stage/.shot--N
 *                        + .thumbs/.th--N + a generated scoped <style> sized to
 *                        the actual image count); group mode shows the shared
 *                        gallery (first group as fallback), single mode the
 *                        row. THEME-ONLY — forbidden inside the operator body
 *                        (BODY_FORBIDDEN_TOKENS): it mints per-render element
 *                        ids, so a duplicate would collide.
 *   {{gallery_groups}}   one .ggroup (.gg-title + .gg-grid of plain <img>) per
 *                        colour/variant group; '' in single mode
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
/** The radio-swap hero is a stage + thumbnail strip (4 per row) — beyond 8 the
 *  strip dominates the hero column. Remaining images still reach the buyer via
 *  {{gallery_groups}}/{{gallery}} and the PDP gallery itself. */
const MAX_HERO_IMAGES = 8
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

/** {{specs_rows}} — bare rows; the theme owns the <table>/<thead> shell and
 *  ALL styling (class-based, unlike the inline-styled {{specs_table}}). */
function specsRows(aspects: Array<{ name: string; value: string }>): string {
  return aspects
    .filter((a) => a.name && a.value)
    .slice(0, MAX_SPEC_ROWS)
    .map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.value)}</td></tr>`)
    .join('')
}

/** {{gallery_hero}} — CSS-only radio-swap gallery (the post-2017 eBay-safe
 *  interactive pattern: no JS, just :checked selectors). Emits its own scoped
 *  <style> sized to the ACTUAL image count, so themes ship no per-N CSS.
 *  Class names match the Modernist design contract: .gallery/.stage/.shot--N/
 *  .thumbs/.th--N/.frame — any theme styling those classes gets the widget.
 *  Self-scoped under its OWN .gallery wrapper (not the theme's), so it is
 *  genuinely wrapper-agnostic — usable inside ANY theme markup. Forbidden
 *  inside the operator body (BODY_FORBIDDEN_TOKENS): it mints per-render
 *  element ids, so a second copy of the same cached string would duplicate
 *  them — a theme should place it once, positionally. */
function heroGallery(urls: string[], warnings: string[]): string {
  const shots = urls.slice(0, MAX_HERO_IMAGES)
  if (shots.length === 0) return ''
  if (urls.length > shots.length) {
    warnings.push(
      `hero gallery shows the first ${MAX_HERO_IMAGES} of ${urls.length} images — add {{gallery_groups}} or {{gallery}} elsewhere in the theme to show the rest`,
    )
  }
  const id = (i: number): string => `ebd-s${i + 1}`
  const inputs = shots
    .map((_, i) => `<input type="radio" name="ebd-shot" id="${id(i)}"${i === 0 ? ' checked' : ''}>`)
    .join('')
  const stage = shots
    .map((u, i) => `<div class="shot shot--${i + 1}"><div class="frame"><img src="${esc(u)}" alt=""></div></div>`)
    .join('')
  const thumbs =
    shots.length > 1
      ? `<div class="thumbs">${shots
          .map((u, i) => `<label class="th--${i + 1}" for="${id(i)}"><div class="frame"><img src="${esc(u)}" alt=""></div></label>`)
          .join('')}</div>`
      : ''
  const css = shots
    .map(
      (_, i) =>
        `.gallery #${id(i)}:checked ~ .stage .shot--${i + 1}{display:block}` +
        `.gallery #${id(i)}:checked ~ .stage .thumbs .th--${i + 1}{border-color:var(--accent,#111827)}`,
    )
    .join('')
  return `<style>${css}</style><div class="gallery">${inputs}<div class="stage">${stage}${thumbs}</div></div>`
}

/** {{gallery_groups}} — one classed section per colour/variant group, images as
 *  bare <img> tags (theme CSS owns sizing/treatment). Shared images are not
 *  repeated inside groups, mirroring {{gallery}}'s dedup. Emits the cap
 *  warning AT MOST ONCE, and only when a non-empty (post-dedup) group was
 *  actually dropped — a budget exhausted only by all-shared-duplicate or
 *  empty groups is not a real cap. */
function groupsGallery(shared: string[], groups: DescriptionGalleryGroup[], warnings: string[]): string {
  let budget = MAX_GALLERY_IMAGES
  let capped = false
  const parts: string[] = []
  for (const g of groups) {
    const urls = g.urls.filter((u) => !shared.includes(u))
    if (urls.length === 0) continue
    if (budget <= 0) {
      capped = true
      break
    }
    const taken = urls.slice(0, budget)
    budget -= taken.length
    if (taken.length < urls.length) capped = true
    parts.push(
      `<div class="ggroup"><h3 class="gg-title">${esc(g.value)}</h3><div class="gg-grid">${taken
        .map((u) => `<img src="${esc(u)}" alt="">`)
        .join('')}</div></div>`,
    )
  }
  if (capped) warnings.push(`group galleries capped at ${MAX_GALLERY_IMAGES} images`)
  return parts.join('')
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
 *  into itself, {{mobile_summary}} derives FROM the body, and {{gallery_hero}}
 *  mints per-render element ids that a body-embedded second copy of the same
 *  cached string would duplicate (hero galleries are a positional theme
 *  widget, not reusable body content — {{gallery_groups}}/{{gallery}} are the
 *  body-embeddable galleries). Stripped with a warning instead of recursing. */
const BODY_FORBIDDEN_TOKENS = new Set(['body', 'mobile_summary', 'gallery_hero'])
const BODY_FORBIDDEN_WARNING = 'token {{body}}/{{mobile_summary}}/{{gallery_hero}} is not allowed inside the description body'

/** Resolve every {{token}} in a theme against the listing's render data. */
export function renderDescriptionTheme(themeHtml: string, data: DescriptionRenderData): RenderedDescription {
  const warnings: string[] = []

  const galleryHtml =
    data.mode === 'group'
      ? groupedGallery(data.sharedImages, data.imagesByGroup, warnings)
      : galleryGrid((data.rowImages ?? data.sharedImages).slice(0, MAX_GALLERY_IMAGES))

  // The three CLASSED tokens have builders that can warn (image caps) and, for
  // specs_rows, iterate every aspect — cheap individually, but computing them
  // UNCONDITIONALLY meant a theme that never references them still paid the
  // cost and, worse, still got their warnings (a theme with no gallery tokens
  // at all could show a bogus "hero gallery capped" notice). Build each ONLY
  // when its token actually appears — in the theme markup, or (specs_rows /
  // gallery_groups only — gallery_hero is body-forbidden) in the raw body.
  const rawBody = data.body ?? ''
  const usesToken = (name: string): boolean => {
    const re = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i')
    return re.test(themeHtml) || re.test(rawBody)
  }
  // gallery_hero is BODY_FORBIDDEN (stripped there, never rendered) — checking
  // themeHtml alone would suffice, but reusing usesToken costs nothing extra.
  const needsHero = usesToken('gallery_hero')
  const needsGroups = usesToken('gallery_groups')
  const needsSpecsRows = usesToken('specs_rows')

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
    specs_rows: needsSpecsRows ? specsRows(data.aspects) : '',
    gallery_hero: needsHero
      ? heroGallery(
          data.mode === 'group'
            ? data.sharedImages.length > 0
              ? data.sharedImages
              : (data.imagesByGroup[0]?.urls ?? [])
            : (data.rowImages ?? data.sharedImages),
          warnings,
        )
      : '',
    gallery_groups: needsGroups && data.mode === 'group' ? groupsGallery(data.sharedImages, data.imagesByGroup, warnings) : '',
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
    // too), truncated at a word boundary to stay well under. <style> CONTENT
    // (not just the tags) is stripped first — a body-resolved token that
    // emits inline CSS (e.g. a future widget) must never leak rule text into
    // buyer-facing summary copy.
    mobile_summary: esc(
      `${data.title ?? ''} — ${bodyResolved
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()}`
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

/** Raw-mode render: resolves {{tokens}} INSIDE the operator's body without any
 *  theme wrapper (equivalent to a '{{body}}'-only theme, so the forbidden-token
 *  guard, sanitizer and size warning all apply). Used when a push has no theme
 *  ('none' assignment / no default) but the description column embeds tokens —
 *  a buyer must never see a literal {{specs_table}}. */
export function renderDescriptionBodyOnly(data: DescriptionRenderData): RenderedDescription {
  return renderDescriptionTheme('{{body}}', data)
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
// verbatim from v1, do not reword) and the brand tagline. Policy tokens AND
// the footer {{sku}} sit on label-free muted lines so an unresolved value
// collapses to invisible empty markup instead of a dangling label (family
// listings have no single sku). Still: all styling inline, single column
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
  <div style="text-align:center;margin:26px 0 4px;padding-top:14px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;letter-spacing:1.5px;">XAVIA — PROTEZIONE E STILE<br /><span style="font-size:11px;letter-spacing:.5px;">{{sku}}</span></div>
</div>`

// v2 as shipped in 9a6910f03, FROZEN for the upgrade guard. The v2 → v2.1
// delta is ONLY the footer sku line ('Cod. articolo: {{sku}}' dangled its
// label on family listings, which pass no sku — now label-free like the
// policy lines), so the frozen copy is derived by reversing that one edit.
const XAVIA_PRO_CLEAN_V2_HTML = XAVIA_PRO_CLEAN_HTML.replace(
  '<span style="font-size:11px;letter-spacing:.5px;">{{sku}}</span>',
  '<span style="font-size:11px;letter-spacing:.5px;">Cod. articolo: {{sku}}</span>',
)

// ── "Xavia Modernist" (operator-designed, 2026-07-27) ───────────────────────
// The operator built this design themselves (Claude design, "Modernist") and
// the brief is EXACT fidelity: UI, fonts (Archivo via Google Fonts @import —
// graceful fallback to Helvetica/Arial wherever eBay's renderer blocks
// webfonts), spacing and section chrome are verbatim from their file. The only
// sanctioned edits are in the design's OWN token layer (its stated re-skin
// point): --accent red → fluo orange (operator call 2026-07-27) and --img-tone
// grayscale OFF (a used-menswear demo treatment; product colours must read
// true — "Rosso" cannot render grey). Content is fully token-driven Italian.
// Sections whose data does not exist live in Nexus were OMITTED from the
// markup rather than filled with fabrications (price row — a static price in
// an always-up-to-date system is a lie waiting to happen; seller stats;
// cross-sell cards; in-the-parcel). Their CSS is kept verbatim so re-adding
// them in the Studio is purely a markup paste.
const XAVIA_MODERNIST_HTML = `<div vocab="https://schema.org/" typeof="Product" style="display:none;"><span property="description">{{mobile_summary}}</span></div>
<style>
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');

/* ┌──────────────────────────────────────────────────────────────────────┐
   │  TOKEN LAYER — edit these to re-skin every listing. Nothing below      │
   │  this block uses a raw value; it all reads from these variables.       │
   └──────────────────────────────────────────────────────────────────────┘ */
.ebd{
  /* — colour — */
  --bg:        #ffffff;   /* page background                    */
  --surface:   #f3f2f2;   /* tinted panels, table zebra         */
  --surface-2: #eae9e9;   /* deeper panel / hover               */
  --ink:       #201e1d;   /* body + heading text                */
  --muted:     #605d5d;   /* secondary text                     */
  --faint:     #9b9797;   /* captions, meta                     */
  --accent:    #ff6600;   /* fluo orange (operator call 2026-07-27 — was the demo red) */
  --accent-ink:#b34700;   /* accent text on tint (readable)     */
  --accent-bg: #fff3e9;   /* accent tint fill                   */
  --line:      rgba(32,30,29,.85); /* strong 2px section rules  */
  --hair:      rgba(32,30,29,.16); /* hairline dividers         */

  /* — type — */
  --font:  "Archivo","Helvetica Neue",Arial,sans-serif;
  --base:  16px;   /* body size — scales the whole doc           */
  --h1:    2.35em;
  --h2:    1.5em;
  --h3:    1.05em;
  --kicker:.72em;

  /* — layout — */
  --max:   1000px; /* content width on desktop                   */
  --gap:   24px;   /* base rhythm                                */
  --radius:0px;    /* Modernist = flat. Bump to soften corners.  */
  --img-tone: none; /* photo treatment — OFF so product colours read true (demo used grayscale(1) contrast(1.06)) */
}

/* ── reset + base (scoped) ─────────────────────────────────────────────── */
.ebd,.ebd *,.ebd *::before,.ebd *::after{ box-sizing:border-box; }
.ebd{
  max-width:var(--max); margin:0 auto; background:var(--bg); color:var(--ink);
  font-family:var(--font); font-size:var(--base); line-height:1.6; font-weight:400;
  -webkit-font-smoothing:antialiased; text-align:left;
}
.ebd img{ display:block; max-width:100%; }
.ebd p{ margin:0 0 .8em; }
.ebd h1,.ebd h2,.ebd h3,.ebd h4{ font-weight:800; line-height:1.1; letter-spacing:-.015em; margin:0; }
.ebd a{ color:var(--accent-ink); }

/* ── shared bits ───────────────────────────────────────────────────────── */
.ebd .kicker{ font-size:var(--kicker); font-weight:800; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin:0 0 6px; }
.ebd .muted{ color:var(--muted); }
.ebd .rule{ height:2px; border:0; margin:0; background:var(--line); }
.ebd .wrap{ padding:36px 32px; }
.ebd .frame{ position:relative; overflow:hidden; background:var(--surface-2); border-radius:var(--radius); }
.ebd .frame > img{ width:100%; height:100%; object-fit:cover; filter:var(--img-tone); }
.ebd .ph{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background:
    repeating-linear-gradient(-45deg, transparent 0 11px, rgba(32,30,29,.05) 11px 12px),
    var(--surface-2);
  color:var(--faint); font-size:.72em; font-weight:800; letter-spacing:.14em; text-transform:uppercase; text-align:center; padding:12px; }
.ebd .chip{ display:inline-flex; align-items:center; gap:6px; font-size:.72em; font-weight:800;
  letter-spacing:.06em; text-transform:uppercase; padding:6px 11px; border-radius:var(--radius);
  background:var(--surface); color:var(--ink); border:1px solid var(--hair); }
.ebd .chip.on{ background:var(--accent-bg); color:var(--accent-ink); border-color:transparent; }

/* ── section header pattern ────────────────────────────────────────────── */
.ebd .sec{ padding:34px 32px; border-top:2px solid var(--line); }
.ebd .sec > .kicker + h2{ margin:0 0 20px; }
.ebd .sec h2{ font-size:var(--h2); }

/* ── 1 · brand bar ─────────────────────────────────────────────────────── */
.ebd .brand{ display:flex; align-items:center; gap:16px; padding:18px 32px; border-bottom:2px solid var(--line); flex-wrap:wrap; }
.ebd .brand .mark{ width:44px; height:44px; flex:none; display:flex; align-items:center; justify-content:center;
  background:var(--accent); color:#fff; font-weight:800; font-size:1.15em; letter-spacing:-.03em; border-radius:var(--radius); }
.ebd .brand .name{ font-weight:800; font-size:1.15em; letter-spacing:-.01em; line-height:1.1; }
.ebd .brand .tag{ font-size:.74em; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.ebd .brand .trust{ margin-left:auto; display:flex; gap:22px; }
.ebd .brand .trust .t{ text-align:left; }
.ebd .brand .trust .t b{ display:block; font-size:1.05em; }
.ebd .brand .trust .t span{ font-size:.66em; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }

/* ── 2 · hero ──────────────────────────────────────────────────────────── */
.ebd .hero{ display:grid; grid-template-columns:1fr 1fr; gap:40px; padding:40px 32px; }

/* gallery (CSS-only radio swap — per-image rules are generated with the markup) */
.ebd .gallery input{ position:absolute; opacity:0; width:0; height:0; }
/* 1/1, not the design's 4/5 — operator instruction 2026-07-27: every Xavia
   photo is shot square, so a taller frame would crop it. */
.ebd .stage .shot{ display:none; aspect-ratio:1/1; }
.ebd .gallery .frame{ height:100%; }
.ebd .thumbs{ display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:8px; }
.ebd .thumbs label{ display:block; aspect-ratio:1; cursor:pointer; border:2px solid transparent; }
.ebd .thumbs label:hover{ border-color:var(--hair); }

/* summary column */
.ebd .summary .meta{ display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.ebd .summary h1{ font-size:var(--h1); margin:0 0 10px; }
.ebd .summary .sub{ font-size:1.02em; color:var(--muted); margin:0 0 22px; }
.ebd .summary .price{ display:flex; align-items:baseline; gap:12px; padding:16px 0; border-top:2px solid var(--line); border-bottom:2px solid var(--line); margin-bottom:22px; }
.ebd .summary .price b{ font-size:2em; letter-spacing:-.02em; }
.ebd .summary .price s{ color:var(--faint); font-weight:600; }
.ebd .summary .price .save{ margin-left:auto; font-size:.74em; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:#fff; background:var(--accent); padding:5px 10px; }
.ebd .assure{ display:grid; grid-template-columns:repeat(3,1fr); gap:0; border:1px solid var(--hair); }
.ebd .assure .a{ padding:14px; border-right:1px solid var(--hair); }
.ebd .assure .a:last-child{ border-right:0; }
.ebd .assure .a b{ display:block; font-size:.82em; }
.ebd .assure .a span{ font-size:.66em; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }

/* ── 3 · features ──────────────────────────────────────────────────────── */
.ebd .feat{ display:grid; grid-template-columns:1fr 1fr; gap:2px 32px; }
.ebd .feat li{ list-style:none; display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--hair); }
.ebd .feat ul{ margin:0; padding:0; }
.ebd .feat .n{ flex:none; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums; }

/* ── 4 · specs table ───────────────────────────────────────────────────── */
.ebd .spectbl{ width:100%; border-collapse:collapse; font-size:.95em; }
.ebd .spectbl th{ text-align:left; font-size:.7em; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);
  padding:10px 14px; border-bottom:2px solid var(--line); }
.ebd .spectbl td{ padding:11px 14px; border-bottom:1px solid var(--hair); vertical-align:top; }
.ebd .spectbl tr:nth-child(even) td{ background:var(--surface); }
.ebd .spectbl td:first-child{ font-weight:800; width:38%; }

/* ── 5 · condition meter ───────────────────────────────────────────────── */
.ebd .cond{ display:grid; grid-template-columns:1.1fr 1fr; gap:36px; align-items:start; }
.ebd .scale{ display:flex; flex-direction:column; gap:0; border:1px solid var(--hair); }
.ebd .scale .lvl{ display:flex; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--hair); }
.ebd .scale .lvl:last-child{ border-bottom:0; }
.ebd .scale .lvl .dot{ width:12px; height:12px; flex:none; border:1.5px solid var(--faint); border-radius:50%; }
.ebd .scale .lvl.is-here{ background:var(--accent-bg); }
.ebd .scale .lvl.is-here .dot{ background:var(--accent); border-color:var(--accent); box-shadow:inset 0 0 0 3px var(--accent-bg); }
.ebd .scale .lvl.is-here b{ color:var(--accent-ink); }
.ebd .scale .lvl b{ font-size:.9em; }
.ebd .scale .lvl span{ margin-left:auto; font-size:.66em; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); }

/* ── 6 · in the box ────────────────────────────────────────────────────── */
.ebd .box{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
.ebd .box .it{ border:1px solid var(--hair); padding:16px; }
.ebd .box .it .qty{ font-size:.66em; font-weight:800; letter-spacing:.1em; color:var(--accent); }
.ebd .box .it b{ display:block; margin-top:4px; font-size:.9em; }

/* ── 7 · policies tabs (:target / :has) ────────────────────────────────── */
.ebd .tabbar{ display:flex; flex-wrap:wrap; gap:0; border:1px solid var(--line); margin-bottom:0; }
.ebd .tabbar a{ padding:12px 18px; font-size:.8em; font-weight:800; letter-spacing:.04em; text-transform:uppercase;
  text-decoration:none; color:var(--ink); border-right:1px solid var(--line); }
.ebd .tabbar a:last-child{ border-right:0; }
.ebd .tabbar a:hover{ background:var(--surface); }
.ebd .tabpanel{ display:none; padding:24px 20px; border:1px solid var(--line); border-top:0; }
.ebd .tabpanel:target{ display:block; }
.ebd .tabwrap:not(:has(.tabpanel:target)) .tabpanel--1{ display:block; }
.ebd .tabgrid{ display:grid; grid-template-columns:1fr 1fr; gap:24px 40px; }
.ebd .tabgrid h4{ font-size:.95em; margin:0 0 6px; }
.ebd .tabgrid .row{ display:flex; justify-content:space-between; gap:16px; padding:9px 0; border-bottom:1px solid var(--hair); font-size:.9em; }
.ebd .tabgrid .row span:last-child{ font-weight:800; text-align:right; }

/* ── 8 · FAQ accordion (<details>) ─────────────────────────────────────── */
.ebd .faq details{ border-bottom:1px solid var(--hair); }
.ebd .faq details:first-child{ border-top:1px solid var(--hair); }
.ebd .faq summary{ list-style:none; cursor:pointer; padding:16px 40px 16px 0; position:relative; font-weight:800; font-size:.98em; }
.ebd .faq summary::-webkit-details-marker{ display:none; }
.ebd .faq summary::after{ content:"+"; position:absolute; right:6px; top:12px; font-size:1.4em; font-weight:400; color:var(--accent); line-height:1; }
.ebd .faq details[open] summary::after{ content:"–"; }
.ebd .faq .ans{ padding:0 40px 18px 0; color:var(--muted); font-size:.94em; }

/* ── 9 · seller ────────────────────────────────────────────────────────── */
.ebd .seller{ display:grid; grid-template-columns:200px 1fr; gap:32px; align-items:center; }
.ebd .seller .stats{ display:grid; grid-template-columns:repeat(3,1fr); gap:0; border:1px solid var(--hair); margin-top:14px; }
.ebd .seller .stats .s{ padding:14px; border-right:1px solid var(--hair); }
.ebd .seller .stats .s:last-child{ border-right:0; }
.ebd .seller .stats .s b{ display:block; font-size:1.3em; letter-spacing:-.02em; }
.ebd .seller .stats .s span{ font-size:.64em; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }

/* ── 10 · cross-sell ───────────────────────────────────────────────────── */
.ebd .cross{ display:grid; grid-template-columns:repeat(4,1fr); gap:20px; }
.ebd .cross .card{ display:block; text-decoration:none; color:var(--ink); }
.ebd .cross .card .frame{ aspect-ratio:1; margin-bottom:10px; }
.ebd .cross .card .frame > img{ transition:filter .2s; }
.ebd .cross .card:hover .frame > img{ filter:none; }
.ebd .cross .card .t{ font-weight:800; font-size:.9em; line-height:1.25; }
.ebd .cross .card .pr{ font-size:.88em; color:var(--muted); margin-top:2px; }

/* ── footer ────────────────────────────────────────────────────────────── */
.ebd .foot{ padding:26px 32px 36px; border-top:2px solid var(--line); font-size:.78em; color:var(--faint); }
.ebd .foot .big{ font-size:1.9em; font-weight:800; letter-spacing:-.02em; color:var(--ink); margin:0 0 10px; }

/* ── SECTION TOGGLES ───────────────────────────────────────────────────── */
/* Add a class to the .ebd wrapper to drop any section — no markup edits:   */
/* class="ebd no-crosssell no-faq" etc.                                     */
.ebd.no-features .sec--features,
.ebd.no-specs .sec--specs,
.ebd.no-condition .sec--condition,
.ebd.no-box .sec--box,
.ebd.no-policies .sec--policies,
.ebd.no-faq .sec--faq,
.ebd.no-seller .sec--seller,
.ebd.no-crosssell .sec--crosssell{ display:none; }

/* ── RESPONSIVE (mobile) — no viewport meta required ───────────────────── */
@media (max-width:720px){
  .ebd{ --base:15px; }
  .ebd .wrap,.ebd .sec,.ebd .hero,.ebd .brand,.ebd .foot{ padding-left:18px; padding-right:18px; }
  .ebd .hero{ grid-template-columns:1fr; gap:26px; padding-top:26px; padding-bottom:26px; }
  .ebd .brand{ gap:12px; }
  .ebd .brand .trust{ margin-left:0; width:100%; justify-content:flex-start; gap:26px; border-top:1px solid var(--hair); padding-top:12px; }
  .ebd .feat,.ebd .cond,.ebd .seller,.ebd .tabgrid{ grid-template-columns:1fr; gap:0; }
  .ebd .cond,.ebd .seller,.ebd .tabgrid{ gap:24px; }
  .ebd .box{ grid-template-columns:1fr 1fr; }
  .ebd .cross{ grid-template-columns:1fr 1fr; }
  .ebd .seller{ grid-template-columns:1fr; }
  .ebd .seller .portrait{ max-width:200px; }
  .ebd .summary h1{ font-size:1.9em; }
  /* stack the spec table into label/value cards */
  .ebd .spectbl,.ebd .spectbl tbody,.ebd .spectbl tr,.ebd .spectbl td{ display:block; width:auto; }
  .ebd .spectbl thead{ display:none; }
  .ebd .spectbl tr{ border-bottom:2px solid var(--line); padding:6px 0; }
  .ebd .spectbl tr:nth-child(even) td{ background:transparent; }
  .ebd .spectbl td{ border:0; padding:3px 0; }
  .ebd .spectbl td:first-child{ width:auto; color:var(--muted); font-size:.7em; letter-spacing:.08em; text-transform:uppercase; }
  .ebd .tabbar a{ flex:1 1 auto; text-align:left; }
}

/* ── XAVIA additions — live-data widgets the static mock-up didn't model ── */
.ebd .brand .logo{ height:34px; width:auto; }
.ebd .sec--colours .ggroup{ margin:0 0 26px; }
.ebd .sec--colours .ggroup:last-child{ margin-bottom:0; }
.ebd .gg-title{ font-size:var(--h3); margin:0 0 10px; text-transform:uppercase; letter-spacing:.08em; }
.ebd .gg-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.ebd .gg-grid img{ width:100%; aspect-ratio:1; object-fit:cover; background:var(--surface-2); filter:var(--img-tone); }
.ebd .sec--colours:not(:has(.ggroup)){ display:none; }
.ebd .foot .foot-sku{ margin:8px 0 0; letter-spacing:.08em; text-transform:uppercase; }
@media (max-width:720px){ .ebd .gg-grid{ grid-template-columns:repeat(2,1fr); } }
/* Extends the verbatim SECTION TOGGLES contract ("no markup edits") to the two
   sections XAVIA added in place of features/box/seller/crosssell. */
.ebd.no-body .sec--body,
.ebd.no-colours .sec--colours{ display:none; }

/* :has()-less fallback (older Android/iOS WebViews eBay's own app embeds):
   the verbatim design's tab-1-default-visible rule above (":not(:has(...))")
   and the Colori auto-hide rule both use :has() — on an engine that doesn't
   parse it the WHOLE declaration is invalid and dropped, so ALL THREE policy
   panels (including the legally-required 14-day recesso copy) go invisible
   until a tap. These two rules are ADDITIVE, non-:has(), same visual result
   on capable engines (redundant with the verbatim rule, harmless), and are
   the fallback itself on engines without :has() — tab 1 stays visible by
   default rather than vanishing. There is no equivalent CSS-only fallback for
   the empty-Colori-section case (nothing else can detect "no .ggroup children"
   without :has()/JS) — documented as an accepted degradation in theme notes. */
.ebd .tabpanel--1{ display:block; }
.ebd .tabwrap:has(.tabpanel:target) .tabpanel--1:not(:target){ display:none; }
</style>

<div class="ebd">

  <!-- 1 · BRAND BAR -->
  <div class="brand">
    <img class="logo" src="https://cdn.shopify.com/s/files/1/0729/9186/7207/files/XAVIA_LOGO_06c286e9-0256-470d-bb70-b8df768bd1d0.png?v=1760139325" alt="XAVIA">
    <div class="tag">Abbigliamento tecnico moto</div>
    <div class="trust">
      <div class="t"><b>Italia</b><span>Spediamo da</span></div>
      <div class="t"><b>eBay</b><span>Garanzia cliente</span></div>
    </div>
  </div>

  <!-- 2 · HERO -->
  <div class="hero">
    {{gallery_hero}}
    <div class="summary">
      <div class="meta">
        <span class="chip on">Nuovo con etichette</span>
        <span class="chip">Spedizione tracciata</span>
      </div>
      <p class="kicker">{{brand}}</p>
      <h1>{{title}}</h1>
      <p class="sub">{{subtitle}}</p>
      <div class="assure">
        <div class="a"><b>Reso facile</b><span>14 giorni</span></div>
        <div class="a"><b>Spedizione rapida</b><span>Tracciata</span></div>
        <div class="a"><b>Garanzia legale</b><span>2 anni</span></div>
      </div>
    </div>
  </div>

  <!-- 3 · DESCRIZIONE (the operator's body copy — may embed any token) -->
  <section class="sec sec--body">
    <p class="kicker">Descrizione</p>
    <h2>Il prodotto</h2>
    <div class="body-copy">{{body}}</div>
  </section>

  <!-- 4 · SPECIFICHE -->
  <section class="sec sec--specs">
    <p class="kicker">Dati tecnici</p>
    <h2>Specifiche</h2>
    <table class="spectbl">
      <thead><tr><th>Attributo</th><th>Dettaglio</th></tr></thead>
      <tbody>{{specs_rows}}</tbody>
    </table>
  </section>

  <!-- 5 · COLORI (auto-hides when the listing has no per-colour galleries) -->
  <section class="sec sec--colours">
    <p class="kicker">Varianti</p>
    <h2>Colori disponibili</h2>
    {{gallery_groups}}
  </section>

  <!-- 6 · CONDIZIONE -->
  <section class="sec sec--condition">
    <p class="kicker">Valutato con onestà</p>
    <h2>Condizione</h2>
    <div class="cond">
      <div class="scale">
        <div class="lvl is-here"><span class="dot"></span><b>Nuovo con etichette</b><span>Questo articolo</span></div>
        <div class="lvl"><span class="dot"></span><b>Nuovo senza etichette</b><span>Mai indossato</span></div>
        <div class="lvl"><span class="dot"></span><b>Eccellente</b><span>Usato</span></div>
        <div class="lvl"><span class="dot"></span><b>Buono</b><span>Usura leggera</span></div>
        <div class="lvl"><span class="dot"></span><b>Discreto</b><span>Usura visibile</span></div>
      </div>
      <div>
        <p>Articolo nuovo, spedito con tutte le etichette nella confezione originale.</p>
      </div>
    </div>
  </section>

  <!-- 7 · POLICIES (tabs) -->
  <section class="sec sec--policies">
    <p class="kicker">Acquista con fiducia</p>
    <h2>Spedizione, resi e pagamento</h2>
    <div class="tabwrap">
      <div class="tabbar">
        <a href="#tab-ship">Spedizione</a>
        <a href="#tab-returns">Resi e garanzia</a>
        <a href="#tab-pay">Pagamento</a>
      </div>
      <div class="tabpanel tabpanel--1" id="tab-ship">
        <div class="tabgrid">
          <div>
            <h4>Spedizione</h4>
            <p class="muted">Spedizione rapida e tracciata dall'Italia. I tempi di consegna stimati sono indicati da eBay nella parte alta dell'inserzione.</p>
            <p class="muted">{{policy_shipping}}</p>
          </div>
          <div>
            <h4>Imballaggio</h4>
            <p class="muted">Ogni capo viene controllato e imballato con cura prima della spedizione.</p>
          </div>
        </div>
      </div>
      <div class="tabpanel" id="tab-returns">
        <div class="tabgrid">
          <div>
            <h4>Diritto di recesso</h4>
            <p class="muted">Hai il diritto di recedere dall'acquisto entro <b>14 giorni</b> dalla consegna, senza doverne indicare il motivo, ai sensi del Codice del Consumo. Il prodotto va restituito integro, non utilizzato e nella confezione originale.</p>
            <p class="muted">{{policy_returns}}</p>
          </div>
          <div>
            <h4>Garanzia</h4>
            <p class="muted">Tutti i nostri prodotti sono coperti dalla <b>garanzia legale di conformità di 2 anni</b> prevista dalla normativa europea. Acquisto protetto dalla Garanzia cliente eBay.</p>
          </div>
        </div>
      </div>
      <div class="tabpanel" id="tab-pay">
        <div class="tabgrid">
          <div>
            <h4>Metodi accettati</h4>
            <p class="muted">Tutti i metodi di pagamento offerti dal checkout di eBay, tra cui carte, PayPal, Apple Pay e Google Pay.</p>
            <p class="muted">{{policy_payment}}</p>
          </div>
          <div>
            <h4>Sicurezza</h4>
            <p class="muted">Il pagamento avviene interamente sulla piattaforma eBay: non riceviamo mai i dati della tua carta.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 8 · FAQ -->
  <section class="sec sec--faq">
    <p class="kicker">Prima di chiedere</p>
    <h2>Domande frequenti</h2>
    <div class="faq">
      <details open>
        <summary>Come scelgo la taglia giusta?</summary>
        <div class="ans">Confronta le misure nella sezione Specifiche con un capo che già possiedi. Se hai dubbi, scrivici tramite i messaggi eBay: ti aiutiamo volentieri a scegliere.</div>
      </details>
      <details open>
        <summary>Posso restituire l'articolo se la taglia non va bene?</summary>
        <div class="ans">Sì. Hai 14 giorni dalla consegna per il reso: il capo va restituito integro, non utilizzato e nella confezione originale.</div>
      </details>
      <details open>
        <summary>Le foto corrispondono al prodotto?</summary>
        <div class="ans">Sì: le immagini mostrano il prodotto in vendita nelle varianti disponibili, così come lo riceverai.</div>
      </details>
    </div>
  </section>

  <!-- FOOTER -->
  <div class="foot">
    <p class="big">Grazie.</p>
    <p>I colori possono variare leggermente in base allo schermo. Per qualsiasi domanda scrivici tramite i messaggi eBay: rispondiamo il prima possibile. © XAVIA.</p>
    <p class="foot-sku">{{sku}}</p>
  </div>

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
    name: 'Xavia Modernist',
    notes:
      "Operator-designed 'Modernist' (Claude design, 2026-07-27) — CSS verbatim from the design file; only its own token layer was touched: accent red→fluo orange #ff6600 (operator call) and --img-tone grayscale OFF so product colours read true. " +
      'Fully token-driven: {{gallery_hero}} radio-swap hero (shared images, ≤8, theme-only — not usable inside the body), {{brand}}/{{title}}/{{subtitle}} summary, {{body}} in Descrizione (may embed tokens), {{specs_rows}} in the .spectbl shell, {{gallery_groups}} per-colour Colori section, label-free {{policy_*}} lines in the tabs, {{sku}} footer (label-free), hidden {{mobile_summary}}. ' +
      'OMITTED (no live data — never fabricate): price row (static price goes stale), seller stats, cross-sell cards, in-the-parcel, AND the "Key features" editorial list (no source data — the design\'s six bullets were invented copy); all four sections\' CSS is retained so re-adding any is a markup paste. ' +
      'Compliance hardening beyond the design file (verified by adversarial review): all FAQ items start OPEN, not just the first — matches the Xavia Pro Clean v2 rule (eBay VI freezes the description iframe height after first render; a closed→open reflow can push content below the frozen frame and clip it) — this is the one deliberate visual departure from the design\'s accordion look. Added a non-:has() fallback so the default policy tab stays visible (never all-three-invisible) on older WebViews that drop the verbatim :has() rule wholesale; the analogous Colori auto-hide has no CSS-only fallback (:has() is the only way to detect empty children) — on those same old engines a single-variation listing shows one empty "Colori disponibili" heading, accepted as a minor, non-legal-content degradation. Tokens are now built lazily (only when referenced) so a theme/body without a gallery token never shows a spurious cap warning. ' +
      'Known dependencies to weigh before wide rollout: (1) Archivo loads via a live Google Fonts @import — every buyer pageview sends their IP to Google with no consent prompt, a GDPR exposure for an EU seller (LG München I 3O17493/20); the Helvetica/Arial fallback is close but not identical, so dropping the @import is a visual-fidelity-vs-legal-risk call for the operator, not decided here. (2) The brand-bar logo hotlinks the Shopify store CDN directly — if that file is ever renamed or the store migrates, every live listing on this theme shows a broken image until re-pushed; mirroring it to the same Cloudinary origin the product galleries already use would remove the dependency. ' +
      '⚠ Italian copy (recesso 14 giorni / garanzia 2 anni / CE) mirrors the D10 draft — operator sign-off required before setting as default.',
    html: XAVIA_MODERNIST_HTML,
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
  'Xavia Pro Clean': [XAVIA_PRO_CLEAN_V1_HTML, XAVIA_PRO_CLEAN_V2_HTML],
}
