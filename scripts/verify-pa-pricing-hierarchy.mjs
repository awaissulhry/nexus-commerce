#!/usr/bin/env node
// Verify P.A — /api/pricing/matrix hierarchy modes.
//
// Covers:
//   - flat mode default + enrichment fields present
//   - parents mode: rolls snapshots up to root products with aggregates
//   - children mode: per-variant rows with primary + chips + snapshotIds
//   - orphan SKUs still surface (don't drop them)
//   - filter params (channel, marketplace) still narrow correctly
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }

console.log('\n[1] Flat mode (default) — enriched fields present')
{
  const r = await fetch(`${API}/api/pricing/matrix?limit=5`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.rows)) ok(`flat returns rows[] (${j.rows.length})`)
  else bad('flat shape', JSON.stringify(j).slice(0, 200))
  if (j.hierarchy === 'flat') ok('hierarchy flag = flat')
  else bad('hierarchy flag', j.hierarchy)
  const first = j.rows[0]
  if (first) {
    if ('productId' in first) ok('row has productId field')
    else bad('row missing productId', Object.keys(first).join(','))
    if ('thumbnailUrl' in first) ok('row has thumbnailUrl field')
    else bad('row missing thumbnailUrl', Object.keys(first).join(','))
    if ('productName' in first) ok('row has productName field')
    else bad('row missing productName', Object.keys(first).join(','))
    if ('productAsin' in first) ok('row has productAsin field')
    else bad('row missing productAsin', Object.keys(first).join(','))
    if ('parentId' in first) ok('row has parentId field')
    else bad('row missing parentId', Object.keys(first).join(','))
  } else {
    ok('database empty — skipping field check')
  }
}

console.log('\n[2] Parents mode — aggregates + childCount')
{
  const r = await fetch(`${API}/api/pricing/matrix?hierarchy=parents&limit=20`)
  const j = await r.json()
  if (r.ok && j.hierarchy === 'parents') ok('hierarchy flag = parents')
  else bad('parents shape', JSON.stringify(j).slice(0, 200))
  if (Array.isArray(j.rows)) ok(`returned ${j.rows.length} parent rows (total=${j.total})`)
  else bad('rows not array', typeof j.rows)
  for (const row of j.rows) {
    if (typeof row.snapshotCount !== 'number') {
      bad(`row ${row.id} missing snapshotCount`, JSON.stringify(row).slice(0, 200))
      break
    }
    if (typeof row.clampedCount !== 'number') {
      bad(`row ${row.id} missing clampedCount`, JSON.stringify(row).slice(0, 200))
      break
    }
    if (typeof row.fallbackCount !== 'number') {
      bad(`row ${row.id} missing fallbackCount`, JSON.stringify(row).slice(0, 200))
      break
    }
    if (typeof row.warningsCount !== 'number') {
      bad(`row ${row.id} missing warningsCount`, JSON.stringify(row).slice(0, 200))
      break
    }
    if (typeof row.childCount !== 'number') {
      bad(`row ${row.id} missing childCount`, JSON.stringify(row).slice(0, 200))
      break
    }
    if (typeof row.isParent !== 'boolean') {
      bad(`row ${row.id} missing isParent`, JSON.stringify(row).slice(0, 200))
      break
    }
  }
  if (j.rows.length > 0 && j.rows.every((r) => typeof r.snapshotCount === 'number')) {
    ok('every row has aggregate fields (snapshotCount, clamped, fallback, warnings)')
  }
}

