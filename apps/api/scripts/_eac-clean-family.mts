/**
 * EAC — generalized variation-data cleanup for ANY eBay variation family.
 *
 * The reusable engine behind a future one-click "Clean this family" cockpit
 * button. Generalizes _eac-aireon-cleanup.mts: instead of an AIREON-hardcoded
 * drop-list + colour regex, it DERIVES keep/drop from the ONE authoritative
 * resolver — resolveFamilyAxes(parentId, marketplace):
 *
 *   • axes       → the KEEPERS: canonical localized axis names + their ONE clean
 *                  value list. These names become the family's variationTheme and
 *                  the child aspect keys; polluted child values fold to them.
 *   • suppressed → ghost/stray aspect names to DROP wherever they appear
 *                  (e.g. Amazon "Team Name" / "Athlete").
 *   • plus       → any synonym-duplicate key that folds to a keeper but carries a
 *                  DIFFERENT (English / miscased) name is dropped, its clean value
 *                  merged under the keeper's canonical name.
 *
 * Cleans, per family:
 *   - child Product.categoryAttributes.variations
 *   - child Product.variantAttributes
 *   - child eBay ChannelListing.platformAttributes.itemSpecifics (this market)
 *   - parent ChannelListing.platformAttributes (_variationAxes, _axisValueOrder)
 *   - parent Product.variationTheme
 *
 * ALL writes are Nexus-local JSON. ZERO eBay calls. The live listing changes
 * only on a later, operator-gated push.
 *
 * SAFETY:
 *   - DRY-RUN by default (prints the full before→after diff; NO writes).
 *   - `--apply` required to write; before writing, snapshots every affected row's
 *     original JSON to _eac-clean-family-backup-<ts>.json for one-command revert.
 *   - Unmatched values (a polluted value with no clean keeper match) are LEFT AS
 *     IS and flagged in the diff under `unmatchedValues` — never silently guessed.
 *
 * Usage:
 *   tsx apps/api/scripts/_eac-clean-family.mts --parent <productId> --market IT
 *   tsx apps/api/scripts/_eac-clean-family.mts --parent <productId> --market IT --apply
 *
 * NOTE: this is a delivered engine + usage note only. Do NOT run it against a
 * real family without operator review of the dry-run diff.
 */
import prisma from '../src/db.js'
import { writeFileSync } from 'node:fs'
import { resolveFamilyAxes } from '../src/services/ebay-family-axes.service.js'
import { axisSynonymKey } from '../src/services/ebay-theme-axes.js'

// ── args ──────────────────────────────────────────────────────────────────
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const PARENT_ID = argVal('--parent')
const MARKET = argVal('--market') ?? 'IT'
const APPLY = process.argv.includes('--apply')

if (!PARENT_ID) {
  console.error('Missing --parent <productId>. Usage: --parent <id> --market IT [--apply]')
  process.exit(1)
}

interface Keeper { name: string; key: string; values: string[]; valuesLower: string[] }

/** Map a raw child value onto the resolved clean value list. Exact (case-
 *  insensitive) wins; else a prefix match strips a trailing " - <suffix>" style
 *  pollution ("Crema e Vino - Giacca" → "Crema e Vino"). No match → unchanged. */
function depollute(v: unknown, keeper: Keeper): { value: unknown; matched: boolean } {
  if (typeof v !== 'string') return { value: v, matched: true }
  const raw = v.trim()
  if (keeper.values.length === 0) return { value: raw, matched: true } // nothing to fold to
  const exactIdx = keeper.valuesLower.indexOf(raw.toLowerCase())
  if (exactIdx >= 0) return { value: keeper.values[exactIdx], matched: true }
  const preIdx = keeper.valuesLower.findIndex((cv) => raw.toLowerCase().startsWith(cv))
  if (preIdx >= 0) return { value: keeper.values[preIdx], matched: true }
  return { value: raw, matched: false }
}

/**
 * Clean one aspect map against the derived keeper/suppressed sets.
 *  - canonical keeper key → keep, de-pollute value
 *  - synonym-duplicate (folds to a keeper, wrong name) → drop, remember value
 *  - suppressed/ghost key → drop
 *  - unknown custom key → pass through unchanged
 * Absent canonical keeper names are back-filled from a dropped duplicate's value.
 */
