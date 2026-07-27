/**
 * ED.1/ED.2 (eBay dynamic descriptions) — theme storage + render orchestration.
 *
 * The flat file's per-market description stays the operator's BODY copy
 * (ChannelListing.description, one row per market — the P9e model). Themes
 * wrap that body at PUSH time; nothing here ever rewrites the stored body.
 *
 * Assignment: ChannelListing.platformAttributes.descriptionThemeId on the
 * market's own row — so a listing can use a different theme per market.
 *   themeId string → that theme;  'none' → raw body even when a default
 *   exists;  absent → the global default theme (isDefault), else raw body.
 *
 * Invariant: rendering must NEVER block a push — any error falls back to the
 * raw body and reports a warning.
 */

import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import {
  renderDescriptionTheme,
  renderDescriptionBodyOnly,
  BUILT_IN_THEMES,
  BUILT_IN_PREVIOUS,
  type DescriptionRenderData,
  type DescriptionGalleryGroup,
} from './ebay-description-render.js'

export interface RenderListingDescriptionArgs {
  productId: string
  /** Flat-file market code (IT/DE/FR/ES/UK…). UK maps to region GB like P9e. */
  marketplace: string
  mode: 'single' | 'group'
  /** The already-resolved per-market body (push sites have it in hand). */
  body: string
  title?: string
  subtitle?: string
  sku?: string
  /** Business-policy display names when the push site has them resolved. */
  policies?: { shipping?: string; returns?: string; payment?: string }
  /** Preview-only: try a specific theme instead of the listing's assignment. */
  themeIdOverride?: string
  /** Preview-only (ED.4 theme editor): render THIS html as the theme without
   *  saving anything — lets the manager preview unsaved drafts. */
  themeHtmlOverride?: string
}

export interface RenderListingDescriptionResult {
  html: string
  themed: boolean
  themeId?: string
  themeName?: string
  /** ED v2 P5 — the rendered theme's version counter (staleness stamp input).
   *  Absent for raw-body renders and unsaved draft previews. */
  themeVersion?: number
  warnings: string[]
}

const regionOf = (mp: string): string => (mp.toUpperCase() === 'UK' ? 'GB' : mp.toUpperCase())

// ── Theme CRUD ───────────────────────────────────────────────────────────────

/**
 * Insert the starter themes that don't exist yet (never overwrites edits) and
 * SAFELY auto-upgrade seeded rows the operator never touched: when an existing
 * built-in row's html byte-equals a PREVIOUS shipped version of that theme
 * (BUILT_IN_PREVIOUS), the constant was revised after seeding and the row is
 * brought up to date (html + notes, version incremented so the D8 staleness
 * badge flags listings still live with the old design). Any html that differs
 * from both the current constant and every previous version is an operator
 * edit and is never modified — both directions unit-tested.
 */
export async function ensureBuiltInThemes(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.ebayDescriptionTheme.findMany({
    select: { name: true, html: true, builtIn: true },
  })
  const byName = new Map(existing.map((t) => [t.name, t]))
  for (const t of BUILT_IN_THEMES) {
    const row = byName.get(t.name)
    if (!row) {
      await prisma.ebayDescriptionTheme.create({
        data: { name: t.name, notes: t.notes, html: t.html, builtIn: true },
      })
      continue
    }
    const isUneditedPrevious = row.builtIn && row.html !== t.html && (BUILT_IN_PREVIOUS[t.name] ?? []).includes(row.html)
    if (isUneditedPrevious) {
      await prisma.ebayDescriptionTheme.update({
        where: { name: t.name },
        data: { html: t.html, notes: t.notes, version: { increment: 1 } },
      })
    }
  }
}

export async function listThemes(prisma: PrismaClient) {
  await ensureBuiltInThemes(prisma)
  return prisma.ebayDescriptionTheme.findMany({ orderBy: [{ builtIn: 'desc' }, { name: 'asc' }] })
}

