// PLAN Step 1.3 (R-42) — prove the BUILT eBay unpublish live on ONE single-SKU item, and read the eBay call limits A-39 b2 needs.
//   npx tsx docs/product-cheat/tools/ebay-single-probe.mts                                          # the plan only
//   npx tsx docs/product-cheat/tools/ebay-single-probe.mts --read                                   # READ: candidates, preference, call limits
//   npx tsx docs/product-cheat/tools/ebay-single-probe.mts --read --record <f>                      # READ + compare with a saved read
//   npx tsx docs/product-cheat/tools/ebay-single-probe.mts --test --record <f> --execute-approved   # the adapter → read back → restore → read back
// The live step calls `dispatchChannelDelist` (the code that ships) with an in-memory UNPUBLISH_LISTING job: no queue row and
// no Nexus row is written. The restore is one ReviseInventoryStatus with the saved quantity.
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'

const ROOT = '/Users/awais/nexus-commerce'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const mode = argv.includes('--read') ? 'read' : argv.includes('--test') ? 'test' : 'plan'
const execute = argv.includes('--execute-approved')
console.log(JSON.stringify({ step: 'PLAN Step 1.3 / R-42 — eBay single-SKU unpublish, live, one item', mode, execute,
  sideEffects: 'read: GetItem (≤ 80), GetUserPreferences, GetApiAccessRules. test: the adapter (one GetItem + one ReviseInventoryStatus to 0), one ReviseInventoryStatus back. No Nexus row.' }, null, 1))
if (mode === 'plan' || (mode === 'test' && !execute)) process.exit(0)

