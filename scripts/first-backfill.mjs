#!/usr/bin/env node
// Phase 4a — Historical backfill runner (HTTP-route-driven).
//
// Talks to the production API's sync routes with explicit { from, to }
// windows. Idempotent on the route side (upsert on channel/channelOrderId).
//
// Why HTTP not direct import: importing apps/api services from a script
// pulls the entire server bootstrap (Fastify, Prisma, OTel, all routes)
// which hangs at module load. The route layer is the right seam.
//
// Routes used:
//   POST {API}/api/amazon/orders/sync     body: { from, to }
//   POST {API}/api/amazon/financials/sync body: { start, end }
//   POST {API}/api/sync/ebay/orders       body: { connectionId, from, to }
//   POST {API}/api/ebay/financials/sync   body: { start, end }
//
// Usage:
//   API_URL=https://your-api.up.railway.app \
//     node scripts/first-backfill.mjs --channel amazon --domain orders --from 2024-05-20 --to 2026-05-20
//
//   # Local:
//   API_URL=http://localhost:3000 node scripts/first-backfill.mjs --channel amazon --domain orders --from 2024-05-20 --to 2026-05-20 --dry-run

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'
const CHECKPOINT_DIR = '/tmp/data-wipe-2026-05-20/backfill-CHECKPOINTS'
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })

// ── CLI parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dryRun: false, resume: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--resume') out.resume = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (!val || val.startsWith('--')) { out[key] = true; continue }
      out[key] = val
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv)
const channel = (args.channel || '').toLowerCase()
const domain = (args.domain || '').toLowerCase()
const fromStr = args.from
const toStr = args.to || new Date().toISOString().slice(0, 10)

if (!['amazon', 'ebay'].includes(channel)) {
  console.error('Usage: --channel {amazon|ebay} --domain {orders|financial|returns} --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--resume]')
  console.error('Env:   API_URL=https://your-api.up.railway.app (defaults to http://localhost:3000)')
  process.exit(2)
}
if (!['orders', 'financial', 'returns', 'settlement'].includes(domain)) {
  console.error(`Unknown domain: ${domain}`)
  process.exit(2)
}
if (!fromStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
  console.error(`Bad --from: ${fromStr || '(missing)'}`)
  process.exit(2)
}

const from = new Date(`${fromStr}T00:00:00Z`)
const to = new Date(`${toStr}T23:59:59Z`)
if (to < from) { console.error('--to must be >= --from'); process.exit(2) }

// ── Checkpoint helpers ─────────────────────────────────────────────
const checkpointFile = path.join(CHECKPOINT_DIR, `${channel}-${domain}-${fromStr}-${toStr}.json`)
function loadCheckpoint() {
  if (!fs.existsSync(checkpointFile)) return null
  try { return JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) } catch { return null }
}
function saveCheckpoint(state) {
  fs.writeFileSync(checkpointFile, JSON.stringify(state, null, 2))
}

// ── Date-range chunking ────────────────────────────────────────────
function chunks(from, to, daysPerChunk) {
  const out = []
  let cur = new Date(from)
  while (cur < to) {
    const end = new Date(cur)
    end.setUTCDate(end.getUTCDate() + daysPerChunk)
    out.push({ from: new Date(cur), to: end > to ? new Date(to) : end })
    cur = end
  }
  return out
}

const chunkDays = {
  // Sized to fit inside Railway's ~30s HTTP-gateway timeout. SP-API
  // getOrders is throttled at 0.0167 req/s (1/min sustained) so each
  // page costs ~5-15s; chunks with N pages cost N × that. 5d typically
  // = 1 page for Xavia (~30-50 orders/week).
  'amazon-orders':      5,
  'amazon-financial':   7,   // listFinancialEvents is faster per call
  'amazon-returns':     7,
  'amazon-settlement': 90,   // settlement listReports is fast; 90d ok
  'ebay-orders':        3,   // eBay GetOrders less throttled but also
                             //   paginated; 3d keeps requests <20s
  'ebay-financial':    14,
  'ebay-returns':       7,
}

