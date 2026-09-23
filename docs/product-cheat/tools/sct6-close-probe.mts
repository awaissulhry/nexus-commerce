// PLAN Step 1.3 (A-38, R-38) — prove SCT.6's Amazon per-market offer CLOSE and its REPLAY live on ONE merchant-only listing,
// channel only: the same calls `services/amazon-market-offer.service.ts` sends, and NO listing / product / queue row written.
//   npx tsx docs/product-cheat/tools/sct6-close-probe.mts                                          # the plan only
//   npx tsx docs/product-cheat/tools/sct6-close-probe.mts --read [--record <f>]                    # READ (+ compare to a saved record)
//   npx tsx docs/product-cheat/tools/sct6-close-probe.mts --preview --record <f>                   # Amazon VALIDATION_PREVIEW of both patches
//   npx tsx docs/product-cheat/tools/sct6-close-probe.mts --test --record <f> --execute-approved   # close → read back → replay → read back
//   npx tsx docs/product-cheat/tools/sct6-close-probe.mts --restore --record <f> --execute-approved  # recovery: replay the saved offer
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'

const ROOT = '/Users/awais/nexus-commerce'
const SKU = 'xracingbxn48'
const ASIN = 'B0BTCBPVTS'
const MARKET = 'IT'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const mode = argv.includes('--read') ? 'read' : argv.includes('--preview') ? 'preview' : argv.includes('--test') ? 'test' : argv.includes('--restore') ? 'restore' : 'plan'
const execute = argv.includes('--execute-approved')
console.log(JSON.stringify({ step: 'PLAN Step 1.3 / A-38 — SCT.6 close + replay, live, one listing, channel only', sku: SKU, market: MARKET, mode, execute,
  sideEffects: 'read/preview: none (VALIDATION_PREVIEW is a read). test: TWO PATCHes of purchasable_offer on one listing in one market. No Nexus listing/product/queue row; the gateway call log and a token refresh only.' }, null, 1))
if (mode === 'plan' || ((mode === 'test' || mode === 'restore') && !execute)) process.exit(0)

const deadline = setTimeout(() => { console.error('Probe stopped at its bound; no result claimed — RE-READ the listing before concluding (an UNKNOWN outcome).'); process.exit(1) }, mode === 'test' ? 480_000 : 240_000)
deadline.unref()
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DATABASE_POOL_MAX = '2'
// The publish gate is closed in this machine's env. Opened ONLY for an Owner-approved live run (R-38).
if (execute && (mode === 'test' || mode === 'restore')) { process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'true'; process.env.AMAZON_PUBLISH_MODE = 'live' }

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const { amazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
const { getAmazonSellerId } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
const { MARKETPLACE_ID_MAP } = await import(`${ROOT}/apps/api/src/services/amazon/flat-file.service.js`)
const { amazonContentRefusal } = await import(`${ROOT}/apps/api/src/services/amazon/validate-before-send.js`)

type Offer = Record<string, unknown>
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)
// SCT.6's own rule (`offerInstancesFor`, not exported): this marketplace's instances, or the only one there is.
const offerInstancesFor = (attrs: any, marketplaceId: string): Offer[] => {
  const po = attrs?.purchasable_offer
  if (!Array.isArray(po)) return []
  return po.filter((x: Offer) => x && (x.marketplace_id === marketplaceId || po.length === 1))
}
// SCT.6's close selector, verbatim in shape.
const selectorFor = (offers: Offer[], marketplaceId: string) => offers.map(x => ({ marketplace_id: marketplaceId, ...(x.currency ? { currency: x.currency } : {}), ...(x.audience ? { audience: x.audience } : {}) }))