export async function setDefaultTheme(prisma: PrismaClient, id: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.ebayDescriptionTheme.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    if (id) await tx.ebayDescriptionTheme.update({ where: { id }, data: { isDefault: true } })
  })
}

// ── Render-data assembly ─────────────────────────────────────────────────────

/**
 * Mirror of the canonical curated-gallery resolution
 * (images/ebay-inventory-image-publish.service.ts): shared gallery =
 * ListingImage rows with no group key; per-group galleries keyed by
 * variantGroupValue; per-SKU pins via variationId. Falls back to the master
 * ProductImage gallery when nothing is curated.
 */
async function loadGalleries(prisma: PrismaClient, productId: string, sku?: string, marketplace?: string): Promise<{
  shared: string[]
  byGroup: DescriptionGalleryGroup[]
  rowImages?: string[]
}> {
  const first = await loadGalleriesForProduct(prisma, productId, sku, marketplace)
  const isEmpty = (g: { shared: string[]; byGroup: DescriptionGalleryGroup[]; rowImages?: string[] }) =>
    g.shared.length === 0 && g.byGroup.length === 0 && (!g.rowImages || g.rowImages.length === 0)
  if (!isEmpty(first)) return first
  // ED v2 polish — SHELL pool-parent gallery borrow (mirrors the Incident #41
  // pictureUrls borrow in ebay-shared-listing-push.service.ts): a shell/
  // childless product fronting a shared pool has no curated rows and no master
  // gallery of its own, so its description gallery resolves against the POOL's
  // parent instead — one extra pass of the same curated-then-master resolution,
  // never recursive. Fail-open: any error keeps the empty-gallery result.
  try {
    const poolParentId = await findShellPoolParentId(prisma, productId)
    if (poolParentId && poolParentId !== productId) {
      const borrowed = await loadGalleriesForProduct(prisma, poolParentId, sku, marketplace)
      if (!isEmpty(borrowed)) return borrowed
    }
  } catch { /* fail-open — empty gallery stays the answer */ }
  return first
}

/**
 * ED v2 polish — resolve the pool parent a SHELL product fronts: the product
 * must be childless, its sku must appear as parentSku on ACTIVE
 * SharedListingMembership rows, and those member products' common parent (the
 * most-represented one when data is mixed) is the borrow target. Returns null
 * whenever the product isn't a shell or no pool parent is resolvable.
 */
