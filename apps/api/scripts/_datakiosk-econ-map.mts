/**
 * READ-ONLY: map analytics_economics_2024_03_15.economics.
 *
 * Data Kiosk's createQuery limit is ~1/min with a small burst, and a
 * VALIDATION-REJECTED query still consumes quota — so probes are spaced 70s
 * apart. GraphQL reports every validation error at once, so each probe maps a
 * whole level: whatever is NOT named in the error list exists.
 */
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const SellingPartner = (await import('amazon-sp-api')).default as any
const sp = new SellingPartner({
  region: (process.env.AMAZON_REGION ?? 'eu') as 'eu',
  refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
  credentials: {
    SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
    SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
  },
  options: { auto_request_tokens: true, auto_request_throttled: false },
})

const MKT = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
const end = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10)
const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
const ARGS = `startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]`

// NOTE: control fields must NOT start with '__'. GraphQL reserves that prefix
// for introspection, and Data Kiosk rejects the whole query with
// "Introspection is not supported." — which looks like a schema answer but is
// not one. Use an ordinary implausible name instead.
async function probe(label: string, selection: string, follow = false): Promise<void> {
  L('   …waiting 70s for the create-query quota to refill')
  await new Promise((r) => setTimeout(r, 70_000))
  const query = `query { analytics_economics_2024_03_15 { economics(${ARGS}) { ${selection} } } }`
  L(`\n── ${label} ──`)
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`  ✅ ACCEPTED — every field in this selection exists. queryId=${res?.queryId}`)
    if (!follow) return
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 6000))
      const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${res.queryId}`, method: 'GET' }).catch(() => null)
      if (!s || (s.processingStatus !== 'DONE' && s.processingStatus !== 'FATAL')) continue
      L(`  status=${s.processingStatus}`)
      for (const [kind, id] of [['DATA', s.dataDocumentId], ['ERROR', s.errorDocumentId]] as Array<[string, string | null]>) {
        if (!id) continue
        const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' }).catch(() => null)
        if (!d?.documentUrl) continue
        const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
        const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
        L(`  ${kind} (${buf.byteLength}B):`)
        L(body.slice(0, 2500))
      }
      return
    }
  } catch (e: any) {
    const d = String(e?.details ?? '')
    if (!d) { L(`  ⛔ ${String(e?.message ?? e).slice(0, 160)}`); return }
    const undef = [...d.matchAll(/Field '([^']+)' in type '([^']+)' is undefined/g)].map((m) => m[1])
    const missingArg = [...d.matchAll(/MissingFieldArgument: Missing field argument ([^ ]+)/g)].map((m) => m[1])
    const wrongType = [...d.matchAll(/of type (\w+): ([^"]{0,150})/g)].map((m) => `${m[1]}: ${m[2]}`)
    if (undef.length) L(`  ✗ undefined: ${[...new Set(undef)].join(', ')}`)
    if (missingArg.length) L(`  ! missing required args: ${[...new Set(missingArg)].join(', ')}`)
    if (!undef.length && !missingArg.length) L(`  raw: ${d.slice(0, 700)}`)
    else if (wrongType.length) L(`  (${[...new Set(wrongType)].slice(0, 3).join(' | ')})`)
  }
}

// Probe 1 — top level. Anything absent from the "undefined" list exists.
await probe('top-level fields', `
  startDate endDate marketplaceId parentAsin childAsin msku
  sales fees ads cost netProceeds charges zzzControlNoSuchField
`)

// Probe 2 — the money sub-objects.
await probe('sub-fields of sales / fees / netProceeds', `
  sales { orderedRevenue unitsOrdered netProductSales averageSellingPrice zzzControlNoSuchField }
  fees { totalFees referralFee fbaFulfillmentFee zzzControlNoSuchField }
  netProceeds { total perUnit zzzControlNoSuchField }
`)

await prisma.$disconnect()
