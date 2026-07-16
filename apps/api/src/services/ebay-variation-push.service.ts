/**
 * eBay variation-group push — shared Inventory-API publisher.
 *
 * Extracted verbatim from ebay-flat-file.routes.ts (behaviour-preserving) so both
 * the eBay flat-file page and the per-product Images tab publish through ONE proven
 * code path. No logic changes vs the original at extraction time.
 */
import prisma from '../db.js'
import { ebayAccountService } from './ebay-account.service.js'
import { syncActivatedListings } from './listing-activation-sync.service.js'
import { parseThemeAxes, AXIS_SYNONYM_GROUPS, axisSynonymKey } from './ebay-theme-axes.js'
import { clampImageSets, EBAY_VARIATION_IMAGE_MAX } from './images/ebay-image-axis.pure.js'
import { validateVariationFamily } from './ebay-variation-preflight.js'
import { Prisma } from '@nexus/database'

// EFX D5 — AXIS_SYNONYM_GROUPS + axisSynonymKey now live in ebay-theme-axes.ts
// (so the pure create-logic module can use them without importing this service).
// Re-exported here so existing importers/tests keep working unchanged.
export { AXIS_SYNONYM_GROUPS, axisSynonymKey }

// FF-EN.2 — eBay numeric conditionId → Inventory API ConditionEnum string.
// get_item_condition_policies returns numeric ids; the flat-file/Inventory
// push uses the enum string, so we translate before exposing as options.
export const CONDITION_ID_TO_ENUM: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'CERTIFIED_REFURBISHED',
  '2010': 'EXCELLENT_REFURBISHED',
  '2020': 'VERY_GOOD_REFURBISHED',
  '2030': 'GOOD_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
};

// ── Variation group push helper ────────────────────────────────────────

// FF-EN.4 — build the Inventory API packageWeightAndSize from the flat
// row's package fields. Returns undefined when nothing usable is set, so
// the publish body is unchanged for rows without shipping dimensions.
export function buildPackageWeightAndSize(
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const w = Number(row.package_weight ?? 0);
  const l = Number(row.package_length ?? 0);
  const wd = Number(row.package_width ?? 0);
  const h = Number(row.package_height ?? 0);
  const pkgType = (row.package_type as string) || '';
  const out: Record<string, unknown> = {};
  if (w > 0) out.weight = { value: w, unit: (row.weight_unit as string) || 'KILOGRAM' };
  if (l > 0 && wd > 0 && h > 0) {
    out.dimensions = {
      length: l,
      width: wd,
      height: h,
      unit: (row.dimension_unit as string) || 'CENTIMETER',
    };
  }
  if (pkgType) out.packageType = pkgType;
  return Object.keys(out).length ? out : undefined;
}

// Known variation-axis synonym groups: axes within the same group represent
// the same physical dimension expressed in different locales or Amazon naming
// conventions. The FIRST name encountered in a family's rows wins as the
// canonical spec name (eBay market-locale names come from itemSpecifics and
// are written first by buildFlatRow, so Italian "Colore" wins over Amazon
// English "Color" for EBAY_IT). Used in synonym dedup during push + in
// buildFlatRow to prevent Amazon aliases from polluting pushed-variant rows.
// Standard clothing / shoe size order used as a built-in fallback when no
// custom _axisValueOrder is configured. Values are matched case-insensitively.
// Covers EU/IT alphanumeric general sizes + EU numeric clothing + EU shoe sizes.
export const STANDARD_SIZE_ORDER_MAP = new Map<string, number>(
  [
    // Alpha general sizes (smallest to largest)
    'XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','7XL',
    // Abbreviated numeric waist/chest (EU clothing)
    '30','32','34','36','38','40','42','44','46','48','50','52','54','56','58','60','62','64',
    // EU shoe sizes
    '33','34','35','35.5','36','36.5','37','37.5','38','38.5','39','39.5',
    '40','40.5','41','41.5','42','42.5','43','43.5','44','44.5','45','45.5','46','46.5','47','48',
    // UK/US shoe sizes
    '1','1.5','2','2.5','3','3.5','4','4.5','5','5.5','6','6.5','7','7.5',
    '8','8.5','9','9.5','10','10.5','11','11.5','12','12.5','13','14','15',
  ].map((v, i) => [v.toUpperCase(), i] as [string, number])
)

/**
 * Sort spec values for one axis.
 * Priority: custom order → built-in standard size order → numeric → as-is.
 */
export function sortAxisValues(
  values: string[],
  axisName: string,
  customOrder: string[] | undefined,
): string[] {
  if (values.length <= 1) return values

  if (customOrder && customOrder.length > 0) {
    const pos = new Map(customOrder.map((v, i) => [v.toLowerCase(), i]))
    return [...values].sort((a, b) => {
      const ai = pos.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      const bi = pos.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      return ai !== bi ? ai - bi : a.localeCompare(b)
    })
  }

  // Built-in: standard clothing/shoe size order for known size dimensions
  if (axisSynonymKey(axisName) === '__dim1__') {
    // Check if any value matches the standard size vocabulary
    const anyStandard = values.some(v => STANDARD_SIZE_ORDER_MAP.has(v.toUpperCase()))
    if (anyStandard) {
      return [...values].sort((a, b) => {
        const ai = STANDARD_SIZE_ORDER_MAP.get(a.toUpperCase()) ?? Number.MAX_SAFE_INTEGER
        const bi = STANDARD_SIZE_ORDER_MAP.get(b.toUpperCase()) ?? Number.MAX_SAFE_INTEGER
        return ai !== bi ? ai - bi : a.localeCompare(b)
      })
    }
    // All-numeric sizes (e.g. EU waist measurements) — sort numerically
    if (values.every(v => /^\d+(\.\d+)?$/.test(v.trim()))) {
      return [...values].sort((a, b) => parseFloat(a) - parseFloat(b))
    }
  }

  return values
}

/**
 * EFX P3 — resolve the effective per-axis value order from a parent listing's
 * platformAttributes. The canonical store is the synonym-keyed `_axisValueOrder`
 * (written by both the flat-file modal and the cockpit card). Legacy raw-name
 * `_axisSortOrder` entries (older cockpit saves) are merged in ONLY where the
 * dimension isn't already covered — so a newer `_axisValueOrder` always wins and
 * legacy data still orders values on push until it's migrated.
 *
 * Extracted (verbatim behaviour) from the push body so it's unit-testable.
 */
export function mergeStoredValueOrder(
  pa: Record<string, unknown>,
): Record<string, string[]> {
  const valueOrder = { ...((pa._axisValueOrder ?? {}) as Record<string, string[]>) }
  const rawSort = (pa._axisSortOrder ?? {}) as Record<string, string[]>
  for (const [name, vals] of Object.entries(rawSort)) {
    if (!Array.isArray(vals) || vals.length === 0) continue
    // Skip if this dimension is already ordered under ANY of its key forms.
    if (!(name in valueOrder) && !(axisSynonymKey(name) in valueOrder) && !(name.toLowerCase() in valueOrder)) {
      valueOrder[name] = vals
    }
  }
  return valueOrder
}

/**
 * Collapse variation specs that carry an IDENTICAL value set — the same physical
 * dimension surfaced under two different aspect names. This happens when a stray or
 * mislabeled aspect duplicates a real axis (observed on AIREON: a leftover Amazon
 * "Team Name" = {Giacca, Pantaloni} shadowing the real "Tipo di prodotto" =
 * {Giacca, Pantaloni}).
 *
 * The previous rule kept the FIRST-seen name. That silently blocks the group when the
 * stray sits on only SOME variants: every variant lacking it then fails the "all
 * variants must carry every axis" pre-flight. Instead we keep the spec present on the
 * MOST variants (highest `coverage`) — that minimises (usually zeroes) the variants
 * missing the surviving axis. Ties keep the incumbent, i.e. the original first-seen
 * behaviour, which is the eBay market-locale name (itemSpecifics are written first).
 * The relative order of the survivors is preserved.
 */
export function dedupeSpecsByValueFingerprint<T extends { values: Set<string>; coverage: number }>(
  specs: T[],
  // EFX D8 — operator-declared / operator-picked axes are EXEMPT from being
  // eliminated: they always survive, and a non-exempt look-alike sharing their
  // value fingerprint collapses INTO them (dropped) rather than competing on
  // coverage. With no exemptions this reduces to the original behaviour
  // (keep the highest-coverage axis per fingerprint; ties keep the incumbent).
  isExempt?: (s: T) => boolean,
): T[] {
  const fingerprint = (s: T) => [...s.values].map((v) => v.toLowerCase()).sort().join('|')
  const exemptFps = new Set<string>()
  if (isExempt) {
    for (const spec of specs) if (isExempt(spec)) exemptFps.add(fingerprint(spec))
  }
  const winnerByFp = new Map<string, T>()
  for (const spec of specs) {
    if (isExempt?.(spec)) continue // exempt specs are always kept (below)
    const fp = fingerprint(spec)
    if (exemptFps.has(fp)) continue // collapses into the exempt axis — never wins
    const cur = winnerByFp.get(fp)
    if (!cur || spec.coverage > cur.coverage) winnerByFp.set(fp, spec)
  }
  return specs.filter((spec) =>
    isExempt?.(spec)
      ? true
      : !exemptFps.has(fingerprint(spec)) && winnerByFp.get(fingerprint(spec)) === spec,
  )
}

// ── EFX D2/D7/D8 — resolve the authoritative variation-axis SET ────────────
//
// Extracted (behaviour-preserving in LEGACY mode) from pushVariationGroup so
// the axis-set decision is unit-testable without prisma/eBay mocks.
//
// LEGACY mode (declaredAxes == null): 100% the pre-EFX behaviour — the axis set
// is inferred purely from aspect_* columns with >1 distinct value, synonym-
// deduped, ordered by storedAxisOrder, then fingerprint-deduped. (The only
// added lever is D8: an operator-picked pictureAxisOverride is exempt from
// fingerprint elimination — inert unless an override is supplied.)
//
// DECLARED mode (declaredAxes non-null): the operator's Variation Theme (or the
// parent's stored _variationAxes) is AUTHORITATIVE for which axes eBay gets:
//   • Observed multi-value axes matching a declared axis (synonym- or name-
//     equal) form the set, in DECLARED order, keeping their observed (live-
//     compatible) display name.
//   • A stray observed axis whose value fingerprint equals a declared+matched
//     axis is SUPPRESSED (the Team Name case — proven duplicate data).
//   • A stray with a UNIQUE fingerprint is KEPT (never silently break a live
//     listing) but raises a warning; appended after the declared axes.
//   • A declared axis with no observed values, or only one value, is NOT sent
//     but raises a warning (D7 — warn, don't silently vanish).
export interface VariationAxisSpec {
  name: string // display / canonical name (observed, locale-correct)
  values: Set<string>
  coverage: number
  rawName: string // observed aspect_ name — used for aspect_<name> key lookups
}

export interface ResolveVariationAxesOptions {
  nameLabels?: Record<string, string>
  valueLabels?: Record<string, Record<string, string>>
  storedAxisOrder?: string[]
  pictureAxisOverride?: string
}

export interface ResolvedVariationAxes {
  /** Final, ordered, non-empty axis specs sent to eBay (variesBy.specifications). */
  validSpecs: VariationAxisSpec[]
  /** Raw multi-value aspect names (>1 distinct value) — feeds isVarAxis. */
  effectiveVarAxes: string[]
  /** Surviving raw axis names in final order — feeds picture-axis selection. */
  dedupedAxisNames: string[]
  /** Operator-facing warnings (undeclared varying axis / missing / single-value). */
  warnings: string[]
  /** Strays dropped as fingerprint-duplicates of a declared axis (diagnostics). */
  suppressed: string[]
}

export function resolveVariationAxes(
  variantRows: Array<Record<string, unknown>>,
  declaredAxes: string[] | null,
  opts: ResolveVariationAxesOptions = {},
): ResolvedVariationAxes {
  const nameLabels = opts.nameLabels ?? {}
  const valueLabels = opts.valueLabels ?? {}
  const storedAxisOrder = opts.storedAxisOrder ?? []
  const pictureAxisOverride = opts.pictureAxisOverride
  const nmLabel = (a: string) => nameLabels[a] || a
  const vlLabel = (a: string, v: string) => valueLabels[a]?.[v] || v
  const fingerprint = (s: VariationAxisSpec) =>
    [...s.values].map((v) => v.toLowerCase()).sort().join('|')

  // 1. Scan aspect_* across variant rows (unchanged from the inline version).
  const allAspectValueSets = new Map<string, Set<string>>()
  const dimRowCoverage = new Map<string, Set<number>>()
  variantRows.forEach((row, rowIdx) => {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const name = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!name) continue
        if (!allAspectValueSets.has(name)) allAspectValueSets.set(name, new Set())
        allAspectValueSets.get(name)!.add(v)
        const dk = axisSynonymKey(name)
        if (!dimRowCoverage.has(dk)) dimRowCoverage.set(dk, new Set())
        dimRowCoverage.get(dk)!.add(rowIdx)
      }
    }
  })
  const dimCoverage = (name: string) => dimRowCoverage.get(axisSynonymKey(name))?.size ?? 0
  const effectiveVarAxes = [...allAspectValueSets.entries()]
    .filter(([, vals]) => vals.size > 1)
    .map(([name]) => name)

  // 2. Synonym-dedup (collapse Colore/Color/… to the first canonical name).
  const seenSynonymDims = new Set<string>()
  const effectiveVarAxesDeDuped = effectiveVarAxes.filter((axis) => {
    const sk = axisSynonymKey(axis)
    if (seenSynonymDims.has(sk)) return false
    seenSynonymDims.add(sk)
    return true
  })
  // storedAxisOrder ranks the deduped axes (unchanged — the operator's stored
  // axis order still shapes derived ordering; declared order overrides below).
  if (storedAxisOrder.length > 0) {
    const rank = new Map(storedAxisOrder.map((a, i) => [axisSynonymKey(a), i]))
    effectiveVarAxesDeDuped.sort((a, b) =>
      (rank.get(axisSynonymKey(a)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(axisSynonymKey(b)) ?? Number.MAX_SAFE_INTEGER))
  }

  // 3. Candidate specs (display name + merged synonym values + coverage).
  const specificationsMap = new Map<string, VariationAxisSpec>()
  for (const rawName of effectiveVarAxesDeDuped) {
    const label = nmLabel(rawName)
    if (!label) continue
    const mapKey = label.toLowerCase()
    if (!specificationsMap.has(mapKey)) {
      specificationsMap.set(mapKey, { name: label, values: new Set(), coverage: 0, rawName })
    }
    const entry = specificationsMap.get(mapKey)!
    entry.coverage = Math.max(entry.coverage, dimCoverage(rawName))
    for (const v of (allAspectValueSets.get(rawName) ?? [])) entry.values.add(vlLabel(rawName, v))
    const dimKey = axisSynonymKey(rawName)
    for (const [candidateName] of allAspectValueSets) {
      if (candidateName === rawName) continue
      if (axisSynonymKey(candidateName) === dimKey) {
        for (const v of (allAspectValueSets.get(candidateName) ?? [])) entry.values.add(vlLabel(candidateName, v))
      }
    }
  }
  const candidateSpecs = [...specificationsMap.values()]

  const matchesOverride = (spec: VariationAxisSpec) =>
    !!pictureAxisOverride &&
    (spec.name.toLowerCase() === pictureAxisOverride.toLowerCase()
      || spec.rawName.toLowerCase() === pictureAxisOverride.toLowerCase()
      || axisSynonymKey(spec.name) === axisSynonymKey(pictureAxisOverride)
      || axisSynonymKey(spec.rawName) === axisSynonymKey(pictureAxisOverride))

  // ── LEGACY MODE — byte-identical to pre-EFX (plus inert D8 exemption) ────
  if (declaredAxes == null) {
    const validSpecs = dedupeSpecsByValueFingerprint(candidateSpecs, matchesOverride)
      .filter((e) => e.name && e.values.size > 0)
    return {
      validSpecs,
      effectiveVarAxes,
      dedupedAxisNames: effectiveVarAxesDeDuped,
      warnings: [],
      suppressed: [],
    }
  }

  // ── DECLARED MODE — theme / _variationAxes authoritative for the SET ─────
  const matchesDeclared = (spec: VariationAxisSpec, d: string) =>
    axisSynonymKey(spec.name) === axisSynonymKey(d)
    || spec.name.toLowerCase() === d.toLowerCase()
    || axisSynonymKey(spec.rawName) === axisSynonymKey(d)
    || spec.rawName.toLowerCase() === d.toLowerCase()

  const warnings: string[] = []
  const suppressed: string[] = []
  const resolved: VariationAxisSpec[] = []
  const usedSpecs = new Set<VariationAxisSpec>()

  for (const d of declaredAxes) {
    const cand = candidateSpecs.find((s) => !usedSpecs.has(s) && matchesDeclared(s, d))
    if (cand) {
      resolved.push(cand)
      usedSpecs.add(cand)
      continue
    }
    // Already represented by a spec matched to an earlier (synonym) declared axis.
    if (candidateSpecs.some((s) => usedSpecs.has(s) && matchesDeclared(s, d))) continue
    // No multi-value candidate — warn with the reason (D7).
    const observed = [...allAspectValueSets.entries()].filter(([n]) =>
      axisSynonymKey(n) === axisSynonymKey(d) || n.toLowerCase() === d.toLowerCase())
    if (observed.length > 0 && observed.every(([, vals]) => vals.size <= 1)) {
      warnings.push(`Variation Theme axis "${d}" has only one value across all variants, so eBay can't vary by it — it was not sent. Add more values or remove it from the theme.`)
    } else {
      warnings.push(`Variation Theme axis "${d}" has no values on any variant — it was not sent. Fill the "${d}" column or remove it from the theme.`)
    }
  }

  // Strays: observed multi-value candidate specs not matched to any declared axis.
  const resolvedFps = new Set(resolved.map(fingerprint))
  const keptStrays: VariationAxisSpec[] = []
  for (const s of candidateSpecs) {
    if (usedSpecs.has(s)) continue
    if (matchesOverride(s)) {
      // D8 — the operator's explicit image-axis pick is never suppressed.
      keptStrays.push(s)
      warnings.push(`Axis "${s.name}" varies across variants but is not in your Variation Theme — add it to the theme or clear the aspect values.`)
      continue
    }
    if (resolvedFps.has(fingerprint(s))) {
      // 3a — its value fingerprint proves it duplicates a declared axis (the
      // AIREON "Team Name" case): drop it entirely, no operator warning.
      suppressed.push(s.name)
      continue
    }
    // 3b — real varying data the operator didn't declare: keep + warn.
    keptStrays.push(s)
    warnings.push(`Axis "${s.name}" varies across variants but is not in your Variation Theme — add it to the theme or clear the aspect values.`)
  }

  const finalSpecs = [...resolved, ...keptStrays]
  const validSpecs = finalSpecs.filter((e) => e.name && e.values.size > 0)
  return {
    validSpecs,
    effectiveVarAxes,
    dedupedAxisNames: validSpecs.map((s) => s.rawName),
    warnings,
    suppressed,
  }
}

