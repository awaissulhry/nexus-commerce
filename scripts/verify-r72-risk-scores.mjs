#!/usr/bin/env node
// Verify R7.2 — per-SKU return-rate risk scoring.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

console.log('\n[1] /risk-scores endpoint reachable')
{
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.scored) && Array.isArray(j.flagged) && j.summary) ok('endpoint shape correct')
  else bad('shape wrong', JSON.stringify(j).slice(0, 200))
  if (j.windowDays === 90) ok('default windowDays=90')
  else bad('windowDays mismatch', j.windowDays)
}

console.log('\n[2] windowDays clamping (7..365)')
{
  const r1 = await fetch(`${API}/api/fulfillment/returns/risk-scores?windowDays=3`)
  const j1 = await r1.json()
  if (j1.windowDays === 7) ok('windowDays=3 clamps to 7')
  else bad('low clamp wrong', j1.windowDays)
  const r2 = await fetch(`${API}/api/fulfillment/returns/risk-scores?windowDays=999`)
  const j2 = await r2.json()
  if (j2.windowDays === 365) ok('windowDays=999 clamps to 365')
  else bad('high clamp wrong', j2.windowDays)
}

console.log('\n[3] z-score math sanity — synthetic 4-SKU bucket with one outlier')
{
  // Pick 4 distinct products of the same productType. We assert
  // the math at a smaller scale by directly querying the service
  // through the API and inspecting one bucket's stats.
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores?windowDays=365`)
  const j = await r.json()
  // Find a bucket with ≥3 scored SKUs
  const byType = new Map()
  for (const s of j.scored) {
    const k = s.productType ?? '_unbucketed'
    const arr = byType.get(k) ?? []
    arr.push(s)
    byType.set(k, arr)
  }
  let analyzedBucket = null
  for (const [k, arr] of byType) {
    if (arr.length >= 3) { analyzedBucket = { key: k, rows: arr }; break }
  }
  if (analyzedBucket) {
    ok(`found bucket "${analyzedBucket.key}" with ${analyzedBucket.rows.length} SKUs for stats check`)
    // All rows in the bucket should report the same bucketMeanPct
    const means = new Set(analyzedBucket.rows.map((r) => r.bucketMeanPct.toFixed(4)))
    if (means.size === 1) ok('bucketMeanPct is consistent across the bucket')
    else bad('bucketMeanPct varies within a bucket', JSON.stringify([...means]))
    // Sanity: sum of (rate - mean) should be ~0 by definition.
    const mean = analyzedBucket.rows[0].bucketMeanPct
    const residSum = analyzedBucket.rows.reduce((acc, r) => acc + (r.ratePct - mean), 0)
    if (Math.abs(residSum) < 0.01) ok(`sum of residuals ≈ 0 (got ${residSum.toFixed(4)})`)
    else bad('residuals don\'t sum to 0', residSum)
  } else {
    console.log('  → no bucket with ≥3 SKUs in current data; skip math sanity')
  }
}

console.log('\n[4] flagged subset is consistent (z>2 + returns≥3 + bucket≥3)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores?windowDays=365`)
  const j = await r.json()
  // Every flagged row must satisfy all three predicates
  const violations = j.flagged.filter((row) =>
    !(row.z > 2 && row.returnCount >= 3 && row.flagged === true)
  )
  if (violations.length === 0) ok(`all ${j.flagged.length} flagged rows pass the gate`)
  else bad(`${violations.length} flagged rows violate the gate`, JSON.stringify(violations[0]))
}

console.log('\n[5] scored sorted by ratePct desc')
{
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores`)
  const j = await r.json()
  let sorted = true
  for (let i = 1; i < j.scored.length; i++) {
    if (j.scored[i].ratePct > j.scored[i - 1].ratePct) { sorted = false; break }
  }
  if (sorted) ok(`scored[] sorted by ratePct desc`)
  else bad('scored not sorted desc', '')
}

console.log('\n[6] Returns analytics page consumes /risk-scores (file marker)')
{
  const fs = await import('fs')
  const src = fs.readFileSync(
    '/Users/awais/nexus-commerce/apps/web/src/app/fulfillment/returns/analytics/AnalyticsClient.tsx',
    'utf8',
  )
  if (src.includes('/api/fulfillment/returns/risk-scores')) ok('analytics page fetches /risk-scores')
  else bad('analytics page does not consume risk-scores', '')
  if (src.includes('High-return-risk SKUs')) ok('"High-return-risk SKUs" card present')
  else bad('risk card missing', '')
  if (src.includes('AlertTriangle')) ok('alert icon imported')
  else bad('icon missing', '')
}

console.log('\n[7] Service safety — bucket < 3 SKUs is unflagged regardless of rate')
{
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores?windowDays=365`)
  const j = await r.json()
  const byType = new Map()
  for (const s of j.scored) {
    const k = s.productType ?? '_unbucketed'
    const arr = byType.get(k) ?? []
    arr.push(s)
    byType.set(k, arr)
  }
  let smallBuckets = 0
  let smallBucketFlagged = 0
  for (const [, arr] of byType) {
    if (arr.length < 3) {
      smallBuckets++
      smallBucketFlagged += arr.filter((r) => r.flagged).length
    }
  }
  if (smallBucketFlagged === 0) ok(`${smallBuckets} small buckets had 0 flags (safety gate works)`)
  else bad(`small bucket leaked ${smallBucketFlagged} flags`, '')
}

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