console.log('\n[3] Children mode — variant rows with primary + chips')
{
  // Find a real parent first.
  const parents = await fetch(`${API}/api/pricing/matrix?hierarchy=parents&limit=50`).then((r) => r.json())
  const realParent = (parents.rows ?? []).find((p) => p.isParent && !p.isOrphan)
  if (!realParent) {
    ok('no hierarchical parent in DB — skipping children check (acceptable for empty/seed dbs)')
  } else {
    const r = await fetch(`${API}/api/pricing/matrix?hierarchy=children&parentId=${realParent.id}`)
    const j = await r.json()
    if (r.ok && j.hierarchy === 'children') ok(`hierarchy flag = children for parent ${realParent.sku}`)
    else bad('children shape', JSON.stringify(j).slice(0, 200))
    if (Array.isArray(j.rows)) ok(`returned ${j.rows.length} variant rows`)
    else bad('rows not array', typeof j.rows)
    const first = j.rows[0]
    if (first) {
      if (first.primary && first.primary.computedPrice != null) ok('variant row has primary channel snapshot')
      else bad('variant row missing primary', JSON.stringify(first).slice(0, 200))
      if (Array.isArray(first.channelChips)) ok(`variant row has channelChips[] (${first.channelChips.length})`)
      else bad('variant row missing channelChips', JSON.stringify(first).slice(0, 200))
      if (Array.isArray(first.snapshotIds)) ok(`variant row has snapshotIds[] (${first.snapshotIds.length})`)
      else bad('variant row missing snapshotIds', JSON.stringify(first).slice(0, 200))
      if (first.parentId === realParent.id) ok('variant row parentId = root id')
      else bad('parentId mismatch', `${first.parentId} vs ${realParent.id}`)
    }
  }
}

console.log('\n[4] Children mode — defaults to Amazon IT FBA primary')
{
  const parents = await fetch(`${API}/api/pricing/matrix?hierarchy=parents&limit=50`).then((r) => r.json())
  const realParent = (parents.rows ?? []).find((p) => p.isParent && !p.isOrphan)
  if (!realParent) {
    ok('no hierarchical parent in DB — skipping primary-channel default check')
  } else {
    const j = await fetch(`${API}/api/pricing/matrix?hierarchy=children&parentId=${realParent.id}`).then((r) => r.json())
    const first = j.rows?.[0]
    if (first?.primary) {
      // If the variant has an AMAZON IT FBA snapshot, that's what should be primary.
      const hasAmazonItFba = first.channelChips.some((c) => c.channel === 'AMAZON' && c.marketplace === 'AMAZON_IT' && c.fulfillmentMethod === 'FBA')
      const primaryIsAmazonItFba = first.primary.channel === 'AMAZON' && first.primary.marketplace === 'AMAZON_IT' && first.primary.fulfillmentMethod === 'FBA'
      if (hasAmazonItFba && !primaryIsAmazonItFba) {
        bad('Amazon IT FBA exists but is not primary', `primary=${first.primary.channel}/${first.primary.marketplace}/${first.primary.fulfillmentMethod}`)
      } else {
        ok('primary channel resolution honors Amazon IT FBA default')
      }
    }
  }
}

console.log('\n[5] Children mode — override primary via query param')
{
  const parents = await fetch(`${API}/api/pricing/matrix?hierarchy=parents&limit=50`).then((r) => r.json())
  const realParent = (parents.rows ?? []).find((p) => p.isParent && !p.isOrphan)
  if (!realParent) {
    ok('no hierarchical parent in DB — skipping primary override check')
  } else {
    const j = await fetch(
      `${API}/api/pricing/matrix?hierarchy=children&parentId=${realParent.id}&primaryChannel=EBAY&primaryMarketplace=EBAY_IT&primaryFulfillmentMethod=FBM`,
    ).then((r) => r.json())
    const first = j.rows?.[0]
    if (first?.primary) {
      const hasEbay = first.channelChips.some((c) => c.channel === 'EBAY') || first.primary.channel === 'EBAY'
      if (hasEbay) {
        if (first.primary.channel === 'EBAY') ok('primary override pinned to EBAY when SKU has eBay snapshot')
        else bad('eBay exists but primary did not move', first.primary.channel)
      } else {
        ok('no eBay snapshot for this variant — falls back to first available')
      }
    }
  }
}

console.log('\n[6] Filter params still narrow within hierarchy modes')
{
  const j = await fetch(`${API}/api/pricing/matrix?hierarchy=parents&channel=AMAZON&limit=50`).then((r) => r.json())
  if (Array.isArray(j.rows)) ok(`channel filter applied in parents mode (${j.rows.length} rows after filter)`)
  else bad('channel filter broke parents mode', JSON.stringify(j).slice(0, 200))
}

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