const deadline = setTimeout(() => { console.error('Probe stopped at its bound; no result claimed — RE-READ the item before concluding (an UNKNOWN outcome).'); process.exit(1) }, 300_000)
deadline.unref()
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DATABASE_POOL_MAX = '2'
process.env.NEXUS_EBAY_REAL_API = 'true' // without it the client fakes success
// The eBay write gate is closed in this machine's env. Opened ONLY for the Owner-approved live test (R-42).
if (execute && mode === 'test') { process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'; process.env.EBAY_PUBLISH_MODE = 'live' }

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const { ebayAuthService } = await import(`${ROOT}/apps/api/src/services/ebay-auth.service.js`)
const trading = await import(`${ROOT}/apps/api/src/services/ebay-trading-api.service.js`)
const delist = await import(`${ROOT}/apps/api/src/services/channel-delist.service.js`)

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const tag = (raw: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(raw)?.[1] ?? null
// The adapter's own GetItem shape (channel-delist.service.ts buildUnpublishGetItemXml, not exported).
const getItemXml = (itemId: string) => `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><OutputSelector>Item.ItemID,Item.Quantity,Item.SellingStatus.QuantitySold,Item.SellingStatus.ListingStatus,Item.Variations.Variation.SKU,Item.Variations.Variation.Quantity,Item.Variations.Variation.SellingStatus.QuantitySold,Item.OutOfStockControl</OutputSelector></GetItemRequest>`
const report: Record<string, unknown> = { at: new Date().toISOString(), mode, execute }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

try {
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const readItem = async (ctx: { oauthToken: string; siteId: number; connectionId: string }, itemId: string) => {
      const raw = (await trading.callTradingApi('GetItem', getItemXml(itemId), ctx)).raw ?? ''
      const q = trading.parseGetItemQuantities(raw)
      return { itemId: tag(raw, 'ItemID'), ack: tag(raw, 'Ack'), listingStatus: q.listingStatus, outOfStockControl: tag(raw, 'OutOfStockControl'),
        variations: q.variations.length, remaining: q.itemAvailable }
    }
    if (mode === 'read') {
      const listings = await prisma.channelListing.findMany({
        where: { channel: 'EBAY', marketplace: 'IT', externalListingId: { not: null }, channelConnectionId: { not: null }, isPublished: true,
          product: { deletedAt: null, parentId: null, NOT: { sku: { startsWith: 'AIREON' } } } },
        select: { externalListingId: true, channelConnectionId: true, product: { select: { sku: true, productType: true } } }, orderBy: { updatedAt: 'desc' }, take: 1000 })
      const seen = new Set<string>()
      const unique = listings.filter(l => !seen.has(l.externalListingId!) && seen.add(l.externalListingId!))
      if (!unique.length) throw new Error('no live eBay·IT listing')
      const account = unique[0].channelConnectionId!
      const ctx = { oauthToken: await ebayAuthService.getValidToken(account), siteId: 101, connectionId: account }
      const prefs = (await trading.callTradingApi('GetUserPreferences', `<?xml version="1.0" encoding="utf-8"?><GetUserPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference></GetUserPreferencesRequest>`, ctx)).raw ?? ''
      report.preference = { ack: tag(prefs, 'Ack'), outOfStockControlPreference: tag(prefs, 'OutOfStockControlPreference') }
      // GetApiAccessRules answers HTTP 410 (retired, measured 2026-09-23 22:46 UTC). Its replacement is the Developer
      // Analytics API; both reads are non-fatal — a failure is recorded, not thrown.
      const limitsRead = async (path: string) => {
        try {
          const res = await fetch(`https://api.ebay.com/developer/analytics/v1_beta/${path}?api_name=TradingAPI&api_context=TradingAPI`, { headers: { Authorization: `Bearer ${ctx.oauthToken}` } })
          const body = await res.json().catch(() => null) as any
          const resources = (body?.rateLimits ?? []).flatMap((r: any) => (r.resources ?? []).map((x: any) => ({ api: r.apiName, name: x.name, rates: x.rates })))
          return { http: res.status, errors: body?.errors?.map((e: any) => e.message).slice(0, 2) ?? null,
            resources: resources.filter((x: any) => /^(TradingAPI|GetItem|ReviseInventoryStatus|GetUserPreferences)$/i.test(String(x.name))).concat(resources.length > 12 ? [] : resources).slice(0, 12) }
        } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
      }
      report.callLimits = { user: await limitsRead('user_rate_limit/'), app: await limitsRead('rate_limit/') }
      const saved = flag('record')
      if (saved) {
        const before = JSON.parse(readFileSync(saved, 'utf8'))
        const now = await readItem({ ...ctx, connectionId: before.account }, before.itemId)
        report.compare = { before: before.item, now, remainingEqual: now.remaining === before.item.remaining, statusEqual: now.listingStatus === before.item.listingStatus }
        return
      }
      const candidatesRead: unknown[] = []
      report.uniqueItemIds = unique.length
      for (const l of unique.slice(0, 80)) {
        if (l.product.productType === 'EBAY_LISTING_SHELL') continue
        if (l.channelConnectionId !== account) continue
        const item = await readItem(ctx, l.externalListingId!)
        candidatesRead.push({ sku: l.product.sku, type: l.product.productType, ...item })
        if (item.variations === 0 && item.listingStatus === 'Active' && item.outOfStockControl === 'true' && (item.remaining ?? 0) > 0) {
          const path = `${ROOT}/docs/product-cheat/records/step-1.3-ebay-single-before-${stamp}.json`
          writeFileSync(path, JSON.stringify({ itemId: l.externalListingId, account, productSku: l.product.sku, item, preference: report.preference, readAt: report.at }, null, 1))
          report.candidate = { itemId: l.externalListingId, productSku: l.product.sku, item }
          report.record = path
          break
        }
      }
      report.candidatesRead = candidatesRead
      if (!report.candidate) report.candidate = { none: 'no single-SKU Active item with stock and out-of-stock control on among those read' }
      return
    }

    // TEST — the item must be exactly as saved.
    const record = JSON.parse(readFileSync(flag('record') ?? '', 'utf8'))
    const ctx = { oauthToken: await ebayAuthService.getValidToken(record.account), siteId: 101, connectionId: record.account }
    const before = await readItem(ctx, record.itemId)
    report.before = before
    if (before.variations !== 0 || before.listingStatus !== 'Active' || before.outOfStockControl !== 'true' || before.remaining !== record.item.remaining || !(before.remaining! > 0)) {
      throw new Error(`not the saved safe state — nothing sent: ${JSON.stringify(before)}`)
    }
    try {
      report.adapter = await delist.dispatchChannelDelist({ queueId: `product-cheat-probe-${stamp}`, productId: null, channelListingId: null, targetChannel: 'EBAY',
        targetRegion: 'IT', externalListingId: record.itemId, channelConnectionId: record.account, syncType: 'UNPUBLISH_LISTING',
        payload: { channelConnectionId: record.account, source: 'product-cheat-probe', channelAction: 'unpublish' } } as never)
      await wait(15_000)
      report.afterUnpublish = await readItem(ctx, record.itemId)
    } finally {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents"><InventoryStatus><ItemID>${record.itemId}</ItemID><Quantity>${before.remaining}</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`
      const r = await trading.callTradingApi('ReviseInventoryStatus', xml, ctx)
      report.restore = { ack: r.ack, errors: (r.errors ?? []).slice(0, 3) }
      await wait(15_000)
      report.afterRestore = await readItem(ctx, record.itemId)
      report.restored = (report.afterRestore as { remaining: number | null }).remaining === before.remaining
    }
  })
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
{
  const path = `${ROOT}/docs/product-cheat/records/step-1.3-ebay-single-${mode}${mode === 'read' && flag('record') ? '-compare' : ''}-${stamp}.json`
  writeFileSync(path, JSON.stringify(report, null, 1))
  report.recordWritten = path
}
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
