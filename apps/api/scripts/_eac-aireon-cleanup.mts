/**
 * EAC Layer B — AIREON variation-data cleanup (Italian canonical).
 *
 * Consolidates each variation axis to ONE clean eBay-IT aspect:
 *   Colore (de-polluted) · Taglia (complete) · Tipo di prodotto (clean)
 * and removes the English duplicates (Color/Size) + Amazon ghost aspects
 * (Team Name / Athlete / Body Type, incl. case-variants) across:
 *   - child Product.categoryAttributes.variations
 *   - child Product.variantAttributes
 *   - child eBay ChannelListing.platformAttributes.itemSpecifics
 *   - parent eBay ChannelListing.platformAttributes (_variationAxes, _axisValueOrder)
 *   - parent Product.variationTheme  → "Tipo di prodotto,Colore,Taglia"
 *
 * ALL writes are Nexus-local JSON. ZERO eBay calls. The live listing changes
 * only on a later, operator-gated push.
 *
 * SAFETY:
 *   - DRY-RUN by default (prints the full before→after diff; NO writes).
 *   - `--apply` required to write; before writing, snapshots every affected
 *     row's original JSON to _eac-aireon-backup-<ts>.json for one-command revert.
 *   - Operator must review the dry-run diff and approve before --apply is run.
 *
 * Usage:  tsx apps/api/scripts/_eac-aireon-cleanup.mts            (dry-run)
 *         tsx apps/api/scripts/_eac-aireon-cleanup.mts --apply    (writes + backup)
 */
import prisma from '../src/db.js'
import { writeFileSync } from 'node:fs'

const PARENT_ID = 'cmr1b1yxl0000s4rcvopsqv42' // AIREON
const MARKET = 'IT'
const APPLY = process.argv.includes('--apply')

// Aspect keys to DROP wherever they appear (case-insensitive), English dups + ghosts.
const DROP_KEYS = new Set(
  ['color', 'size', 'team name', 'team_name', 'athlete', 'body type', 'body_type'].map((s) => s.toLowerCase()),
)
// Strip a trailing " - <type>" suffix from a polluted colour value.
const cleanColour = (v: string) => v.replace(/\s*-\s*(Giacca|Pantaloni)\s*$/i, '').trim()

function cleanAttrMap(m: Record<string, unknown> | null | undefined) {
  if (!m || typeof m !== 'object') return { next: m, changed: false }
  const next: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(m)) {
    if (DROP_KEYS.has(k.toLowerCase())) { changed = true; continue }
    if (k.toLowerCase() === 'colore' && typeof v === 'string') {
      const c = cleanColour(v)
      if (c !== v) changed = true
      next[k] = c
    } else {
      next[k] = v
    }
  }
  return { next, changed }
}

async function main() {
  const parent = await prisma.product.findUnique({
    where: { id: PARENT_ID },
    select: { id: true, sku: true, variationTheme: true },
  })
  if (!parent) throw new Error('parent not found')

  const children = await prisma.product.findMany({
    where: { parentId: PARENT_ID },
    select: { id: true, sku: true, variantAttributes: true, categoryAttributes: true },
  })
  const childIds = children.map((c) => c.id)
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: [...childIds, PARENT_ID] }, channel: 'EBAY', marketplace: MARKET },
    select: { id: true, productId: true, platformAttributes: true },
  })
  const listingByProduct = new Map(listings.map((l) => [l.productId, l]))

  const diff: any[] = []
  const backup: any[] = []
  const writes: Array<() => Promise<unknown>> = []

  // ── children ──────────────────────────────────────────────────────
  for (const c of children) {
    const cat = (c.categoryAttributes ?? {}) as any
    const variations = cat.variations as Record<string, unknown> | undefined
    const cv = cleanAttrMap(variations)
    const va = cleanAttrMap(c.variantAttributes as Record<string, unknown> | null)
    const listing = listingByProduct.get(c.id)
    const pa = (listing?.platformAttributes ?? {}) as any
    const is = cleanAttrMap(pa.itemSpecifics as Record<string, unknown> | null)

    const childChanged = cv.changed || va.changed || is.changed
    if (!childChanged) continue

    diff.push({
      sku: c.sku,
      variations: cv.changed ? { before: variations, after: cv.next } : undefined,
      variantAttributes: va.changed ? { before: c.variantAttributes, after: va.next } : undefined,
      itemSpecifics: is.changed ? { before: pa.itemSpecifics, after: is.next } : undefined,
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

  // ── parent listing platformAttributes ────────────────────────────
  const pl = listingByProduct.get(PARENT_ID)
  if (pl) {
    const pa = { ...(pl.platformAttributes as any) }
    const before = JSON.parse(JSON.stringify(pa))
    pa._variationAxes = ['Tipo di prodotto', 'Colore', 'Taglia']
    const avo = { ...(pa._axisValueOrder ?? {}) }
    // colour dim = __dim0__ (per observed data); set clean, drop team-name key
    if (avo.__dim0__) avo.__dim0__ = ['Crema e Vino', 'Nero Neo']
    delete avo['team name']
    delete avo['team_name']
    pa._axisValueOrder = avo
    pl && backup.push({ productId: PARENT_ID, listingId: pl.id, platformAttributes: pl.platformAttributes })
    diff.push({ sku: parent.sku + ' (parent listing)', platformAttributes: { before: { _variationAxes: before._variationAxes, _axisValueOrder: before._axisValueOrder }, after: { _variationAxes: pa._variationAxes, _axisValueOrder: pa._axisValueOrder } } })
    writes.push(() => prisma.channelListing.update({ where: { id: pl.id }, data: { platformAttributes: pa } }))
  }

  // ── parent variationTheme ─────────────────────────────────────────
  const nextTheme = 'Tipo di prodotto,Colore,Taglia'
  if (parent.variationTheme !== nextTheme) {
    diff.push({ sku: parent.sku + ' (variationTheme)', before: parent.variationTheme, after: nextTheme })
    writes.push(() => prisma.product.update({ where: { id: PARENT_ID }, data: { variationTheme: nextTheme } }))
  }

  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY-RUN', childrenChanged: diff.filter((d) => !String(d.sku).includes('(')).length, totalWrites: writes.length, diff }, null, 2))

  if (APPLY) {
    const ts = Date.now()
    const path = `apps/api/scripts/_eac-aireon-backup-${ts}.json`
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
