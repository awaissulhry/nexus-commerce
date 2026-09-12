/**
 * VP.2 — in-process probes of the four new routes, through `app.inject()`.
 *
 * Reaching the handler rather than the network means the reading is of the ROUTE, not of a dev server that
 * might be serving a different build (`reference_api_route_probe_by_inject`). Every call here is a READ except
 * the two dry runs, which the service refuses to commit by construction.
 *
 * Run: `DATABASE_URL=... npx tsx _vp2-inject.mts`
 */
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'

const GALE = 'cmokmy3a40078pm0p1fvnu523'
const EBAY_IT_ACCOUNT = 'cmr4aaqb00025nz016k18rup9'

const app = Fastify()
await app.register(multipart)
await app.register(routes)
await app.ready()

const line = (label: string, res: { statusCode: number }, ms: number, extra = '') =>
  console.log(`${String(res.statusCode).padEnd(4)} ${String(ms + 'ms').padStart(7)}  ${label.padEnd(52)} ${extra}`)

async function probe(label: string, opts: Parameters<typeof app.inject>[0], show: (body: any) => string = () => '') {
  const t0 = Date.now()
  const res = await app.inject(opts)
  const ms = Date.now() - t0
  let body: any = null
  try { body = res.json() } catch { body = res.body?.slice(0, 120) }
  line(label, res, ms, show(body))
  return { res, body, ms }
}

console.log('code   time    route                                                detail')
console.log('-'.repeat(120))

// ── §5.1 family read ──────────────────────────────────────────────
const family = await probe(
  'GET /studio/family?market=IT',
  { method: 'GET', url: `/products/${GALE}/studio/family?market=IT` },
  (b) => `axes=${b.axes?.length} children=${b.children?.length} channels=${b.channels?.length} `
    + `combos=${b.coverage?.combinations} existing=${b.coverage?.existing} missing=${b.coverage?.missing?.length} `
    + `dups=${b.coverage?.duplicates?.length} conflicts=${b.coverage?.axisValueConflicts?.length}`,
)
if (family.res.statusCode === 200) {
  const b = family.body
  console.log('       axes          :', JSON.stringify(b.axes.map((a: any) => ({ key: a.key, storedKey: a.storedKey, source: a.source, values: a.values.length }))))
  console.log('       channels      :', b.channels.map((c: any) => `${c.channel}:${c.market}${c.connected ? '' : '(not set up)'}`).join(' '))
  const first = b.children[0]
  console.log('       child[0]      :', first.sku, JSON.stringify(first.axisValues), 'readiness=', JSON.stringify(first.readiness))
  console.log('       projections[0]:', JSON.stringify(first.projections))
  console.log('       parent EBAY:IT:', JSON.stringify(b.parent.projections['EBAY:IT']))
  console.log('       phases        :', JSON.stringify(b.meta.phases), 'tookMs=', b.meta.tookMs)
  const withValues = b.children.filter((c: any) => Object.keys(c.axisValues).length === b.axes.length).length
  console.log(`       axis coverage : ${withValues} of ${b.children.length} children carry every axis value`)
}

// ── error shapes ──────────────────────────────────────────────────
await probe('GET /studio/family (no market)', { method: 'GET', url: `/products/${GALE}/studio/family` }, (b) => b.error ?? '')
await probe('GET /studio/family (marketplace= typo)', { method: 'GET', url: `/products/${GALE}/studio/family?marketplace=IT` }, (b) => b.hint ?? b.error ?? '')
await probe('GET /studio/family (unknown product)', { method: 'GET', url: '/products/does-not-exist/studio/family?market=IT' }, (b) => b.error ?? '')

