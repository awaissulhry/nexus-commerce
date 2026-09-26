/** PE P3.0 — READ-ONLY census: which eBay model (Inventory or Trading) each active Nexus eBay item really uses, and whether
 *  Nexus's marker (`platformAttributes.__offerIds` on child listings) agrees. The marker can be erased by an old flat-file
 *  save (VTR step 0b), and an Inventory family without it would be treated as Trading — so eBay's own offers are the truth.
 *
 *    npx tsx docs/publish-everywhere/tools/ebay-inventory-probe.mts --self-test      (verdict rules, no network, no database)
 *    npx tsx docs/publish-everywhere/tools/ebay-inventory-probe.mts [--market=IT]    (production reads only)
 *
 *  Reads: the database in BEGIN READ ONLY; eBay GetItem, getOffers per SKU, inventory_item_group, bulk_get_inventory_item.
 *  Canonical clients may refresh an OAuth token and write gateway call logs; nothing else is written. Every publish gate is
 *  forced off in this process. Output: family names and counts only — never item, offer, seller or policy ids (public repo).
 *  Since 2026-09-26 the channel logins are KMS-sealed: run it on the production server (`railway ssh`, no .env there).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type SkuModel = 'inventory-this-item' | 'inventory-elsewhere' | 'none' | 'unread'
export interface ItemCensus {
  family: string; market: string; alias: boolean; nexusChildren: number; nexusMarked: number
  skus: Record<SkuModel, number>; liveListingType: string | null; liveVariations: number | null
}
/** The verdict never calls an unread SKU "fine": any unread SKU makes the item COULD-NOT-MEASURE. */
export function verdict(c: Pick<ItemCensus, 'nexusChildren' | 'nexusMarked' | 'skus'>): string {
  const inv = c.skus['inventory-this-item'], checked = inv + c.skus['inventory-elsewhere'] + c.skus.none
  if (c.skus.unread > 0 || checked === 0) return 'COULD-NOT-MEASURE'
  if (inv === checked && c.nexusMarked === c.nexusChildren && c.nexusChildren > 0) return 'INVENTORY-OK'
  if (inv === 0 && c.nexusMarked === 0) return 'TRADING-OK'
  if (inv > 0 && c.nexusMarked < inv) return 'MISMATCH-MARKER-MISSING'
  if (inv === 0 && c.nexusMarked > 0) return 'MISMATCH-MARKER-WITHOUT-OFFER'
  return 'MIXED'
}

if (process.argv.includes('--self-test')) {
  const base = { nexusChildren: 4, nexusMarked: 4, skus: { 'inventory-this-item': 4, 'inventory-elsewhere': 0, none: 0, unread: 0 } }
  const cases: [string, Parameters<typeof verdict>[0], string][] = [
    ['all Inventory, all marked', base, 'INVENTORY-OK'],
    ['Trading, unmarked', { ...base, nexusMarked: 0, skus: { ...base.skus, 'inventory-this-item': 0, none: 4 } }, 'TRADING-OK'],
    ['eBay Inventory, marker erased on 2', { ...base, nexusMarked: 2 }, 'MISMATCH-MARKER-MISSING'],
    ['eBay Inventory, marker erased on all', { ...base, nexusMarked: 0 }, 'MISMATCH-MARKER-MISSING'],
    ['marked, eBay has no offer', { ...base, skus: { ...base.skus, 'inventory-this-item': 0, none: 4 } }, 'MISMATCH-MARKER-WITHOUT-OFFER'],
    ['one SKU unread', { ...base, skus: { ...base.skus, 'inventory-this-item': 3, unread: 1 } }, 'COULD-NOT-MEASURE'],
    ['nothing checked', { ...base, skus: { 'inventory-this-item': 0, 'inventory-elsewhere': 0, none: 0, unread: 0 } }, 'COULD-NOT-MEASURE'],
    ['half on eBay Inventory', { ...base, nexusMarked: 4, skus: { ...base.skus, 'inventory-this-item': 2, none: 2 } }, 'MIXED'],
  ]
  const failed = cases.filter(([, input, want]) => verdict(input) !== want)
  for (const [name, input, want] of cases) console.log(`${verdict(input) === want ? 'ok  ' : 'FAIL'} ${name} → ${verdict(input)}`)
  process.exit(failed.length ? 1 : 0)
}

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SERVER = process.env.RAILWAY_ENVIRONMENT_NAME === 'production' && !existsSync(join(ROOT, '.env'))
const WORKSPACE = 'nexus_legacy_workspace'
const MARKET = (process.argv.find(a => a.startsWith('--market='))?.split('=')[1] ?? 'IT').toUpperCase()
const SITE: Record<string, string> = { IT: '101', DE: '77', FR: '71', ES: '186', UK: '3' }
if (!SITE[MARKET]) throw new Error(`Unknown eBay market ${MARKET}.`)
const { parse } = await import('dotenv')
const env = SERVER ? process.env as Record<string, string> : parse(readFileSync(join(ROOT, '.env'), 'utf8'))
const target = new URL(env.DATABASE_URL)
if (!/neon\.tech$/.test(target.hostname) || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '2', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0',
  NEXUS_EBAY_REAL_API: 'true', EBAY_SANDBOX: 'false', NEXUS_ENABLE_AMAZON_PUBLISH: 'false', NEXUS_ENABLE_EBAY_PUBLISH: 'false',
  NEXUS_ENABLE_SHOPIFY_PUBLISH: 'false', NEXUS_ENABLE_ETSY_PUBLISH: 'false' })