// Maps eBay marketplace short-code to the BCP-47 language tag that eBay's
// Inventory API requires for Content-Language / Accept-Language headers.
// eBay stores aspect names in the locale used at write time — sending en-US
// for an EBAY_IT listing causes eBay to expect English names ("Color", "Size")
// which then don't match the Italian category aspects ("Colore", "Taglia"),
// triggering publish error 25013.
export function toListingLanguage(mp: string): string {
  const MAP: Record<string, string> = {
    IT: 'it-IT', DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', UK: 'en-GB', GB: 'en-GB',
  }
  return MAP[mp.toUpperCase()] ?? 'en-US'
}

// Transient eBay Inventory errors — 25001 ("internal warehouse service error")
// and 25604 ("product not found") — fire when a PUT/POST races eBay's eventual
// consistency (e.g. a group PUT referencing inventory_items written <2s earlier,
// common for large families). Retry with exponential backoff. The body is peeked
// via res.clone() so callers still read res.ok / res.text() on the result unchanged.
async function ebayFetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Response> {
  const { retries = 3, baseDelayMs = 2000, maxDelayMs = 10000 } = opts
  let res = await fetch(url, init)
  for (let attempt = 0; attempt < retries; attempt++) {
    if (res.ok || res.status === 204) return res
    let body = ''
    try { body = await res.clone().text() } catch { /* unreadable — treat as non-transient */ }
    const transient =
      res.status === 500 || res.status === 503 ||
      body.includes('"errorId":25001') || body.includes('"errorId":25604') ||
      // 25007 ("invalid shipping policy on the offer") frequently fires spuriously against
      // an offer/policy written seconds earlier while eBay's Inventory Service is still
      // eventually-consistent — even when the policy is valid & already on a published offer.
      // Retry it too; a genuinely-bad policy still fails after the backoff (+ the publish
      // probe then names the real culprit).
      body.includes('"errorId":25007')
    if (!transient) return res
    await new Promise((r) => setTimeout(r, Math.min(baseDelayMs * 2 ** attempt, maxDelayMs))) // 2s → 4s → 8s → capped at maxDelayMs
    res = await fetch(url, init)
  }
  return res
}

// ── P1: Offer-ID cache helpers ─────────────────────────────────────────────
// Persists per-SKU eBay offer IDs to ChannelListing.platformAttributes.__offerIds.
// Eliminates one GET /offer per variant on every subsequent push.

async function loadCachedOfferIds(
  skus: string[],
  region: string,
  marketplaceId: string,
): Promise<Map<string, string>> {
  const cache = new Map<string, string>()
  if (skus.length === 0) return cache
  try {
    const listings = await prisma.channelListing.findMany({
      where: { product: { sku: { in: skus } }, channel: 'EBAY', region },
      select: { platformAttributes: true, product: { select: { sku: true } } },
    })
    for (const l of listings) {
      const sku = l.product?.sku
      if (!sku) continue
      const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
      const offerIds = ((pa.__offerIds ?? {}) as Record<string, string>)
      const offerId = offerIds[marketplaceId]
      if (offerId) cache.set(sku, offerId)
    }
  } catch { /* non-fatal */ }
  return cache
}

async function saveOfferIds(
  skuOfferIds: Map<string, string>,
  region: string,
  marketplaceId: string,
): Promise<void> {
  await Promise.all([...skuOfferIds.entries()].map(async ([sku, offerId]) => {
    try {
      const listing = await prisma.channelListing.findFirst({
        where: { product: { sku }, channel: 'EBAY', region },
        select: { id: true, platformAttributes: true },
      })
      if (!listing) return
      const pa = (listing.platformAttributes ?? {}) as Record<string, unknown>
      const existing = ((pa.__offerIds ?? {}) as Record<string, string>)
      if (existing[marketplaceId] === offerId) return
      await prisma.channelListing.update({
        where: { id: listing.id },
        data: { platformAttributes: { ...pa, __offerIds: { ...existing, [marketplaceId]: offerId } } },
      })
    } catch { /* non-fatal */ }
  }))
}

// Persists the parent listing's last-published variation axis NAMES, per market, to
// ChannelListing.platformAttributes.__lastPublishedAxes[marketplaceId] — server
// metadata like __offerIds (NEVER flatFileSnapshot). Called ONLY after a successful
// publish, so it records what actually went live. Feeds the AXIS_STRUCTURE_CHANGE
// pre-flight: a later axis-count change (e.g. 3 axes → 2) is caught before it reaches
// eBay. Merge-only — spreads the existing platformAttributes so __offerIds and every
// other key are preserved. Queried by `marketplace: mp` to hit the SAME parent
// listing row the read side used.
async function saveLastPublishedAxes(
  parentSku: string,
  mp: string,
  marketplaceId: string,
  axisNames: string[],
): Promise<void> {
  if (!parentSku || axisNames.length === 0) return
  try {
    const listing = await prisma.channelListing.findFirst({
      where: { product: { sku: parentSku }, channel: 'EBAY', marketplace: mp },
      select: { id: true, platformAttributes: true },
    })
    if (!listing) return
    const pa = (listing.platformAttributes ?? {}) as Record<string, unknown>
    const existing = ((pa.__lastPublishedAxes ?? {}) as Record<string, string[]>)
    const prev = existing[marketplaceId]
    // Idempotent — skip the write when the stored axes already match.
    if (Array.isArray(prev) && prev.length === axisNames.length && prev.every((v, i) => v === axisNames[i])) return
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: { platformAttributes: { ...pa, __lastPublishedAxes: { ...existing, [marketplaceId]: axisNames } } },
    })
  } catch { /* non-fatal */ }
}

/**
 * FM/25004 self-heal — return the offer body for an updateOffer (a FULL
 * replacement) with `availableQuantity` forced to `qty`, preserving every other
 * field eBay's getOffer echoed (marketplaceId, format, categoryId,
 * listingPolicies, merchantLocationKey, pricingSummary, tax, subtitle…) so the
 * PUT changes ONLY the quantity. The read-only `listing` container that getOffer
 * returns (listingId/status/etc.) is stripped — it is not a valid updateOffer
 * input. Pure and idempotent: raising to the same qty repeatedly is safe.
 */
export function withAvailableQuantity(
  offer: Record<string, unknown>,
  qty: number,
): Record<string, unknown> {
  const { listing: _listing, ...rest } = offer
  return { ...rest, availableQuantity: Number(qty) }
}

/**
 * EFX P9a — map the sheet's Best Offer columns onto the eBay Inventory API
 * offer's Best Offer terms.
 *
 * eBay carries Best Offer under the offer's `listingPolicies` as `bestOfferTerms`
 * (Sell Inventory API createOffer/updateOffer → listingPolicies.bestOfferTerms:
 * { bestOfferEnabled, autoAcceptPrice, autoDeclinePrice }, see
 * developer.ebay.com/api-docs/sell/inventory/types/slr:BestOffer).
 *   • autoAcceptPrice  = amount at/above which an offer auto-ACCEPTS  → our BO Ceiling
 *   • autoDeclinePrice = amount below which an offer auto-DECLINES     → our BO Floor
 *
 * Always returns a terms object (never null) so switching Best Offer OFF sends
 * an explicit { bestOfferEnabled: false } that clears any terms on the live offer.
 *
 * Rules:
 *   • best_offer_enabled falsy → { bestOfferEnabled: false } (thresholds ignored).
 *   • enabled → { bestOfferEnabled: true } plus autoDecline (floor) / autoAccept
 *     (ceiling) ONLY when that threshold is a positive number; blanks are omitted.
 *   • floor ≥ ceiling with both set is contradictory (auto-decline at/above the
 *     auto-accept point) → drop BOTH thresholds and warn; Best Offer stays on.
 */
export function buildBestOfferTerms(
  row: Record<string, unknown>,
  currency: string,
  warnings?: string[],
): Record<string, unknown> {
  if (!row.best_offer_enabled) return { bestOfferEnabled: false }

  const floor = Number(row.best_offer_floor ?? 0)     // auto-decline threshold
  const ceiling = Number(row.best_offer_ceiling ?? 0) // auto-accept threshold
  const hasFloor = Number.isFinite(floor) && floor > 0
  const hasCeiling = Number.isFinite(ceiling) && ceiling > 0

  const terms: Record<string, unknown> = { bestOfferEnabled: true }
  if (hasFloor && hasCeiling && floor >= ceiling) {
    const w = `Best Offer thresholds ignored for ${String(row.sku ?? 'this listing')}: the auto-decline floor (${floor}) must be below the auto-accept ceiling (${ceiling}). Best Offer stays on with no automatic rules.`
    if (warnings && !warnings.includes(w)) warnings.push(w)
    return terms
  }
  if (hasCeiling) terms.autoAcceptPrice = { value: ceiling.toFixed(2), currency }
  if (hasFloor) terms.autoDeclinePrice = { value: floor.toFixed(2), currency }
  return terms
}

/**
 * EFX P9f — per-listing cap on how many units one buyer may purchase
 * (eBay offer field `quantityLimitPerBuyer`). Operator override via the sheet's
 * quantity_limit_per_buyer column; falls back to our historical default of 10
 * when the cell is blank or not a valid ≥1 integer. Floors at 1.
 */
export function resolveQuantityLimitPerBuyer(row: Record<string, unknown>): number {
  const raw = row.quantity_limit_per_buyer
  if (raw == null || raw === '') return 10
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 10
  return Math.floor(n)
}

/**
 * EFX P9d — map the sheet's shared `video_id` cell onto the eBay Inventory API
 * inventory item's `product.videoIds`.
 *
 * eBay attaches a listing video via the createOrReplaceInventoryItem method's
 * `product.videoIds` field — an array of one or more Media-API videoId values
 * (developer.ebay.com/api-docs/sell/inventory/types/slr:Product → videoIds, and
 * "Managing videos" static guide). eBay currently allows exactly ONE video per
 * listing (Seller Help "Adding a video to your listing" — one per listing, the
 * same video may be reused across listings), so a supplied id maps to a single-
 * element array. A videoId is minted by uploading the file through the Media API
 * (createVideo → uploadVideo); a raw URL/file is NOT accepted here.
 *
 * Rules:
 *   • blank / null / whitespace-only → undefined (field omitted; no video change
 *     is requested — leaves any existing live video untouched).
 *   • a plausible id (non-empty, no internal whitespace, not a URL) → [id].
 *   • an obviously-wrong value (contains whitespace, or looks like an http(s)
 *     URL — the classic "pasted the video URL not the id" mistake) → undefined
 *     plus an optional warning via the warnings sink, so it is dropped rather
 *     than sent to trigger an opaque eBay rejection.
 */
export function resolveVideoIds(
  videoIdRaw: unknown,
  warnings?: string[],
): string[] | undefined {
  if (videoIdRaw == null) return undefined
  const id = String(videoIdRaw).trim()
  if (!id) return undefined
  if (/\s/.test(id) || /^https?:\/\//i.test(id)) {
    const w = `Listing video ignored: "${id.slice(0, 40)}" is not a valid eBay videoId. Upload the video via the Media API (createVideo → uploadVideo) and paste the returned videoId — not a URL.`
    if (warnings && !warnings.includes(w)) warnings.push(w)
    return undefined
  }
  return [id]
}

/**
 * STEP 1a — clamp a resolved quantity to a safe non-negative integer for
 * shipToLocationAvailability. A non-finite / null / negative value becomes 0 so
 * we never serialize `null` (eBay 25004 "quantità non valida"); a fractional
 * value floors (3.9 → 3). Extracted verbatim from the inline push expression.
 */