// ── Active eBay connection lookup ──────────────────────────────────
async function getActiveEbayConnectionId() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    const r = await c.query(`
      SELECT id, "displayName" FROM "ChannelConnection"
      WHERE "channelType" = 'EBAY' AND "isActive" = true
        AND ("refreshToken" IS NOT NULL OR "ebayRefreshToken" IS NOT NULL)
      ORDER BY "createdAt" DESC LIMIT 1
    `)
    if (r.rows.length === 0) throw new Error('No active eBay ChannelConnection with refresh token')
    return r.rows[0].id
  } finally {
    await c.end()
  }
}

// ── HTTP helper with retry on transient 502/503/504 ───────────────
// Railway's HTTP gateway returns 502 when an upstream request takes >30s
// (sometimes due to brief container restarts or load). Backfill chunks
// are idempotent so retry is safe.
async function postJson(routePath, body) {
  const url = `${API_URL.replace(/\/+$/, '')}${routePath}`
  const backoffMs = [5_000, 20_000, 60_000]  // up to 3 retries
  let lastErr
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    let r, text, payload
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      text = await r.text()
      try { payload = JSON.parse(text) } catch { payload = { raw: text.slice(0, 500) } }
    } catch (e) {
      // network-level failure (DNS, conn reset, etc.) → treat as transient
      lastErr = new Error(`fetch failed: ${e.message}`)
      if (attempt < backoffMs.length) {
        process.stdout.write(`\n      retry ${attempt + 1}/${backoffMs.length} after ${backoffMs[attempt]/1000}s (fetch failed): `)
        await new Promise(r => setTimeout(r, backoffMs[attempt]))
        continue
      }
      throw lastErr
    }
    if (r.ok) return payload
    // Transient gateway errors → retry
    if ([502, 503, 504].includes(r.status) && attempt < backoffMs.length) {
      lastErr = new Error(`HTTP ${r.status} ${routePath} (retrying)`)
      process.stdout.write(`\n      retry ${attempt + 1}/${backoffMs.length} after ${backoffMs[attempt]/1000}s (HTTP ${r.status}): `)
      await new Promise(r => setTimeout(r, backoffMs[attempt]))
      continue
    }
    // Non-retryable error
    const e = new Error(`HTTP ${r.status} ${routePath}: ${JSON.stringify(payload).slice(0, 400)}`)
    e.status = r.status
    e.payload = payload
    throw e
  }
  throw lastErr
}

// ── Per-(channel, domain) handlers ─────────────────────────────────
let cachedEbayConnId = null

async function handleChunk({ channel, domain, from, to, dryRun }) {
  if (dryRun) {
    return { fetched: 0, upserted: 0, failed: 0, cursor: to.toISOString(), stub: true }
  }

  const key = `${channel}-${domain}`
  switch (key) {
    case 'amazon-orders': {
      const r = await postJson('/api/amazon/orders/sync', {
        from: from.toISOString(),
        to: to.toISOString(),
      })
      return {
        fetched: r.ordersFetched ?? 0,
        upserted: r.ordersUpserted ?? 0,
        failed: r.ordersFailed ?? 0,
        cursor: to.toISOString(),
      }
    }
    case 'amazon-financial': {
      const r = await postJson('/api/amazon/financials/sync', {
        start: from.toISOString(),
        end: to.toISOString(),
      })
      return {
        fetched: (r.orderEventsFetched ?? 0) + (r.refundEventsFetched ?? 0),
        upserted: r.txCreated ?? 0,
        failed: 0,
        cursor: to.toISOString(),
      }
    }
    case 'amazon-settlement': {
      // Single-marketplace per call to stay inside Railway 30s timeout
      // (per-marketplace iteration on the route side was the killer).
      // Pass --marketplace flag to override; defaults to IT (APJ6JRA9NG5V4).
      const marketplaceId = args.marketplace || 'APJ6JRA9NG5V4'
      const r = await postJson('/api/amazon/settlements/sync', {
        from: from.toISOString(),
        to: to.toISOString(),
        marketplaceIds: [marketplaceId],
      })
      const t = r.totals ?? {}
      return {
        fetched: t.reportsListed ?? 0,
        upserted: t.reportsUpserted ?? 0,
        failed: t.errors ?? 0,
        cursor: to.toISOString(),
      }
    }
    case 'ebay-orders': {
      cachedEbayConnId ??= await getActiveEbayConnectionId()
      const r = await postJson('/api/sync/ebay/orders', {
        connectionId: cachedEbayConnId,
        from: from.toISOString(),
        to: to.toISOString(),
      })
      const s = r.summary || {}
      return {
        fetched: s.ordersFetched ?? 0,
        upserted: (s.ordersCreated ?? 0) + (s.ordersUpdated ?? 0),
        failed: s.errorCount ?? 0,
        cursor: to.toISOString(),
      }
    }
    case 'ebay-financial': {
      const r = await postJson('/api/ebay/financials/sync', {
        start: from.toISOString(),
        end: to.toISOString(),
      })
      return {
        fetched: r.transactionsFetched ?? r.fetched ?? 0,
        upserted: r.created ?? r.upserted ?? 0,
        failed: r.failed ?? 0,
        cursor: to.toISOString(),
      }
    }
    case 'amazon-returns':
    case 'ebay-returns':
      throw new Error(`Returns handler not implemented (Phase 7).`)
    default:
      throw new Error(`No handler for ${key}`)
  }
}