const safety = setTimeout(() => { console.error('Probe deadline (15 min) reached; partial results are not a census.'); process.exit(2) }, 15 * 60_000)
safety.unref()

type Row = { family: string; sku: string; isChild: boolean; item: string; aliasKey: string; account: string; active: boolean; marked: boolean }
async function readRows(): Promise<Row[]> {
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 20_000 })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    if ((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('Discovery is not read only.')
    await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
    return (await db.query(`SELECT f.sku AS family, p.sku, (p."parentId" IS NOT NULL) AS "isChild", l."externalListingId" AS item, l."aliasKey",
        l."channelConnectionId" AS account, (l."listingStatus"='ACTIVE') AS active, coalesce(l."platformAttributes" ? '__offerIds', false) AS marked
      FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId" JOIN "Product" f ON f.id=coalesce(p."parentId", p.id)
      JOIN "ChannelConnection" c ON c.id=l."channelConnectionId"
      WHERE l."workspaceId"=$1 AND l.channel='EBAY' AND l.marketplace=$2 AND p."deletedAt" IS NULL AND c."isActive"=true
        AND l."externalListingId" ~ '^[0-9]+$'`, [WORKSPACE, MARKET])).rows
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
}

const { withWorkspace } = await import(join(ROOT, 'apps/api/src/lib/workspace-context.js'))
await import(join(ROOT, 'apps/api/src/services/cx/connectors/index.js'))
const { default: prisma } = await import(join(ROOT, 'apps/api/src/db.js'))
const { ebayAuthService } = await import(join(ROOT, 'apps/api/src/services/ebay-auth.service.js'))
const { callTradingApi, escapeXml } = await import(join(ROOT, 'apps/api/src/services/ebay-trading-api.service.js'))
const { parseEbayItemDocument, ebayXmlObject, ebayXmlText, ebayXmlList } = await import(join(ROOT, 'apps/api/src/services/channel-drift/ebay-content-compare.js'))
const { ebaySend } = await import(join(ROOT, 'apps/api/src/services/gateway/ebay.js'))
const { ebayListingLanguage } = await import(join(ROOT, 'apps/api/src/services/gateway/channels.js'))
const API = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]) } }))
  return out
}