export function computeSafeQty(qty: unknown): number {
  const n = Number(qty)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * STEP 1b — a variation listing can only publish with ≥1 sellable variant.
 * Mirrors the `anyVariantSellable` accumulation (a variant is sellable when its
 * clamped qty > 0). All-zero ⇒ false ⇒ the push aborts with a clear message.
 */
export function familyHasSellableVariant(qtys: number[]): boolean {
  return qtys.some((q) => q > 0)
}

/**
 * STEP 1c — build the eBay variesBy `specifications` array from the resolved,
 * fingerprint-deduped axis specs. Extracted VERBATIM from the inline push body
 * so BOTH the publish path AND the pre-flight validator consume ONE spec-builder
 * (no value drift between what we validate and what we send).
 *
 * Behaviour-preserving: with ≥1 valid spec, each spec's values are value-ordered
 * exactly as before (custom order → standard size → numeric → as-is, via
 * sortAxisValues); with NO valid spec it falls back to the historical single
 * "Custom Bundle" spec whose values are the family SKUs.
 */
export function buildVariesBySpecifications(
  validSpecs: VariationAxisSpec[],
  valueOrder: Record<string, string[]>,
  fallbackSkus: string[],
): Array<{ name: string; values: string[] }> {
  if (validSpecs.length > 0) {
    return validSpecs.map((e) => ({
      name: e.name,
      values: sortAxisValues(
        [...e.values].filter(Boolean),
        e.name,
        valueOrder[axisSynonymKey(e.name)] ?? valueOrder[e.name] ?? valueOrder[e.name.toLowerCase()],
      ),
    }))
  }
  return [{ name: 'Custom Bundle', values: fallbackSkus }]
}

export async function pushVariationGroup(
  groupKey: string,
  rows: Array<Record<string, unknown>>,
  mp: string,
  token: string,
  connectionId: string,
  connectionMeta: Record<string, unknown>,
  apiBase: string,
  marketplaceId: string,
  // FCF.3 — caps each variant's qty at its FBM-available pool.
  capToFbm: (pid: string | undefined, sku: string, requested: number, market?: string) => number,
  // P3 — per-colour curated image override (colourValue.toLowerCase() → ordered
  // URLs). When a colour is present here these URLs WIN over the ProductImage-
  // derived colorRepImages, so the operator's master-gallery selections become
  // the per-variant images. Colours absent from the map keep the default.
  imageOverrideByColor?: Map<string, string[]>,
  // P4 — the variation axis eBay varies images by (aspectsImageVariesBy). Defaults
  // to the auto-detected colour axis when omitted, so the flat-file push is
  // unchanged. imageOverrideByColor is keyed by THIS axis's values.
  pictureAxisOverride?: string,
  // P4 — per-SKU image override; WINS over the per-axis-value override for that
  // exact variant. Keyed by SKU. (eBay only shows per-SKU images when the picture
  // axis is granular enough — e.g. Size — so this is for those configurations.)
  imageOverrideBySku?: Map<string, string[]>,
  // P5 — operator-curated group/default gallery (the "cover & common" set). When
  // provided it REPLACES the parent-derived group images (up to 12). The caller
  // de-dupes the per-variant sets against this so nothing shows twice on eBay.
  groupImageOverride?: string[],
  // When true, variants with no price are silently skipped in the offer step
  // instead of failing the whole push. Used by the images tab which only needs
  // inventory_item + group updates — not offer updates — to deliver images.
  opts?: {
    skipOffersOnNoPrice?: boolean
    /** FFP.15 — shared-gallery mode (single-colour families): publish ONE
     *  gallery for the whole listing instead of varying pictures by an axis.
     *  If eBay rejects the group without aspectsImageVariesBy, the group PUT
     *  retries once with the default axis (images stay uniform either way). */
    omitImageVariesBy?: boolean
    /** EFX D7 — mutable sink the caller passes in to collect axis-resolution
     *  warnings (undeclared varying axis / declared axis missing or single-
     *  valued). The push route merges these into its response `warnings` so the
     *  flat-file client can show them. Never affects the pushed payload. */
    warningsSink?: string[]
    /** EFX P9e — the PARENT's per-market resolved content for the target market
     *  (title/subtitle/description). A variation listing has ONE parent-level
     *  title/subtitle/description, so the caller resolves it from the parent
     *  product's ChannelListing for this market (via resolvePerMarketContent,
     *  falling back to the active-market parent row) and threads it in. When
     *  omitted, the group falls back to the parentRow.* values (byte-identical to
     *  pre-P9e). Only the group-level title/description + offer subtitle use this;
     *  per-variant inventory_item title/description are non-surfacing on grouped
     *  listings (the group title/description is authoritative) and stay as-is. */
    parentContent?: { title: string; subtitle: string; description: string }
  },
): Promise<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[]> {
  const results: { sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[] = []

  // EFX P5 — cap consistency. eBay allows at most 12 pictures per variation in
  // a multiple-variation listing (Inventory API "Managing images"; same cap as
  // Trading's VariationSpecificPictureSet). Curated per-axis-value and per-SKU
  // sets arrive operator-sized and were previously sent unclamped — eBay drops
  // the surplus with zero feedback. Clamp HERE (covers every caller) and tell
  // the operator via warningsSink (never silent). Mutation is idempotent, so
  // the multi-market loop re-entering with the same maps is harmless.
  const sinkWarn = (w: string) => {
    if (opts?.warningsSink && !opts.warningsSink.includes(w)) opts.warningsSink.push(w)
  }
  if (imageOverrideByColor) {
    for (const w of clampImageSets(imageOverrideByColor, EBAY_VARIATION_IMAGE_MAX, (k) => `Curated ${pictureAxisOverride ?? 'variation'} set "${k}"`)) sinkWarn(w)
  }
  if (imageOverrideBySku) {
    for (const w of clampImageSets(imageOverrideBySku, EBAY_VARIATION_IMAGE_MAX, (k) => `Per-SKU image set for ${k}`)) sinkWarn(w)
  }
  if (groupImageOverride && groupImageOverride.length > EBAY_VARIATION_IMAGE_MAX) {
    // The slice itself happens where groupImageUrls is built (below) — this is
    // the honest-feedback half of that existing ≤12 group cap.
    sinkWarn(`Cover & common gallery: ${groupImageOverride.length} images curated — only the first ${EBAY_VARIATION_IMAGE_MAX} were sent (eBay group gallery limit)`)
  }

  const lang = toListingLanguage(mp)
  // eBay Sell Inventory API requires BOTH Content-Language AND Accept-Language
  // on every call (inventory_item, inventory_item_group, offer, publish).
  // Sending only one triggers error 25709 ("Invalid value for Content-Language
  // header"). Use one headers object for all steps — mirrors ebay-publish.adapter.ts.
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': lang,
    'Accept-Language': lang,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
  }

  // EV.5b — the family load (EV.5) includes the parent *container* row
  // (_isParent). The parent is not a sellable variant: it must not get
  // its own inventory_item nor be a group member. It IS the right source
  // for the group-level title/description/images.
  //
  // Fallback: if React strips underscore-prefixed fields during the round-trip
  // (_isParent becomes undefined), identify the parent by the invariant
  // platformProductId === _productId (parent's own id is its "group" key;
  // children have platformProductId = parentId ≠ _productId).
  const isParentRow = (r: Record<string, unknown>) =>
    r._isParent === true ||
    (r._productId != null && r.platformProductId != null &&
      String(r._productId) === String(r.platformProductId))

  const parentRow = rows.find(isParentRow) ?? rows[0]
  const variantRowsAll = rows.filter((r) => !isParentRow(r))
  const variantRows = variantRowsAll.length > 0 ? variantRowsAll : rows

  // EV.6b — name/value renames from parent ChannelListing platformAttributes.
  // Also build brandBySku (sku-keyed, not _productId-keyed) so brand lookup is
  // frontend-round-trip-proof: _productId/_brand are _ -prefixed internal fields
  // that React state may drop; sku is always present in the push body.
  let nameLabels: Record<string, string> = {}
  let valueLabels: Record<string, Record<string, string>> = {}
  let valueOrder: Record<string, string[]> = {}
  // FFP.8 — operator's stored axis ORDER (_variationAxes, per market+channel).
  let storedAxisOrder: string[] = []
  // AXIS_STRUCTURE_CHANGE — the axis NAMES eBay actually last published for THIS
  // market (parent listing platformAttributes.__lastPublishedAxes[marketplaceId]),
  // read below from the parent listing already loaded for label overrides. Fed to
  // the pre-flight validator; undefined ⇒ first publish ⇒ the check stays silent.
  let priorPublishedAxes: string[] | undefined
  // EFX D2 — the operator's declared axis SET (authoritative). parseThemeAxes on
  // the parent Product.variationTheme; falling back to the parent listing's
  // stored _variationAxes; null ⇒ LEGACY inference (byte-identical to pre-EFX).
  let declaredAxes: string[] | null = null
  let parentThemeRaw: string | null = null
  const brandBySku = new Map<string, string>()
  try {
    const skus = rows.map((r) => r.sku as string).filter(Boolean)
    const prods = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, parentId: true, brand: true, variationTheme: true },
    })
    for (const p of prods) {
      if (p.brand) brandBySku.set(p.sku, p.brand)
    }
    // Resolve name/value label overrides from the parent listing's platformAttributes
    const parentSku = (rows.find((r) => r._isParent) ?? rows[0])?.sku as string | undefined
    parentThemeRaw = prods.find((p) => p.sku === parentSku)?.variationTheme
      ?? prods.find((p) => p.parentId == null)?.variationTheme
      ?? null
    if (parentSku) {
      const pl = await prisma.channelListing.findFirst({
        where: { product: { sku: parentSku }, channel: 'EBAY', marketplace: mp },
        select: { platformAttributes: true },
      })
      const pa = (pl?.platformAttributes ?? {}) as Record<string, unknown>
      nameLabels = (pa._axisNameLabels ?? {}) as Record<string, string>
      valueLabels = (pa._axisValueLabels ?? {}) as Record<string, Record<string, string>>
      // EFX P3 — canonical synonym-keyed _axisValueOrder, with legacy raw-name
      // _axisSortOrder merged in only where a dimension isn't already ordered.
      // (Both keys were once push-dead; FFP.8 revived the merge, P3 extracted it.)
      valueOrder = mergeStoredValueOrder(pa)
      storedAxisOrder = Array.isArray(pa._variationAxes)
        ? (pa._variationAxes as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      // AXIS_STRUCTURE_CHANGE read — reuse the just-loaded parent platformAttributes
      // (no extra query). __lastPublishedAxes is server metadata keyed by marketplaceId
      // (mirrors __offerIds); absent on a first publish ⇒ leave undefined ⇒ no warning.
      const lastAxesForMarket = ((pa.__lastPublishedAxes ?? {}) as Record<string, unknown>)[marketplaceId]
      priorPublishedAxes = Array.isArray(lastAxesForMarket)
        ? (lastAxesForMarket as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined
    }
    // EFX D2 — theme wins; else the parent's stored _variationAxes; else LEGACY.
    const themeAxes = parseThemeAxes(parentThemeRaw)
    declaredAxes = themeAxes.length > 0
      ? themeAxes
      : storedAxisOrder.length > 0
        ? storedAxisOrder.slice()
        : null
  } catch (err) {
    console.warn('[ebay-push] brand/label fetch failed — proceeding without renames', err)
  }
  const nmLabel = (a: string) => nameLabels[a] || a
  const vlLabel = (a: string, v: string) => valueLabels[a]?.[v] || v

  // Pre-fetch images per SKU. Priority order:
  //   1. ProductImage rows (PI) — the canonical image store; always populated for
  //      products that went through the image editor. Covers all colours + all sizes.
  //   2. Amazon ChannelListing platformAttributes.imageUrls — SP-API import fallback
  //      (only present when Amazon sync has run and stored per-variant image URLs).
  //   3. row.image_1..image_6 — operator-entered flat-file image columns (fallback
  //      of last resort; used per-variant in the loop below).
  const productImagesBySku = new Map<string, string[]>()
  try {
    const variantSkus = variantRows.map(r => r.sku as string).filter(Boolean)
    const piRows = await prisma.product.findMany({
      where: { sku: { in: variantSkus }, deletedAt: null },
      select: {
        sku: true,
        images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
      },
    })
    for (const p of piRows) {
      const urls = p.images.map(i => i.url).filter(Boolean)
      if (urls.length) productImagesBySku.set(p.sku, urls)
    }
  } catch (err) {
    console.warn('[ebay-push] ProductImage fetch failed', err)
  }

  const amazonImagesBySku = new Map<string, string[]>()
  try {
    const variantSkus = variantRows.map(r => r.sku as string).filter(Boolean)
    const amazonListings = await prisma.channelListing.findMany({
      where: { product: { sku: { in: variantSkus } }, channel: 'AMAZON' },
      select: { platformAttributes: true, product: { select: { sku: true } } },
    })
    for (const al of amazonListings) {
      const attrs = (al.platformAttributes ?? {}) as Record<string, unknown>
      let urls: string[] = Array.isArray(attrs.imageUrls)
        ? (attrs.imageUrls as string[]).filter(Boolean)
        : []
      if (urls.length === 0 && Array.isArray(attrs.main_product_image_locator)) {
        urls = (attrs.main_product_image_locator as Array<{ media_location?: string }>)
          .map(l => l.media_location ?? '')
          .filter(Boolean)
      }
      if (urls.length === 0 && typeof attrs.mainImage === 'string' && attrs.mainImage) {
        urls = [attrs.mainImage]
      }
      if (urls.length) amazonImagesBySku.set(al.product.sku, urls)
    }
  } catch (err) {
    console.warn('[ebay-push] Amazon image fallback fetch failed', err)
  }

  // Merge: ProductImage rows win over Amazon ChannelListing platformAttributes.
  const imagesBySku = new Map<string, string[]>()
  for (const [sku, urls] of amazonImagesBySku) imagesBySku.set(sku, urls)
  for (const [sku, urls] of productImagesBySku) imagesBySku.set(sku, urls) // PI wins

  // EFX D2/D7/D8 — resolve the authoritative variation-axis SET. In LEGACY mode
  // (declaredAxes == null) this is byte-identical to the old inline inference:
  // aspect_* columns with >1 distinct value, synonym-deduped, storedAxisOrder-
  // ranked, fingerprint-deduped. When the operator declared a theme (or the
  // parent has stored _variationAxes) the declared set is authoritative and
  // stray look-alikes (the AIREON "Team Name" case) are suppressed. Warnings are
  // surfaced to the caller via opts.warningsSink.
  const resolved = resolveVariationAxes(variantRows, declaredAxes, {
    nameLabels,
    valueLabels,
    storedAxisOrder,
    pictureAxisOverride,
  })
  const { effectiveVarAxes, dedupedAxisNames, validSpecs } = resolved
  if (opts?.warningsSink && resolved.warnings.length > 0) {
    for (const w of resolved.warnings) if (!opts.warningsSink.includes(w)) opts.warningsSink.push(w)
  }
  if (resolved.warnings.length > 0 || resolved.suppressed.length > 0) {
    console.log('[ebay-push] axis resolve: declared=%j specs=%j warnings=%j suppressed=%j',
      declaredAxes, validSpecs.map(s => s.name), resolved.warnings, resolved.suppressed)
  }

  const isVarAxis = (name: string) => effectiveVarAxes.includes(name)

  const COLOR_AXIS_NAMES_PRE = new Set(['colore', 'color', 'farbe', 'couleur', 'colour', 'kleur'])
  const colorAxisRawName = dedupedAxisNames.find(n => COLOR_AXIS_NAMES_PRE.has(n.toLowerCase()))
  // FFP.16 — explicit override matches across locales too (Taglia ≡ Size):
  // an operator's deliberate axis pick is always honored when it truly varies.
  const pictureAxis = (pictureAxisOverride
    && dedupedAxisNames.find(a =>
      a.toLowerCase() === pictureAxisOverride.toLowerCase()
      || axisSynonymKey(a) === axisSynonymKey(pictureAxisOverride)))
    || colorAxisRawName

  // Build variesBy specifications from the resolved spec set (value ordering +
  // Custom Bundle fallback unchanged).
  const specifications = buildVariesBySpecifications(
    validSpecs,
    valueOrder,
    variantRows.map(r => r.sku as string).filter(Boolean),
  )
  const pictureSpec = pictureAxis
    ? validSpecs.find(s => s.name.toLowerCase() === pictureAxis.toLowerCase()
        || s.rawName.toLowerCase() === pictureAxis.toLowerCase()
        || (COLOR_AXIS_NAMES_PRE.has(s.name.toLowerCase()) && COLOR_AXIS_NAMES_PRE.has(pictureAxis.toLowerCase())))
    : undefined
  // FFP.15/16 — picture-axis policy: pictures vary ONLY by a colour-like axis
  // or an explicit operator pick. NEVER default to the first spec — on
  // size-only families that produced per-size picture sets (unprofessional
  // PDP: the gallery swaps as the buyer clicks sizes). With no eligible axis
  // the group is published WITHOUT aspectsImageVariesBy → one shared gallery
  // (the 400-retry below is the safety net if eBay refuses that shape).
  const imageVariesByAxes = opts?.omitImageVariesBy
    ? []
    : (pictureSpec ? [pictureSpec.name] : []).filter(Boolean)

  // Row normalisation: write the canonical spec key to any row that only has a
  // synonym alias. Without this, families where existing variants were pushed
  // before the Accept-Language fix (so their itemSpecifics uses English "Color"/
  // "Size") and a new variant was filled in Italian ("Colore"/"Taglia") will fail
  // pre-flight — the check looks for aspect_Color, finds nothing, blocks the push.
  // After normalisation every row carries the canonical key; the pre-flight lookup,
  // Step 1 aspect building, and colorRepImages all find the value in one place.
  // In-memory only — no DB writes; persisted on the next Save.
  for (const spec of validSpecs) {
    const dimKey = axisSynonymKey(spec.name)
    if (!dimKey.startsWith('__dim')) continue // only known synonym dimensions
    const canonKey = `aspect_${spec.name.replace(/\s+/g, '_')}`
    const canonLower = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
    for (const vRow of variantRows) {
      if (vRow[canonKey] || vRow[canonLower]) continue // already present
      for (const [rk, rv] of Object.entries(vRow)) {
        if (!rk.startsWith('aspect_') || !rv) continue
        const axisName = rk.slice('aspect_'.length).replace(/_/g, ' ')
        if (axisSynonymKey(axisName) === dimKey) {
          ;(vRow as Record<string, unknown>)[canonKey] = rv
          break
        }
      }
    }
  }

  // ── STEP 3 — variation-family pre-flight (WARN-NEVER-BLOCK) ───────────────
  // Advisory, pure validation over the EXACT resolved axes + specifications the
  // group PUT sends (built by the shared buildVariesBySpecifications above), so
  // what we warn about is byte-identical to what we publish. Every issue — even
  // block-soft — is only surfaced via warningsSink (which the route returns as
  // `axisWarnings`); the push STILL PROCEEDS. Wrapped defensively so a validator
  // bug can never regress a working publish. Runs after row-normalisation so the
  // per-variant value lookups match the canonical keys the item PUT uses.
  //
  // NOTE: wired here (immediately after specs are assembled) rather than in the
  // route, because this is the only place the fully-resolved axes/specifications
  // exist — reusing them avoids duplicating the prisma-backed axis resolution in
  // the route (which would reintroduce the drift this hardening exists to remove).
  try {
    const preflightQtys = variantRows.map(r =>
      computeSafeQty(capToFbm(r._productId as string | undefined, r.sku as string,
        Number(r[`${mp.toLowerCase()}_qty`] ?? r.quantity ?? 0), mp)))
    const brandDefaulted = variantRows.some(r =>
      !String(r.brand ?? '').trim() && !String(brandBySku.get(r.sku as string) ?? '').trim())
    const familyIssues = validateVariationFamily(variantRows, resolved, specifications, {
      brandDefaulted,
      safeQtys: preflightQtys,
      // AXIS_STRUCTURE_CHANGE — the axis names eBay ACTUALLY published last time for
      // this market, read above from the parent listing's __lastPublishedAxes. NOT the
      // declared set (which equals the current axes by construction). undefined on a
      // first publish ⇒ the validator skips the check (no false positive).
      priorPublishedAxisNames: priorPublishedAxes,
    })
    for (const issue of familyIssues) sinkWarn(`${issue.message} ${issue.fixHint}`.trim())
  } catch (err) {
    console.warn('[ebay-push] variation pre-flight validator failed (non-fatal)', err)
  }

  // Pre-flight: every variant must have a non-empty value for every FINAL spec name.
  // Using final spec names (after fingerprint dedup) avoids false positives from
  // duplicate data sources — e.g. "Colore" (eBay flat-file) + "color name" (Amazon
  // categoryAttributes) both appear in effectiveVarAxes with >1 distinct value, but
  // fingerprint dedup collapses them to one spec "Colore". Validating against raw
  // effectiveVarAxes would incorrectly flag every variant as missing "color name".
  const isCustomBundleFallback = specifications.length === 1 && specifications[0].name === 'Custom Bundle'
  if (!isCustomBundleFallback) {
    const missingAxisErrors: Array<{ sku: string; axes: string[] }> = []
    for (const row of variantRows) {
      const missingForRow: string[] = []
      for (const spec of specifications) {
        const key1 = `aspect_${spec.name.replace(/\s+/g, '_')}`
        const key2 = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
        const val = String((row[key1] ?? row[key2]) ?? '').trim()
        if (!val) missingForRow.push(spec.name)
      }
      if (missingForRow.length > 0) missingAxisErrors.push({ sku: row.sku as string, axes: missingForRow })
    }
    if (missingAxisErrors.length > 0) {
      const detail = missingAxisErrors.map(e => `${e.sku}: missing ${e.axes.join(', ')}`).join('; ')
      console.log('[ebay-push] 25013 pre-check: %s', detail)
      return variantRows.map(r => {
        const rowError = missingAxisErrors.find(e => e.sku === (r.sku as string))
        const msg = rowError
          ? `Missing variation aspects: ${rowError.axes.join(', ')} — fill in the flat-file before pushing`
          : `Blocked: another variant in this group is missing variation aspects (${detail})`
        return { sku: r.sku as string, market: mp, status: 'ERROR' as const, message: msg }
      })
    }
  }

  // ── Colour-representative image sets ─────────────────────────────────────
  // eBay with aspectsImageVariesBy=['Color'] aggregates images from EVERY variant
  // that matches the selected colour. If all 9 Black-size variants each carry 6
  // images (even identical URLs), eBay may show up to 9×6=54 photos in the
  // carousel instead of 6.
  //
  // Fix: pre-compute ONE canonical image set per colour value, then assign that
  // exact same set to every same-colour variant. eBay deduplicates by URL so the
  // buyer always sees 6 images regardless of how many sizes the colour has.
  //
  // Falls back to per-SKU images when no colour axis is present (single-colour
  // products, bundles, etc.).
  const colorRepImages = new Map<string, string[]>() // pictureAxisValue.toLowerCase() → [url, ...]
  if (pictureAxis) {
    const axisKey = `aspect_${pictureAxis.replace(/ /g, '_')}`
    for (const row of variantRows) {
      const colorVal = String((row as Record<string, unknown>)[axisKey] ?? '').toLowerCase()
      if (!colorVal || colorRepImages.has(colorVal)) continue
      const sku = row.sku as string
      // Prefer imagesBySku (ProductImage rows + Amazon PA — set in the merge above)
      // over the flat-file image_1..6 columns which may contain old stale URLs.
      let imgs = (imagesBySku.get(sku) ?? []).slice(0, 6)
      if (imgs.length === 0) {
        for (let i = 1; i <= 6; i++) {
          const url = (row as Record<string, unknown>)[`image_${i}`] as string | undefined
          if (url) imgs.push(url)
        }
      }
      colorRepImages.set(colorVal, imgs)
    }
  }

  // EFX P9d — listing video (eBay allows one video per listing). `video_id` is a
  // shared per-listing field, so the same Media-API videoId is attached to every
  // variant's inventory_item.product.videoIds. Read from the parent row first,
  // then the first variant carrying a value (round-trips via each listing's
  // platformAttributes.videoId). Omitted entirely when blank → leaves any live
  // video untouched; an invalid paste (URL/whitespace) is dropped + warned.
  const rawVideoId = [parentRow, ...variantRows]
    .map((r) => r?.video_id)
    .find((v) => v != null && String(v).trim() !== '')
  const listingVideoIds = resolveVideoIds(rawVideoId, opts?.warningsSink)

  // Step 1: Create/update each variant's inventory_item.
  // FFP.17 — transient eBay flakes (25604/25001/5xx) collected for a second pass.
  const transientItemFailures: Array<{ sku: string; url: string; body: string }> = []
  // eBay lists a variation with some sizes at qty 0 (they show as out of stock);
  // only the whole listing needs >=1 sellable variant. Track that here for the
  // all-zero guard before the group publish.
  const safeQtys: number[] = []
  for (const row of variantRows) {
    const sku = row.sku as string

    // Build variation aspects using canonical spec names (must match the group's
    // specifications exactly). Synonym matching finds the value regardless of
    // what key the row uses — "Colore", "color name", or "Color" all resolve to
    // the same canonical spec name. After row normalisation above, the canonical
    // key is usually already present (fast path); the synonym scan is a fallback.
    const aspectsMap = new Map<string, string[]>()
    for (const spec of validSpecs) {
      const dimKey = axisSynonymKey(spec.name)
      const canonKey = `aspect_${spec.name.replace(/\s+/g, '_')}`
      const canonLower = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
      let foundVal = String((row[canonKey] ?? row[canonLower]) ?? '').trim()
      if (!foundVal && dimKey.startsWith('__dim')) {
        for (const [rk, rv] of Object.entries(row)) {
          if (!rk.startsWith('aspect_') || !rv) continue
          const an = rk.slice('aspect_'.length).replace(/_/g, ' ')
          if (axisSynonymKey(an) === dimKey) { foundVal = String(rv).trim(); break }
        }
      }
      if (foundVal) aspectsMap.set(spec.name, [vlLabel(spec.name, foundVal)])
    }
    // Non-variation aspects: operator item-specifics not in the synonym dict.
    // Skip known synonym dimensions (already added above under canonical name).
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('aspect_') || !v) continue
      const aspectName = k.slice('aspect_'.length).replace(/_/g, ' ')
      if (!aspectName) continue
      if (axisSynonymKey(aspectName).startsWith('__dim')) continue // handled above
      const label = isVarAxis(aspectName) ? nmLabel(aspectName) : aspectName
      if (!label) continue
      if (!aspectsMap.has(label)) aspectsMap.set(label, [vlLabel(aspectName, String(v))])
    }
    if (row.ean) aspectsMap.set('EAN', [String(row.ean)])
    if (row.mpn) aspectsMap.set('MPN', [String(row.mpn)])

    // eBay requires the market-localised brand aspect ("Marca" for IT/ES,
    // "Marke" for DE, "Marque" for FR, "Brand" for UK). Normalise any
    // existing brand-like key, or inject from Product.brand (_brand on row).
    const BRAND_ASPECT: Record<string, string> = {
      IT: 'Marca', ES: 'Marca', DE: 'Marke', FR: 'Marque', UK: 'Brand', GB: 'Brand',
    }
    const targetBrandAspect = BRAND_ASPECT[mp.toUpperCase()] ?? 'Brand'
    const BRAND_ALIASES = new Set(['marca', 'brand', 'marke', 'marque', 'marka'])
    const existingBrandKey = [...aspectsMap.keys()].find(k => BRAND_ALIASES.has(k.toLowerCase()))
    if (existingBrandKey && existingBrandKey !== targetBrandAspect) {
      // Rename e.g. "Brand" → "Marca" for EBAY_IT
      const v = aspectsMap.get(existingBrandKey)!
      aspectsMap.delete(existingBrandKey)
      aspectsMap.set(targetBrandAspect, v)
    } else if (!existingBrandKey) {
      // Prefer operator-typed brand column over DB value so the flat-file is
      // the authoritative source. Fall back to brandBySku (Product.brand) when
      // the column is blank.
      const brandVal = (row.brand as string | undefined ?? '').trim()
        || (brandBySku.get(sku) ?? '').trim()
      if (brandVal) aspectsMap.set(targetBrandAspect, [brandVal])
    }

    // Unconditional safety net: if the brand aspect is still absent after all
    // injection paths (DB lookup, rename, row data), force-set it. A missing
    // brand causes eBay error 25002 at publish_by_group. The brandBySku map
    // should have the value; 'Xavia' is the correct fallback for this system.
    if (!aspectsMap.has(targetBrandAspect)) {
      aspectsMap.set(targetBrandAspect, [brandBySku.get(sku) || 'Xavia'])
    }

    // eBay IT requires EAN as an item specific for clothing (error 25002 "Manca EAN").
    // When no real EAN exists, 'Does not apply' is the eBay-standard placeholder for
    // products that genuinely have no GTIN/barcode. Accepted by all EU marketplaces.
    const EAN_ALIASES = new Set(['ean', 'gtin', 'upc', 'isbn'])
    const existingEanKey = [...aspectsMap.keys()].find(k => EAN_ALIASES.has(k.toLowerCase()))
    if (!existingEanKey && !row.ean) {
      aspectsMap.set('EAN', ['Does not apply'])
    }

    const aspects = Object.fromEntries(aspectsMap)

    // FCF.3 — cap each variant at its FBM-available pool.
    const qty = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)
    // Diagnostic — per-variant qty trace (service has no fastify logger; use the
    // existing [ebay-push] console channel). Lightweight, no secrets.
    console.log('[ebay-push] qty-trace %j', { sku, rawItQty: row[`${mp.toLowerCase()}_qty`] ?? null, sharedQty: row.quantity ?? null, cappedQty: qty })

    // eBay LISTS a variation with some sizes at quantity 0 — those variants show as
    // out of stock; only the whole listing needs >=1 sellable variant. So we do NOT
    // skip a 0-qty variant (an earlier guard did, which wrongly aborted the entire
    // family whenever any size was out of stock). Publish it at its capToFbm qty.
    // safeQty clamps a non-finite/negative value to 0 so we never serialize `null`
    // into shipToLocationAvailability (eBay would reject that as 25004 "quantità non
    // valida"). The all-zero case is caught by the familyHasSellableVariant guard before
    // the group publish.
    const safeQty = computeSafeQty(qty)
    safeQtys.push(safeQty)

    // Use the colour-representative image set (same URLs for every variant of
    // the same colour). eBay deduplicates by URL, so all Black-size variants
    // end up showing the same 6 images in the carousel instead of 9×6=54.
    // Falls back to per-SKU images when no colour axis is detected.
    const imageUrls: string[] = []
    // P4 — a per-SKU override (operator pinned images to this exact variant) wins
    // over everything else.
    if (imageOverrideBySku?.get(sku)?.length) {
      imageUrls.push(...imageOverrideBySku.get(sku)!)
    } else if (pictureAxis) {
      const axisKey = `aspect_${pictureAxis.replace(/ /g, '_')}`
      const axisVal = String((row as Record<string, unknown>)[axisKey] ?? '').toLowerCase()
      // P3 — curated per-axis-value override (operator's master-gallery picks) wins
      // over the ProductImage-derived set; otherwise fall back to the rep-image set.
      if (axisVal && imageOverrideByColor?.get(axisVal)?.length) {
        imageUrls.push(...imageOverrideByColor.get(axisVal)!)
      } else if (axisVal && colorRepImages.has(axisVal)) {
        imageUrls.push(...colorRepImages.get(axisVal)!)
      }
    }
    // Fallback: per-SKU images (no colour axis, or this variant's colour value
    // wasn't found in the pre-pass map).
    if (imageUrls.length === 0) {
      for (let i = 1; i <= 6; i++) {
        const url = row[`image_${i}`] as string | undefined
        if (url) imageUrls.push(url)
      }
      if (imageUrls.length === 0) {
        imageUrls.push(...(imagesBySku.get(sku) ?? []).slice(0, 6))
      }
    }
    // eBay rejects inventory_item PUT with error 25717 when imageUrls is empty.
    if (imageUrls.length === 0) {
      results.push({ sku, market: mp, status: 'ERROR', message: 'No images found for this SKU — upload images via the image editor or populate image_1 in the flat-file before pushing' })
      continue
    }

    // Translate numeric conditionId (e.g. '1000') to eBay ConditionEnum ('NEW').
    // buildFlatRow stores the raw conditionId from platformAttributes; the
    // Inventory API rejects numeric strings.
    const rawCondition = String(row.condition ?? '')
    const condition = CONDITION_ID_TO_ENUM[rawCondition] ?? (rawCondition || 'NEW')

    const pkgSize = buildPackageWeightAndSize(row)
    const itemBody = {
      product: {
        title: row.title ?? sku,
        description: row.description ?? '',
        imageUrls,
        aspects,
        // eBay requires the EAN/GTIN identifier field to be explicitly set.
        // When no real barcode exists, 'Does not apply' is the correct value —
        // equivalent to selecting "Does not apply" in eBay's listing form.
        ean: row.ean ? [String(row.ean)] : ['Does not apply'],
        // MPN is required alongside EAN. Use 'Does not apply' when absent.
        mpn: row.mpn ? String(row.mpn) : 'Does not apply',
        // EFX P9d — attach the listing video (Media API videoId) when supplied.
        // Omitted otherwise so a videoId-less push never clears an existing video.
        ...(listingVideoIds ? { videoIds: listingVideoIds } : {}),
      },
      condition,
      availability: {
        shipToLocationAvailability: { quantity: safeQty },
      },
      ...(pkgSize ? { packageWeightAndSize: pkgSize } : {}),
    }

    // FFP.17 — the item write is just as exposed to the Seller Inventory
    // Service's flakiness (25604 "Prodotto non trovato — Riprova" / 25001 /
    // bare 5xx) as the publish step; give it a real retry budget.
    const itemUrl = `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
    const itemBodyJson = JSON.stringify(itemBody)
    const itemRes = await ebayFetchRetry(itemUrl, {
      method: 'PUT', headers, body: itemBodyJson,
    }, { retries: 4, baseDelayMs: 1500 })
    if (!itemRes.ok && itemRes.status !== 204) {
      const err = await itemRes.text().catch(() => '')

      // FM/25004 self-heal — eBay computes the live listing qty as
      // min(inventory_item.quantity, offer.availableQuantity). When this SKU
      // already has a PUBLISHED offer parked at availableQuantity:0 (from a prior
      // deactivate / out-of-stock offers-only push), that min() floors to 0 and the
      // inventory_item PUT is rejected with 25004 even though we sent quantity>0.
      // Step 3.5's offer-update (which would raise availableQuantity) runs AFTER this
      // PUT and is never reached — a deadlock. Break it here: raise the existing
      // offer's availableQuantity to the SAME capToFbm `qty` (anti-oversell cap
      // intact — we never send more than the FBM-available pool), then retry the PUT
      // once. Operator has accepted that this re-lists a previously-deactivated
      // variant that now has stock. On a fresh SKU (no offer) this is a clean no-op:
      // the GET-by-sku returns no offers → fall through to the normal ERROR path.
      // (The offer-ID cache + `region` aren't in scope until Step 3.5, so resolve
      // the offer on-demand — mirrors the Step 3.5 GET-by-sku at :1497-1506.)
      if (err.includes('"errorId":25004')) {
        let healDetail = 'no existing offer found'
        try {
          const getBySku = await fetch(
            `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
            { headers },
          )
          let offerId: string | null = null
          if (getBySku.ok) {
            const od = await getBySku.json().catch(() => ({})) as { offers?: Array<{ offerId?: string }> }
            offerId = od.offers?.[0]?.offerId ?? null
          }
          if (offerId) {
            // updateOffer is a FULL replacement: GET the complete offer so every
            // required field (marketplaceId, format, categoryId, listingPolicies,
            // merchantLocationKey, pricingSummary…) is echoed back unchanged, with
            // only availableQuantity raised.
            const getFull = await fetch(`${apiBase}/sell/inventory/v1/offer/${offerId}`, { headers })
            if (getFull.ok) {
              const fullOffer = await getFull.json().catch(() => ({})) as Record<string, unknown>
              const putRes = await ebayFetchRetry(
                `${apiBase}/sell/inventory/v1/offer/${offerId}`,
                { method: 'PUT', headers, body: JSON.stringify(withAvailableQuantity(fullOffer, Number(qty))) },
                { retries: 2, baseDelayMs: 1000 },
              )
              if (putRes.ok || putRes.status === 204) {
                // Offer quantity raised — retry the inventory_item PUT once; eBay's
                // min(inventory, offer) now clears our >0 quantity. Step 3.5 later
                // re-affirms availableQuantity=qty harmlessly.
                const retryItem = await ebayFetchRetry(
                  itemUrl,
                  { method: 'PUT', headers, body: itemBodyJson },
                  { retries: 2, baseDelayMs: 1000 },
                )
                if (retryItem.ok || retryItem.status === 204) {
                  results.push({ sku, market: mp, status: 'PUSHED', message: `inventory_item updated (recovered from 25004 — raised the parked offer to quantity ${Number(qty)})` })
                  continue
                }
                healDetail = `inventory_item PUT still ${retryItem.status} after raising the offer quantity`
              } else {
                const putErr = await putRes.text().catch(() => '')
                healDetail = `offer quantity-raise PUT ${putRes.status}: ${putErr.slice(0, 160)}`
              }
            } else {
              healDetail = `could not load the full offer (GET ${getFull.status})`
            }
          }
        } catch (e) {
          healDetail = `quantity-raise error: ${e instanceof Error ? e.message : String(e)}`
        }
        results.push({
          sku, market: mp, status: 'ERROR',
          message: `eBay already has an offer for this SKU at quantity 0 and the automatic quantity-raise failed (${healDetail}); revise the quantity in Seller Hub, then re-push.`,
        })
        continue
      }

      const isTransientItemErr = itemRes.status >= 500
        || err.includes('"errorId":25604') || err.includes('"errorId":25001')
      if (isTransientItemErr) transientItemFailures.push({ sku, url: itemUrl, body: itemBodyJson })
      results.push({
        sku, market: mp, status: 'ERROR',
        message: `inventory_item PUT ${itemRes.status} (we sent quantity=${Number(qty)}): ${err.slice(0, 300)}${isTransientItemErr ? ' — eBay inventory-service hiccup (their own message says retry); auto-retries ran, press Publish again in ~30s if this variant is still listed as blocked.' : ''}`,
      })
      continue
    }
    results.push({ sku, market: mp, status: 'PUSHED', message: 'inventory_item updated' })
  }

  // FFP.17 — second pass for transient item-write flakes: the SAME PUT
  // typically lands seconds later (verified live — an unchanged re-push
  // succeeded). Retry just the flaked variants once after a short settle
  // instead of aborting the whole family.
  if (transientItemFailures.length > 0) {
    console.log(`[ebay-push] FFP.17 — ${transientItemFailures.length} inventory_item PUT(s) hit transient eBay errors; settling 3s, then one more pass`)
    await new Promise((r) => setTimeout(r, 3000))
    for (const f of transientItemFailures) {
      try {
        const retryRes = await ebayFetchRetry(f.url, { method: 'PUT', headers, body: f.body }, { retries: 3, baseDelayMs: 2000 })
        if (retryRes.ok || retryRes.status === 204) {
          const idx = results.findIndex((r) => r.sku === f.sku && r.status === 'ERROR')
          if (idx >= 0) results[idx] = { sku: f.sku, market: mp, status: 'PUSHED', message: 'inventory_item updated (recovered after transient eBay error)' }
        }
      } catch { /* keep the original error result */ }
    }
  }

  // Guard (prevents eBay error 25701): every variant must have a created inventory_item
  // before the group PUT can reference it. If any variant was skipped/failed above (e.g.
  // "No images found for this SKU"), abort NOW with the real per-variant reason — otherwise
  // the group PUT references SKUs eBay never created (25701) AND that error overwrites every
  // row's message, hiding the true cause from the operator.
  const blockedVariants = results.filter(r => r.status === 'ERROR')
  if (blockedVariants.length > 0) {
    const blockers = blockedVariants.map(r => r.sku).join(', ')
    console.log('[ebay-push] aborting group PUT — %d/%d variant(s) not created on eBay: %s', blockedVariants.length, variantRows.length, blockers)
    return results.map(r => r.status === 'ERROR'
      ? r
      : { ...r, status: 'ERROR' as const, message: `Listing not published — first fix the blocked variant(s): ${blockers}` })
  }

  // eBay's Inventory Service has eventual consistency: a freshly PUT inventory_item
  // may not be visible to the offer endpoint for ~1s. Without this pause, rapid
  // sequential calls hit a 25604 "product not found" / 25001 internal error on
  // random SKUs (the exact SKU varies each run — it is eBay-side, not data-driven).
  await new Promise(r => setTimeout(r, 1500))

  // eBay needs >=1 sellable variant to publish a variation listing. If EVERY
  // variant resolved to 0 available, abort with a clear message rather than doing
  // the group PUT + publish only to hit eBay's misleading all-zero 25007.
  if (!familyHasSellableVariant(safeQtys)) {
    return variantRows.map(r => ({
      sku: r.sku as string, market: mp, status: 'ERROR' as const,
      message: 'Every variant is out of stock — eBay needs at least one sellable variation to publish this listing. Restock (or lower a buffer) on at least one size, then re-push.',
    }))
  }

  // Step 3: (specifications + imageVariesByAxes computed above before Step 1) Create/update the inventory_item_group.
  // variantSKUs is the correct field name (plain string array, not objects).
  // EFX P9e — prefer this market's resolved parent title (falls back to the
  // active-market parent row when the caller supplied none / the market has none).
  let parentTitle = String(opts?.parentContent?.title ?? parentRow.title ?? '').trim()
  if (!parentTitle) {
    // Flat-file rows built from buildFlatRow already fall back to product.name, but
    // when the eBay ChannelListing has an explicitly empty title (operator cleared it)
    // or the product has never been saved with a title, try the master product name.
    try {
      const masterProduct = await prisma.product.findFirst({
        where: { sku: parentRow.sku as string },
        select: { name: true },
      })
      parentTitle = masterProduct?.name?.trim() ?? ''
    } catch { /* ignore — fall through to the error below */ }
  }
  if (!parentTitle) {
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: 'Missing title on parent row — set a title before pushing' }))
  }
  // eBay group title max is 80 chars — truncate silently to avoid error 25718.
  if (parentTitle.length > 80) parentTitle = parentTitle.slice(0, 80)
  const groupImageUrls: string[] = []
  if (groupImageOverride && groupImageOverride.length > 0) {
    // P5 — operator-curated cover & common gallery wins over the parent-derived
    // mix (eBay allows up to 12 group photos; truncation is warned about via
    // warningsSink at the top of this function — EFX P5).
    groupImageUrls.push(...groupImageOverride.slice(0, EBAY_VARIATION_IMAGE_MAX))
  } else {
    for (let i = 1; i <= 6; i++) {
      const url = parentRow[`image_${i}`] as string | undefined
      if (url) groupImageUrls.push(url)
    }
  }
  // If parent has no direct images, use the first color variant's images as the
  // group representative. Using ALL variant images (both colors) creates too many
  // images in the eBay listing carousel. The per-variant inventory_items already
  // carry their own color-specific images (shown when buyer selects a color).
  if (groupImageUrls.length === 0) {
    // Try the first variant's full image set (ProductImage rows preferred)
    const firstVariantSku = variantRows[0]?.sku as string | undefined
    const firstVariantImages = firstVariantSku ? (imagesBySku.get(firstVariantSku) ?? []) : []
    groupImageUrls.push(...firstVariantImages.slice(0, 6))
    // Fallback: use the colour-representative image set built in the pre-pass
    if (groupImageUrls.length === 0 && colorRepImages.size > 0) {
      const firstRepImages = colorRepImages.values().next().value as string[] ?? []
      groupImageUrls.push(...firstRepImages.slice(0, 6))
    }
    // Last resort: aggregate unique URLs from all variants
    if (groupImageUrls.length === 0) {
      const seen = new Set<string>()
      for (const urls of imagesBySku.values()) {
        for (const u of urls) {
          if (u && !seen.has(u) && groupImageUrls.length < 6) {
            seen.add(u); groupImageUrls.push(u)
          }
        }
      }
    }
  }
  // eBay requires imageUrls on the group — hard-fail if still empty so the
  // operator gets a clear message rather than a cryptic eBay error 25717.
  if (groupImageUrls.length === 0) {
    return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'ERROR' as const, message: 'No images found for this group — upload images via the image editor or populate image_1 on the parent row before pushing' })
  }

  // eBay validates Brand/Marca at the GROUP level at publish_by_inventory_item_group.
  // Setting it only on the individual inventory_items is not enough.
  const GROUP_BRAND_ASPECT: Record<string, string> = {
    IT: 'Marca', ES: 'Marca', DE: 'Marke', FR: 'Marque', UK: 'Brand', GB: 'Brand',
  }
  const groupBrandKey = GROUP_BRAND_ASPECT[mp.toUpperCase()] ?? 'Brand'
  const groupBrandVal =
    (parentRow.brand as string | undefined ?? '').trim() ||
    brandBySku.get(parentRow.sku as string) ||
    [...brandBySku.values()][0] ||
    'Xavia'

  const groupBody = {
    inventoryItemGroupKey: groupKey,
    title: parentTitle,
    // EFX P9e — this market's resolved parent description (falls back to the row).
    description: opts?.parentContent?.description ?? parentRow.description ?? '',
    imageUrls: groupImageUrls,
    variantSKUs: variantRows.map(r => r.sku as string),
    variesBy: {
      // FFP.15 — omitted entirely in shared-gallery mode (single-colour family):
      // the listing then shows ONE gallery for every variation.
      ...(imageVariesByAxes.length > 0 ? { aspectsImageVariesBy: imageVariesByAxes } : {}),
      specifications,
    },
    aspects: {
      [groupBrandKey]: [groupBrandVal],
    },
  }

  // eBay error 25703: one or more SKUs are already members of a DIFFERENT group —
  // typically the old UUID-based group from before we switched to parent-SKU keys.
  // eBay won't let us DELETE an active group (it has published offers pointing to it).
  // Strategy: update the EXISTING group IN PLACE using its old key so all content
  // fixes (specs dedup, image cap, correct title) land immediately on the live listing.
  // The groupKey stays as the old UUID for now — the operator can migrate to the parent
  // SKU key by ending the listing in eBay Seller Hub, then re-pushing.
  let effectiveGroupKey = groupKey

  console.log('[ebay-push][debug] group_put groupKey=%s variesBy=%j aspects=%j variantCount=%d',
    effectiveGroupKey, groupBody.variesBy, groupBody.aspects, variantRows.length)
  let groupRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(effectiveGroupKey)}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...groupBody, inventoryItemGroupKey: effectiveGroupKey }),
  })

  // Read the body ONCE — a Response stream can only be consumed once. Reusing this
  // single variable everywhere below prevents the swallowed-error bug where a second
  // `.text()` on the same response returned '' and hid eBay's real 400 reason from
  // operators (the "inventory_item_group PUT 400:" with nothing after it).
  let groupErrText = groupRes.ok ? '' : await groupRes.text().catch(() => '')

  if (!groupRes.ok && groupRes.status === 400) {
    let errJson: { errors?: Array<{ errorId?: number; message?: string }> } = {}
    try { errJson = JSON.parse(groupErrText) } catch { /* raw text fallback */ }
    const firstErr = errJson.errors?.[0]
    const is25703 = firstErr?.errorId === 25703 || groupErrText.includes('"errorId":25703')
    if (is25703) {
      // Extract the existing groupId from the error message text ("...groupId: abc123")
      const groupIdMatch = (firstErr?.message ?? groupErrText).match(/groupId[:\s]+([a-zA-Z0-9]+)/)
      const oldGroupId = groupIdMatch?.[1]
      if (oldGroupId && oldGroupId !== effectiveGroupKey) {
        // Update the existing group in place (preserving its old key on eBay)
        effectiveGroupKey = oldGroupId
        console.log(`[ebay-push] 25703 — updating existing group ${effectiveGroupKey} in place`)
        groupRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(effectiveGroupKey)}`, {
          method: 'PUT', headers, body: JSON.stringify({ ...groupBody, inventoryItemGroupKey: effectiveGroupKey }),
        })
        groupErrText = groupRes.ok ? '' : await groupRes.text().catch(() => '') // re-read the retry's body
      }
    }
    // If still not ok after 25703 fallback (or other error), fall through to error return below
  }

  // FFP.15/16 — shared-gallery fallback: if eBay rejected the group WITHOUT
  // aspectsImageVariesBy, retry once with the default axis. Images stay
  // uniform across variations either way (every variant carries the same
  // gallery), so the buyer experience is identical.
  if (!groupRes.ok && groupRes.status === 400 && imageVariesByAxes.length === 0) {
    const fallbackAxes = (validSpecs.slice(0, 1).map(e => e.name)).filter(Boolean)
    if (fallbackAxes.length > 0) {
      console.log(`[ebay-push] FFP.15 — group rejected without aspectsImageVariesBy; retrying with [${fallbackAxes.join(', ')}]`)
      groupRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(effectiveGroupKey)}`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          ...groupBody,
          inventoryItemGroupKey: effectiveGroupKey,
          variesBy: { aspectsImageVariesBy: fallbackAxes, specifications },
        }),
      })
      groupErrText = groupRes.ok ? '' : await groupRes.text().catch(() => '')
    }
  }

  if (!groupRes.ok && groupRes.status !== 204) {
    console.log('[ebay-push][debug] inventory_item_group PUT FAILED status=%d body=%s', groupRes.status, groupErrText.slice(0, 2000))
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `inventory_item_group PUT ${groupRes.status}: ${groupErrText.slice(0, 500) || '(eBay returned an empty 400 body — check images/aspects on all variants)'}` }))
  }

  // Step 3.5: Create/update one offer per variant.
  // Rules for variation member offers (eBay Inventory API):
  //   • listingDescription MUST be omitted — it comes from the group description;
  //     including it overwrites the group description on the live listing.
  //   • inventoryItemGroupKey is NOT a valid offer field — group linkage is
  //     established exclusively via variantSKUs in the group PUT above.
  //   • availableQuantity is required before publishOfferByInventoryItemGroup.
  //   • merchantLocationKey (top-level on offer) is required so eBay can resolve
  //     Item.Country; absence causes error 25002 at publish.
  //
  // Policy waterfall (mirrors ebay-publish.adapter.ts):
  //   1. Per-row flat-file columns (operator override)
  //   2. ChannelConnection.connectionMetadata.ebayPolicies (account default)
  //   3. ebayAccountService.getSnapshot() — live eBay Account + Inventory API
  //   Hard-fail if any required field is still missing after all three tiers.
  const configured = ((connectionMeta.ebayPolicies ?? {}) as {
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    merchantLocationKey?: string
  })
  let fulfillmentPolicyId = (parentRow.fulfillment_policy_id as string | undefined) || configured.fulfillmentPolicyId || ''
  let paymentPolicyId     = (parentRow.payment_policy_id     as string | undefined) || configured.paymentPolicyId     || ''
  let returnPolicyId      = (parentRow.return_policy_id      as string | undefined) || configured.returnPolicyId      || ''
  let merchantLocationKey = (parentRow.merchant_location_key as string | undefined) || configured.merchantLocationKey || ''

  // MARKET-SPECIFIC policy guard. eBay business policies belong to ONE marketplace; a
  // policy id from another market (e.g. a DE default applied to an IT offer) is the
  // classic 25007 "invalid shipping policy" cause — often surfacing as a mixed IT/DE
  // error. Reconcile against THIS market's policies (snapshot is per-market, cached
  // 5min) and REPLACE any id that isn't in this market's list — not just missing ones.
  try {
    const snapshot = await ebayAccountService.getSnapshot(connectionId, marketplaceId)
    const fSet = new Set(snapshot.fulfillmentPolicies.map((p) => p.id))
    const pSet = new Set(snapshot.paymentPolicies.map((p) => p.id))
    const rSet = new Set(snapshot.returnPolicies.map((p) => p.id))
    if (!fulfillmentPolicyId || !fSet.has(fulfillmentPolicyId)) fulfillmentPolicyId = snapshot.fulfillmentPolicies[0]?.id ?? ''
    if (!paymentPolicyId     || !pSet.has(paymentPolicyId))     paymentPolicyId     = snapshot.paymentPolicies[0]?.id     ?? ''
    if (!returnPolicyId      || !rSet.has(returnPolicyId))      returnPolicyId      = snapshot.returnPolicies[0]?.id      ?? ''
    if (!merchantLocationKey) merchantLocationKey = snapshot.locations[0]?.key ?? ''
  } catch (err) {
    // FFP.12 — NEVER proceed with UNVERIFIED policy ids. The old fallback
    // ("keep whatever ids we have") is exactly how another market's policy
    // got written onto DE offers — creating unpublishable drafts that then
    // failed EVERY publish of the family with a mixed-locale 25007. Policies
    // are per-marketplace; if we can't verify them for THIS market, stop.
    const msg = `Couldn't verify ${mp} business policies (${err instanceof Error ? err.message : String(err)}) — refusing to write unverified policy ids onto ${mp} offers (a wrong-market policy is the classic persistent 25007). Retry in a minute.`
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  const missing: string[] = []
  if (!merchantLocationKey) missing.push('merchantLocation (configure in eBay Seller Hub > Inventory > Locations)')
  if (!fulfillmentPolicyId) missing.push('fulfillmentPolicy')
  if (!returnPolicyId)      missing.push('returnPolicy')
  if (missing.length > 0) {
    const msg = `Missing required seller settings: ${missing.join(', ')}`
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  const currency = mp === 'UK' ? 'GBP' : 'EUR'
  const catId    = (parentRow.category_id as string | undefined) ?? ''
  // EFX P9a/P9f — shared (parent-level) offer terms, resolved once for the family.
  // EFX P9a — Best Offer is intentionally NOT built for a variation group: eBay
  // rejects Best Offer on any SKU that belongs to an inventory item group (error
  // 25737 "La Proposta d'acquisto non è consentita…"). Surface it as a warning
  // (warn-never-block) so the operator knows their Best Offer setting was ignored.
  if (parentRow.best_offer_enabled && opts?.warningsSink) {
    opts.warningsSink.push('Best Offer (Trattativa) isn’t supported on multi-variation eBay listings — it was ignored for this family.')
  }
  const quantityLimitPerBuyer = resolveQuantityLimitPerBuyer(parentRow)

  // Seed from Step-1 errors: if any inventory_item PUT already failed, skip
  // publish_by_group — eBay would reject it because the group's variantSKUs
  // includes SKUs without valid inventory_items.
  const region = mp === 'UK' ? 'GB' : mp
  const variantSkusList = variantRows.map(r => r.sku as string).filter(Boolean)
  const cachedOfferIds = await loadCachedOfferIds(variantSkusList, region, marketplaceId)
  const collectedOfferIds = new Map<string, string>()
  let anyOfferFailed = results.some(r => r.status === 'ERROR')
  for (const row of variantRows) {
    const sku   = row.sku as string
    const price = Number(row[`${mp.toLowerCase()}_price`] ?? row.price ?? 0)
    const qty   = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    if (!price || price <= 0) {
      if (opts?.skipOffersOnNoPrice) {
        // Images-only push: skip offer update without blocking the group publish.
        continue
      }
      const msg = `No ${mp} price set for ${sku} — enter a price before pushing`
      const idx = results.findIndex(r => r.sku === sku)
      if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
      else results.push({ sku, market: mp, status: 'ERROR', message: msg })
      anyOfferFailed = true
      continue
    }

    // EFX P9e — this market's resolved (snapshot-authoritative) parent subtitle,
    // falling back to the active-market parent row when the caller supplied none.
    const subtitle = (opts?.parentContent?.subtitle ?? (parentRow.subtitle as string | undefined))?.trim() ?? ''
    const offerBody: Record<string, unknown> = {
      sku,
      marketplaceId,
      format: 'FIXED_PRICE',
      // listingDescription intentionally omitted — comes from group description
      ...(catId ? { categoryId: catId } : {}),
      ...(subtitle ? { subtitle } : {}),
      availableQuantity: qty,
      pricingSummary: { price: { value: price.toFixed(2), currency } },
      listingPolicies: {
        ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
        ...(paymentPolicyId     ? { paymentPolicyId }     : {}),
        ...(returnPolicyId      ? { returnPolicyId }      : {}),
        // EFX P9a — Best Offer OMITTED for variation groups: eBay forbids it on a
        // SKU that belongs to an inventory item group (error 25737).
      },
      // merchantLocationKey (top-level, not inside listingPolicies) tells eBay
      // the seller's location so it can resolve Item.Country for the listing.
      ...(merchantLocationKey ? { merchantLocationKey } : {}),
      quantityLimitPerBuyer,
    }

    let offerId: string | null = cachedOfferIds.get(sku) ?? null
    if (!offerId) {
      const getOfferRes = await fetch(
        `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
        { headers: headers },
      )
      if (getOfferRes.ok) {
        const od = await getOfferRes.json() as { offers?: Array<{ offerId: string }> }
        offerId = od.offers?.[0]?.offerId ?? null
      }
    }

    if (offerId) {
      const upd = await fetch(`${apiBase}/sell/inventory/v1/offer/${offerId}`, {
        method: 'PUT', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!upd.ok) {
        const err = await upd.text().catch(() => '')
        const msg = `offer update ${upd.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
      collectedOfferIds.set(sku, offerId)
    } else {
      const cre = await fetch(`${apiBase}/sell/inventory/v1/offer`, {
        method: 'POST', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!cre.ok) {
        const err = await cre.text().catch(() => '')
        const msg = `offer create ${cre.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
      const creBody = await cre.json().catch(() => ({})) as { offerId?: string }
      if (creBody.offerId) collectedOfferIds.set(sku, creBody.offerId)
    }
  }

  // If any offer failed, skip publish and return per-variant results so the
  // operator can see exactly which SKUs need attention.
  if (anyOfferFailed) return results

  // Step 4: Publish the variation listing.
  // Use effectiveGroupKey (may be old UUID if 25703 triggered in-place update).
  console.log('[ebay-push][debug] publish_by_group groupKey=%s specs=%j imageVariesBy=%j',
    effectiveGroupKey, specifications, imageVariesByAxes)
  let publishRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers,
    body: JSON.stringify({ inventoryItemGroupKey: effectiveGroupKey, marketplaceId }),
    // publish_by_group is the step most exposed to eBay's eventual consistency — 25604
    // "product not found" fires against inventory_items written seconds earlier. eBay
    // itself says "Riprova" (retry), so give it a much bigger budget than the default
    // ~14s: 6 attempts, ~2+4+8+10+10 ≈ 34s of capped backoff before giving up.
  }, { retries: 6, baseDelayMs: 2000 })
  // FFP.14 — market independence, self-healing: when the publish is poisoned by
  // UNPUBLISHED drafts on OTHER marketplaces (eBay validates every offer on the
  // group's SKUs, drafts included), the drafts are auto-removed and the publish
  // retried once. True per-market isolation isn't possible at eBay's API level
  // (SKU/item/group are account-scoped) — so Nexus removes the coupling itself.
  let healedByOrphanCleanup = false

  if (!publishRes.ok) {
    const err = await publishRes.text().catch(() => '')
    console.log('[ebay-push][debug] publish_by_group FAILED status=%d body=%s', publishRes.status, err.slice(0, 2000))
    // 25604/25001 are transient eBay-side consistency errors — say so plainly instead of
    // a raw 500, so the operator knows to retry rather than think the data is broken.
    const isTransient = err.includes('"errorId":25604') || err.includes('"errorId":25001')
    // publish_by_group reports a GROUP error without naming WHICH variant's offer is bad —
    // one broken (5xx), missing, unpublished, or policy-less/location-less offer fails the
    // whole group. Probe each variant's offer to pinpoint the culprit(s) so the operator
    // gets an actionable "variant X: <problem>" instead of an opaque group 25007. (Only on
    // non-transient failures — a transient error is about eBay sync, not a specific offer.)
    let detail = ''
    if (!isTransient) {
      const issues: string[] = []
      let offersSeen = 0
      let allZeroQty = true
      for (const r of variantRows) {
        const s = String(r.sku ?? '')
        if (!s) continue
        try {
          const or = await fetch(`${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(s)}&marketplace_id=${marketplaceId}`, { headers })
          if (!or.ok) { issues.push(`${s}: offer GET ${or.status}`); allZeroQty = false; continue }
          const oj = await or.json() as { offers?: Array<{ status?: string; availableQuantity?: number; listingPolicies?: { fulfillmentPolicyId?: string }; merchantLocationKey?: string }> }
          const o = oj.offers?.[0]
          if (!o) { issues.push(`${s}: no offer`); allZeroQty = false }
          else if (!o.listingPolicies?.fulfillmentPolicyId) { issues.push(`${s}: no fulfillment policy`); allZeroQty = false }
          else if (!o.merchantLocationKey) { issues.push(`${s}: no merchant location`); allZeroQty = false }
          else {
            offersSeen++
            if (Number(o.availableQuantity ?? 0) > 0) allZeroQty = false
          }
        } catch { issues.push(`${s}: offer probe failed`); allZeroQty = false }
      }
      // FFP.7 — every-variant-at-zero: eBay cannot (re)publish a variation
      // listing with no purchasable variant, and reports it as a misleading
      // 25007 "invalid shipping" error. Verified live 2026-07-06 (all offers
      // valid, policies valid — publish only fails while every qty is 0).
      if (issues.length === 0 && offersSeen > 0 && allZeroQty) {
        detail = ` Every variant's quantity is 0 — eBay can't (re)publish a listing with no purchasable variant (its 25007 message is misleading). Set a quantity ≥ 1 on at least one variant (Quick update is enough), then re-push.`
      } else if (issues.length === 0) {
        // FFP.12 — cross-market orphan sweep. publish_by_group validates EVERY
        // offer attached to the group's SKUs — including UNPUBLISHED drafts on
        // OTHER marketplaces. A draft carrying a wrong-market policy fails the
        // whole publish with a mixed-locale 25007 (the foreign-language detail
        // names the draft's marketplace). Verified live 2026-07-06: ten
        // unpublished DE drafts with an IT policy blocked every IT publish.
        const orphans: string[] = []
        const otherMkts = MARKETS.map((m) => toMarketplaceId(m)).filter((id) => id !== marketplaceId)
        for (const otherId of otherMkts) {
          const otherHeaders = { ...headers, 'X-EBAY-C-MARKETPLACE-ID': otherId, 'Content-Language': toListingLanguage(otherId), 'Accept-Language': toListingLanguage(otherId) }
          // Bounded probe: the first hit per market is enough to name the culprit.
          for (const r of variantRows.slice(0, 4)) {
            const s = String(r.sku ?? '')
            if (!s) continue
            try {
              const or = await fetch(`${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(s)}&marketplace_id=${otherId}`, { headers: otherHeaders })
              if (!or.ok) continue
              const oj = await or.json() as { offers?: Array<{ status?: string }> }
              if (oj.offers?.[0]?.status === 'UNPUBLISHED') { orphans.push(otherId); break }
            } catch { /* best-effort probe */ }
          }
        }
        if (orphans.length > 0) {
          // FFP.14 — auto-heal: delete the poison drafts (UNPUBLISHED only,
          // never a live offer — a draft is recreatable by simply pushing that
          // market properly later) and retry the publish once.
          let removed = 0
          for (const otherId of orphans) {
            const otherHeaders = { ...headers, 'X-EBAY-C-MARKETPLACE-ID': otherId, 'Content-Language': toListingLanguage(otherId), 'Accept-Language': toListingLanguage(otherId) }
            for (const r of variantRows) {
              const s = String(r.sku ?? '')
              if (!s) continue
              try {
                const or = await fetch(`${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(s)}&marketplace_id=${otherId}`, { headers: otherHeaders })
                if (!or.ok) continue
                const oj = await or.json() as { offers?: Array<{ offerId?: string; status?: string }> }
                const o = oj.offers?.[0]
                if (o?.offerId && o.status === 'UNPUBLISHED') {
                  const dr = await fetch(`${apiBase}/sell/inventory/v1/offer/${o.offerId}`, { method: 'DELETE', headers: otherHeaders })
                  if (dr.ok || dr.status === 204) removed++
                }
              } catch { /* best-effort cleanup */ }
            }
          }
          console.log(`[ebay-push] FFP.14 — removed ${removed} unpublished cross-market draft(s) on ${orphans.join(', ')}; retrying publish`)
          if (removed > 0) {
            const retryRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
              method: 'POST', headers,
              body: JSON.stringify({ inventoryItemGroupKey: effectiveGroupKey, marketplaceId }),
            }, { retries: 3, baseDelayMs: 2000 })
            if (retryRes.ok) {
              publishRes = retryRes
              healedByOrphanCleanup = true
            }
          }
          detail = healedByOrphanCleanup ? '' : ` Removed ${removed} unpublished cross-market draft offer(s) on ${orphans.join(', ')} but the publish still failed — re-push in ~30s; if it persists, check that market's policies in Seller Hub.`
        } else {
          detail = ` All ${variantRows.length} variant offers look valid (policy + merchant location present), so this is very likely a transient eBay-side error — wait ~30s and re-push.`
        }
      } else {
        detail = ` Problem offer(s): ${issues.slice(0, 8).join('; ')} — fix these, then re-push.`
      }
    }
    // FFP.14 — a successful orphan-cleanup retry falls through to the normal
    // success path below (publishRes was reassigned to the OK retry response).
    if (!healedByOrphanCleanup) {
      const pubMsg = isTransient
        ? `eBay is still syncing this listing on its side (transient ${publishRes.status}/25604 after ~34s of retries) — the policies/offer were sent but eBay couldn't confirm the items in time. Wait ~30s and re-push; it almost always lands on the next try.`
        : `publish_by_group ${publishRes.status}: ${err.slice(0, 600)}.${detail}`
      // Preserve per-SKU step-1 errors — only stamp publish failure on rows that
      // made it through to the offer stage (status 'PUSHED'). Overwriting step-1
      // errors with "Manca Marca" masks the real root cause (e.g. imageUrls empty).
      return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'ERROR' as const, message: pubMsg })
    }
  }

  const pubData = await publishRes.json().catch(() => ({})) as { listingId?: string }
  let listingId = pubData.listingId
  if (collectedOfferIds.size > 0) void saveOfferIds(collectedOfferIds, region, marketplaceId)
  // AXIS_STRUCTURE_CHANGE write — record the axes that just went live for THIS market.
  // Reached only past the publish-failure early-return above, so it captures a real
  // publish. Merge-only into the parent listing's platformAttributes (never clobbers
  // __offerIds); fire-and-forget like saveOfferIds — server metadata, not sent to eBay.
  void saveLastPublishedAxes(parentRow.sku as string, mp, marketplaceId, specifications.map(s => s.name))

  // Re-publishing an already-active listing returns no listingId in the publish body.
  // Fall back to GET offer for the first variant — the offer's listing.listingId is
  // always populated once the group has been published at least once.
  if (!listingId && variantRows.length > 0) {
    try {
      const firstSku = variantRows[0].sku as string
      const offerLookup = await fetch(
        `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(firstSku)}&marketplace_id=${marketplaceId}`,
        { headers },
      )
      if (offerLookup.ok) {
        const offerData = await offerLookup.json().catch(() => ({})) as { offers?: Array<{ listing?: { listingId?: string } }> }
        listingId = offerData.offers?.[0]?.listing?.listingId
      }
    } catch { /* non-fatal — listingId stays undefined */ }
  }

  // Write the shared listingId back to all variant ChannelListings AND the parent.
  // _productId may be stripped in the frontend round-trip; fall back to SKU lookup.
  let productIds = variantRows.map(r => r._productId as string).filter(Boolean)
  let parentProductId: string | null = null
  if (productIds.length === 0) {
    const skus = variantRows.map(r => r.sku as string).filter(Boolean)
    if (skus.length > 0) {
      const prods = await prisma.product.findMany({
        where: { sku: { in: skus }, deletedAt: null },
        select: { id: true, parentId: true },
      }).catch(() => [])
      productIds = prods.map(p => p.id)
      parentProductId = prods.find(p => p.parentId != null)?.parentId ?? null
    }
  } else {
    // Resolve parent from the first child record (non-fatal).
    const first = await prisma.product.findFirst({
      where: { id: productIds[0], deletedAt: null },
      select: { parentId: true },
    }).catch(() => null)
    parentProductId = first?.parentId ?? null
  }
  // Include the parent product ID so its ChannelListing transitions to ACTIVE too.
  const allIds = [...new Set([...productIds, ...(parentProductId ? [parentProductId] : [])])]
  if (allIds.length > 0) {
    try {
      await prisma.channelListing.updateMany({
        where: { productId: { in: allIds }, channel: 'EBAY', region },
        // Only set externalListingId when we have a fresh value from the publish response.
        // Re-publishing an existing listing returns no new listingId — don't overwrite with null.
        data: { ...(listingId ? { externalListingId: listingId } : {}), listingStatus: 'ACTIVE', offerActive: true },
      })
      // Seed any missing parent/child ChannelListing rows for this market so the
      // cockpit and status views reflect the live eBay state going forward.
      const existing = await prisma.channelListing.findMany({
        where: { productId: { in: allIds }, channel: 'EBAY', region },
        select: { productId: true },
      })
      const existingSet = new Set(existing.map(e => e.productId))
      const missing = allIds.filter(id => !existingSet.has(id))
      if (missing.length > 0) {
        // Persist the price we just sent to eBay so a reload doesn't show 0.
        const pricePrefix = mp.toLowerCase()
        const priceByProductId = new Map<string, number>()
        for (const r of variantRows) {
          const pid = r._productId as string | undefined
          if (!pid) continue
          const p = Number(r[`${pricePrefix}_price`] ?? r.price ?? 0)
          if (p > 0) priceByProductId.set(pid, p)
        }
        await prisma.channelListing.createMany({
          data: missing.map(productId => ({
            productId,
            channel: 'EBAY',
            channelMarket: `EBAY_${region}`,
            region,
            marketplace: region,
            listingStatus: 'ACTIVE' as const,
            ...(listingId ? { externalListingId: listingId } : {}),
            ...(priceByProductId.has(productId) ? { price: priceByProductId.get(productId) } : {}),
          })),
          skipDuplicates: true,
        })
      }
      const activated = await prisma.channelListing.findMany({
        where: { productId: { in: allIds }, channel: 'EBAY', region },
        select: { id: true },
      })
      void syncActivatedListings(activated.map(l => l.id))
    } catch (e) {
      // Previously swallowed silently — which hid that the ItemID/status never persisted.
      // Non-fatal (the listing is live on eBay) but MUST be visible so a broken write-back
      // surfaces instead of looking like "the fields keep vanishing".
      console.error('[ebay-push] listing write-back FAILED (externalListingId/status NOT saved):', e instanceof Error ? e.message : e)
    }
  }

  // Preserve step-1 errors even on successful publish — a SKU that failed
  // inventory_item PUT was not actually pushed, even though the group published.
  return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'PUSHED' as const, message: 'pushed as variation group', itemId: listingId })
}

