/**
 * VT.1 Phase 4 — the WRITE rehearsal on `VX-TEST-3AX` only, through the running API on :8091.
 *
 * Every arm PREDICTS before it writes (reference_predict_before_you_write), reads back after **8 s**
 * (reference_read_before_the_write_arrived — a read at ~1.5 s on this path reads stale), and reports the PAIR:
 * the request, the response, and the independent read-back. A write's response is not what it wrote.
 *
 *   cd apps/api && npx tsx scripts/_vt1-write-rehearsal.mts <DATABASE_URL> [API_BASE]
 */
const url = process.argv[2]
if (!url || url.includes('neon.tech')) { console.error('local DATABASE_URL required (Neon is read-only for this lane)'); process.exit(2) }
const API = process.argv[3] ?? 'http://127.0.0.1:8091'
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const j = (v: unknown) => JSON.stringify(v)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log(`DB discriminator: GALE-JACKET Product.version = ${gale!.version} (local 59 / Neon prod 51)`)
const apiGale = await (await fetch(`${API}/api/products?search=GALE-JACKET&limit=60`)).json() as { products: Array<{ sku: string; version: number }> }
console.log(`API ${API} discriminator: GALE-JACKET version = ${apiGale.products.find((x) => x.sku === 'GALE-JACKET')?.version}`)

const parent = await p.product.findFirstOrThrow({ where: { sku: 'VX-TEST-3AX' }, select: { id: true, version: true, variationAxes: true } })
const children = await p.product.findMany({ where: { parentId: parent.id }, select: { id: true }, orderBy: { sku: 'asc' } })
const childIds = children.map((c) => c.id)
console.log(`fixture: ${parent.id} v${parent.version} axes=${j(parent.variationAxes)} children=${childIds.length}`)

