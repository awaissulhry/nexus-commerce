// P-RT.6 — smoke for the edit-page listing.synced toast filter.
// The React effect in ProductEditClient.tsx does three jobs:
//   1. Filter SSE listing.synced events to ones belonging to THIS
//      product (listingId in our local set).
//   2. Resolve the listing's channel label so the toast reads
//      "Amazon" not "cl_abc123".
//   3. Dedup by listingId + ts so a re-render doesn't re-toast.
// All three are pure transformations on the event payload + the
// local clientListings map. We exercise them here without React or
// the bus so a regression in the filter shows up as a script failure
// (no need to spin up a browser + dev server to validate behaviour).
//
// Run:
//   node scripts/p-rt-6-edit-toast-smoke.mjs
// Exit 0 = pass, 1 = filter / label / dedup logic broke.

const LABEL_CASE = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

// Mirror of the production filter. Mirrors logic in
// apps/web/src/app/products/[id]/edit/ProductEditClient.tsx —
// keep this in sync when the production effect changes.
function classifyEvent(event, clientListings, knownIds, toastedKeys) {
  if (!event) return { skip: 'no event' }
  if (event.type !== 'listing.synced') return { skip: 'wrong type' }
  if (!event.listingId) return { skip: 'no listingId' }
  if (!knownIds.has(event.listingId)) return { skip: 'foreign listing' }
  const dedupKey = `${event.listingId}:${event.ts ?? 0}`
  if (toastedKeys.has(dedupKey)) return { skip: 'already toasted' }
  toastedKeys.add(dedupKey)
  let channelLabel = 'channel'
  for (const [chKey, arr] of Object.entries(clientListings)) {
    if (arr.some((l) => l.id === event.listingId)) {
      channelLabel = LABEL_CASE[chKey] ?? chKey
      break
    }
  }
  if (event.status === 'SUCCESS') return { toast: 'success', channelLabel }
  if (event.status === 'FAILED') return { toast: 'error', channelLabel }
  if (event.status === 'TIMEOUT') return { toast: 'error.timeout', channelLabel }
  return { skip: 'silent status' }  // NOT_IMPLEMENTED
}

const listings = {
  AMAZON: [{ id: 'cl_amazon_1' }, { id: 'cl_amazon_2' }],
  EBAY: [{ id: 'cl_ebay_3' }],
  SHOPIFY: [{ id: 'cl_shopify_4' }],
}
const knownIds = new Set(
  Object.values(listings).flatMap((arr) => arr.map((l) => l.id)),
)

const cases = [
  {
    name: 'SUCCESS on our Amazon listing → success toast labeled Amazon',
    event: { type: 'listing.synced', listingId: 'cl_amazon_1', status: 'SUCCESS', ts: 1 },
    expect: { toast: 'success', channelLabel: 'Amazon' },
  },
  {
    name: 'FAILED on our eBay listing → error toast labeled eBay',
    event: { type: 'listing.synced', listingId: 'cl_ebay_3', status: 'FAILED', ts: 2 },
    expect: { toast: 'error', channelLabel: 'eBay' },
  },
  {
    name: 'TIMEOUT on our Shopify listing → error.timeout toast',
    event: { type: 'listing.synced', listingId: 'cl_shopify_4', status: 'TIMEOUT', ts: 3 },
    expect: { toast: 'error.timeout', channelLabel: 'Shopify' },
  },
  {
    name: 'NOT_IMPLEMENTED → silent (no toast)',
    event: { type: 'listing.synced', listingId: 'cl_amazon_2', status: 'NOT_IMPLEMENTED', ts: 4 },
    expect: { skip: 'silent status' },
  },
  {
    name: 'Event for ANOTHER product → ignored',
    event: { type: 'listing.synced', listingId: 'cl_someone_else', status: 'SUCCESS', ts: 5 },
    expect: { skip: 'foreign listing' },
  },
  {
    name: 'Different event type → ignored',
    event: { type: 'listing.updated', listingId: 'cl_amazon_1', ts: 6 },
    expect: { skip: 'wrong type' },
  },
  {
    name: 'null event → no-op',
    event: null,
    expect: { skip: 'no event' },
  },
]

let ok = true
let toastedKeys = new Set()
for (const c of cases) {
  const got = classifyEvent(c.event, listings, knownIds, toastedKeys)
  const fail = Object.entries(c.expect).some(([k, v]) => got[k] !== v)
  if (fail) {
    console.log(`[smoke] FAIL — ${c.name}`)
    console.log(`   want ${JSON.stringify(c.expect)}`)
    console.log(`   got  ${JSON.stringify(got)}`)
    ok = false
  } else {
    console.log(`[smoke] PASS — ${c.name}`)
  }
}

// Dedup: re-toast same event → second call should skip.
toastedKeys = new Set()
const dup = { type: 'listing.synced', listingId: 'cl_amazon_1', status: 'SUCCESS', ts: 99 }
const first = classifyEvent(dup, listings, knownIds, toastedKeys)
const second = classifyEvent(dup, listings, knownIds, toastedKeys)
if (first.toast === 'success' && second.skip === 'already toasted') {
  console.log('[smoke] PASS — dedup blocks second toast for same listingId+ts')
} else {
  console.log('[smoke] FAIL — dedup not blocking duplicate')
  console.log(`   first: ${JSON.stringify(first)}`)
  console.log(`   second: ${JSON.stringify(second)}`)
  ok = false
}

process.exit(ok ? 0 : 1)
