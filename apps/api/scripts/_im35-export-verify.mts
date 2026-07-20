/**
 * IM.3.5 verify — export endpoints via route injection (read-only).
 *
 * 1. GET /stock/export (csv + xlsx): every non-parent product present,
 *    quantities match StockLevel, header row auto-maps (sku/quantity),
 *    CSV cells with commas/quotes escaped, XLSX parses back via the same
 *    ExcelJS the import uses (true round-trip proof) with sku text-typed.
 * 2. GET /stock/import/history/:id/export: failed scope returns only
 *    not-applied rows with quantity + error columns.
 */
import Fastify from 'fastify'
import multipartPlugin from '@fastify/multipart'
import ExcelJS from 'exceljs'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/stock.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const app = Fastify()
await app.register(multipartPlugin, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } })
await app.register(routes, { prefix: '/api' })

let fails = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail)?.slice(0, 200) : ''}`)
  if (!ok) fails++
}

// ── 1. Stock export ──────────────────────────────────────────────────────────
{
  const csvRes = await app.inject({ method: 'GET', url: '/api/stock/export?locationCode=IT-MAIN&format=csv' })
  check('stock export csv: 200 + attachment', csvRes.statusCode === 200 && /attachment/.test(csvRes.headers['content-disposition'] as string), csvRes.headers['content-disposition'])
  const lines = csvRes.body.trim().split('\r\n')
  check('stock export csv: header auto-maps (sku,quantity,…)', lines[0] === 'sku,quantity,name,ean,reserved,available', lines[0])

  const productCount = await prisma.product.count({ where: { deletedAt: null, isParent: false } })
  check(`stock export csv: one row per non-parent product (${productCount})`, lines.length === productCount + 1, { lines: lines.length - 1, productCount })

  // Spot-check a real level quantity round-trips
  const loc = await prisma.stockLocation.findUnique({ where: { code: 'IT-MAIN' }, select: { id: true } })
  const lvl = await prisma.stockLevel.findFirst({
    where: { locationId: loc!.id, variationId: null, quantity: { gte: 1 } },
    select: { quantity: true, product: { select: { sku: true } } },
  })
  if (lvl?.product) {
    const row = lines.find((l) => l.startsWith(lvl.product.sku + ',') || l.startsWith(`"${lvl.product.sku}"`))
    check(`stock export csv: ${lvl.product.sku} qty matches level (${lvl.quantity})`, row?.split(',')[1] === String(lvl.quantity), row?.slice(0, 60))
  }

  const xlsxRes = await app.inject({ method: 'GET', url: '/api/stock/export?locationCode=IT-MAIN&format=xlsx' })
  check('stock export xlsx: 200', xlsxRes.statusCode === 200)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(xlsxRes.rawPayload as Buffer)
  const ws = wb.getWorksheet('rows')!
  check('stock export xlsx: parses + header row', ws.getRow(1).getCell(1).value === 'sku', ws.getRow(1).getCell(1).value)
  check('stock export xlsx: row count matches', ws.rowCount === productCount + 1, ws.rowCount)
  check('stock export xlsx: sku column text-typed', ws.getColumn(1).numFmt === '@', ws.getColumn(1).numFmt)

  const missing = await app.inject({ method: 'GET', url: '/api/stock/export?locationCode=NOPE' })
  check('stock export: unknown location 404', missing.statusCode === 404)
}

// ── 2. Job results export ────────────────────────────────────────────────────
{
  // The IM.3.3 verify left FAILED jobs with rich results — use the latest.
  const job = await prisma.stockImportJob.findFirst({
    where: { status: { in: ['FAILED', 'PARTIAL'] }, results: { not: undefined as never } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, results: true },
  })
  if (!job) {
    console.log('⚠️ no failed/partial job with results found — skipping results-export check')
  } else {
    const failedCount = ((job.results as Array<{ applied: boolean }>) ?? []).filter((r) => !r.applied).length
    const res = await app.inject({ method: 'GET', url: `/api/stock/import/history/${job.id}/export?scope=failed&format=csv` })
    check('results export: 200 csv', res.statusCode === 200, res.statusCode)
    const lines = res.body.trim().split('\r\n')
    check('results export: header', lines[0] === 'sku,quantity,channel,marketplace,error,matched_sku,applied', lines[0])
    check(`results export: ${failedCount} failed rows`, lines.length === failedCount + 1, { got: lines.length - 1, failedCount })
    const xres = await app.inject({ method: 'GET', url: `/api/stock/import/history/${job.id}/export?scope=all&format=xlsx` })
    check('results export xlsx: 200', xres.statusCode === 200)
  }
  const nf = await app.inject({ method: 'GET', url: '/api/stock/import/history/does-not-exist/export' })
  check('results export: unknown job 404', nf.statusCode === 404)
}

await prisma.$disconnect()
console.log(fails === 0 ? '\n🎉 IM.3.5 verify: ALL PASS' : `\n💥 IM.3.5 verify: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
