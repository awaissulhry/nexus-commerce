// PLAN Step 3.4 (A-35, R-35) — the first live write and read-back. ONE attribute (Amazon·IT backend search terms,
// `generic_keyword`, not shown to buyers) on ONE listing (GALE-JACKET-BLACK-MEN-S). Each step is a separate run:
//   npx tsx docs/product-cheat/tools/live-write-probe.mts                                   # the plan only
//   npx tsx docs/product-cheat/tools/live-write-probe.mts --read                            # READ: save the current value
//   npx tsx docs/product-cheat/tools/live-write-probe.mts --write --record <f> --preview    # build + Amazon's own check, no write
//   npx tsx docs/product-cheat/tools/live-write-probe.mts --write --record <f> --execute-approved    # the write + read-back
//   npx tsx docs/product-cheat/tools/live-write-probe.mts --restore --record <f> --execute-approved  # put the saved value back
// The send path is the mapping cascade's own, without the queue: amazonRootPatch + buildAmazonListingPatch
// (FM_CATALOG_CASCADE) → listingPublishService.publish (Amazon gate: mode, circuit, rate limit, audit) → Amazon's
// validation preview → submitListingPayload. No Nexus data is written; no queue row is created.
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'

const ROOT = '/Users/awais/nexus-commerce'
const SKU = 'GALE-JACKET-BLACK-MEN-S'
const MARKET = 'IT'
const MARKETPLACE_ID = 'APJ6JRA9NG5V4'
const ATTRIBUTE = 'generic_keyword'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const mode = argv.includes('--read') ? 'read' : argv.includes('--write') ? 'write' : argv.includes('--restore') ? 'restore' : 'plan'
const execute = argv.includes('--execute-approved')
console.log(JSON.stringify({ step: 'PLAN Step 3.4 — one live write and read-back', sku: SKU, market: MARKET, attribute: ATTRIBUTE, mode,
  execute, sideEffects: 'read: none. preview: Amazon VALIDATION_PREVIEW (no listing change). execute: ONE PATCH of one attribute on one listing, the gate audit row, a normal token refresh.' }, null, 1))
if (mode === 'plan') process.exit(0)

const deadline = setTimeout(() => { console.error('Probe stopped at its 300-second bound; no result claimed — RE-READ before concluding (a timeout is an UNKNOWN outcome).'); process.exit(1) }, 300_000)
deadline.unref()
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DATABASE_POOL_MAX = '2'
// The publish gate is closed on this machine's env. Opened ONLY for an Owner-approved write or restore.
if (execute && (mode === 'write' || mode === 'restore')) { process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'true'; process.env.AMAZON_PUBLISH_MODE = 'live' }

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
const { getAmazonSellerId } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)

