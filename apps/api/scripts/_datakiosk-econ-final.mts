/**
 * READ-ONLY: (1) find FeeSummary's identifier field + PerUnitCost's shape,
 * (2) run the production economics query for real and print the data.
 *
 * A [FeeSummary]! list whose only known field is `charge` would be unusable —
 * we'd have amounts with no idea which fee each one is — so the identifier
 * matters before the table is designed.
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

async function probe(label: string, selection: string, follow = false): Promise<void> {
  L('   …70s quota wait')
  await new Promise((r) => setTimeout(r, 70_000))
  const query = `query { analytics_economics_2024_03_15 { economics(${ARGS}) { ${selection} } } }`
  L(`\n── ${label} ──`)
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`  ✅ ACCEPTED queryId=${res?.queryId}`)
    if (!follow) return
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
        const lines = body.trim().split('\n').filter(Boolean)
        L(`  ${kind}: ${buf.byteLength}B, ${lines.length} JSONL rows`)
        L(`  first row pretty:`)
        try { L(JSON.stringify(JSON.parse(lines[0]), null, 2).slice(0, 2600)) } catch { L(body.slice(0, 2000)) }
      }
      return
    }
    L('  (timed out polling)')
  } catch (e: any) {
    const d = String(e?.details ?? '')
    if (!d) { L(`  ⛔ ${String(e?.message ?? e).slice(0, 200)}`); return }
    const undef = [...d.matchAll(/Field '([^']+)' in type '([^']+)' is undefined/g)]
    const sub = [...d.matchAll(/Sub selection required for type ([^ ]+) of field (\w+)/g)]
    const byType = new Map<string, string[]>()
    for (const m of undef) { const a = byType.get(m[2]) ?? []; a.push(m[1]); byType.set(m[2], a) }
    for (const [t, f] of byType) L(`  ✗ ${t}: ${[...new Set(f)].join(', ')}  DO NOT EXIST`)
    if (sub.length) L(`  ⊂ needs sub-selection: ${[...new Set(sub.map((m) => `${m[2]}:${m[1]}`))].join(', ')}`)
  }
}

// Round 3 — the fee identifier and PerUnitCost, second guess set.
await probe('FeeSummary identifier + PerUnitCost', `
  fees { id feeId feeName feeCode label key chargeType feeCharge chargeName zzzCtlFS }
  cost { costOfGoodsSold miscellaneousCost shipping netCost totalCostOfGoods unitCost2 zzzCtlPUC }
`)

// Round 4 — the production query. `cost` is deliberately omitted: it stayed
// unmapped after 20 candidate names and the profitability figures we actually
// need (netProceeds, fees, ads) do not depend on it.
await probe('PRODUCTION economics query (real data)', `
  startDate endDate marketplaceId parentAsin childAsin msku
  sales {
    unitsOrdered
    netProductSales { amount currencyCode }
    averageSellingPrice { amount currencyCode }
  }
  fees { charge { aggregatedDetail { amount { amount currencyCode } quantity } } }
  ads { charge { amount { amount currencyCode } quantity } }
  netProceeds { total { amount currencyCode } perUnit { amount currencyCode } }
`, true)

await prisma.$disconnect()