async function findShellPoolParentId(prisma: PrismaClient, productId: string): Promise<string | null> {
  const self = await prisma.product.findFirst({ where: { id: productId }, select: { sku: true } })
  if (!self?.sku) return null
  const childCount = await prisma.product.count({ where: { parentId: productId, deletedAt: null } })
  if (childCount > 0) return null
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { parentSku: self.sku, status: 'ACTIVE' },
    select: { productId: true },
  })
  const memberIds = [...new Set(memberships.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
  if (memberIds.length === 0) return null
  const members = await prisma.product.findMany({
    where: { id: { in: memberIds } },
    select: { parentId: true },
  })
  const counts = new Map<string, number>()
  for (const m of members) {
    if (!m.parentId || m.parentId === productId) continue
    counts.set(m.parentId, (counts.get(m.parentId) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [id, n] of counts) {
    if (n > bestN) { best = id; bestN = n }
  }
  return best
}

/** One pass of the curated-then-master resolution for ONE product id (the
 *  pre-borrow body of loadGalleries, unchanged in behaviour). */
async function loadGalleriesForProduct(prisma: PrismaClient, productId: string, sku?: string, marketplace?: string): Promise<{
  shared: string[]
  byGroup: DescriptionGalleryGroup[]
  rowImages?: string[]
}> {
  const curated = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true },
  })
  // AXIS-AWARE grouping (ED v2 P1). This was a hand-rolled mirror of the push's
  // curation resolution that ignored variantGroupKey entirely — on a family
  // with buckets under more than one key (Color residue beside Colore, or a
  // per-market axis pick) the description's per-colour sections could mix or
  // mis-bucket. Use the SAME authorities as the push: the per-market image
  // axis (readImageAxisPreference) + synonym matching (axisSynonymKey), so
  // Color/Colore/Farbe spellings can never split a bucket. No preference or no
  // key-match → legacy accept-all (fail-open, never an empty description).
  let pictureAxis: string | undefined
  try {
    const { readImageAxisPreference } = await import('./ebay-image-axis-preference.service.js')
    pictureAxis = await readImageAxisPreference(productId, marketplace)
  } catch { /* fail-open */ }
  const { axisSynonymKey } = await import('./ebay-theme-axes.js')
  const keyMatches = (k: string) => !pictureAxis || axisSynonymKey(k) === axisSynonymKey(pictureAxis)
  const anyKeyMatched = curated.some((r) => !r.variationId && r.variantGroupKey && keyMatches(r.variantGroupKey))

  const shared: string[] = []
  const groups = new Map<string, string[]>()
  const byVariationId = new Map<string, string[]>()
  for (const r of curated) {
    if (r.variationId) {
      if (!byVariationId.has(r.variationId)) byVariationId.set(r.variationId, [])
      byVariationId.get(r.variationId)!.push(r.url)
    } else if (r.variantGroupKey && r.variantGroupValue) {
      if (anyKeyMatched && !keyMatches(r.variantGroupKey)) continue // other-axis residue
      const key = r.variantGroupValue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r.url)
    } else {
      shared.push(r.url)
    }
  }

  let rowImages: string[] | undefined
  if (sku) {
    const variant = await prisma.product.findFirst({ where: { sku }, select: { id: true, variantAttributes: true, categoryAttributes: true } })
    if (variant && byVariationId.has(variant.id)) {
      rowImages = byVariationId.get(variant.id)
    } else if (variant) {
      // Match the variant's own bucket by any axis value it carries.
      // variantAttributes ?? categoryAttributes.variations is the CANONICAL
      // variant-attr resolution (old bulk-create products store axes ONLY in
      // categoryAttributes.variations — missing it meant their per-colour
      // section never matched); compare case-insensitively so "nero" finds
      // the "Nero" bucket.
      const ca = (variant.categoryAttributes ?? {}) as Record<string, unknown>
      const caVar = ca && typeof ca.variations === 'object' && ca.variations !== null ? ca.variations as Record<string, unknown> : {}
      const attrs = { ...(caVar), ...((variant.variantAttributes ?? {}) as Record<string, unknown>) }
      const byLower = new Map([...groups.entries()].map(([k, v]) => [k.toLowerCase(), v]))
      for (const v of Object.values(attrs)) {
        const hit = typeof v === 'string' ? byLower.get(v.toLowerCase()) : undefined
        if (hit && hit.length > 0) {
          rowImages = hit
          break
        }
      }
    }
    if (!rowImages || rowImages.length === 0) rowImages = shared.length > 0 ? shared : undefined
  }

  if (shared.length === 0 && groups.size === 0) {
    // nothing curated for eBay — fall back to the master gallery
    const master = await prisma.productImage.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
      select: { url: true },
      take: 12,
    })
    return { shared: master.map((m) => m.url), byGroup: [], rowImages: rowImages ?? master.map((m) => m.url) }
  }
  return {
    shared,
    byGroup: [...groups.entries()].map(([value, urls]) => ({ value, urls })),
    rowImages,
  }
}

/** Item specifics from the market row's snapshot (aspect_* keys, deduped). */
function aspectsFromSnapshot(snapshot: unknown): Array<{ name: string; value: string }> {
  if (!snapshot || typeof snapshot !== 'object') return []
  const out = new Map<string, { name: string; value: string }>()
  for (const [key, val] of Object.entries(snapshot as Record<string, unknown>)) {
    if (!key.startsWith('aspect_') || typeof val !== 'string' || !val.trim()) continue
    const display = key.slice('aspect_'.length).replace(/_/g, ' ')
    const lk = display.toLowerCase()
    // buildFlatRow writes both cased and lowercase keys — prefer the cased one.
    const existing = out.get(lk)
    if (!existing || (existing.name === existing.name.toLowerCase() && display !== lk)) {
      out.set(lk, { name: display, value: val.trim() })
    }
  }
  return [...out.values()]
}

