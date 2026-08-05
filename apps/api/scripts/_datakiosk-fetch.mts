/** READ-ONLY: fetch an already-created Data Kiosk query's result by id.
 *  GET endpoints have their own (looser) quota than createQuery. */
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)
const QID = process.argv[2] ?? '111255020663'

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

for (let i = 0; i < 40; i++) {
  const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${QID}`, method: 'GET' }).catch((e: any) => { L(`poll err ${String(e?.message ?? e).slice(0, 120)}`); return null })
  if (!s) { await new Promise((r) => setTimeout(r, 8000)); continue }
  if (s.processingStatus !== 'DONE' && s.processingStatus !== 'FATAL') {
    L(`poll#${i + 1} ${s.processingStatus}`)
    await new Promise((r) => setTimeout(r, 8000))
    continue
  }
  L(`status=${s.processingStatus} dataDoc=${s.dataDocumentId ?? '-'} errDoc=${s.errorDocumentId ?? '-'}`)
  for (const [kind, id] of [['DATA', s.dataDocumentId], ['ERROR', s.errorDocumentId]] as Array<[string, string | null]>) {
    if (!id) continue
    const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' }).catch(() => null)
    if (!d?.documentUrl) { L(`  ${kind}: no documentUrl`); continue }
    const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
    const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
    const lines = body.trim().split('\n').filter(Boolean)
    L(`\n${kind}: ${buf.byteLength}B, ${lines.length} JSONL rows`)
    if (kind === 'ERROR') { L(body.slice(0, 2000)); continue }
    L('\nFIRST ROW (pretty):')
    try { L(JSON.stringify(JSON.parse(lines[0]), null, 2).slice(0, 3000)) } catch { L(lines[0]?.slice(0, 1500)) }
    // How many fee entries per row, and do they carry any label at all?
    try {
      const r0 = JSON.parse(lines[0])
      L(`\nfees array length = ${Array.isArray(r0.fees) ? r0.fees.length : 'n/a'}`)
      L(`ads  array length = ${Array.isArray(r0.ads) ? r0.ads.length : 'n/a'}`)
      L(`row keys = ${Object.keys(r0).join(', ')}`)
    } catch { /* ignore */ }
  }
  break
}

await prisma.$disconnect()
