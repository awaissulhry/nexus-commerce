// E0 read-only probe: eBay connection health, Marketing API scope test,
// existing PL campaigns, listing census, size-aspect sample. NO WRITES.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
const prisma = new PrismaClient()

const out = (s) => console.log(s)

// ── 1. Connection health (no secret values printed) ─────────────────────────
out('════════ 1. eBay ChannelConnection health ════════')
const conns = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY' },
  select: { id: true, marketplace: true, managedBy: true, isActive: true, tokenExpiresAt: true, lastSyncAt: true, displayName: true, accessToken: true, refreshToken: true, createdAt: true, updatedAt: true },
})
for (const c of conns) {
  out(`  conn …${c.id.slice(-6)} active=${c.isActive} managedBy=${c.managedBy} marketplace=${c.marketplace ?? 'null(multi)'} display=${c.displayName ?? '—'}`)
  out(`    tokenExpiresAt=${c.tokenExpiresAt?.toISOString() ?? 'null'} lastSyncAt=${c.lastSyncAt?.toISOString() ?? 'null'} hasAccess=${!!c.accessToken} hasRefresh=${!!c.refreshToken} updatedAt=${c.updatedAt.toISOString()}`)
}
const conn = conns.find(c => c.isActive)
if (!conn) { out('  !! no active EBAY connection'); process.exit(1) }

// ── 2. Token (refresh only if expired; refresh is routine, not a state change)
let tok = conn.accessToken
if (!tok || (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) <= new Date())) {
  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  if (!r.ok) { out(`  !! token refresh failed: HTTP ${r.status}`); process.exit(1) }
  const j = await r.json()
  tok = j.access_token
  out(`  (token refreshed in-memory; expires_in=${j.expires_in}s; scope field present=${!!j.scope})`)
  if (j.scope) out(`  granted scopes: ${j.scope}`)
}

// ── 3. Marketing API probe: GET ad_campaign (read-only) ─────────────────────
out('\n════════ 2. Marketing API scope probe + existing campaigns ════════')
const r = await fetch('https://api.ebay.com/sell/marketing/v1/ad_campaign?limit=100', {
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
})
out(`  GET /sell/marketing/v1/ad_campaign → HTTP ${r.status}`)
if (r.status === 403) {
  const body = await r.text()
  out(`  403 body (first 400 chars): ${body.slice(0, 400)}`)
  out('  ⇒ token likely missing sell.marketing scope — re-consent required')
} else if (r.ok) {
  const j = await r.json()
  out(`  total=${j.total ?? '?'} campaigns returned=${j.campaigns?.length ?? 0}`)
  for (const c of (j.campaigns ?? [])) {
    const fs = c.fundingStrategy ?? {}
    out(`  • ${c.campaignId} "${c.campaignName}" status=${c.campaignStatus} market=${c.marketplaceId} funding=${fs.fundingModel ?? '?'} rate=${fs.bidPercentage ?? '—'} targeting=${c.campaignTargetingType ?? '—'} channels=${JSON.stringify(c.channels ?? [])} start=${c.startDate ?? '?'} end=${c.endDate ?? 'none'}`)
    if (c.budget) out(`      budget=${JSON.stringify(c.budget)}`)
    if (c.campaignCriterion) out(`      criterion: autoSelect=${c.campaignCriterion.autoSelectFutureInventory ?? '?'} rules=${(c.campaignCriterion.selectionRules ?? []).length}`)
  }
} else {
  out(`  body (first 400): ${(await r.text()).slice(0, 400)}`)
}

// ── 4. Listing census ────────────────────────────────────────────────────────
out('\n════════ 3. eBay listing census (DB) ════════')
const byMkt = await prisma.channelListing.groupBy({
  by: ['marketplace', 'listingStatus'],
  where: { channel: 'EBAY' },
  _count: { _all: true },
})
for (const g of byMkt.sort((a, b) => (a.marketplace + a.listingStatus).localeCompare(b.marketplace + b.listingStatus))) {
  out(`  ${g.marketplace} ${g.listingStatus}: ${g._count._all}`)
}
const live = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', listingStatus: 'ACTIVE' },
  select: { id: true, productId: true, marketplace: true, externalListingId: true, offerActive: true, platformAttributes: true, product: { select: { sku: true, name: true } } },
})
out(`  ACTIVE rows total=${live.length}`)
const withItem = live.filter(l => l.externalListingId)
out(`  ACTIVE with externalListingId=${withItem.length}, distinct itemIds=${new Set(withItem.map(l => l.externalListingId)).size}, distinct products=${new Set(withItem.map(l => l.productId)).size}`)
// products with multiple live item IDs on the same marketplace (shared-SKU fanout)
const byProdMkt = new Map()
for (const l of withItem) {
  const k = `${l.productId}|${l.marketplace}`
  byProdMkt.set(k, (byProdMkt.get(k) ?? new Set()).add(l.externalListingId))
}
const multi = [...byProdMkt.entries()].filter(([, s]) => s.size > 1)
out(`  product×marketplace combos with >1 live itemId: ${multi.length}`)
for (const [k, s] of multi.slice(0, 8)) out(`    ${k.split('|')[1]} product …${k.split('|')[0].slice(-6)} → ${[...s].join(', ')}`)

// ── 5. Size-aspect sample from platformAttributes.itemSpecifics ─────────────
out('\n════════ 4. Size-aspect sample (apparel compliance) ════════')
let withSpecifics = 0, withSizeKey = 0
const sizeKeyNames = new Set(); const sampleVals = []
for (const l of live) {
  const pa = l.platformAttributes ?? {}
  const specifics = pa.itemSpecifics ?? pa.item_specifics ?? null
  if (!specifics) continue
  withSpecifics++
  const entries = Array.isArray(specifics) ? specifics.map(s => [s.name ?? s.Name, s.value ?? s.Value]) : Object.entries(specifics)
  const sizeEntry = entries.find(([k]) => /^(taglia|size|größe|talla|taille)/i.test(String(k)))
  if (sizeEntry) {
    withSizeKey++
    sizeKeyNames.add(String(sizeEntry[0]))
    if (sampleVals.length < 12) sampleVals.push(`${l.product.sku} [${l.marketplace}] ${sizeEntry[0]}=${JSON.stringify(sizeEntry[1]).slice(0, 60)}`)
  }
}
out(`  ACTIVE eBay rows with stored itemSpecifics: ${withSpecifics}/${live.length}`)
out(`  …of those, rows with a size-like key: ${withSizeKey} (keys seen: ${[...sizeKeyNames].join(', ') || 'none'})`)
for (const s of sampleVals) out(`    ${s}`)
if (withSpecifics === 0) out('  ⇒ itemSpecifics not stored in DB — size audit needs a live GetItem sample (defer to follow-up probe)')

await prisma.$disconnect()