const report: Record<string, unknown> = { at: new Date().toISOString(), mode, execute }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
try {
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const offer = await prisma.offer.findFirst({ where: { sku: SKU, isActive: true, channelListing: { channel: 'AMAZON', marketplace: MARKET } },
      include: { channelListing: { select: { id: true, channelConnectionId: true, externalListingId: true, product: { select: { id: true } } } } } })
    const listing = offer?.channelListing ?? await prisma.channelListing.findFirstOrThrow({ where: { channel: 'AMAZON', marketplace: MARKET, product: { sku: SKU } },
      select: { id: true, channelConnectionId: true, externalListingId: true, product: { select: { id: true } } } })
    const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: listing.channelConnectionId! }, select: { id: true, region: true } })
    const client = new AmazonSpApiClient({ id: account.id, region: account.region ?? 'eu' })
    const sellerId = await getAmazonSellerId(account.id)
    const readAttr = async () => {
      const r = await client.getListingsItem({ sellerId, sku: SKU, marketplaceId: MARKETPLACE_ID, includedData: ['summaries', 'attributes'] })
      const raw = r.rawResponse as any
      return { success: r.success, asin: r.asin, productType: raw?.summaries?.[0]?.productType ?? null, value: raw?.attributes?.[ATTRIBUTE] ?? null, error: r.error ?? null }
    }

    if (mode === 'read') {
      const now = await readAttr()
      report.read = now
      if (!now.success || !now.asin) throw new Error(`the listing read did not return the listing: ${now.error ?? 'no ASIN'}`)
      const path = `${ROOT}/docs/product-cheat/records/step-3.4-before-${stamp}.json`
      writeFileSync(path, JSON.stringify({ sku: SKU, market: MARKET, attribute: ATTRIBUTE, listingId: listing.id, accountId: account.id, asin: now.asin, productType: now.productType, value: now.value, readAt: report.at }, null, 1))
      report.record = path
      return
    }

    const record = JSON.parse(readFileSync(flag('record') ?? '', 'utf8'))
    if (record.sku !== SKU || record.attribute !== ATTRIBUTE) throw new Error('the record is for another listing or attribute')
    const { loadAmazonSpec } = await import(`${ROOT}/apps/api/src/services/pim/channel-specs/index.js`)
    const { attributesFromCells } = await import(`${ROOT}/apps/api/src/services/pim/mapping/schema-requirements.js`)
    const { amazonRootPatch } = await import(`${ROOT}/apps/api/src/services/amazon/mapping-payload.js`)
    const { buildAmazonListingPatch } = await import(`${ROOT}/apps/api/src/services/outbound-sync.service.js`)
    const spec = await loadAmazonSpec(MARKET, record.productType, account.id)
    const probe = flag('probe') ?? record.probe ?? `nexusprobe${stamp.slice(11, 19).replace(/-/g, '')}`
    let value: unknown
    if (mode === 'write') {
      const field = spec.fields.find((f: { attribute: string }) => f.attribute === ATTRIBUTE)
      if (!field) throw new Error(`the ${record.productType} schema has no ${ATTRIBUTE}`)
      value = (attributesFromCells(spec, { [field.key]: probe }) as Record<string, unknown>)[ATTRIBUTE]
    } else value = record.value ?? undefined // restore: the saved value; absent → a delete by the schema's selectors
    const patch = amazonRootPatch(spec, ATTRIBUTE, value)
    const amazonPayload = await buildAmazonListingPatch({ source: 'FM_CATALOG_CASCADE', mappingAttributePatches: [patch] } as never, MARKET, record.productType)
    report.payload = amazonPayload
    report.probe = mode === 'write' ? probe : undefined

    const { amazonContentRefusal } = await import(`${ROOT}/apps/api/src/services/amazon/validate-before-send.js`)
    if (!execute) {
      // PREVIEW: Amazon's own validation of exactly this patch set — no listing change.
      report.preview = { refusal: await amazonContentRefusal({ sellerId, sku: SKU, marketplaceId: MARKETPLACE_ID, productType: record.productType, patches: amazonPayload.patches }) }
      return
    }
    const { listingPublishService } = await import(`${ROOT}/apps/api/src/services/listing-publish.service.js`)
    const gate = await import(`${ROOT}/apps/api/src/services/amazon-publish-gate.service.js`)
    const { digestPayload } = await import(`${ROOT}/apps/api/src/services/channel-publish-audit.service.js`)
    const sent = await listingPublishService.publish({
      channel: 'AMAZON', marketplaceId: MARKETPLACE_ID, sku: SKU, productId: listing.product.id,
      digest: digestPayload(amazonPayload),
      gate: { getMode: gate.getAmazonPublishMode, checkCircuit: gate.checkAmazonCircuit, acquireToken: gate.acquireAmazonPublishToken, recordOutcome: gate.recordAmazonOutcome },
      resolveSeller: async () => ({ id: sellerId }),
      execute: async ({ sellerId: sid }: { sellerId: string }) => {
        const refusal = await amazonContentRefusal({ sellerId: sid, sku: SKU, marketplaceId: MARKETPLACE_ID, productType: record.productType, patches: amazonPayload.patches })
        if (refusal) return { ok: false, error: refusal }
        const res = await client.submitListingPayload({ sellerId: sid, sku: SKU, payload: amazonPayload, marketplaceId: MARKETPLACE_ID })
        report.submit = { success: res.success, status: res.status, error: res.error ?? null, dryRun: res.dryRun ?? false, issues: (res.rawResponse as any)?.issues ?? [] }
        return { ok: res.success, error: res.error }
      },
    } as never)
    report.publish = { success: (sent as any).success, status: (sent as any).status, mode: (sent as any).mode, message: (sent as any).message ?? null, error: (sent as any).error ?? null }
    // Read back: Amazon applies a PATCH asynchronously. Poll every 15 s for up to 3 minutes; stop when it matches.
    const want = JSON.stringify(mode === 'write' ? probe : (record.value ?? null))
    const has = (v: unknown) => mode === 'write' ? JSON.stringify(v ?? null).includes(probe) : JSON.stringify(v ?? null) === JSON.stringify(record.value ?? null)
    const reads: unknown[] = []
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 15_000))
      const now = await readAttr()
      reads.push({ afterSeconds: (i + 1) * 15, value: now.value, error: now.error })
      if (has(now.value)) break
    }
    const last = reads[reads.length - 1] as { value: unknown }
    report.readBack = { want: JSON.parse(want), matched: has(last?.value), reads }
    const path = `${ROOT}/docs/product-cheat/records/step-3.4-${mode}-${stamp}.json`
    writeFileSync(path, JSON.stringify({ ...report, record: flag('record'), probe: mode === 'write' ? probe : undefined }, null, 1))
    report.recordWritten = path
  })
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