// ── Orchestrator ───────────────────────────────────────────────────
console.log(`\n━━━ first-backfill ${channel}-${domain} ${'━'.repeat(40)}`)
console.log(`  API:      ${API_URL}`)
console.log(`  window:   ${from.toISOString()} → ${to.toISOString()}`)
console.log(`  chunk:    ${chunkDays[`${channel}-${domain}`]} days`)
console.log(`  mode:     ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`)
console.log(`  resume:   ${args.resume ? 'YES (read checkpoint)' : 'no'}`)

const all = chunks(from, to, chunkDays[`${channel}-${domain}`])
console.log(`  chunks:   ${all.length} total`)

let startIdx = 0
if (args.resume) {
  const cp = loadCheckpoint()
  if (cp && typeof cp.completedChunks === 'number') {
    startIdx = cp.completedChunks
    console.log(`  resume:   skipping first ${startIdx} chunks (already complete per checkpoint)`)
  }
}

const summary = { fetched: 0, upserted: 0, failed: 0, chunks: 0, errors: [] }

for (let i = startIdx; i < all.length; i++) {
  const chunk = all[i]
  const tag = `${i + 1}/${all.length} [${chunk.from.toISOString().slice(0, 10)} → ${chunk.to.toISOString().slice(0, 10)}]`
  process.stdout.write(`  ${tag} ... `)
  try {
    const r = await handleChunk({ channel, domain, from: chunk.from, to: chunk.to, dryRun: args.dryRun })
    summary.fetched += r.fetched
    summary.upserted += r.upserted
    summary.failed += r.failed
    summary.chunks++
    console.log(`fetched=${r.fetched} upserted=${r.upserted} failed=${r.failed}${r.stub ? ' (STUB)' : ''}`)
    saveCheckpoint({ completedChunks: i + 1, lastCursor: r.cursor, summary })
  } catch (e) {
    console.log(`ERROR: ${e.message}`)
    summary.errors.push({ chunk: tag, error: e.message })
    saveCheckpoint({ completedChunks: i, summary })
    break
  }
}

console.log(`\n━━━ summary ${'━'.repeat(50)}`)
console.log(`  chunks processed: ${summary.chunks}/${all.length}`)
console.log(`  rows fetched:     ${summary.fetched}`)
console.log(`  rows upserted:    ${summary.upserted}`)
console.log(`  rows failed:      ${summary.failed}`)
console.log(`  errors:           ${summary.errors.length}`)
console.log(`  checkpoint:       ${checkpointFile}`)
if (summary.errors.length > 0) {
  console.log(`\n  Recoverable — resume with --resume to skip completed chunks.`)
  process.exit(1)
}