// ── The safe entry point every push site calls ───────────────────────────────

export async function renderListingDescriptionSafe(
  prisma: PrismaClient,
  args: RenderListingDescriptionArgs,
): Promise<RenderListingDescriptionResult> {
  const raw: RenderListingDescriptionResult = { html: args.body ?? '', themed: false, warnings: [] }
  try {
    const region = regionOf(args.marketplace)
    const listing = await prisma.channelListing.findFirst({
      where: { productId: args.productId, channel: 'EBAY', region },
      select: { title: true, description: true, platformAttributes: true, flatFileSnapshot: true },
    })
    const attrs = (listing?.platformAttributes ?? {}) as Record<string, unknown>
    const assigned = typeof attrs.descriptionThemeId === 'string' ? attrs.descriptionThemeId : undefined

    const buildData = async (): Promise<DescriptionRenderData> => {
      const galleries = await loadGalleries(prisma, args.productId, args.sku, args.marketplace)
      return {
        market: args.marketplace.toUpperCase(),
        title: args.title ?? listing?.title ?? '',
        subtitle: args.subtitle ?? (typeof attrs.subtitle === 'string' ? attrs.subtitle : undefined),
        body: args.body ?? listing?.description ?? '',
        sku: args.sku,
        brand: aspectsFromSnapshot(listing?.flatFileSnapshot).find((a) =>
          ['marca', 'marke', 'marque', 'brand'].includes(a.name.toLowerCase()),
        )?.value,
        mode: args.mode,
        sharedImages: galleries.shared,
        imagesByGroup: galleries.byGroup,
        rowImages: galleries.rowImages,
        aspects: aspectsFromSnapshot(listing?.flatFileSnapshot),
        policies: args.policies,
      }
    }
    // The description column is token-aware: even an UNTHEMED push ('none'
    // assignment, or no theme and no default) must resolve {{tokens}} embedded
    // in the body — a buyer must never see a literal {{specs_table}}. Bodies
    // without token syntax skip the gallery/spec loads entirely (the unchanged
    // fast path for plain-prose descriptions).
    const rawResolved = async (): Promise<RenderListingDescriptionResult> => {
      if (!/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(raw.html)) return raw
      const rendered = renderDescriptionBodyOnly(await buildData())
      return { html: rendered.html, themed: false, warnings: rendered.warnings }
    }

    let themeId = args.themeIdOverride ?? assigned
    if (themeId === 'none' && !args.themeHtmlOverride) return rawResolved()
    let theme = args.themeHtmlOverride
      ? ({ id: '__draft__', name: 'Draft preview', html: args.themeHtmlOverride, active: true } as never)
      : themeId
        ? await prisma.ebayDescriptionTheme.findUnique({ where: { id: themeId } })
        : null
    if (!theme && !args.themeIdOverride && !args.themeHtmlOverride) {
      theme = await prisma.ebayDescriptionTheme.findFirst({ where: { isDefault: true, active: true } })
    }
    // D7 (ED v2 P3) — an assigned-but-INACTIVE theme behaves exactly like a
    // deleted one: fall back to the DEFAULT theme when an active default
    // exists, raw body otherwise. (It used to drop straight to the raw body
    // even when a default existed, contradicting the theme manager's
    // "listings fall back to the default" copy.)
    if (theme && !(theme as { active: boolean }).active) {
      theme = await prisma.ebayDescriptionTheme.findFirst({ where: { isDefault: true, active: true } })
    }
    if (!theme) return rawResolved()

    const rendered = renderDescriptionTheme(theme.html, await buildData())
    const themeVersion = (theme as { version?: number }).version
    return {
      html: rendered.html,
      themed: true,
      themeId: theme.id,
      themeName: theme.name,
      ...(typeof themeVersion === 'number' ? { themeVersion } : {}),
      warnings: rendered.warnings,
    }
  } catch (err) {
    raw.warnings.push(
      `description theme render failed — pushed the raw body (${err instanceof Error ? err.message : String(err)})`,
    )
    return raw
  }
}

