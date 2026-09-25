// PCO-3: bounded content reads only. Discovery transaction is READ ONLY; canonical read clients may refresh OAuth and log calls.
// No listing mutation is imported or invoked. The process disables every listing write gate.
// Prediction: a 21-SKU Amazon IT family reads at concurrency five in <10 seconds; one eBay Trading item returns its own ID/content.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { parse } from 'dotenv'
import pg from 'pg'

const ROOT = '/Users/awais/nexus-commerce'
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (!/neon\.tech$/.test(target.hostname) || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '4', NEXUS_EBAY_REAL_API: 'true',
  NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0', NEXUS_ENABLE_AMAZON_PUBLISH: 'false', NEXUS_ENABLE_EBAY_PUBLISH: 'false', NEXUS_ENABLE_SHOPIFY_PUBLISH: 'false' })
const deadline = setTimeout(() => { console.error('Content read probe exceeded its 120-second bound.'); process.exit(1) }, 120_000)
deadline.unref()
const db = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 15_000 })
await db.connect()
let amazonRows: any[], ebayRow: any
try {
  await db.query('BEGIN READ ONLY')
  const amazon = await db.query(`WITH families AS (
    SELECT coalesce(p."parentId",p.id) AS family, l."channelConnectionId" AS account, count(*) AS n
    FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId"
    WHERE l.channel='AMAZON' AND l.marketplace='IT' AND l."aliasKey"='' AND l."externalListingId" IS NOT NULL
      AND l."channelConnectionId" IS NOT NULL AND l."offerClosedAt" IS NULL AND p."deletedAt" IS NULL
    GROUP BY 1,2 HAVING count(*)=21 ORDER BY 1 LIMIT 1)
    SELECT l.id,l."productId",l."channelConnectionId" AS account,l."externalListingId",p.sku,l."platformAttributes",l."flatFileSnapshot"
    FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId" JOIN families f ON f.family=coalesce(p."parentId",p.id) AND f.account=l."channelConnectionId"
    WHERE l.channel='AMAZON' AND l.marketplace='IT' AND l."aliasKey"='' AND l."externalListingId" IS NOT NULL
      AND l."offerClosedAt" IS NULL AND p."deletedAt" IS NULL ORDER BY p.sku`)
  amazonRows = amazon.rows
  ebayRow = (await db.query(`SELECT l.id,l."channelConnectionId" AS account,l."externalListingId" AS item,p.sku
    FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId"
    WHERE l.channel='EBAY' AND l.marketplace='IT' AND l."externalListingId" IS NOT NULL AND l."channelConnectionId" IS NOT NULL
      AND p."deletedAt" IS NULL AND l."isPublished"=true AND coalesce(l."platformAttributes"->>'inventoryItemGroupKey','')=''
    ORDER BY p.sku LIMIT 1`)).rows[0]
  await db.query('ROLLBACK')
} finally { await db.end() }
const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const report: any = { at: new Date().toISOString(), discoveryReadOnly: true, channelMutations: 0, amazon: {}, ebay: {} }
try {
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    if (amazonRows.length !== 21) throw new Error(`Expected one 21-SKU family; discovered ${amazonRows.length}.`)
    const account = amazonRows[0].account
    const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
    const { getAmazonSellerId, getAmazonRegion } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
    const client = new AmazonSpApiClient({ id: account, region: await getAmazonRegion(account) })
    const sellerId = await getAmazonSellerId(account)
    const listingIds = amazonRows.map(r => r.id)
    const offers = await prisma.offer.findMany({ where: { channelListingId: { in: listingIds }, isActive: true }, select: { channelListingId: true, sku: true } })
    let next = 0
    const results: any[] = [], started = performance.now()
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (next < amazonRows.length) {
        const index = next++, row = amazonRows[index], pa = row.platformAttributes ?? {}, flat = row.flatFileSnapshot ?? {}
        const identities = [...new Set([...offers.filter(o => o.channelListingId === row.id).map(o => o.sku), pa.sellerSku, pa.seller_sku, pa.sku, pa.item_sku, flat.item_sku].filter(Boolean))]
        if (identities.length > 1) throw new Error(`${row.sku}: seller SKU identity is ambiguous.`)
        const sku = identities[0] ?? row.sku, at = performance.now()
        const response = await client.getListingsItem({ sellerId, sku, marketplaceId: 'APJ6JRA9NG5V4', includedData: ['summaries', 'attributes'] })
        const raw = response.rawResponse as any
        results[index] = { sku, success: response.success, seconds: Number(((performance.now()-at)/1000).toFixed(3)),
          matchingSku: raw?.sku === sku, roots: Object.keys(raw?.attributes ?? {}).length,
          productType: raw?.summaries?.find((s: any) => s.marketplaceId === 'APJ6JRA9NG5V4')?.productType ?? null, error: response.error ?? null }
      }
    }))
    report.amazon = { account, concurrency: 5, seconds: Number(((performance.now()-started)/1000).toFixed(3)), results }
    if (!ebayRow) throw new Error('No existing eBay item found.')
    const { ebayAuthService } = await import(`${ROOT}/apps/api/src/services/ebay-auth.service.js`)
    const { callTradingApi, escapeXml } = await import(`${ROOT}/apps/api/src/services/ebay-trading-api.service.js`)
    const { parseEbayItemDocument, ebayXmlText, ebayContentFromItem } = await import(`${ROOT}/apps/api/src/services/channel-drift/ebay-content-compare.js`)
    const oauthToken = await ebayAuthService.getValidToken(ebayRow.account), at = performance.now()
    const response = await callTradingApi('GetItem', `<?xml version="1.0"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(ebayRow.item)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`, { oauthToken, siteId: 101, connectionId: ebayRow.account, market: 'IT' })
    const item = parseEbayItemDocument(response.raw ?? ''), content = ebayContentFromItem(item)
    report.ebay = { account: ebayRow.account, sku: ebayRow.sku, itemId: ebayRow.item, matchingItem: ebayXmlText(item.ItemID) === ebayRow.item,
      seconds: Number(((performance.now()-at)/1000).toFixed(3)), title: content.title, aspects: Object.keys(content.itemSpecifics).length, ack: response.ack }
  })
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally { await prisma.$disconnect() }
try {
  const pushing = execSync('ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \\.githooks/pre-push"', { encoding: 'utf8', shell: '/bin/zsh' })
  if (pushing.trim()) throw new Error('Push active; refusing evidence write.')
} catch (error: any) { if (error.status !== 1 || error.stderr?.toString().trim()) throw error }
writeFileSync(`${ROOT}/docs/publish-changes-only/records/pco3-live-reads-c5.json`, JSON.stringify(report, null, 2)+'\n')
console.log(JSON.stringify(report))
process.exit(process.exitCode ?? 0)
