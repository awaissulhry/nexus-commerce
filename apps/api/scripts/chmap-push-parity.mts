/**
 * CHMAP M4 — push parity (study §8.6, check 4), offline: for an Amazon file IMPORTED into this database, build the
 * SP-API attributes the product-sheet push would send for each listing (`attributesFromCells`, the push's own
 * serializer, fed with what Nexus holds) and compare every mapped column of the file with the payload, after the
 * template's dictionary turns the file's labels into Amazon codes. Nothing is sent; read only.
 *   cd apps/api && npx tsx scripts/chmap-push-parity.mts --file "<imported Amazon file>" [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const FILE = arg('file'), JSON_OUT = arg('json')
if (!FILE) throw new Error('--file is required')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error('refusing: a local database whose name contains "test" only')

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
const { amazonFormOf } = await import('../src/services/channel-mapping/form.js')
const { findSetForForm, fieldRowOf } = await import('../src/services/channel-mapping/store.js')
const { codeFor } = await import('../src/services/channel-mapping/amazon-export.js')
const { attributesFromCells } = await import('../src/services/pim/mapping/schema-requirements.js')
const { loadAmazonSpec } = await import('../src/services/pim/channel-specs/index.js')
const { catalogRows, productInclude } = await import('../src/services/pim/catalog-transfer-export.js')
const { transferContracts } = await import('../src/services/pim/catalog-transfer-plan.js')
const { marketLanguages } = await import('../src/services/pim/market-languages.js')
const { normalizeLanguage } = await import('../src/services/pim/content-language.js')
const { default: prisma } = await import('../src/db.js')

/** `bullet_point[marketplace_id=…][language_tag=it_IT]#3.value` → the payload value at bullet_point[2].value. */
function readPath(payload: Record<string, unknown>, header: string): unknown {
  const segments = header.replace(/\[[^\]]*\]/g, '').split('.')
  let node: unknown = payload
  for (const segment of segments) {
    const m = /^(.*?)(?:#(\d+))?$/.exec(segment)!
    node = (node as Record<string, unknown> | undefined)?.[m[1]]
    if (m[2] !== undefined) node = Array.isArray(node) ? node[Number(m[2]) - 1] : m[2] === '1' ? node : undefined
  }
  return node
}
const same = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (typeof b === 'boolean') return String(b) === String(a).toLowerCase()
  const na = Number(String(a).replace(/^(\d+),(\d+)$/, '$1.$2')), nb = Number(b)
  return String(a).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) ? na === nb : String(a) === String(b)
}

let planted = false
const report = { file: FILE, control: 'not run', compared: 0, equal: 0, differ: [] as { sku: string; header: string; file: string; payload: unknown }[], notInPayload: [] as { sku: string; header: string; file: string }[], pushRefused: [] as { sku: string; reason: string }[] }
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const parsed = (await detectAmazonTemplate(readFileSync(FILE), { strict: true }))!
  const marketplace = parsed.meta.marketplace!
  const set = await findSetForForm(amazonFormOf(parsed, marketplace))
  if (!set) throw new Error('No mapping version for this file: import it first.')
  const fields = new Map(set.fields.map(fieldRowOf).map(f => [f.columnKey, f]))
  const skuHeader = parsed.headers.find(h => h.startsWith('contribution_sku'))!
  const typeHeader = parsed.headers.find(h => h.startsWith('product_type'))!
  const market = (await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace }, select: { language: true, languages: true } }))!
  const primary = normalizeLanguage(market.language)
  const languages = new Map([[JSON.stringify(['AMAZON', marketplace]), marketLanguages('AMAZON', marketplace, [{ channel: 'AMAZON', code: marketplace, language: market.language, languages: market.languages ?? [] }])]])
  const skus = [...new Set(parsed.rows.map(r => (r[skuHeader] ?? '').trim()).filter(Boolean))]
  const products = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, include: productInclude })
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true } })
  const rows = await catalogRows(products, { market: marketplace, marketplaces: [marketplace] }, transferContracts(marketplace, { allowIncompleteSchema: true }), families, undefined, languages) as { sku: string; aliasKey: string; channel: string; marketplace: string; field: string; locale: string; action: string; value?: unknown; entity: string }[]
  const specs = new Map<string, Awaited<ReturnType<typeof loadAmazonSpec>>>()
  for (const record of parsed.rows) {
    const sku = (record[skuHeader] ?? '').trim()
    if (!products.some(p => p.sku === sku)) continue
    const type = codeFor(parsed, typeHeader, (record[typeHeader] ?? '').trim()).toUpperCase()
    if (!specs.has(type)) specs.set(type, await loadAmazonSpec(marketplace, type))
    const spec = specs.get(type)!
    const values: Record<string, unknown> = {}
    for (const r of rows) if (r.channel === 'AMAZON' && r.marketplace === marketplace && r.sku === sku && !r.aliasKey && r.action === 'SET' && r.value !== undefined && (!r.locale || normalizeLanguage(r.locale) === primary)) values[r.field] = r.value
    // Positive control: the first listing's title is altered before the payload is built; exactly that cell must differ.
    if (!planted && typeof values.item_name === 'string') { values.item_name = `${values.item_name} (planted)`; planted = true; report.control = `planted in ${sku}` }
    let payload: Record<string, unknown>
    try { payload = attributesFromCells(spec, values) }
    catch (error) { report.pushRefused.push({ sku, reason: error instanceof Error ? error.message : String(error) }); continue }
    for (const header of parsed.headers) {
      const raw = (record[header] ?? '').trim()
      const decision = fields.get(header)
      if (!raw || decision?.state !== 'mapped' || decision.targetKind !== 'channelField') continue
      if (decision.productTypes.length && !decision.productTypes.includes(type)) continue
      const expected = codeFor(parsed, header, raw)
      const actual = readPath(payload, header)
      report.compared++
      if (actual === undefined) report.notInPayload.push({ sku, header, file: raw })
      else if (same(expected, actual)) report.equal++
      else report.differ.push({ sku, header, file: expected, payload: actual })
    }
  }
})
const byHeader = (list: { header: string }[]) => Object.entries(list.reduce<Record<string, number>>((a, x) => { const h = x.header.replace(/\[marketplace_id=[^\]]*\]/, ''); a[h] = (a[h] ?? 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1])
const plantedDiffers = report.differ.filter(d => d.header.startsWith('item_name') && String(d.payload).endsWith('(planted)')).length
report.control = planted ? (plantedDiffers === 1 ? 'caught' : `NOT CAUGHT (${plantedDiffers})`) : 'no title to plant'
report.differ = report.differ.filter(d => !String(d.payload).endsWith('(planted)'))
report.equal += 0
const summary = { file: FILE, pushRefused: report.pushRefused.length, pushRefusedReasons: [...new Set(report.pushRefused.map(r => r.reason))].slice(0, 3), control: report.control, compared: report.compared, equal: report.equal, differ: report.differ.length, notInPayload: report.notInPayload.length, differByColumn: byHeader(report.differ).slice(0, 10), notInPayloadByColumn: byHeader(report.notInPayload).slice(0, 10), differSamples: report.differ.slice(0, 6), notInPayloadSamples: report.notInPayload.slice(0, 4) }
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, report }, null, 1))
console.log(JSON.stringify(summary, null, 1))
await prisma.$disconnect()
process.exit(0)