// ── ED v2 P5 — description staleness stamp (operator decision D8) ────────────
// eBay HTML descriptions are STATIC: once pushed they never re-render. The
// stamp records WHAT the last successful delivery rendered (theme id+version,
// curated-gallery hash) on the family parent's eBay ChannelListing, so a
// read-only staleness check can tell the operator "the live description is
// behind your curation / theme edit — re-push". Badge + manual re-push ONLY;
// nothing here (or anywhere) auto-writes to eBay from this signal.

export interface DescriptionPushStamp {
  /** ISO timestamp of the successful description delivery. */
  at: string
  /** Theme that wrapped the body; null = raw body was delivered. */
  themeId: string | null
  /** The theme's version counter at delivery time (null for raw body). */
  themeVersion: number | null
  /** galleryHashOfRows over the product's curated eBay ListingImage rows. */
  galleryHash: string
}

interface GalleryHashRow {
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  position: number
}

/**
 * Pure, stable hash of a curated gallery: sha256 over each row's
 * `variantGroupKey|variantGroupValue|url|position`, SORTED — so DB return
 * order can never change the hash, while any add/remove/reorder/re-bucket
 * (position and group are part of the identity) does.
 */
export function galleryHashOfRows(rows: GalleryHashRow[]): string {
  const lines = rows
    .map((r) => `${r.variantGroupKey ?? ''}|${r.variantGroupValue ?? ''}|${r.url}|${r.position}`)
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** Current hash of the product's curated eBay gallery (family-root productId). */
export async function computeDescriptionGalleryHash(prisma: PrismaClient, productId: string): Promise<string> {
  const rows = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY', mediaType: 'IMAGE' },
    select: { variantGroupKey: true, variantGroupValue: true, url: true, position: true },
  })
  return galleryHashOfRows(rows)
}

/**
 * Merge-write the stamp onto the family parent's eBay ChannelListing for the
 * market. MERGE-ONLY: every other platformAttributes key (__offerIds,
 * descriptionThemeId, subtitle, …) is preserved verbatim. Returns false when
 * the market has no eBay ChannelListing row (nothing to stamp).
 */
export async function stampDescriptionPush(
  prisma: PrismaClient,
  args: {
    /** FAMILY-ROOT product id (call sites resolve the root before calling). */
    productId: string
    /** Flat-file market code (IT/DE/FR/ES/UK — UK maps to region GB). */
    marketplace: string
    themeId?: string | null
    themeVersion?: number | null
    galleryHash: string
  },
): Promise<boolean> {
  const region = regionOf(args.marketplace)
  const cl = await prisma.channelListing.findFirst({
    where: { productId: args.productId, channel: 'EBAY', region },
    select: { id: true, platformAttributes: true },
  })
  if (!cl) return false
  const attrs = (cl.platformAttributes ?? {}) as Record<string, unknown>
  const stamp: DescriptionPushStamp = {
    at: new Date().toISOString(),
    themeId: args.themeId ?? null,
    themeVersion: args.themeVersion ?? null,
    galleryHash: args.galleryHash,
  }
  await prisma.channelListing.update({
    where: { id: cl.id },
    data: { platformAttributes: { ...attrs, descriptionPush: stamp } as object },
  })
  return true
}