const report: Record<string, unknown> = { at: new Date().toISOString(), mode, execute }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
try {
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const rows = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', product: { sku: SKU } },
      select: { id: true, marketplace: true, channelConnectionId: true, fulfillmentMethod: true, offerClosedAt: true, offerActive: true, externalListingId: true, isPublished: true,
        followMasterQuantity: true, quantityOverride: true, syncPaused: true, quantity: true, price: true,
        product: { select: { sku: true, fulfillmentMethod: true, productType: true } }, offers: { where: { isActive: true }, select: { sku: true } } } })
    const it = rows.find(r => r.marketplace.toUpperCase() === MARKET)
    if (!it) throw new Error(`no Amazon·${MARKET} listing row for ${SKU}`)
    if (!it.channelConnectionId) throw new Error('the listing names no Amazon account')
    const sellerId = await getAmazonSellerId(it.channelConnectionId)
    const itId = MARKETPLACE_ID_MAP[MARKET]
    const readMarket = async (code: string) => {
      const marketplaceId = MARKETPLACE_ID_MAP[code.toUpperCase()]
      if (!marketplaceId) return { market: code, error: 'unknown marketplace' }
      const r = await amazonSpApiClient.getListingsItem({ sellerId, sku: SKU, marketplaceId, includedData: ['attributes', 'summaries'] } as never) as any
      const raw = r.rawResponse ?? {}
      const fa = (raw.attributes?.fulfillment_availability ?? []) as Array<{ fulfillment_channel_code?: string; quantity?: number }>
      return { market: code, marketplaceId, success: r.success, asin: r.asin ?? null, status: raw.summaries?.[0]?.status ?? null, productType: raw.summaries?.[0]?.productType ?? null,
        fulfillment: fa.map(f => ({ code: f.fulfillment_channel_code, quantity: f.quantity ?? null })), offers: offerInstancesFor(raw.attributes, marketplaceId),
        offerRawCount: Array.isArray(raw.attributes?.purchasable_offer) ? raw.attributes.purchasable_offer.length : 0, error: r.error ?? null }
    }
    const readAll = async () => { const out: Record<string, unknown> = {}; for (const r of rows) out[r.marketplace.toUpperCase()] = await readMarket(r.marketplace); return out as Record<string, any> }

    if (mode === 'read') {
      const now = await readAll()
      report.db = rows.map(r => ({ market: r.marketplace, fulfillmentMethod: r.fulfillmentMethod ?? r.product.fulfillmentMethod, offerClosedAt: r.offerClosedAt, offerActive: r.offerActive,
        followMasterQuantity: r.followMasterQuantity, quantityOverride: r.quantityOverride, syncPaused: r.syncPaused, quantity: r.quantity, price: r.price, offerSkus: r.offers.map(o => o.sku), productSku: r.product.sku, account: r.channelConnectionId }))
      report.live = now
      const itLive = now[MARKET]
      const checks = {
        asin: itLive.asin === ASIN,
        merchantOnly: itLive.fulfillment.length > 0 && itLive.fulfillment.every((f: { code?: string }) => f.code === 'DEFAULT'),
        oneItOffer: itLive.offers.length === 1 && itLive.offers[0].marketplace_id === itId,
        notClosedInNexus: it.offerClosedAt === null,
        notFba: (it.fulfillmentMethod ?? it.product.fulfillmentMethod) !== 'FBA',
        amazonSkuIsProductSku: it.offers.every(o => o.sku === it.product.sku),
      }
      report.checks = checks
      const saved = flag('record')
      if (saved) {
        const before = JSON.parse(readFileSync(saved, 'utf8'))
        report.compare = Object.fromEntries(Object.keys(before.live).map(k => [k, {
          offerEqual: canon(before.live[k].offers) === canon(now[k]?.offers), fulfillmentEqual: canon(before.live[k].fulfillment) === canon(now[k]?.fulfillment),
          statusBefore: before.live[k].status, statusNow: now[k]?.status }]))
      } else {
        const path = `${ROOT}/docs/product-cheat/records/step-1.3-sct6-before-${stamp}.json`
        writeFileSync(path, JSON.stringify({ sku: SKU, asin: ASIN, market: MARKET, sellerAccount: it.channelConnectionId, readAt: report.at, checks, db: report.db, live: now }, null, 1))
        report.record = path
      }
      return
    }

    const record = JSON.parse(readFileSync(flag('record') ?? '', 'utf8'))
    if (record.sku !== SKU || record.market !== MARKET) throw new Error('the record is for another listing')
    if (Object.values(record.checks as Record<string, boolean>).some(v => v !== true)) throw new Error(`the saved read failed a safety check: ${JSON.stringify(record.checks)}`)
    const snapshot: Offer[] = record.live[MARKET].offers
    const productType: string = String(record.live[MARKET].productType ?? '').toUpperCase()
    if (snapshot.length === 0 || !productType) throw new Error('no usable snapshot in the record')
    const deletePatch = { op: 'delete', path: '/attributes/purchasable_offer', value: selectorFor(snapshot, itId) }
    const replacePatch = { op: 'replace', path: '/attributes/purchasable_offer', value: snapshot }
    report.patches = { close: deletePatch, replay: replacePatch }
    const preview = async () => ({
      close: await amazonContentRefusal({ sellerId, sku: SKU, marketplaceId: itId, productType, patches: [deletePatch] }),
      replay: await amazonContentRefusal({ sellerId, sku: SKU, marketplaceId: itId, productType, patches: [replacePatch] }),
    })

    if (mode === 'preview') { report.preview = await preview(); return }

    const replayAndReadBack = async () => {
      const attempts: unknown[] = []
      let res = await amazonSpApiClient.patchPurchasableOffer({ sellerId, sku: SKU, marketplaceId: itId, productType, op: 'replace', value: snapshot })
      attempts.push(res)
      if (!res.success) { await wait(15_000); res = await amazonSpApiClient.patchPurchasableOffer({ sellerId, sku: SKU, marketplaceId: itId, productType, op: 'replace', value: snapshot }); attempts.push(res) }
      const reads: unknown[] = []
      for (let i = 0; i < 12 && res.success; i++) {
        await wait(15_000)
        const r = await readMarket(MARKET)
        const equal = canon(r.offers) === canon(snapshot)
        reads.push({ afterSeconds: (i + 1) * 15, offers: r.offers, fulfillment: r.fulfillment, status: r.status, equal })
        if (equal) break
      }
      return { attempts, reads, restored: (reads.at(-1) as { equal?: boolean } | undefined)?.equal === true }
    }

    if (mode === 'restore') { report.restore = await replayAndReadBack(); return }

    // TEST — fail closed unless the listing is exactly as saved and Amazon accepts BOTH patches in its own check.
    const fresh = await readAll()
    report.freshBefore = fresh
    for (const k of Object.keys(record.live)) {
      if (canon(record.live[k].offers) !== canon(fresh[k]?.offers) || canon(record.live[k].fulfillment) !== canon(fresh[k]?.fulfillment)) throw new Error(`${k} changed since the saved read — nothing sent`)
    }
    const pre = await preview()
    report.preview = pre
    if (pre.close || pre.replay) throw new Error('Amazon refused a patch in its own check — nothing sent')
    try {
      const close = await amazonSpApiClient.patchPurchasableOffer({ sellerId, sku: SKU, marketplaceId: itId, productType, op: 'delete', value: selectorFor(snapshot, itId) })
      report.close = close
      if (close.dryRun) throw new Error('the gate answered dry-run — nothing was sent')
      if (close.success) {
        const reads: unknown[] = []
        for (let i = 0; i < 12; i++) {
          await wait(15_000)
          const r = await readMarket(MARKET)
          reads.push({ afterSeconds: (i + 1) * 15, asin: r.asin, offers: r.offers, offerRawCount: r.offerRawCount, fulfillment: r.fulfillment, status: r.status })
          if (r.offers.length === 0) break
        }
        report.afterClose = reads
      }
    } finally {
      report.replay = await replayAndReadBack()
      report.siblingsAfter = await readAll()
      report.siblingsUnchanged = Object.fromEntries(Object.keys(record.live).filter(k => k !== MARKET).map(k => [k,
        canon(record.live[k].offers) === canon((report.siblingsAfter as any)[k]?.offers) && canon(record.live[k].fulfillment) === canon((report.siblingsAfter as any)[k]?.fulfillment)]))
    }
  })
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
if (mode !== 'read' || flag('record')) {
  const path = `${ROOT}/docs/product-cheat/records/step-1.3-sct6-${mode}${mode === 'read' ? '-compare' : ''}-${stamp}.json`
  writeFileSync(path, JSON.stringify(report, null, 1))
  report.recordWritten = path
}
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
