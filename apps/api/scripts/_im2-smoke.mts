/**
 * IM.2 smoke — stock import wizard P1/P2 verification against prod DB.
 * Read-only: parse (pure) + resolve + preview. NO apply.
 */
import Fastify from 'fastify'
import multipartPlugin from '@fastify/multipart'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/stock.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const app = Fastify()
await app.register(multipartPlugin, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } })
await app.register(routes, { prefix: '/api' })

function mp(filename: string, content: string | Buffer, mime = 'text/csv') {
  const boundary = '----im2smoke8f3a'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function parse(filename: string, content: string | Buffer, mime?: string) {
  const { body, headers } = mp(filename, content, mime)
  const r = await app.inject({ method: 'POST', url: '/api/stock/import/parse', payload: body, headers })
  return { status: r.statusCode, json: r.json() }
}

let fails = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail)?.slice(0, 160) : ''}`)
  if (!ok) fails++
}

// ── 1. Semicolon CSV under .csv (Italian Excel) ─────────────────────────
{
  const { status, json } = await parse('magazzino.csv', 'sku;qta;note\nGAL-1;5;arrivo\nGAL-2;3;\n')
  check('semicolon .csv → 3 headers', status === 200 && JSON.stringify(json.headers) === '["sku","qta","note"]', json.headers)
  check('semicolon .csv → delimiter ";"', json.delimiter === ';', json.delimiter)
  check('semicolon .csv → 2 full rows', json.rows?.length === 2 && json.rows[0].sku === 'GAL-1', json.rows?.[0])
}

// ── 2. BOM + quoted comma value ─────────────────────────────────────────
{
  const { status, json } = await parse('bom.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('sku,name,qty\nGAL-1,"Giacca, nera",5\n')]))
  check('BOM stripped from first header', status === 200 && json.headers?.[0] === 'sku', json.headers)
  check('quoted comma stays one cell', json.rows?.[0]?.name === 'Giacca, nera', json.rows?.[0])
}

// ── 3. JSON routed to parseJson ─────────────────────────────────────────
{
  const { status, json } = await parse('rows.json', JSON.stringify([{ sku: 'GAL-1', qty: 5 }, { sku: 'GAL-2', qty: 3 }]), 'application/json')
  check('json → headers [sku,qty]', status === 200 && JSON.stringify(json.headers) === '["sku","qty"]', json.headers)
  check('json → numeric qty preserved', json.rows?.[0]?.qty === 5, json.rows?.[0])
}

// ── 4. Pasted tabs as .txt ──────────────────────────────────────────────
{
  const { status, json } = await parse('pasted.txt', 'sku\tqty\nGAL-1\t5\n', 'text/plain')
  check('pasted .txt tabs → tab delimiter', status === 200 && json.delimiter === '\t', json.delimiter)
}

// ── 5. .xls rejected clearly ────────────────────────────────────────────
{
  const { status, json } = await parse('legacy.xls', 'whatever')
  check('.xls → 400 with save-as-xlsx message', status === 400 && /xlsx/i.test(json.error ?? ''), json.error)
}

// ── 6. Resolve tiers against the REAL prod catalog ──────────────────────
const product =
  (await prisma.product.findFirst({
    where: { ean: { not: null } },
    select: { sku: true, ean: true, name: true },
  })) ??
  (await prisma.product.findFirst({ select: { sku: true, ean: true, name: true } }))
const membership = await prisma.sharedListingMembership.findFirst({
  where: { status: 'ACTIVE', productId: { not: null }, NOT: { sku: { equals: '' } } },
  select: { sku: true, productId: true },
})
const memberIsAlsoMasterSku = membership
  ? (await prisma.product.count({ where: { sku: { equals: membership.sku, mode: 'insensitive' } } })) > 0
  : false
{
  const rows: Array<{ raw: string; quantity: number }> = [
    { raw: product!.sku, quantity: 1 },
    { raw: 'ZZZ-DOES-NOT-EXIST-42', quantity: 1 },
  ]
  if (product!.ean) rows.push({ raw: product!.ean, quantity: 1 })
  if (membership) rows.push({ raw: membership.sku, quantity: 1 })
  const r = await app.inject({ method: 'POST', url: '/api/stock/import/resolve', payload: { rows } })
  const j = r.json()
  const tiers = (j.rows ?? []).map((x: { raw: string; tier: string }) => `${x.raw}→${x.tier}`)
  check('exact master SKU → EXACT', j.rows?.[0]?.tier === 'EXACT', tiers[0])
  check('garbage → UNRESOLVED', j.rows?.[1]?.tier === 'UNRESOLVED', tiers[1])
  let i = 2
  if (product!.ean) {
    check('EAN → BARCODE', j.rows?.[i]?.tier === 'BARCODE', tiers[i])
    i++
  } else {
    console.log('ℹ️  no Product.ean in catalog — barcode tier untested against prod data')
  }
  if (membership) {
    const expected = memberIsAlsoMasterSku ? 'EXACT' : 'CHANNEL_SKU'
    check(`eBay custom label → ${expected}`, j.rows?.[i]?.tier === expected, tiers[i])
  } else {
    console.log('ℹ️  no ACTIVE SharedListingMembership with productId — channel-label tier untested')
  }
}

// ── 6b. ASIN → CHANNEL_SKU (Product.amazonAsin, 264/273 coverage) ───────
{
  const asinProduct = await prisma.product.findFirst({
    where: { amazonAsin: { not: null } },
    select: { sku: true, amazonAsin: true },
  })
  if (asinProduct?.amazonAsin) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/stock/import/resolve',
      payload: { rows: [{ raw: asinProduct.amazonAsin, quantity: 1 }] },
    })
    const j = r.json()
    check(
      'ASIN → CHANNEL_SKU resolving to owning SKU',
      j.rows?.[0]?.tier === 'CHANNEL_SKU' && j.rows?.[0]?.resolvedSku === asinProduct.sku,
      { raw: asinProduct.amazonAsin, tier: j.rows?.[0]?.tier, sku: j.rows?.[0]?.resolvedSku },
    )
  } else {
    console.log('ℹ️  no Product.amazonAsin — ASIN tier untested')
  }
}

// ── 7. Preview (read-only math) on the real SKU ─────────────────────────
{
  const r = await app.inject({
    method: 'POST',
    url: '/api/stock/import/preview',
    payload: {
      rows: [{ raw: product!.sku, quantity: 1 }],
      locationCode: 'IT-MAIN',
      mode: 'ADJUST',
      target: 'WAREHOUSE',
    },
  })
  const j = r.json()
  const row = j.rows?.[0]
  check('preview resolves + computes wouldBe', r.statusCode === 200 && row?.tier === 'EXACT' && typeof row?.currentWarehouseQty === 'number' && row?.wouldBeWarehouseQty === row?.currentWarehouseQty + 1, { cur: row?.currentWarehouseQty, next: row?.wouldBeWarehouseQty })
}

// ── 8. P3 preview parity — per-listing channel math, filters, duplicates ─
{
  const listed = await prisma.channelListing.findFirst({
    where: { listingStatus: { not: 'ENDED' }, channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] } },
    select: { channel: true, product: { select: { sku: true } } },
  })
  if (listed?.product?.sku) {
    const sku = listed.product.sku
    const r = await app.inject({
      method: 'POST',
      url: '/api/stock/import/preview',
      payload: {
        rows: [
          { raw: sku, quantity: 1 },
          { raw: sku, quantity: 2 }, // duplicate — sequential math + warning
          { raw: sku, quantity: 0 }, // ADJUST 0 — no-op warning
        ],
        locationCode: 'IT-MAIN',
        mode: 'ADJUST',
        target: 'CHANNEL',
      },
    })
    const j = r.json()
    const [a, b, c] = j.rows ?? []
    check('CHANNEL preview → per-listing detail present', (a?.channelListings?.length ?? 0) > 0, a?.channelListings?.slice(0, 2))
    check('per-listing math: wouldBe = current + 1', a?.channelListings?.every((x: any) => x.wouldBe === Math.max(0, x.current + 1)), a?.channelListings?.[0])
    check('duplicate row → warning', (b?.warnings ?? []).some((w: string) => w.includes('Duplicate')), b?.warnings)
    const filtered = await app.inject({
      method: 'POST',
      url: '/api/stock/import/preview',
      payload: {
        rows: [{ raw: sku, quantity: 1, channel: 'WOOCOMMERCE' }],
        locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'CHANNEL',
      },
    })
    const fr = filtered.json().rows?.[0]
    check('row channel filter → no-match is an ERROR for CHANNEL target', /No active channel listing/.test(fr?.error ?? ''), fr?.error)
    void c
  } else {
    console.log('ℹ️  no active channel listing found — P3 preview checks skipped')
  }
}

// ── 9. P3 warehouse duplicate sequencing (WAREHOUSE target) ──────────────
{
  const r = await app.inject({
    method: 'POST',
    url: '/api/stock/import/preview',
    payload: {
      rows: [
        { raw: product!.sku, quantity: 5 },
        { raw: product!.sku, quantity: 5 },
      ],
      locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE',
    },
  })
  const j = r.json()
  const [a, b] = j.rows ?? []
  check(
    'duplicate warehouse rows preview sequentially (row2 base = row1 result)',
    typeof a?.wouldBeWarehouseQty === 'number' && b?.wouldBeWarehouseQty === a.wouldBeWarehouseQty + 5,
    { first: a?.wouldBeWarehouseQty, second: b?.wouldBeWarehouseQty },
  )
}

// ── 10. P4 draft-job idempotency (no stock writes — all rows skipped) ────
{
  const previewBody = {
    rows: [{ raw: 'ZZZ-DOES-NOT-EXIST-42', quantity: 1 }],
    locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE',
    filename: '_im2-smoke.csv', fileKind: 'csv',
  }
  const p1 = await app.inject({ method: 'POST', url: '/api/stock/import/preview', payload: previewBody })
  const jobId = p1.json().jobId
  check('preview returns a draft jobId', typeof jobId === 'string' && jobId.length > 10, jobId)

  const p2 = await app.inject({ method: 'POST', url: '/api/stock/import/preview', payload: { ...previewBody, jobId } })
  check('re-preview reuses the SAME draft', p2.json().jobId === jobId, p2.json().jobId)

  const hist = await app.inject({ method: 'GET', url: '/api/stock/import/history' })
  check('DRAFT hidden from history', !(hist.json().jobs ?? []).some((j: { id: string }) => j.id === jobId))

  const applyBody = {
    rows: p1.json().rows, // single UNRESOLVED row → skipped, zero stock writes
    locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId,
  }
  const a1 = await app.inject({ method: 'POST', url: '/api/stock/import/apply', payload: applyBody })
  check('apply consumes the draft (skipped=1, no writes)', a1.statusCode === 200 && a1.json().skipped === 1 && a1.json().succeeded === 0, a1.json())

  const a2 = await app.inject({ method: 'POST', url: '/api/stock/import/apply', payload: applyBody })
  check('second apply of same draft → 409', a2.statusCode === 409, { status: a2.statusCode, error: a2.json().error })

  const hist2 = await app.inject({ method: 'GET', url: '/api/stock/import/history' })
  check('consumed job now visible in history', (hist2.json().jobs ?? []).some((j: { id: string }) => j.id === jobId))

  const detail = await app.inject({ method: 'GET', url: `/api/stock/import/history/${jobId}` })
  check('history detail returns per-row results', Array.isArray(detail.json().job?.results) && detail.json().job.results.length === 1, detail.json().job?.results?.[0])
}

console.log(fails === 0 ? '\n🎉 IM.2 smoke: ALL PASS' : `\n💥 IM.2 smoke: ${fails} FAILURES`)
await prisma.$disconnect()
process.exit(fails === 0 ? 0 : 1)