// ── §5.4 projection read ──────────────────────────────────────────
const ebay = await probe(
  'GET /studio/projection EBAY/IT',
  { method: 'GET', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}` },
  (b) => `v=${b.version} noun=${b.vocabulary?.axisNoun} limits=${b.limits?.axes}/${b.limits?.variants} `
    + `mapped=${b.mapping?.filter((m: any) => m.target).length}/${b.mapping?.length} options=${b.targetOptions?.length} `
    + `included=${b.counts?.included} locked=${b.locked ? 'YES' : 'no'} creatable=${b.split?.creatable}`,
)
if (ebay.res.statusCode === 200) {
  const b = ebay.body
  console.log('       mapping       :', JSON.stringify(b.mapping))
  console.log('       targetOptions :', JSON.stringify(b.targetOptions))
  console.log('       locked        :', JSON.stringify(b.locked))
  console.log('       split         :', JSON.stringify(b.split))
  console.log('       order         :', JSON.stringify({ axes: b.order?.axes, valueOrder: Object.keys(b.order?.valueOrder ?? {}), writableHere: b.order?.writableHere }))
  console.log('       coordinate    :', JSON.stringify(b.coordinate))
  console.log('       axes (A4)     :', JSON.stringify(b.axes))
  console.log('       child[0]      :', JSON.stringify(b.children[0]))
  console.log('       counts        :', JSON.stringify(b.counts), 'phases=', JSON.stringify(b.meta?.phases))
}

const amazon = await probe(
  'GET /studio/projection AMAZON/IT  (known slow)',
  { method: 'GET', url: `/products/${GALE}/studio/projection?channel=AMAZON&market=IT` },
  (b) => `v=${b.version} noun=${b.vocabulary?.axisNoun} limits=${b.limits?.axes}/${b.limits?.variants} `
    + `themeOptions=${b.theme?.options?.length} options=${b.targetOptions?.length} included=${b.counts?.included}`,
)
if (amazon.res.statusCode === 200) {
  console.log('       limits.source :', JSON.stringify(amazon.body.limits.source))
  console.log('       theme.value   :', JSON.stringify(amazon.body.theme?.value), 'first options:', JSON.stringify(amazon.body.targetOptions.slice(0, 6)))
  console.log('       affectsAll    :', amazon.body.affectsAllMarkets)
}

await probe('GET /studio/projection (no channel)', { method: 'GET', url: `/products/${GALE}/studio/projection?market=IT` }, (b) => b.error ?? '')
await probe('GET /studio/projection (no market)', { method: 'GET', url: `/products/${GALE}/studio/projection?channel=EBAY` }, (b) => b.error ?? '')

// ── §5.4 write refusals — all reached WITHOUT writing ─────────────
const v = ebay.body?.version ?? 0
await probe('PATCH /studio/projection (stale version)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v + 999, mapping: [] } },
  (b) => `${b.error}`)
await probe('PATCH /studio/projection (unknown axis)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v, mapping: [{ axisKey: 'Materiale', target: 'Materiale' }] } },
  (b) => `${b.error}: ${String(b.message).slice(0, 70)}`)
await probe('PATCH /studio/projection (two axes, one target)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v, mapping: [{ axisKey: 'Colore', target: 'Colore' }, { axisKey: 'Taglia', target: 'Colore' }] } },
  (b) => `${b.error}: ${String(b.message).slice(0, 70)}`)
await probe('PATCH /studio/projection (REMOVE a locked axis)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v, mapping: [{ axisKey: 'Colore', target: 'Colore' }] } },
  (b) => `${b.error}: ${String(b.message).slice(0, 90)}`)
await probe('PATCH /studio/projection (no version)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT`, payload: { mapping: [] } },
  (b) => `${b.error}`)

// ── include/exclude refusals, no write ────────────────────────────
await probe('PATCH /projection/children (stale version)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v + 999, changes: [{ id: 'x', included: false }] } },
  (b) => `${b.error}`)
await probe('PATCH /projection/children (foreign product id)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v, changes: [{ id: 'not-a-child', included: true }] } },
  (b) => `${b.error}: ${String(b.message).slice(0, 60)}`)
await probe('PATCH /projection/children (same id twice)',
  { method: 'PATCH', url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=IT&accountId=${EBAY_IT_ACCOUNT}`, payload: { expectedVersion: v, changes: [{ id: 'a', included: true }, { id: 'a', included: false }] } },
  (b) => `${b.error}: ${String(b.message).slice(0, 60)}`)

// ── §5.3 generate — DRY RUN ONLY. Nothing below creates a product. ─
const fv = family.body?.version ?? 0
const dry = await probe(
  'POST /studio/family/generate (dryRun)',
  { method: 'POST', url: `/products/${GALE}/studio/family/generate`, payload: {
    version: fv, dryRun: true, skuPattern: '{parent}-{Colore.code}-MEN-{Taglia.code}',
    axisValues: { Colore: ['Nero', 'Giallo', 'Rosso'], Taglia: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'] },
  } },
  (b) => `combos=${b.counts?.combinations} existing=${b.counts?.existing} willCreate=${b.counts?.willCreate} skipped=${b.skipped?.length}`,
)
if (dry.res.statusCode === 200) {
  console.log('       newValues     :', JSON.stringify(dry.body.newValues))
  console.log('       plan[0..2]    :', JSON.stringify(dry.body.plan.slice(0, 3)))
  const collisions = dry.body.skipped.filter((s: any) => s.reason === 'sku_collision')
  console.log('       collisions    :', collisions.length, JSON.stringify(collisions.slice(0, 2)))
}

await probe('POST generate (collides with an existing SKU, dryRun)',
  { method: 'POST', url: `/products/${GALE}/studio/family/generate`, payload: {
    version: fv, dryRun: true, skuPattern: 'GALE-JACKET-BLACK-MEN-3XL',
    axisValues: { Colore: ['Rosso'], Taglia: ['XXS'] },
  } },
  (b) => `willCreate=${b.counts?.willCreate} skipped=${JSON.stringify(b.skipped)}`)

await probe('POST generate (unknown SKU token, dryRun)',
  { method: 'POST', url: `/products/${GALE}/studio/family/generate`, payload: {
    version: fv, dryRun: true, skuPattern: '{parent}-{materiale}', axisValues: { Colore: ['Rosso'], Taglia: ['XXS'] },
  } },
  (b) => `${b.error}: ${String(b.message).slice(0, 80)}`)

await probe('POST generate (stale family version, dryRun)',
  { method: 'POST', url: `/products/${GALE}/studio/family/generate`, payload: {
    version: fv + 999, dryRun: true, skuPattern: '{parent}-{Colore.code}', axisValues: { Colore: ['Rosso'], Taglia: ['XXS'] },
  } },
  (b) => `willCreate=${b.counts?.willCreate ?? '-'} ${b.error ?? '(dry run does not check the version — it writes nothing)'}`)

await probe('POST generate (no dryRun flag)',
  { method: 'POST', url: `/products/${GALE}/studio/family/generate`, payload: { version: fv, skuPattern: '{parent}', axisValues: {} } },
  (b) => `${b.error}: ${String(b.message).slice(0, 70)}`)

await app.close()
console.log('\nDone. No product was created and no listing row was written by this run.')
process.exit(0)