const census: (ItemCensus & Record<string, unknown>)[] = []
try {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const rows = await readRows()
    const items = new Map<string, Row[]>()
    for (const row of rows) { const key = `${row.account}|${row.item}|${row.aliasKey}`; items.set(key, [...(items.get(key) ?? []), row]) }
    const tokens = new Map<string, string>(), lang = await ebayListingLanguage(MARKET)
    const token = async (account: string) => tokens.get(account) ?? tokens.set(account, await ebayAuthService.getValidToken(account)).get(account)!
    for (const group of items.values()) {
      if (!group.some(r => r.active)) continue
      const { family, item, account, aliasKey } = group[0]
      const children = group.filter(r => r.isChild)
      const oauthToken = await token(account)
      const headers = { Authorization: `Bearer ${oauthToken}`, Accept: 'application/json', 'Content-Language': lang, 'Accept-Language': lang }
      // 1. What buyers see: listing type, variations, sales per variation, item specifics.
      let live: Record<string, unknown> = {}, readError: string | null = null
      try {
        const answer = await callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(item)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
          { oauthToken, siteId: SITE[MARKET], connectionId: account, market: MARKET })
        if (!answer.raw || !['Success', 'Warning'].includes(answer.ack)) readError = 'GetItem not acknowledged'
        else live = parseEbayItemDocument(answer.raw)
      } catch (error) { readError = `GetItem ${error instanceof Error ? error.name : 'failure'}` }
      const variations = ebayXmlList(ebayXmlObject(live.Variations).Variation).map(ebayXmlObject)
      const liveSkus = variations.map(v => ebayXmlText(v.SKU)).filter((s): s is string => !!s)
      const sold = variations.filter(v => Number(ebayXmlText(ebayXmlObject(v.SellingStatus).QuantitySold) ?? 0) > 0).length
      // 2. eBay's own model per SKU: an offer PUBLISHED on this very item = Inventory-managed.
      const skus = [...new Set([...children.map(r => r.sku), ...liveSkus])]
      const models: Record<SkuModel, number> = { 'inventory-this-item': 0, 'inventory-elsewhere': 0, none: 0, unread: 0 }
      const otherMarkets: Record<string, number> = {}
      await pool(skus, 4, async sku => {
        try {
          const res = await ebaySend(account, `${API}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=100`, { headers })
          if (res.status === 404 || res.status === 400) { const body = await res.text(); models[/25713|not available|not found|no offer/i.test(body) || res.status === 404 ? 'none' : 'unread']++; return }
          if (!res.ok) { models.unread++; return }
          const offers = ((await res.json()) as { offers?: { marketplaceId?: string; status?: string; listing?: { listingId?: string } }[] }).offers ?? []
          for (const offer of offers) if (offer.marketplaceId !== `EBAY_${MARKET}`) otherMarkets[`${offer.marketplaceId}:${offer.status}`] = (otherMarkets[`${offer.marketplaceId}:${offer.status}`] ?? 0) + 1
          models[offers.some(o => o.status === 'PUBLISHED' && o.listing?.listingId === item) ? 'inventory-this-item' : offers.length ? 'inventory-elsewhere' : 'none']++
        } catch { models.unread++ }
      })
      // 3. The Inventory group (only where eBay says Inventory): does its key equal the parent SKU, do its variants match Nexus?
      let groupFacts: Record<string, unknown> | null = null
      if (models['inventory-this-item'] > 0) {
        const res = await ebaySend(account, `${API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(family)}`, { headers }).catch(() => null)
        if (res?.ok) {
          const g = await res.json() as { variantSKUs?: string[]; aspects?: Record<string, unknown>; imageUrls?: string[]; description?: string; variesBy?: { specifications?: { name: string; values: string[] }[] } }
          const nexusSkus = new Set(children.map(r => r.sku)), groupSkus = new Set(g.variantSKUs ?? [])
          groupFacts = { keyIsParentSku: true, variants: groupSkus.size, missingInNexus: [...groupSkus].filter(s => !nexusSkus.has(s)).length,
            missingOnEbay: [...nexusSkus].filter(s => !groupSkus.has(s)).length, axes: (g.variesBy?.specifications ?? []).map(s => `${s.name}(${s.values.length})`),
            groupAspects: Object.keys(g.aspects ?? {}).length, images: (g.imageUrls ?? []).length, descriptionChars: (g.description ?? '').length }
        } else {
          // The key is not stored in Nexus; ask the items which group they belong to.
          const first = skus.slice(0, 25).map(sku => ({ sku }))
          const bulk = await ebaySend(account, `${API}/sell/inventory/v1/bulk_get_inventory_item`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: first }) }).catch(() => null)
          const groups = bulk?.ok ? new Set(((await bulk.json()) as { responses?: { inventoryItem?: { groupIds?: string[] } }[] }).responses?.flatMap(r => r.inventoryItem?.groupIds ?? []) ?? []) : null
          groupFacts = { keyIsParentSku: false, groupGetStatus: res?.status ?? 'error', distinctGroupsOnItems: groups ? groups.size : 'unread' }
        }
      }
      const row = { family, market: MARKET, alias: aliasKey !== '', nexusChildren: children.length, nexusMarked: children.filter(r => r.marked).length,
        skus: models, liveListingType: ebayXmlText(live.ListingType), liveVariations: readError ? null : variations.length, variantsWithSales: readError ? null : sold,
        itemSpecifics: readError ? null : ebayXmlList(ebayXmlObject(live.ItemSpecifics).NameValueList).length, readError, otherMarketOffers: otherMarkets, group: groupFacts }
      census.push({ ...row, verdict: verdict(row) })
    }
  })
  const by = (v: string) => census.filter(c => c.verdict === v).length
  console.log(JSON.stringify({ probe: 'pe-p3.0-ebay-inventory', market: MARKET, workspace: WORKSPACE, at: new Date().toISOString(),
    totals: { items: census.length, inventoryOk: by('INVENTORY-OK'), tradingOk: by('TRADING-OK'), mismatch: census.filter(c => String(c.verdict).startsWith('MISMATCH')).length,
      mixed: by('MIXED'), couldNotMeasure: by('COULD-NOT-MEASURE') }, items: census }, null, 2))
} finally {
  clearTimeout(safety); await prisma.$disconnect().catch(() => {})
}
process.exit(0)
