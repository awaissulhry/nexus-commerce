/**
 * EAC Layer B — snapshot completion for AIREON.
 *
 * The structured cleanup (_eac-aireon-cleanup.mts) fixed itemSpecifics /
 * categoryAttributes / variantAttributes / parent platformAttributes, but the
 * eBay flat file is SNAPSHOT-BACKED: `ChannelListing.flatFileSnapshot` stores
 * the last-saved row verbatim, and the /rows route overlays it on top of the
 * live data (applyEbayFlatFileSnapshot). So the grid + push still showed the
 * pre-cleanup snapshot (ghost aspect_* columns, polluted aspect_Colore, stale
 * variation_theme "…,Color,Size"). This script cleans that snapshot layer.
 *
 * Per child snapshot: drop ghost aspect_* keys (Color/Size/Team Name/Athlete/
 * Body Type + case-variants), de-pollute aspect_Colore. Parent snapshot: also
 * set variation_theme → "Tipo di prodotto,Colore,Taglia".
 *
 * DRY-RUN by default; --apply writes a JSON backup first. Zero eBay calls.
 * Usage: tsx apps/api/scripts/_eac-aireon-snapshot.mts [--apply]
 */
import prisma from '../src/db.js'
import { writeFileSync } from 'node:fs'

const PARENT_ID = 'cmr1b1yxl0000s4rcvopsqv42'
const MARKET = 'IT'
const APPLY = process.argv.includes('--apply')
const CANON_THEME = 'Tipo di prodotto,Colore,Taglia'

// aspect_<name> whose lowercased name is a ghost/English-dup → drop from snapshot.
const DROP = new Set(['color', 'size', 'team name', 'athlete', 'body type'])
const cleanColour = (v: string) => v.replace(/\s*-\s*(Giacca|Pantaloni)\s*$/i, '').trim()

function cleanSnapshot(snap: Record<string, unknown> | null | undefined) {
  if (!snap || typeof snap !== 'object') return { next: snap, changed: false }
  const next: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(snap)) {
    if (k.startsWith('aspect_')) {
      const name = k.slice('aspect_'.length).replace(/_/g, ' ').toLowerCase()
      if (DROP.has(name)) { changed = true; continue }
      if (name === 'colore' && typeof v === 'string') {
        const c = cleanColour(v)
        if (c !== v) changed = true
        next[k] = c
        continue
      }
    }
    if (k === 'variation_theme' && typeof v === 'string' && v && v !== CANON_THEME) {
      next[k] = CANON_THEME
      changed = true
      continue
    }
    next[k] = v
  }
  return { next, changed }
}

async function main() {
  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'EBAY',
      marketplace: MARKET,
      OR: [{ productId: PARENT_ID }, { product: { parentId: PARENT_ID } }],
    },
    select: { id: true, productId: true, flatFileSnapshot: true, product: { select: { sku: true } } },
  })

  const diff: any[] = []
  const backup: any[] = []
  const writes: Array<() => Promise<unknown>> = []

  for (const l of listings) {
    const snap = l.flatFileSnapshot as Record<string, unknown> | null
    const { next, changed } = cleanSnapshot(snap)
    if (!changed) continue
    const sku = l.product?.sku ?? l.productId
    // Show only the aspect_/theme keys that changed (snapshots are large).
    const beforeKeys = Object.keys(snap ?? {}).filter((k) => k.startsWith('aspect_') || k === 'variation_theme')
    const afterAspects = Object.fromEntries(
      Object.entries(next as Record<string, unknown>).filter(([k]) => k.startsWith('aspect_') || k === 'variation_theme'),
    )
    const dropped = beforeKeys.filter((k) => !(k in (next as any)))
    diff.push({ sku, dropped, colore: (next as any).aspect_Colore, theme: (next as any).variation_theme })
    backup.push({ listingId: l.id, flatFileSnapshot: snap })
    writes.push(() => prisma.channelListing.update({ where: { id: l.id }, data: { flatFileSnapshot: next as any } }))
  }

  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY-RUN', listingsChanged: diff.length, diff: diff.slice(0, 6), totalWrites: writes.length }, null, 2))

  if (APPLY) {
    const ts = Date.now()
    const path = `apps/api/scripts/_eac-aireon-snapshot-backup-${ts}.json`
    writeFileSync(path, JSON.stringify(backup, null, 2))
    console.log(`\nBackup written: ${path}`)
    for (const w of writes) await w()
    console.log(`APPLIED ${writes.length} snapshot writes.`)
  } else {
    console.log('\nDRY-RUN only — no writes.')
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