const patch = async (path: string, body: unknown) => {
  const res = await fetch(`${API}/api/products/${parent.id}/studio/${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* keep the text */ }
  return { status: res.status, body: parsed as Record<string, unknown> }
}
const ACCOUNTS: Record<string, string> = {}
for (const [channel, marketplace] of [['AMAZON','IT'],['SHOPIFY','GLOBAL']] as const) {
  const row = await p.channelListing.findFirst({ where: { productId: parent.id, channel, marketplace }, select: { channelConnectionId: true } })
  if (row?.channelConnectionId) ACCOUNTS[`${channel}:${marketplace}`] = row.channelConnectionId
}
// The projection PATCH refuses an inferred account ("Choose an explicit connected account") - the coordinate is
// channel x market x ACCOUNT, and guessing which account a write lands on is exactly what that refusal prevents.
console.log('accounts:', j(ACCOUNTS))
const coord = (channel: string, market: string) => `channel=${channel}&market=${market}&accountId=${ACCOUNTS[`${channel}:${market}`] ?? ''}`

const readListing = (channel: string, marketplace: string) => p.channelListing.findFirst({
  where: { productId: parent.id, channel, marketplace },
  select: { version: true, variationTheme: true, variationMapping: true, platformAttributes: true },
})

// ── ARM 1 — master axes PATCH ────────────────────────────────────────────────────────────────────
{
  const before = await p.product.findFirstOrThrow({ where: { id: parent.id }, select: { version: true, variationAxes: true } })
  const axes = ['Taglia', 'Colore', 'Fit Type'] // REORDER: size first
  console.log(`\n=== ARM 1 master PATCH /studio/variation-axes`)
  console.log(`  before: v${before.version} axes=${j(before.variationAxes)}`)
  console.log(`  PREDICT: 200; Product.version ${before.version} -> ${before.version + 1}; axes -> ${j(axes)}`)
  const body = { version: before.version, axes, childIds, market: 'IT' }
  const res = await patch('variation-axes', body)
  console.log(`  request:  ${j(body)}`)
  console.log(`  response: ${res.status} ${j(res.body)}`)
  await sleep(8000)
  const after = await p.product.findFirstOrThrow({ where: { id: parent.id }, select: { version: true, variationAxes: true } })
  console.log(`  READ-BACK after 8 s: v${after.version} axes=${j(after.variationAxes)}`)
  console.log(`  VERDICT: version bumped = ${after.version === before.version + 1}; axes match the request = ${j(after.variationAxes) === j(axes)}`)
}

// ── ARM 2 — the 409, with a stale version ────────────────────────────────────────────────────────
{
  const now = await p.product.findFirstOrThrow({ where: { id: parent.id }, select: { version: true } })
  console.log(`\n=== ARM 2 master PATCH with a STALE version (${now.version - 1}, current ${now.version})`)
  console.log('  PREDICT: 409 (the axes route answers "This family changed after you reviewed it"), axes UNCHANGED')
  const res = await patch('variation-axes', { version: now.version - 1, axes: ['Colore'], childIds, market: 'IT' })
  console.log(`  response: ${res.status} ${j(res.body)}`)
  await sleep(8000)
  const after = await p.product.findFirstOrThrow({ where: { id: parent.id }, select: { version: true, variationAxes: true } })
  console.log(`  READ-BACK after 8 s: v${after.version} axes=${j(after.variationAxes)}`)
  console.log(`  VERDICT: refused = ${res.status >= 400}; version unchanged = ${after.version === now.version}`)
}

// ── ARM 3 — channel theme PATCH on Amazon·IT ─────────────────────────────────────────────────────
{
  const before = await readListing('AMAZON', 'IT')
  const theme = 'FIT_TYPE/SIZE_NAME/COLOR_NAME'
  console.log(`\n=== ARM 3 channel PATCH /studio/projection?channel=AMAZON&market=IT`)
  console.log(`  before: listing v${before!.version} theme=${j(before!.variationTheme)} mapping=${j(before!.variationMapping)}`)
  console.log(`  PREDICT: 200; ChannelListing.version ${before!.version} -> ${before!.version + 1}; variationTheme -> ${j(theme)}; source becomes 'override'`)
  const body = { expectedVersion: before!.version, theme, mapping: [
    { axisKey: 'Fit Type', target: 'fit_type', order: 0 },
    { axisKey: 'Taglia', target: 'size', order: 1 },
    { axisKey: 'Colore', target: 'color', order: 2 },
  ] }
  const res = await patch(`projection?${coord('AMAZON','IT')}`, body)
  console.log(`  request:  ${j(body)}`)
  console.log(`  response: ${res.status} ${typeof res.body === 'object' && res.body ? j({ error: res.body.error, message: res.body.message, version: (res.body as any).version, theme: (res.body as any).theme }) : j(res.body)}`)
  await sleep(8000)
  const after = await readListing('AMAZON', 'IT')
  console.log(`  READ-BACK after 8 s: listing v${after!.version} theme=${j(after!.variationTheme)} mapping=${j(after!.variationMapping)}`)
  console.log(`  VERDICT: version bumped = ${after!.version === before!.version + 1}; theme match = ${after!.variationTheme === theme}`)
  const cell = await readCell('AMAZON', 'IT')
  console.log(`  CELL now: source=${j(cell?.source)} theme=${j(cell?.theme)}`)
}

// ── ARM 4 — collision_unresolved: a mapping that drops an axis the variants need ──────────────────
{
  const before = await readListing('SHOPIFY', 'GLOBAL')
  console.log(`\n=== ARM 4 channel PATCH on SHOPIFY with only TWO axes mapped (Fit Type dropped)`)
  console.log(`  before: listing v${before!.version} mapping=${j(before!.variationMapping)}`)
  console.log('  PREDICT: 400 collision_unresolved; 4 variants in 2 groups; listing UNCHANGED (no version bump)')
  const body = { expectedVersion: before!.version, mapping: [
    { axisKey: 'Colore', target: 'Color', order: 0 },
    { axisKey: 'Taglia', target: 'Size', order: 1 },
  ] }
  const res = await patch(`projection?${coord('SHOPIFY','GLOBAL')}`, body)
  const b = res.body as any
  console.log(`  response: ${res.status} error=${j(b?.error)} message=${j(b?.message)}`)
  console.log(`  collisions: ${j(b?.collisions ? { unresolved: b.collisions.unresolved, groups: b.collisions.groups?.length, resolvers: b.collisions.resolvers } : null)}`)
  await sleep(8000)
  const after = await readListing('SHOPIFY', 'GLOBAL')
  console.log(`  READ-BACK after 8 s: listing v${after!.version} mapping=${j(after!.variationMapping)}`)
  console.log(`  VERDICT: refused = ${res.status === 400 && b?.error === 'collision_unresolved'}; nothing written = ${after!.version === before!.version}`)
}

// ── ARM 5 — reset clears the Amazon override ─────────────────────────────────────────────────────
{
  const before = await readListing('AMAZON', 'IT')
  console.log(`\n=== ARM 5 channel PATCH { reset: true } on AMAZON·IT`)
  console.log(`  before: listing v${before!.version} theme=${j(before!.variationTheme)} mapping=${j(before!.variationMapping)}`)
  console.log(`  PREDICT: 200; version ${before!.version} -> ${before!.version + 1}; theme -> null; mapping -> null; source back to 'derived'`)
  const res = await patch(`projection?${coord('AMAZON','IT')}`, { expectedVersion: before!.version, reset: true })
  console.log(`  response: ${res.status} ${typeof res.body === 'object' && res.body ? j({ error: (res.body as any).error, version: (res.body as any).version }) : j(res.body)}`)
  await sleep(8000)
  const after = await readListing('AMAZON', 'IT')
  console.log(`  READ-BACK after 8 s: listing v${after!.version} theme=${j(after!.variationTheme)} mapping=${j(after!.variationMapping)}`)
  const cell = await readCell('AMAZON', 'IT')
  console.log(`  CELL now: source=${j(cell?.source)} theme=${j(cell?.theme)}`)
  console.log(`  VERDICT: cleared = ${after!.variationTheme === null && after!.variationMapping === null}; version bumped = ${after!.version === before!.version + 1}`)
}

// ── ARM 6 — reset with a theme is refused (two intents in one request) ───────────────────────────
{
  const before = await readListing('AMAZON', 'IT')
  console.log(`\n=== ARM 6 { reset: true, theme: … } and { reset: false }`)
  console.log('  PREDICT: both 400 bad_projection_request; listing UNCHANGED')
  const a = await patch(`projection?${coord('AMAZON','IT')}`, { expectedVersion: before!.version, reset: true, theme: 'FIT_TYPE/SIZE/COLOR' })
  const b = await patch(`projection?${coord('AMAZON','IT')}`, { expectedVersion: before!.version, reset: false })
  console.log(`  reset+theme: ${a.status} ${j((a.body as any)?.message)}`)
  console.log(`  reset=false: ${b.status} ${j((b.body as any)?.message)}`)
  await sleep(8000)
  const after = await readListing('AMAZON', 'IT')
  console.log(`  READ-BACK after 8 s: listing v${after!.version} theme=${j(after!.variationTheme)}`)
  console.log(`  VERDICT: both refused = ${a.status === 400 && b.status === 400}; nothing written = ${after!.version === before!.version}`)
}

async function readCell(channel: string, market: string) {
  const res = await fetch(`${API}/api/products/${parent.id}/studio/sheet?scope=channel&channel=${channel}&market=${market}&accountId=${ACCOUNTS[`${channel}:${market}`] ?? ''}`)
  const sheet = await res.json() as { rows?: Array<{ parentId: string | null; values: Record<string, { value: unknown }> }> }
  const row = sheet.rows?.find((r) => r.parentId === null)
  return row?.values['variation_theme']?.value as { source?: unknown; theme?: unknown } | undefined
}

await p.$disconnect()
