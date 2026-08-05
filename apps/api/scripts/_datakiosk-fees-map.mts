/**
 * READ-ONLY: map Fee / FeeSummary / AdSummary / PerUnitCost in as few queries
 * as possible.
 *
 * GraphQL returns EVERY validation error at once, so one deliberately
 * over-broad selection maps several types in a single request — which matters
 * because Data Kiosk allows ~1 createQuery/min and a validation failure still
 * costs quota.
 *
 * Control fields must not start with '__' (reserved → "Introspection is not
 * supported", which tells us nothing).
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

async function probe(label: string, selection: string, follow = false): Promise<boolean> {
  L('   …70s quota wait')
  await new Promise((r) => setTimeout(r, 70_000))
  const query = `query { analytics_economics_2024_03_15 { economics(${ARGS}) { ${selection} } } }`
  L(`\n── ${label} ──`)
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`  ✅ ACCEPTED — whole selection is valid. queryId=${res?.queryId}`)
    if (!follow) return true
    for (let i = 0; i < 30; i++) {
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
        L(body.slice(0, 3000))
      }
      return true
    }
    return true
  } catch (e: any) {
    const d = String(e?.details ?? '')
    if (!d) { L(`  ⛔ ${String(e?.message ?? e).slice(0, 200)}`); return false }
    const undef = [...d.matchAll(/Field '([^']+)' in type '([^']+)' is undefined/g)]
    const sub = [...d.matchAll(/Sub selection required for type ([^ ]+) of field (\w+)/g)]
    const byType = new Map<string, string[]>()
    for (const m of undef) {
      const arr = byType.get(m[2]) ?? []
      arr.push(m[1]); byType.set(m[2], arr)
    }
    for (const [type, fields] of byType) L(`  ✗ ${type}: ${[...new Set(fields)].join(', ')}  DO NOT EXIST`)
    if (sub.length) L(`  ⊂ needs sub-selection: ${[...new Set(sub.map((m) => `${m[2]}:${m[1]}`))].join(', ')}`)
    return false
  }
}

// Round 2 — Fee, AggregatedDetail and PerUnitCost. None of the conventional
// money field names exist on Fee/PerUnitCost, and AdSummary.charge turned out
// to be an AggregatedDetail, so probe that shape directly.
await probe('map Fee / AggregatedDetail / PerUnitCost', `
  fees {
    charge { aggregatedDetail detail summary fee id description code amount zzzCtlFee }
  }
  ads {
    charge { amount perUnit total quantity unitCount value currencyCode zzzCtlAgg }
  }
  cost {
    aggregatedDetail detail value unitCost costPerUnit charges components zzzCtlCost
  }
`)

await prisma.$disconnect()