function cleanAspectMap(
  m: Record<string, unknown> | null | undefined,
  keeperByKey: Map<string, Keeper>,
  suppressedKeys: Set<string>,
  suppressedNames: Set<string>,
): { next: Record<string, unknown> | null | undefined; changed: boolean; unmatched: string[] } {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { next: m, changed: false, unmatched: [] }
  const next: Record<string, unknown> = {}
  const pendingFill = new Map<string, unknown>() // keeperKey -> clean value from a dropped dup
  const canonicalPresent = new Set<string>()
  const unmatched: string[] = []
  let changed = false

  for (const [k, v] of Object.entries(m)) {
    const kk = axisSynonymKey(k)
    const keeper = keeperByKey.get(kk)
    if (keeper && k.toLowerCase() === keeper.name.toLowerCase()) {
      const { value, matched } = depollute(v, keeper)
      next[k] = value
      canonicalPresent.add(kk)
      if (value !== v) changed = true
      if (!matched) unmatched.push(`${k}="${String(v)}"`)
    } else if (keeper) {
      // synonym duplicate carrying the wrong name — drop; keep its clean value
      const { value, matched } = depollute(v, keeper)
      if (!pendingFill.has(kk)) pendingFill.set(kk, value)
      if (!matched) unmatched.push(`${k}="${String(v)}"`)
      changed = true
    } else if (suppressedKeys.has(kk) || suppressedNames.has(k.toLowerCase())) {
      changed = true // ghost stray — drop
    } else {
      next[k] = v // unknown custom axis — pass through
    }
  }

  // back-fill a canonical keeper name that was only present under a dropped dup
  for (const [kk, value] of pendingFill) {
    if (canonicalPresent.has(kk)) continue
    const keeper = keeperByKey.get(kk)!
    next[keeper.name] = value
  }
  return { next, changed, unmatched }
}

