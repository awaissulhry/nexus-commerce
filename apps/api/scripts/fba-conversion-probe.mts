/**
 * READ-ONLY probe — which fulfilment channels Amazon holds for ONE seller SKU on ONE marketplace, right now.
 *
 * Step 0 of the FBA ⇄ FBM live test (Owner 2026-10-08, "Option B": fix Nexus's one-click send, test live on ONE SKU,
 * GALE-JACKET-BLACK-MEN-S on Amazon IT, with the Owner's yes). Run it BEFORE the conversion (what the 2026-10-07 patch
 * left: AMAZON_EU only, DEFAULT only, or both side by side) and AFTER it (did the add + delete land, are there issues).
 *
 * What it does: ONE `getListingsItem` with includedData=attributes,issues,offers,fulfillmentAvailability, through the
 * channel gateway (`AmazonSpApiClient.getListingsItem` → `gatewayFetch`; the gateway logs one OutboundApiCallLog row,
 * as it does for every call), plus a SELECT of Nexus's newest `FulfilmentConversion` record for the pair. It prints the
 * fulfilment channels Amazon reports (the `fulfillmentAvailability` section and the `fulfillment_availability`
 * attribute), the offers, the listing status and every issue.
 *
 * What it never does: send anything to Amazon. It refuses to start without `--read-only`; it forces
 * AMAZON_PUBLISH_MODE=dry-run in its own process before anything loads, so even a write path reached by mistake would
 * be a no-op; and it calls the read method only.
 *
 * How the Owner or the lead runs it in production (from the repo, on the Owner's Mac — the Railway CLI injects the
 * production API service's variables, which win over any local .env; Railway's internal Redis is not reachable from a
 * Mac, so it is unset, as the other production read scripts do):
 *
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     npx tsx scripts/fba-conversion-probe.mts --read-only --sku GALE-JACKET-BLACK-MEN-S --market IT
 *
 * Options: --account <ChannelConnection id> (default: the business's Amazon account), --workspace <id> (default:
 * nexus_legacy_workspace), --json (print Amazon's raw answer too). `railway run` buffers a piped stdout until exit; run
 * it in a terminal, not through a pipe.
 */
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }

if (!flag('read-only')) {
  console.error('Refused: this probe only reads. Pass --read-only to confirm (see the header for the command).')
  process.exit(2)
}
const sku = option('sku')
const market = option('market')?.toUpperCase()
if (!sku || !market) {
  console.error('Usage: npx tsx scripts/fba-conversion-probe.mts --read-only --sku <seller SKU> --market <IT|DE|FR|ES|…> [--account <id>] [--workspace <id>] [--json]')
  process.exit(2)
}
// Before any module reads it: no write can leave this process, whatever is imported below.
process.env.AMAZON_PUBLISH_MODE = 'dry-run'

await import('../src/env.js')
const { withWorkspace, LEGACY_WORKSPACE_ID } = await import('../src/lib/workspace-context.js')
const { AmazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')
const { amazonAccount, getAmazonRegion } = await import('../src/lib/amazon-sp-client.js')
const { marketplaceCodeToId } = await import('../src/utils/marketplace-code.js')
const { default: prisma } = await import('../src/db.js')

const marketplaceId = marketplaceCodeToId(market === 'GB' ? 'UK' : market)
if (!marketplaceId) { console.error(`Unknown Amazon market ${market}.`); process.exit(2) }
const workspaceId = option('workspace') ?? LEGACY_WORKSPACE_ID

type Json = Record<string, any>
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])

await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
  const account = await amazonAccount({ accountId: option('account') })
  const client = new AmazonSpApiClient({ id: account.id, region: await getAmazonRegion(account.id) })
  const r = await client.getListingsItem({
    sellerId: account.externalAccountId!, sku, marketplaceId,
    includedData: ['summaries', 'attributes', 'issues', 'offers', 'fulfillmentAvailability'],
  })
  console.log(`Amazon ${market} (${marketplaceId}) · seller SKU ${sku} · account ${account.id}`)
  if (!r.success) { console.log(`Read failed: ${r.error ?? 'no reason given'}`); return }
  if (r.rawResponse === undefined) { console.log('Not found on Amazon (HTTP 404).'); return }
  const raw = r.rawResponse as Json
  const section = list(raw.fulfillmentAvailability).map((f) => `${f.fulfillmentChannelCode}${f.quantity != null ? ` (quantity ${f.quantity})` : ''}`)
  const attribute = list(raw.attributes?.fulfillment_availability).map((f) => `${f.fulfillment_channel_code}${f.quantity != null ? ` (quantity ${f.quantity})` : ''}`)
  const codes = new Set([...list(raw.fulfillmentAvailability).map((f) => String(f.fulfillmentChannelCode ?? '')), ...list(raw.attributes?.fulfillment_availability).map((f) => String(f.fulfillment_channel_code ?? ''))].map((c) => c.toUpperCase()).filter(Boolean))
  const fba = [...codes].some((c) => c.startsWith('AMAZON')), fbm = codes.has('DEFAULT')
  console.log(`Status: ${r.status ?? '—'} · ASIN ${r.asin ?? '—'}`)
  console.log(`fulfillmentAvailability: ${section.join(', ') || '(none)'}`)
  console.log(`attributes.fulfillment_availability: ${attribute.join(', ') || '(none)'}`)
  console.log(`Reads as: ${fba && fbm ? 'BOTH — an Amazon record AND a merchant record (Amazon sells FBA stock first, then the merchant quantity)' : fba ? 'FBA only' : fbm ? 'FBM only' : 'no fulfilment record'}`)
  for (const o of list(raw.offers)) console.log(`Offer: ${o.offerType ?? '?'} · ${o.marketplaceId ?? ''} · ${o.price?.amount ?? '—'} ${o.price?.currency ?? o.price?.currencyCode ?? ''}${o.audience ? ` · ${o.audience.value ?? JSON.stringify(o.audience)}` : ''}`)
  const issues = list(r.issues)
  console.log(issues.length ? `Issues (${issues.length}):` : 'Issues: none')
  for (const i of issues) console.log(`  ${i.severity ?? '?'} ${i.code ?? ''}: ${i.message ?? ''}${Array.isArray(i.attributeNames) && i.attributeNames.length ? ` [${i.attributeNames.join(', ')}]` : ''}`)
  const rec = await prisma.fulfilmentConversion.findFirst({
    where: { sku, marketplaceId }, orderBy: { createdAt: 'desc' },
    select: { toMethod: true, status: true, message: true, createdAt: true, sentAt: true, submissionId: true, payload: true },
  })
  console.log(rec ? `Nexus's newest conversion: to ${rec.toMethod} · ${rec.status} · created ${rec.createdAt.toISOString()} · sent ${rec.sentAt?.toISOString() ?? '—'} · submission ${rec.submissionId ?? '—'} · ${rec.message ?? ''}\n  patch: ${JSON.stringify(rec.payload)}` : 'Nexus has no conversion record for this SKU and market.')
  if (flag('json')) console.log(JSON.stringify(raw, null, 2))
})
process.exit(0)