/**
 * SAFE stamp for push sites: computes the current gallery hash, stamps, and
 * reports any problem through `warn` — the returned promise NEVER rejects, so
 * a stamp failure can never fail the push that calls it. DS-0: the promise is
 * returned (instead of swallowed) so a caller can AWAIT commit — the client's
 * post-push staleness refetch must read committed state, not race the write.
 * Fire-and-forget call sites may still ignore the return value unchanged.
 */
export function stampDescriptionPushSafe(
  prisma: PrismaClient,
  args: { productId: string; marketplace: string; themeId?: string | null; themeVersion?: number | null },
  warn?: (msg: string) => void,
): Promise<void> {
  return computeDescriptionGalleryHash(prisma, args.productId)
    .then((galleryHash) => stampDescriptionPush(prisma, { ...args, galleryHash }))
    .then((stamped) => {
      if (!stamped) warn?.(`description-push stamp skipped — no eBay ChannelListing for ${args.productId} on ${args.marketplace}`)
    })
    .catch((err) => {
      warn?.(`description-push stamp failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`)
    })
}

// ── ED v2 P5 — staleness evaluation (pure; the endpoint feeds it batch data) ─

export interface DescriptionStalenessInput {
  /** The market's eBay ChannelListing exists at all. */
  hasListing: boolean
  /** platformAttributes.descriptionPush as stored (unknown shape — validated). */
  stamp: unknown
  /** galleryHashOfRows over the product's CURRENT curated eBay rows. */
  currentGalleryHash: string
  /** The theme a push would render RIGHT NOW (assignment → D7 fallback → default); null = raw body. */
  currentTheme: { id: string; name: string; version: number } | null
  /** Any eBay ListingImage row for the product still has publishStatus DRAFT. */
  hasDraftImageRows: boolean
}

export interface DescriptionStalenessResult {
  stale: boolean
  reasons: string[]
  /** ISO timestamp of the last stamped delivery, when one exists. */
  stampedAt?: string
}

function parseStamp(v: unknown): DescriptionPushStamp | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (typeof s.galleryHash !== 'string' || typeof s.at !== 'string') return null
  return {
    at: s.at,
    themeId: typeof s.themeId === 'string' ? s.themeId : null,
    themeVersion: typeof s.themeVersion === 'number' ? s.themeVersion : null,
    galleryHash: s.galleryHash,
  }
}

/**
 * D8 — stale means the LIVE description may not match what a push would render
 * today: no stamp ever, curated gallery changed, theme re-assigned or edited,
 * or curated image rows still awaiting publish. The answer is a badge for the
 * operator — never an automatic write.
 */
export function evaluateDescriptionStaleness(input: DescriptionStalenessInput): DescriptionStalenessResult {
  const reasons: string[] = []
  if (!input.hasListing) {
    return { stale: true, reasons: ['no eBay listing row for this market — the description has never been pushed here'] }
  }
  const stamp = parseStamp(input.stamp)
  if (!stamp) {
    reasons.push('never pushed since staleness tracking began — freshness unknown until the next push')
  } else {
    if (stamp.galleryHash !== input.currentGalleryHash) {
      reasons.push('images changed since last push — the curated eBay gallery differs from what the live description was rendered with')
    }
    const currentThemeId = input.currentTheme?.id ?? null
    if (stamp.themeId !== currentThemeId) {
      reasons.push(
        input.currentTheme
          ? `theme assignment changed since last push (now "${input.currentTheme.name}")`
          : 'theme assignment changed since last push (now raw body — no theme)',
      )
    } else if (input.currentTheme && stamp.themeVersion !== input.currentTheme.version) {
      reasons.push(
        `theme "${input.currentTheme.name}" edited since last push (v${stamp.themeVersion ?? '?'} → v${input.currentTheme.version})`,
      )
    }
  }
  if (input.hasDraftImageRows) {
    reasons.push('curated image changes not yet published to eBay (DRAFT rows pending)')
  }
  return { stale: reasons.length > 0, reasons, ...(stamp ? { stampedAt: stamp.at } : {}) }
}
