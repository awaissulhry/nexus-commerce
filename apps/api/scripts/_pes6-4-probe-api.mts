// PES.6 — prove the new routes answer with REAL data, via app.inject()
// (reference_api_route_probe_by_inject: no server, no auth dance).
// Register ONLY the PES.6 plugin — the whole index.ts would boot crons and queues.
import Fastify from 'fastify'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../.env', import.meta.url).pathname })
const { default: routes } = await import('../src/routes/channel-mapping.routes.js')
const app = Fastify({ logger: false })
await app.register(routes, { prefix: '/api' })
await app.ready()

const j = async (method: string, url: string, payload?: any) => {
  const r = await app.inject({ method: method as any, url, payload })
  return { status: r.statusCode, body: (() => { try { return r.json() } catch { return r.body.slice(0, 200) } })() }
}

console.log('\n=== templates ===')
const t = await j('GET', '/api/pim/channel-mapping/templates')
console.log('status', t.status)
for (const x of (t.body as any).templates ?? []) {
  console.log(` ${x.channel} ${x.code}\t fields=${x.fieldCount} mapped=${x.mappedCount} overlays=${x.overlayTypes.length} exprs=${x.expressionCount}`)
}

console.log('\n=== functions ===')
const f = await j('GET', '/api/pim/channel-mapping/functions')
console.log('status', f.status, 'count', (f.body as any).functions?.length)

console.log('\n=== fields: AMAZON/IT default bucket ===')
const f1 = await j('GET', '/api/pim/channel-mapping/AMAZON/IT/fields')
console.log('status', f1.status, 'total', (f1.body as any).counts?.total, 'schema', JSON.stringify((f1.body as any).schema))

console.log('\n=== fields: AMAZON/IT productType=OUTERWEAR ===')
const f2: any = (await j('GET', '/api/pim/channel-mapping/AMAZON/IT/fields?productType=OUTERWEAR')).body
console.log('counts:', JSON.stringify(f2.counts))
console.log('schema:', JSON.stringify(f2.schema))
console.log('groups:', f2.groups.map((g: any) => `${g.key}(${g.label})`).join(', '))
const byPrio: Record<string, number> = {}
for (const fl of f2.fields) byPrio[fl.priority] = (byPrio[fl.priority] ?? 0) + 1
console.log('priority histogram:', JSON.stringify(byPrio))
console.log('prioritySource histogram:', JSON.stringify(f2.fields.reduce((a: any, x: any) => (a[x.prioritySource] = (a[x.prioritySource]??0)+1, a), {})))
console.log('sample required fields:', f2.fields.filter((x: any) => x.priority === 'required').map((x: any) => x.fieldKey).join(', '))
console.log('sample mapped fields:', f2.fields.filter((x: any) => x.status === 'mapped').slice(0, 8).map((x: any) => `${x.fieldKey}[${x.ruleKind}]=${x.ruleSummary}`).join(' | '))

console.log('\n=== categories (our taxonomy) ===')
const c: any = (await j('GET', '/api/pim/channel-mapping/AMAZON/IT/categories')).body
console.log('counts:', JSON.stringify(c.counts))
console.log('first 8 rows:', c.rows.slice(0, 8).map((r: any) => `${r.categoryPath} (${r.productCount}p)${r.mapping ? ' → ' + r.mapping.channelCategoryId : ''}`).join('\n           '))

console.log('\n=== channel categories (picker) ===')
const cc: any = (await j('GET', '/api/pim/channel-mapping/AMAZON/IT/channel-categories')).body
console.log(cc.options.map((o: any) => o.id).join(', '), '|', cc.note)

console.log('\n=== preview SKUs ===')
const sk: any = (await j('GET', '/api/pim/channel-mapping/AMAZON/IT/preview-skus?q=GALE&limit=5')).body
for (const s of sk.skus) console.log(` ${s.label}  listedHere=${s.listedHere}  productType=${s.productType}`)

if (sk.skus.length > 0) {
  const pid = sk.skus[0].productId
  console.log('\n=== resolve (the engine) for', sk.skus[0].sku, '===')
  const r: any = (await j('POST', '/api/pim/channel-mapping/AMAZON/IT/resolve', { productIds: [pid], productType: 'OUTERWEAR' })).body
  const p = r.products?.[0]
  if (!p) { console.log('no product resolved', JSON.stringify(r).slice(0, 300)) }
  else {
    console.log('category:', JSON.stringify(p.category))
    console.log('counts:', JSON.stringify(p.counts))
    const cells = Object.values(p.cells) as any[]
    console.log('\n  mapped cells with values:')
    for (const cell of cells.filter((x) => x.status === 'mapped').slice(0, 12)) {
      console.log(`   ${cell.fieldKey.padEnd(28)} ${String(JSON.stringify(cell.value)).slice(0, 46).padEnd(48)} prov=${cell.provenance} err=${cell.errors.length} warn=${cell.warnings.length}${cell.autoCorrected ? ' AUTOCORRECTED' : ''}`)
    }
    const errs = cells.filter((x) => x.errors.length > 0)
    console.log(`\n  cells with errors: ${errs.length}`)
    for (const cell of errs.slice(0, 6)) console.log(`   ${cell.fieldKey}: ${cell.errors[0]}`)
  }
}

await app.close()
process.exit(0)