// ── P2: Offer-only fast path ───────────────────────────────────────────
// Updates price + quantity on existing eBay offers without touching inventory
// items, item groups, or triggering re-publish. Price changes go live instantly.

export async function pushOffersOnly(
  rows: Array<Record<string, unknown>>,
  mp: string,
  token: string,
  connectionId: string,
  connectionMeta: Record<string, unknown>,
  apiBase: string,
  marketplaceId: string,
  capToFbm: (pid: string | undefined, sku: string, requested: number, market?: string) => number,
): Promise<Array<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string }>> {
  const region = mp === 'UK' ? 'GB' : mp
  const currency = mp === 'UK' ? 'GBP' : 'EUR'
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': toListingLanguage(marketplaceId),
    'Accept-Language': toListingLanguage(marketplaceId),
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
  }

  const parentRow = rows.find(r => r._isParent === true) ?? rows[0] ?? {}
  const variantRows = rows.filter(r => r._isParent !== true)

  const configured = ((connectionMeta.ebayPolicies ?? {}) as {
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    merchantLocationKey?: string
  })
  let fulfillmentPolicyId = (parentRow.fulfillment_policy_id as string | undefined) || configured.fulfillmentPolicyId || ''
  let paymentPolicyId     = (parentRow.payment_policy_id     as string | undefined) || configured.paymentPolicyId     || ''
  let returnPolicyId      = (parentRow.return_policy_id      as string | undefined) || configured.returnPolicyId      || ''
  let merchantLocationKey = (parentRow.merchant_location_key as string | undefined) || configured.merchantLocationKey || ''

  // MARKET-SPECIFIC policy guard. eBay business policies belong to ONE marketplace; a
  // policy id from another market (e.g. a DE default applied to an IT offer) is the
  // classic 25007 "invalid shipping policy" cause — often surfacing as a mixed IT/DE
  // error. Reconcile against THIS market's policies (snapshot is per-market, cached
  // 5min) and REPLACE any id that isn't in this market's list — not just missing ones.
  try {
    const snapshot = await ebayAccountService.getSnapshot(connectionId, marketplaceId)
    const fSet = new Set(snapshot.fulfillmentPolicies.map((p) => p.id))
    const pSet = new Set(snapshot.paymentPolicies.map((p) => p.id))
    const rSet = new Set(snapshot.returnPolicies.map((p) => p.id))
    if (!fulfillmentPolicyId || !fSet.has(fulfillmentPolicyId)) fulfillmentPolicyId = snapshot.fulfillmentPolicies[0]?.id ?? ''
    if (!paymentPolicyId     || !pSet.has(paymentPolicyId))     paymentPolicyId     = snapshot.paymentPolicies[0]?.id     ?? ''
    if (!returnPolicyId      || !rSet.has(returnPolicyId))      returnPolicyId      = snapshot.returnPolicies[0]?.id      ?? ''
    if (!merchantLocationKey) merchantLocationKey = snapshot.locations[0]?.key ?? ''
  } catch (err) {
    // FFP.12 — NEVER proceed with UNVERIFIED policy ids. The old fallback
    // ("keep whatever ids we have") is exactly how another market's policy
    // got written onto DE offers — creating unpublishable drafts that then
    // failed EVERY publish of the family with a mixed-locale 25007. Policies
    // are per-marketplace; if we can't verify them for THIS market, stop.
    const msg = `Couldn't verify ${mp} business policies (${err instanceof Error ? err.message : String(err)}) — refusing to write unverified policy ids onto ${mp} offers (a wrong-market policy is the classic persistent 25007). Retry in a minute.`
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  if (!merchantLocationKey) {
    const msg = 'Missing merchantLocation — configure in eBay Seller Hub > Inventory > Locations'
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  // EFX P9a/P9f — shared (parent-level) offer terms, resolved once for the family.
  const offerWarnings: string[] = []
  const bestOfferTerms = buildBestOfferTerms(parentRow, currency, offerWarnings)
  const quantityLimitPerBuyer = resolveQuantityLimitPerBuyer(parentRow)
  if (offerWarnings.length > 0) console.warn('[ebay-push] offers-only best-offer:', offerWarnings.join(' | '))

  const variantSkusList = variantRows.map(r => r.sku as string).filter(Boolean)

  // L5 — Best Offer must NEVER be sent on a SKU that belongs to an eBay inventory
  // item group: eBay rejects it with error 25737. The old gate (`variantRows.length
  // > 1`) still leaked Best Offer when the operator selected a SINGLE variant of a
  // family for an offers-only push — that one SKU is still a group member on eBay.
  //
  // Group membership isn't returned in this offers-only scope, so we use the SAFE
  // proxy: a SKU is treated as a group member unless it is a genuinely standalone,
  // single-SKU listing. Heuristic (unknown ⇒ omit — the safe default):
  //   • the push must be exactly ONE non-parent variant with no parent container
  //     row (a real family push carries a parent and/or >1 variant), AND
  //   • that sole product must be neither a child (parentId set) nor a parent with
  //     children — i.e. it is not part of any variation family in our catalog.
  // Only then do we send Best Offer; every family (or unknown) push omits it.
  let bestOfferEligible = false
  if (variantRows.length === 1 && !rows.some(r => r._isParent === true)) {
    const soleSku = variantRows[0]?.sku as string | undefined
    if (soleSku) {
      try {
        const p = await prisma.product.findFirst({
          where: { sku: soleSku },
          select: { parentId: true, _count: { select: { children: true } } },
        })
        bestOfferEligible = !!p && p.parentId == null && (p._count?.children ?? 0) === 0
      } catch {
        bestOfferEligible = false // unknown → safe default: omit Best Offer
      }
    }
  }

  const cachedOfferIds = await loadCachedOfferIds(variantSkusList, region, marketplaceId)
  const collectedOfferIds = new Map<string, string>()
  const results: Array<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string }> = []

  for (const row of variantRows) {
    const sku   = row.sku as string
    const price = Number(row[`${mp.toLowerCase()}_price`] ?? row.price ?? 0)
    const qty   = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    if (!price || price <= 0) {
      results.push({ sku, market: mp, status: 'ERROR', message: `No ${mp} price set for ${sku}` })
      continue
    }

    let offerId: string | null = cachedOfferIds.get(sku) ?? null
    if (!offerId) {
      const getRes = await fetch(
        `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
        { headers },
      )
      if (getRes.ok) {
        const od = await getRes.json() as { offers?: Array<{ offerId: string }> }
        offerId = od.offers?.[0]?.offerId ?? null
      }
    }

    if (!offerId) {
      results.push({ sku, market: mp, status: 'ERROR', message: `No existing offer for ${sku} on ${mp} — run Full Publish first` })
      continue
    }

    const offerBody: Record<string, unknown> = {
      sku,
      marketplaceId,
      format: 'FIXED_PRICE',
      availableQuantity: qty,
      pricingSummary: { price: { value: price.toFixed(2), currency } },
      listingPolicies: {
        ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
        ...(paymentPolicyId     ? { paymentPolicyId }     : {}),
        ...(returnPolicyId      ? { returnPolicyId }      : {}),
        // EFX P9a / L5 — Best Offer, but NEVER for a SKU that is (or may be) an
        // inventory-item-group member: eBay rejects it with 25737. Only a
        // genuinely standalone single-SKU listing is eligible (see bestOfferEligible
        // above); unknown/family pushes omit it — the safe default.
        ...(bestOfferEligible ? { bestOfferTerms } : {}),
      },
      ...(merchantLocationKey ? { merchantLocationKey } : {}),
      quantityLimitPerBuyer,
    }

    const upd = await fetch(`${apiBase}/sell/inventory/v1/offer/${offerId}`, {
      method: 'PUT', headers, body: JSON.stringify(offerBody),
    })
    if (!upd.ok) {
      const err = await upd.text().catch(() => '')
      results.push({ sku, market: mp, status: 'ERROR', message: `offer update ${upd.status}: ${err.slice(0, 300)}` })
      continue
    }

    collectedOfferIds.set(sku, offerId)
    results.push({ sku, market: mp, status: 'PUSHED', message: 'offer updated (price/qty only — live immediately)' })
  }

  if (collectedOfferIds.size > 0) void saveOfferIds(collectedOfferIds, region, marketplaceId)
  return results
}

// ── Market constants ───────────────────────────────────────────────────
export const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const;
export type Market = (typeof MARKETS)[number];

// ── Helpers ────────────────────────────────────────────────────────────

export function toMarketplaceId(marketplace: string): string {
  const MAP: Record<string, string> = {
    IT: 'EBAY_IT',
    DE: 'EBAY_DE',
    FR: 'EBAY_FR',
    ES: 'EBAY_ES',
    UK: 'EBAY_GB',
    GB: 'EBAY_GB',
  };
  return MAP[marketplace.toUpperCase()] ?? `EBAY_${marketplace.toUpperCase()}`;
}

export function toChannelMarket(mp: Market): string {
  if (mp === 'UK') return 'EBAY_GB';
  return `EBAY_${mp}`;
}

// ── P4 — Snapshot overlay (mirrors Amazon applySnapshotOverlay) ─────────

/**
 * Fields that ALWAYS come from the live DB-derived row, never from the snapshot.
 * Mirrors Amazon's SNAPSHOT_LIVE_OVERLAY: quantities may be updated by the stock
 * system after the user saved; eBay item IDs are set after push; sync_status and
 * system fields are owned by the backend; identity fields (sku, ean) and grouping
 * flags (_isParent, platformProductId) are always DB-authoritative.
 *
 * FFP.1 — per-market PRICE is deliberately NOT in this set: the operator's typed
 * price (snapshot) is authoritative in the grid and on push. When the live DB
 * price diverges (repricer/external), GET /rows attaches a `_live_price_{mp}`
 * hint field instead of silently overriding what the operator entered.
 */
export const EBAY_SNAPSHOT_LIVE_FIELDS = new Set([
  // Identity — product-level, not user-entered in the flat file
  'sku', 'ean',
  // Live eBay system fields
  'ebay_item_id', 'listing_status', 'sync_status', 'last_pushed_at',
  // Per-market live fields (qty owned by the stock system; ids/status by publish)
  ...MARKETS.flatMap((mp) => {
    const p = mp.toLowerCase();
    return [`${p}_qty`, `${p}_item_id`, `${p}_status`, `${p}_listing_id`];
  }),
  // Grouping / family structure — derived from Product.parentId, not user intent
  'platformProductId', '_isParent',
]);

/**
 * P4 — eBay flat-file snapshot overlay.
 *
 * After buildFlatRow derives a row from live DB state and P1a/P3 fills parent_sku,
 * this function overlays the ChannelListing.flatFileSnapshot so the user-entered
 * version of the file is what gets returned on reload.
 *
 * Merge strategy (same as Amazon's applySnapshotOverlay):
 *   1. derivedRow — base layer; fields absent from the snapshot fall through here
 *      (handles schema additions after the snapshot was written).
 *   2. snapshot   — user-entered content wins: parentage, parent_sku, title,
 *      description, category_id, condition, aspect_*, images, policies, package
 *      dims, variation_theme, etc.
 *   3. live       — EBAY_SNAPSHOT_LIVE_FIELDS + all _-prefixed internal fields
 *      always come from derivedRow (repricer/stock changes show, system state
 *      is authoritative).
 *
 * Only call this when snapshot is non-empty (the route guards with
 * `Object.keys(snapshot).length > 0`).
 *
 * Divergence risk: if snapshot.parentage/parent_sku disagrees with DB-derived
 * platformProductId / _isParent, the display shows the user's saved intent but
 * grouping uses the DB parentId. Flag this in the report; it is expected.
 */
export function applyEbayFlatFileSnapshot(
  derivedRow: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  // Collect live-field overrides: EBAY_SNAPSHOT_LIVE_FIELDS + all _ internal keys.
  const live: Record<string, unknown> = {};
  for (const k of Object.keys(derivedRow)) {
    if (k.startsWith('_') || EBAY_SNAPSHOT_LIVE_FIELDS.has(k)) {
      live[k] = derivedRow[k];
    }
  }
  return {
    ...derivedRow,  // base: derived fields as fallback for fields missing from snapshot
    ...snapshot,    // user-entered content overrides derived
    ...live,        // live/system fields always win (override snapshot)
  };
}

/**
 * EFX P9e — per-market push content resolution.
 *
 * A single push can target several marketplaces at once. The flat row carries
 * only the ACTIVE market's content (title/description come from listings[0] and
 * subtitle from the active-market snapshot overlay). Sending that same content to
 * every target market would bleed one site's copy onto all others. This resolver
 * picks each market's OWN saved content from THAT market's ChannelListing, falling
 * back to the active-market row value only when the market has no distinct content.
 *
 * Field authority:
 *   • title / description — stored directly on the per-market ChannelListing.
 *   • subtitle — SNAPSHOT-AUTHORITATIVE: the market's flatFileSnapshot.subtitle
 *     wins, then its platformAttributes.subtitle (market-scoped since EFX P9e's
 *     save fix), then the active-market row value.
 *
 * Pure (no I/O) so the caller batch-loads the market listing and unit tests can
 * exercise every branch. "Falls back to row" fires per-field when the market's
 * own value is blank — i.e. blank = inherit the active market (never the reverse:
 * a non-blank market value is authoritative and is never overwritten by the row).
 */
export interface PerMarketListingContent {
  title?: string | null;
  description?: string | null;
  platformAttributes?: unknown;
  flatFileSnapshot?: unknown;
}
export interface PerMarketContentFallback {
  title?: string | null;
  description?: string | null;
  subtitle?: string | null;
}
export function resolvePerMarketContent(
  marketListing: PerMarketListingContent | null | undefined,
  fallback: PerMarketContentFallback,
): { title: string; subtitle: string; description: string } {
  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const snap = asObj(marketListing?.flatFileSnapshot);
  const attrs = asObj(marketListing?.platformAttributes);

  // First non-blank string wins; blank/missing values are skipped so the fallback
  // (active-market row) is used only when the market has no distinct value.
  const firstNonBlank = (...vals: Array<unknown>): string => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return '';
  };

  return {
    title: firstNonBlank(marketListing?.title, fallback.title),
    description: firstNonBlank(marketListing?.description, fallback.description),
    // snapshot-authoritative → market snapshot, then market platformAttributes,
    // then the active-market row value.
    subtitle: firstNonBlank(snap.subtitle, attrs.subtitle, fallback.subtitle),
  };
}

/**
 * Build a flat multi-market row from a Product + its eBay ChannelListings.
 */
export function buildFlatRow(
  product: {
    id: string;
    sku: string;
    name: string;
    ean: string | null;
    // EV.5b — family linkage + variation data (present at runtime; /rows
    // selects all Product scalars).
    parentId?: string | null;
    isParent?: boolean | null;
    variationTheme?: string | null;
    categoryAttributes?: unknown;
    variantAttributes?: unknown;
    brand?: string | null;
    images?: Array<{ url: string; sortOrder: number; type: string }>;
    channelListings: Array<{
      id: string;
      region: string;
      externalListingId: string | null;
      title: string | null;
      description: string | null;
      price: { toNumber(): number } | null;
      quantity: number | null;
      platformAttributes: unknown;
      listingStatus: string;
      offerActive: boolean;
      syncStatus: string;
      updatedAt: Date;
      // IN.1 — Inheritance state fields (present at runtime, optional in type)
      followMasterTitle?: boolean | null;
      followMasterDescription?: boolean | null;
      followMasterPrice?: boolean | null;
      followMasterQuantity?: boolean | null;
      stockBuffer?: number | null;
      followMasterBulletPoints?: boolean | null;
      masterTitle?: string | null;
      masterDescription?: string | null;
      masterPrice?: { toNumber(): number } | null;
      masterQuantity?: number | null;
    }>;
  },
  opts?: {
    /**
     * P4 — image inheritance: parent/SHARED images supplied by the caller.
     * Used as a last-resort fallback when this variant has no own ProductImage
     * rows AND no platformAttributes.imageUrls.
     */
    parentImages?: Array<{ url: string; sortOrder: number; type: string }>;
  },
): Record<string, unknown> {
  // Shared fields come from the first listing that has data, or from the product
  const listings = product.channelListings;
  const first = listings[0];
  const firstAttrs = first ? ((first.platformAttributes ?? {}) as Record<string, unknown>) : {};
  const firstImageUrls = (firstAttrs.imageUrls as string[] | undefined) ?? [];

  // Prefer Cloudinary images (ProductImage rows) over Amazon CDN platformAttributes URLs.
  // Sort MAIN type first, then by sortOrder. Fall back to non-Amazon platformAttributes URLs.
  // Prefer Cloudinary (ProductImage rows) over platformAttributes URLs.
  // Do NOT filter out Amazon CDN fallback URLs — m.media-amazon.com images are
  // publicly accessible; eBay fetches and re-hosts them in eBay Picture Services.
  // Filtering them was leaving imageUrls empty → eBay error 25717.
  const cloudinaryUrls = (product.images ?? [])
    .slice()
    .sort((a, b) => (a.type === 'MAIN' ? -1 : b.type === 'MAIN' ? 1 : 0) || a.sortOrder - b.sortOrder)
    .map((img) => img.url)
    .filter((url) => !!url);
  // P4 — image inheritance: sorted parent images used as last-resort fallback
  // when this variant has no own ProductImage rows and no platformAttributes URLs.
  const inheritedImageUrls = (opts?.parentImages ?? [])
    .slice()
    .sort((a, b) => (a.type === 'MAIN' ? -1 : b.type === 'MAIN' ? 1 : 0) || a.sortOrder - b.sortOrder)
    .map((img) => img.url)
    .filter((url) => !!url);
  const ownOrPlatformUrls = cloudinaryUrls.length > 0 ? cloudinaryUrls : firstImageUrls.filter(Boolean);
  const effectiveImageUrls = ownOrPlatformUrls.length > 0 ? ownOrPlatformUrls : inheritedImageUrls;

  // EV.5b — variation linkage. Axis names normalised to comma-separated
  // (what the variation publish's split(',') expects); axis values from
  // the canonical categoryAttributes.variations. EFX D4 — one shared parser
  // (splits on , / | ;) so a ';'-separated theme no longer collapses to one axis.
  const variationAxisNames = parseThemeAxes(product.variationTheme);
  // variantAttributes is the canonical per-variant field (set during product creation);
  // categoryAttributes.variations is the legacy bulk-create fallback. Merge both so
  // newly-added variants (which may have variantAttributes but empty categoryAttributes)
  // still have aspect data for the pushVariationGroup synonym normalisation to work with.
  // catVars keys (Italian/eBay-locale) win on collision via spread order.
  const catVars = ((product.categoryAttributes as { variations?: Record<string, string> } | null)?.variations) ?? {}
  const variantAttrs = (product.variantAttributes as Record<string, string> | null) ?? {}
  const variationValues: Record<string, string> = { ...variantAttrs, ...catVars }

  const row: Record<string, unknown> = {
    _rowId: product.id,
    _productId: product.id,
    _dirty: false,
    _status: 'idle',
    sku: product.sku,
    ean: product.ean ?? '',
    mpn: '',
    // shared listing fields from first listing
    title: first?.title || product.name || '',
    condition: (firstAttrs.conditionId as string | undefined) ?? 'NEW',
    category_id: (firstAttrs.categoryId as string | undefined) ?? '',
    subtitle: (firstAttrs.subtitle as string | undefined) ?? '',
    // ED.3 — per-market description theme assignment (blank = default theme).
    description_theme: (firstAttrs.descriptionThemeId as string | undefined) ?? '',
    // Phase 4 — shared-SKU listing flag (parent-level), read back from platformAttributes.
    shared_sku_listing: (firstAttrs.sharedSkuListing as boolean | undefined) ?? false,
    description: first?.description ?? '',
    price: first?.price?.toNumber() ?? 0,
    best_offer_enabled: (firstAttrs.bestOffer as boolean | undefined) ?? false,
    best_offer_floor: (firstAttrs.bestOfferFloor as number | undefined) ?? 0,
    best_offer_ceiling: (firstAttrs.bestOfferCeiling as number | undefined) ?? 0,
    quantity: first?.quantity ?? 0,
    handling_time: (firstAttrs.handlingTime as number | undefined) ?? 1,
    // FF-EN.4 — full-parity fields (round-trip via platformAttributes)
    vat_rate: (firstAttrs.vatRate as string | undefined) ?? '',
    listing_format: (firstAttrs.listingFormat as string | undefined) ?? 'FIXED_PRICE',
    listing_duration: (firstAttrs.listingDuration as string | undefined) ?? 'GTC',
    item_location_country: (firstAttrs.itemLocationCountry as string | undefined) ?? '',
    package_type: (firstAttrs.packageType as string | undefined) ?? '',
    package_weight: (firstAttrs.packageWeight as number | undefined) ?? 0,
    weight_unit: (firstAttrs.weightUnit as string | undefined) ?? 'KILOGRAM',
    package_length: (firstAttrs.packageLength as number | undefined) ?? 0,
    package_width: (firstAttrs.packageWidth as number | undefined) ?? 0,
    package_height: (firstAttrs.packageHeight as number | undefined) ?? 0,
    dimension_unit: (firstAttrs.dimensionUnit as string | undefined) ?? 'CENTIMETER',
    image_1: effectiveImageUrls[0] ?? '',
    image_2: effectiveImageUrls[1] ?? '',
    image_3: effectiveImageUrls[2] ?? '',
    image_4: effectiveImageUrls[3] ?? '',
    image_5: effectiveImageUrls[4] ?? '',
    image_6: effectiveImageUrls[5] ?? '',
    // EFX P9d — eBay listing video (shared). Stored as a single Media-API
    // videoId; the push maps it to product.videoIds (one video per listing).
    video_id: (firstAttrs.videoId as string | undefined) ?? '',
    // EFX P9b — eBay merchantLocationKey (shared). Blank falls back to the
    // account-configured default location at push time.
    merchant_location_key: (firstAttrs.merchantLocationKey as string | undefined) ?? '',
    // EFX P9f — per-listing max qty per buyer (shared). Blank = default of 10.
    quantity_limit_per_buyer:
      (firstAttrs.quantityLimitPerBuyer as number | undefined) != null
        ? (firstAttrs.quantityLimitPerBuyer as number)
        : '',
    fulfillment_policy_id: (firstAttrs.fulfillmentPolicyId as string | undefined) ?? '',
    payment_policy_id: (firstAttrs.paymentPolicyId as string | undefined) ?? '',
    return_policy_id: (firstAttrs.returnPolicyId as string | undefined) ?? '',
    _brand: product.brand ?? '',
    // legacy single-market fields (backward compat)
    listing_status: first?.listingStatus ?? 'DRAFT',
    last_pushed_at: first?.updatedAt.toISOString() ?? '',
    sync_status: first?.syncStatus ?? 'pending',
    ebay_item_id: first?.externalListingId ?? '',
    // EV.5b — family group key: children share the parent's id, the parent
    // uses its own. So a family groups (push + UI) instead of every row
    // being its own one-row "family".
    platformProductId: product.parentId ?? product.id,
    variation_theme: variationAxisNames.join(','),
    // metadata flag (underscore-prefixed, not a display column).
    _isParent: !product.parentId,
    // P1a — explicit parentage columns (display-only; parent_sku placeholder
    // filled by the GET /rows route after the full product set is loaded).
    parentage: product.parentId ? 'child' : (product.isParent ? 'parent' : ''),
    parent_sku: '',
  };

  // Dynamic item specifics from first listing
  const itemSpecifics = (firstAttrs.itemSpecifics as Record<string, string> | undefined) ?? {};
  for (const [key, val] of Object.entries(itemSpecifics)) {
    if (!key) continue; // guard: skip empty-key entry
    const colId = `aspect_${key.replace(/\s+/g, '_')}`;
    row[colId] = val;
  }

  // EV.5b — variation axis values from categoryAttributes.variations.
  // Skip any axis whose physical dimension is already covered by itemSpecifics:
  // a pushed variant has "Colore"/"Taglia" in itemSpecifics (Italian, correct
  // for EBAY_IT) — writing also "Color"/"color_name" from Amazon's variation
  // theme would pollute the row with English aliases that survive the push
  // service's old fingerprint dedup when values are in different languages
  // (NERO ≠ Black), forcing the group to require BOTH axes from every variant.
  const itemSpecificsDims = new Set(
    Object.keys(itemSpecifics).map(k => axisSynonymKey(k))
  )
  for (const [axis, val] of Object.entries(variationValues)) {
    if (!axis || !val) continue; // guard: skip empty axis name or empty value
    if (itemSpecificsDims.has(axisSynonymKey(axis))) continue; // covered by itemSpecifics
    row[`aspect_${axis.replace(/\s+/g, '_')}`] = val;
    row[`aspect_${axis.toLowerCase().replace(/\s+/g, '_')}`] = val;
  }

  // Per-market flat fields
  for (const mp of MARKETS) {
    const listing = listings.find((l) => l.region === mp || l.region === (mp === 'UK' ? 'GB' : mp));
    const attrs = listing ? ((listing.platformAttributes ?? {}) as Record<string, unknown>) : {};
    const prefix = mp.toLowerCase() as Lowercase<Market>;
    row[`${prefix}_price`] = listing?.price?.toNumber() ?? null;
    row[`${prefix}_qty`] = listing?.quantity ?? null;
    // FM Phase 2 — per-market Follow/Pinned state (drives the Follow column).
    // 'Follow' = this market draws from the shared pool; 'Pinned' = it holds a
    // fixed quantity. null when there's no listing for this market.
    row[`${prefix}_follow`] = listing ? (listing.followMasterQuantity === false ? 'Pinned' : 'Follow') : null;
    // FM Phase 4 — units reserved from the pool (only shapes a Following listing's qty).
    row[`${prefix}_buffer`] = listing ? String(listing.stockBuffer ?? 0) : null;
    row[`${prefix}_item_id`] = listing?.externalListingId ?? null;
    row[`${prefix}_status`] = listing?.listingStatus ?? null;
    row[`${prefix}_listing_id`] = (attrs.offerId as string | undefined) ?? null;
  }

  // IN.1 — Inheritance state from the first (primary) listing.
  // _marketFieldStates provides per-market breakdown for the eBay popover.
  if (first) {
    row._listingId = first.id
    row._fieldStates = {
      price:        (first.followMasterPrice        ?? true) ? 'INHERITED' : 'OVERRIDE',
      title:        (first.followMasterTitle        ?? true) ? 'INHERITED' : 'OVERRIDE',
      description:  (first.followMasterDescription  ?? true) ? 'INHERITED' : 'OVERRIDE',
      quantity:     (first.followMasterQuantity     ?? true) ? 'INHERITED' : 'OVERRIDE',
      bulletPoints: (first.followMasterBulletPoints ?? true) ? 'INHERITED' : 'OVERRIDE',
    }
    row._masterValues = {
      price:       first.masterPrice != null ? first.masterPrice.toNumber() : null,
      title:       first.masterTitle       ?? null,
      description: first.masterDescription ?? null,
      quantity:    first.masterQuantity    ?? null,
    }
    // Per-market override state (price + qty are the key ones for eBay)
    const marketFieldStates: Record<string, Record<string, 'INHERITED' | 'OVERRIDE'>> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) {
        marketFieldStates[mp] = {
          price:    (l.followMasterPrice    ?? true) ? 'INHERITED' : 'OVERRIDE',
          quantity: (l.followMasterQuantity ?? true) ? 'INHERITED' : 'OVERRIDE',
          title:    (l.followMasterTitle    ?? true) ? 'INHERITED' : 'OVERRIDE',
        }
      }
    }
    row._marketFieldStates = marketFieldStates
    // Build list of per-market listing IDs for the reset-per-market action
    const marketListingIds: Record<string, string> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) marketListingIds[mp] = l.id
    }
    row._marketListingIds = marketListingIds
  }

  return row;
}

/**
 * Pack shared listing fields back into ChannelListing DB fields.
 */
export function packSharedFields(row: Record<string, unknown>): {
  title: string;
  description: string;
  externalListingId: string | null;
  listingStatus: string;
  offerActive: boolean;
  platformAttributes: Prisma.InputJsonValue;
} {
  const imageUrls: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const url = row[`image_${i}`] as string | undefined;
    if (url) imageUrls.push(url);
  }

  // Collect item specifics from aspect_* keys — deduplicate by lowercase name
  // so both aspect_Colore and aspect_colore (buildFlatRow writes both for variation
  // axes) don't end up as two separate keys in platformAttributes.itemSpecifics.
  const itemSpecifics: Record<string, string> = {};
  const seenAspectLower = new Set<string>();
  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith('aspect_') && typeof val === 'string' && val) {
      const aspectName = key.slice('aspect_'.length).replace(/_/g, ' ');
      if (!aspectName) continue; // guard: skip aspect_ with empty suffix
      const lk = aspectName.toLowerCase();
      if (!seenAspectLower.has(lk)) {
        seenAspectLower.add(lk);
        itemSpecifics[aspectName] = val;
      }
    }
  }

  return {
    title: (row.title as string) ?? '',
    description: (row.description as string) ?? '',
    externalListingId: (row.ebay_item_id as string) || null,
    listingStatus: (row.listing_status as string) ?? 'DRAFT',
    offerActive: row.listing_status === 'ACTIVE',
    platformAttributes: {
      conditionId: (row.condition as string) ?? 'NEW',
      categoryId: (row.category_id as string) ?? '',
      subtitle: (row.subtitle as string) ?? '',
      // ED.3 — description theme id ('' = default, 'none' = raw body). Split
      // per-market at save exactly like subtitle.
      descriptionThemeId: ((row.description_theme as string) ?? '').trim(),
      // Phase 4 — shared-SKU listing routing flag (Trading-API multi-variation,
      // shared variant SKUs across parents). Round-trips via existing JSON; no migration.
      sharedSkuListing: Boolean(row.shared_sku_listing),
      imageUrls,
      itemSpecifics,
      handlingTime: Number(row.handling_time ?? 1),
      bestOffer: Boolean(row.best_offer_enabled),
      bestOfferFloor: Number(row.best_offer_floor ?? 0),
      bestOfferCeiling: Number(row.best_offer_ceiling ?? 0),
      // EFX P9d — eBay listing video (Media-API videoId). Blank = no video.
      videoId: ((row.video_id as string) ?? '').trim(),
      // EFX P9b — merchantLocationKey (blank = account default at push).
      merchantLocationKey: (row.merchant_location_key as string) ?? '',
      // EFX P9f — quantityLimitPerBuyer override; null when blank (push uses 10).
      quantityLimitPerBuyer:
        row.quantity_limit_per_buyer != null && row.quantity_limit_per_buyer !== ''
          ? Number(row.quantity_limit_per_buyer)
          : null,
      fulfillmentPolicyId: (row.fulfillment_policy_id as string) ?? '',
      paymentPolicyId: (row.payment_policy_id as string) ?? '',
      returnPolicyId: (row.return_policy_id as string) ?? '',
      // FF-EN.4 — full-parity fields
      vatRate: (row.vat_rate as string) ?? '',
      listingFormat: (row.listing_format as string) ?? 'FIXED_PRICE',
      listingDuration: (row.listing_duration as string) ?? 'GTC',
      itemLocationCountry: (row.item_location_country as string) ?? '',
      packageType: (row.package_type as string) ?? '',
      packageWeight: Number(row.package_weight ?? 0),
      weightUnit: (row.weight_unit as string) ?? 'KILOGRAM',
      packageLength: Number(row.package_length ?? 0),
      packageWidth: Number(row.package_width ?? 0),
      packageHeight: Number(row.package_height ?? 0),
      dimensionUnit: (row.dimension_unit as string) ?? 'CENTIMETER',
    } as Prisma.InputJsonValue,
  };
}

/**
 * Load the full eBay flat-row payload for ONE product family (parent + variant
 * children) — identical to GET /api/ebay/flat-file/rows?familyId=. Lets the
 * per-product Images tab publish build the SAME listing body the flat-file page
 * builds, so there is one source of truth for the eBay listing payload.
 */
export async function buildEbayFamilyRows(
  familyParentId: string,
): Promise<Array<Record<string, unknown>>> {
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      OR: [{ id: familyParentId }, { parentId: familyParentId }],
    },
    include: {
      channelListings: { where: { channel: 'EBAY' } },
      images: { select: { url: true, sortOrder: true, type: true }, orderBy: { sortOrder: 'asc' } },
    },
    orderBy: { sku: 'asc' },
  })
  // P4 — image inheritance: pass parent images to child products.
  const imagesByProductId = new Map(products.map((p) => [p.id, p.images ?? []]))
  return products.map((p) => {
    const parentImages = p.parentId ? (imagesByProductId.get(p.parentId) ?? []) : undefined
    return buildFlatRow(p as Parameters<typeof buildFlatRow>[0], { parentImages })
  })
}