async function main() {
  const parent = await prisma.product.findUnique({
    where: { id: PARENT_ID },
    select: { id: true, sku: true, variationTheme: true },
  })
  if (!parent) throw new Error(`parent not found: ${PARENT_ID}`)

  // ── DERIVE keep/drop from the ONE authoritative resolver ──────────────────
  const resolved = await resolveFamilyAxes(PARENT_ID!, MARKET)
  const keeperByKey = new Map<string, Keeper>()
  for (const a of resolved.axes) {
    keeperByKey.set(a.key, {
      name: a.name,
      key: a.key,
      values: a.values,
      valuesLower: a.values.map((v) => v.toLowerCase()),
    })
  }
  const suppressedNames = new Set(resolved.suppressed.map((s) => s.toLowerCase()))
  const suppressedKeys = new Set(resolved.suppressed.map((s) => axisSynonymKey(s)))
  // never suppress a name that also resolved to a keeper (safety)
  for (const k of keeperByKey.keys()) suppressedKeys.delete(k)

  const clean = (m: Record<string, unknown> | null | undefined) =>
    cleanAspectMap(m, keeperByKey, suppressedKeys, suppressedNames)

  const children = await prisma.product.findMany({
    where: { parentId: PARENT_ID },
    select: { id: true, sku: true, variantAttributes: true, categoryAttributes: true },
  })
  const childIds = children.map((c) => c.id)
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: [...childIds, PARENT_ID!] }, channel: 'EBAY', marketplace: MARKET },
    select: { id: true, productId: true, platformAttributes: true },
  })
  const listingByProduct = new Map(listings.map((l) => [l.productId, l]))

  const diff: any[] = []
  const backup: any[] = []
  const writes: Array<() => Promise<unknown>> = []

  // ── children ──────────────────────────────────────────────────────────────
  for (const c of children) {
    const cat = (c.categoryAttributes ?? {}) as any
    const variations = cat.variations as Record<string, unknown> | undefined
    const cv = clean(variations)
    const va = clean(c.variantAttributes as Record<string, unknown> | null)
    const listing = listingByProduct.get(c.id)
    const pa = (listing?.platformAttributes ?? {}) as any
    const is = clean(pa.itemSpecifics as Record<string, unknown> | null)

    if (!(cv.changed || va.changed || is.changed)) continue

    diff.push({
      sku: c.sku,
      variations: cv.changed ? { before: variations, after: cv.next } : undefined,
      variantAttributes: va.changed ? { before: c.variantAttributes, after: va.next } : undefined,
      itemSpecifics: is.changed ? { before: pa.itemSpecifics, after: is.next } : undefined,
      unmatchedValues: [...cv.unmatched, ...va.unmatched, ...is.unmatched].length
        ? [...new Set([...cv.unmatched, ...va.unmatched, ...is.unmatched])] : undefined,
    })
    backup.push({ productId: c.id, categoryAttributes: c.categoryAttributes, variantAttributes: c.variantAttributes, listingId: listing?.id, platformAttributes: listing?.platformAttributes })

    if (cv.changed || va.changed) {
      const nextCat = { ...cat, variations: cv.next }
      writes.push(() => prisma.product.update({ where: { id: c.id }, data: { categoryAttributes: nextCat, variantAttributes: va.next as any } }))
    }
    if (is.changed && listing) {
      const nextPa = { ...pa, itemSpecifics: is.next }
      writes.push(() => prisma.channelListing.update({ where: { id: listing.id }, data: { platformAttributes: nextPa } }))
    }
  }

  // ── parent listing platformAttributes ─────────────────────────────────────
  const keeperNames = resolved.axes.map((a) => a.name)
  const nextValueOrder = Object.fromEntries(resolved.axes.map((a) => [a.key, a.values]))
  const pl = listingByProduct.get(PARENT_ID!)
  if (pl && keeperNames.length) {
    const pa = { ...(pl.platformAttributes as any) }
    const before = { _variationAxes: pa._variationAxes, _axisValueOrder: pa._axisValueOrder }
    pa._variationAxes = keeperNames
    pa._axisValueOrder = nextValueOrder
    const axesChanged = JSON.stringify(before._variationAxes ?? null) !== JSON.stringify(keeperNames)
    const orderChanged = JSON.stringify(before._axisValueOrder ?? null) !== JSON.stringify(nextValueOrder)
    if (axesChanged || orderChanged) {
      backup.push({ productId: PARENT_ID, listingId: pl.id, platformAttributes: pl.platformAttributes })
      diff.push({ sku: parent.sku + ' (parent listing)', platformAttributes: { before, after: { _variationAxes: keeperNames, _axisValueOrder: nextValueOrder } } })
      writes.push(() => prisma.channelListing.update({ where: { id: pl.id }, data: { platformAttributes: pa } }))
    }
  }

  // ── parent variationTheme ──────────────────────────────────────────────────
  const nextTheme = keeperNames.join(',')
  if (keeperNames.length && parent.variationTheme !== nextTheme) {
    diff.push({ sku: parent.sku + ' (variationTheme)', before: parent.variationTheme, after: nextTheme })
    writes.push(() => prisma.product.update({ where: { id: PARENT_ID }, data: { variationTheme: nextTheme } }))
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    parent: parent.sku,
    marketplace: MARKET,
    keepers: resolved.axes.map((a) => ({ name: a.name, values: a.values })),
    suppressed: resolved.suppressed,
    warnings: resolved.warnings,
    childrenChanged: diff.filter((d) => !String(d.sku).includes('(')).length,
    totalWrites: writes.length,
    diff,
  }, null, 2))

  if (resolved.axes.length === 0) {
    console.log('\nNo resolved axes for this family/market — refusing to clean (would blank the theme). No writes.')
    await prisma.$disconnect()
    return
  }

  if (APPLY) {
    const ts = Date.now()
    const path = `apps/api/scripts/_eac-clean-family-backup-${ts}.json`
    writeFileSync(path, JSON.stringify(backup, null, 2))
    console.log(`\nBackup written: ${path}  (revert source)`)
    for (const w of writes) await w()
    console.log(`APPLIED ${writes.length} writes.`)
  } else {
    console.log('\nDRY-RUN only — no writes. Re-run with --apply after operator approval.')
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
