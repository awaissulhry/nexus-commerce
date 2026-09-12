#!/usr/bin/env node
/**
 * SC.1 — WRITABILITY conformance: does every column the studio declares writable
 * actually survive the write path's own validation?
 *
 * Hub ruling #564. This is D14.1's third witness (W-3). W-1 and W-2 live in
 * `scripts/check-layout-v2.mjs` (UX.1); W-3 was deliberately kept OUT of that gate because it
 * takes ~20 minutes against the real registry and would make the pre-handover gate unrunnable.
 *
 *   RUN ON DEMAND.  NEVER IN pre-push.
 *   npx tsx scripts/check-writability.mjs              # the four D14.1 coordinates
 *   npx tsx scripts/check-writability.mjs --self-test  # prove the red branch fires
 *   npx tsx scripts/check-writability.mjs --coord master:DE:de
 *
 * ⚠ Must be run under `tsx`, not bare `node`: it imports the API's TypeScript registry and route
 * plugin directly so it measures the same code the server runs, with no HTTP and no server.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSERTS
 *
 *   For every declared column whose `writeField` is an `attr_*` id:
 *       getFieldDefinition(writeField, { marketplace: <THE EFFECTIVE ONE> }) resolves and is
 *       editable,  OR  the cell already refuses it (`writeBlockedReason != null`).
 *
 * A column that fails this is offered to the operator as writable and returns 400 when they type
 * in it. That is #449's fourth category in a new costume: the cell EXISTS (so W-1 passes) and the
 * write is refused at the door.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE TRAP THIS SCRIPT EXISTS TO AVOID, AND WHICH IT ALMOST FELL INTO ITSELF
 *
 * "The effective marketplace" is NOT the market in the URL, and it is NOT what the writer puts in
 * its body. It is what `products.routes.ts` still has in hand when it calls `getFieldDefinition`.
 * Measured 2026-09-02, all three differed on the master scope until #569 landed:
 *
 *   the sheet was READ at              ?market=DE                              → DE
 *   `masterWrite.ts` (07:28:08) sent   [{ marketplace: 'DE', locale }]         → DE
 *   `products.routes.ts:1129` dropped it (`if (!c?.channel …) continue`)       → null
 *   so every master attr_* write 400'd, and a fix at the WRITER did not move it.
 *
 * A witness that takes the marketplace from the coordinate reports GREEN on master while every
 * operator write fails. So this script does NOT model the route: it CALLS the route's own
 * `validationMarketplace()` (`services/pim/validation-marketplace.ts`, exported for exactly this),
 * so the gate and the server cannot disagree. What it still replicates is the WRITER's payload,
 * and that has a drift guard: see DRIFT below.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 `writeBlockedReason` IS A PROPERTY OF THE CELL, NOT THE COLUMN.
 *
 * The first run of this gate read `column.writeBlockedReason` — a field that does not exist on
 * `SheetColumn` — so it was `undefined` on every column, `== null` was always true, and every
 * registry-refused column was reported RED even when the cell refuses it honestly. It reported
 * `condition_type` red on three coordinates; `condition_type` is one of the columns whose CELLS
 * carry `writable: false` and a reason. A false positive, and it took a fix, not an explanation.
 * The reason an operator actually sees lives on the cell, so the cell is what this reads.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NEVER A GREEN FOR A SUBSET
 *
 * A coordinate that cannot be read prints NOT MEASURED, not a pass. Every row prints how many of
 * its declared columns were actually checked, and the summary refuses to say "green" unless
 * checked === declared for every coordinate. An absence of evidence is never evidence of
 * compliance (`reference_absence_is_not_an_answer`).
 */
import { statSync, readFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const API = `${ROOT}/apps/api`
const PRODUCT = process.env.WRITABILITY_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523' // GALE-JACKET
const SELF_TEST = process.argv.includes('--self-test')

/* ── The two pieces of server logic this script REPLICATES, with a drift guard on each ─────────
 * If either source stops matching, the model is stale and every number it produces is a guess.
 * The run then reports NOT MEASURED rather than a number, because a witness that silently keeps
 * asserting an old rule is worse than no witness. */
const DRIFT = [
  { file: `${API}/src/routes/products.routes.ts`,
    needle: 'validationMarketplace(rawContexts)',
    models: 'the route derives its registry marketplace from the helper this gate calls' },
  { file: `${API}/src/routes/products.routes.ts`,
    needle: 'marketplace: registryMarketplace',
    models: 'the registry lookup uses that marketplace' },
  { file: `${ROOT}/apps/web/src/app/products/[id]/edit/_studio/sheet/master/masterWrite.ts`,
    needle: 'marketplaceContexts: [{ marketplace: ctx.market, locale: ctx.locale }]',
    models: 'the master writer sends a context with NO channel' },
  { file: `${ROOT}/apps/web/src/app/products/[id]/edit/_studio/sheet/channel/useChannelSheet.ts`,
    needle: 'marketplaceContexts',
    models: 'the channel writer sends contexts at all' },
]

/* What each scope's writer puts on the wire. Channel: `useChannelSheet.ts:230`. Master: above. */
const writerBodyFor = (scope, channel, market, locale) =>
  scope === 'master'
    ? [{ marketplace: market, locale }]                    // no channel — see the trap above
    : [{ channel, marketplace: market, locale }]

/* NOT replicated — imported from the route's own module below (#569). */

const COORDS = process.argv.includes('--coord')
  ? [process.argv[process.argv.indexOf('--coord') + 1]].map((s) => {
      const [scopeOrChannel, market, locale] = s.split(':')
      return scopeOrChannel === 'master'
        ? { name: `master ${market}/${locale}`, scope: 'master', channel: null, market, locale }
        : { name: `${scopeOrChannel}·${market}/${locale}`, scope: 'channel', channel: scopeOrChannel.toUpperCase(), market, locale }
    })
  : [
      { name: 'master DE/de', scope: 'master', channel: null, market: 'DE', locale: 'de' },
      { name: 'Amazon·DE/de', scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de' },
      { name: 'Amazon·IT/it', scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it' },
      { name: 'eBay·IT/it', scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' },
    ]

const stamp = (p) => { try { return statSync(p).mtime.toISOString().replace('T', ' ').slice(0, 19) } catch { return 'MISSING' } }
/* Stamped BEFORE and AFTER. A run of this gate takes tens of minutes against the real registry,
 * and on this repo the API source moves inside that window — three times during the pass that
 * produced this script. A number stamped only at the start silently spans two builds. */
const STAMPED = ['src/services/pim/studio-sheet.service.ts', 'src/services/pim/sheet-columns.service.ts',
                 'src/routes/products.routes.ts', 'src/routes/product-studio.routes.ts',
                 'src/services/pim/validation-marketplace.ts', 'src/services/pim/field-registry.service.ts']
const stampsNow = () => Object.fromEntries(STAMPED.map((f) => [f.split('/').pop(), stamp(`${API}/${f}`)]))
const stampsBefore = stampsNow()
const load1 = () => +loadavg()[0].toFixed(2)

console.log('writability conformance (D14.1 / W-3) — SC.1, hub #564')
console.log(`  product ${PRODUCT} · load(1m) ${load1()} · ${new Date().toISOString()}`)
for (const [f, m] of Object.entries(stampsBefore)) console.log(`  ${f.padEnd(30)} ${m}`)

/* ── drift guard ─────────────────────────────────────────────────────────────────────────── */
const drifted = []
for (const d of DRIFT) {
  let src = ''
  try { src = readFileSync(d.file, 'utf8') } catch { drifted.push(`${path.basename(d.file)} unreadable`); continue }
  if (!src.includes(d.needle)) drifted.push(`${path.basename(d.file)}: "${d.models}" no longer matches source`)
}
if (drifted.length) {
  console.log('\n🔶 NOT MEASURED — this script replicates server logic that has since moved:')
  for (const d of drifted) console.log(`     ${d}`)
  console.log('   Re-read the two sources named in DRIFT, update the model, then re-run.')
  console.log('   (Reporting a number here would assert a rule the server no longer follows.)')
  process.exit(2)
}

/* ── the API, in-process ─────────────────────────────────────────────────────────────────── */
await import(`${API}/src/env.js`)
process.env.RBAC_ENFORCE = 'false'
const { default: prisma } = await import(`${API}/src/db.js`)
const { getFieldDefinition } = await import(`${API}/src/services/pim/field-registry.service.js`)
/* The ROUTE's own function. If this import fails the gate reports NOT MEASURED rather than
 * falling back to a local copy — a local copy is precisely the drift this witness exists to catch. */
let validationMarketplace
try {
  ({ validationMarketplace } = await import(`${API}/src/services/pim/validation-marketplace.js`))
} catch (e) {
  console.log(`\n🔶 NOT MEASURED — cannot import the route's validationMarketplace(): ${e?.message ?? e}`)
  console.log('   Without it this gate would have to reimplement the rule it is checking. Refusing.')
  process.exit(2)
}
if (typeof validationMarketplace !== 'function') {
  console.log('\n🔶 NOT MEASURED — validation-marketplace.js exports no validationMarketplace function.')
  process.exit(2)
}
const require_ = createRequire(`${API}/package.json`)
const Fastify = (await import(pathToFileURL(require_.resolve('fastify')).href)).default
const app = Fastify({ logger: false })
await app.register((await import(`${API}/src/routes/product-studio.routes.js`)).default, { prefix: '/api' })

const rows = []
for (const c of COORDS) {
  const q = c.scope === 'master'
    ? `scope=master&market=${c.market}&locale=${c.locale}`
    : `scope=channel&channel=${c.channel}&market=${c.market}&locale=${c.locale}`
  const res = await app.inject({ method: 'GET', url: `/api/products/${PRODUCT}/studio/columns?${q}` })
  if (res.statusCode !== 200) {
    rows.push({ name: c.name, notMeasured: `/studio/columns returned ${res.statusCode}` })
    continue
  }
  const cols = res.json().columns
  // The CELLS carry `writeBlockedReason`; the columns do not. See the trap note in the header.
  const sheetRes = await app.inject({ method: 'GET', url: `/api/products/${PRODUCT}/studio/sheet?${q}` })
  if (sheetRes.statusCode !== 200) {
    rows.push({ name: c.name, notMeasured: `/studio/sheet returned ${sheetRes.statusCode} — cannot read the cells' refusal reasons, and the columns alone cannot answer` })
    continue
  }
  const sheetRows = sheetRes.json().rows
  /** Rows on which this column's cell offers itself with NO reason — those are the ones an
   *  operator can type in and get a 400 from. A column every row already refuses is honest. */
  const silentRows = (key) => sheetRows.filter((r) => {
    const v = r.values?.[key]
    return v && v.writable !== false && v.editable !== false && v.writeBlockedReason == null
  })
  const mkt = validationMarketplace(writerBodyFor(c.scope, c.channel, c.market, c.locale))
  const attrs = cols.filter((x) => typeof x.writeField === 'string' && x.writeField.startsWith('attr_'))
  const refused = []
  const honest = []
  let checked = 0
  for (const col of attrs) {
    let def
    try { def = await getFieldDefinition(col.writeField, { marketplace: mkt }) }
    catch (e) { refused.push({ key: col.key, why: `LOOKUP FAILED: ${e?.message ?? e}`, notMeasured: true }); continue }
    checked++
    const ok = !!def && def.editable !== false
    if (ok) continue
    // A cell that already refuses is HONEST — it is not this witness's failure. Only a cell that
    // OFFERS itself while the registry refuses the write is the defect.
    const silent = silentRows(col.key)
    if (silent.length === 0) { honest.push(col.key); continue }
    refused.push({ key: col.key, writeField: col.writeField,
                   why: def ? 'registry says not editable' : 'absent from the registry',
                   onRows: `${silent.length}/${sheetRows.length} rows offer it with no reason`,
                   eg: silent[0]?.sku })
  }
  rows.push({ name: c.name, declared: cols.length, attrs: attrs.length, checked, mkt, refused, honest,
              sends: JSON.stringify(writerBodyFor(c.scope, c.channel, c.market, c.locale)) })
}

/* ── report ───────────────────────────────────────────────────────────────────────────────── */
console.log('\n  coordinate      declared  attr_*  checked  effective mkt  refused-by-write-path')
let red = 0, unmeasured = 0
for (const r of rows) {
  if (r.notMeasured) { unmeasured++; console.log(`  ${r.name.padEnd(15)} NOT MEASURED — ${r.notMeasured}`); continue }
  const partial = r.checked !== r.attrs
  if (partial) unmeasured++
  if (r.refused.length) red++
  const flag = r.refused.length ? '🔴' : partial ? '🔶' : '✅'
  console.log(`  ${r.name.padEnd(15)} ${String(r.declared).padStart(8)}  ${String(r.attrs).padStart(6)}  ${String(r.checked).padStart(7)}  ${String(r.mkt).padEnd(13)}  ${flag} ${r.refused.length}${r.honest.length ? `  (+${r.honest.length} refused by the registry AND by the cell — honest: ${r.honest.join(', ')})` : ''}${partial ? ` (only ${r.checked}/${r.attrs} checked — NOT a green)` : ''}`)
  if (r.refused.length) {
    console.log(`      the writer sends ${r.sends} → the route keeps marketplace=${JSON.stringify(r.mkt)}`)
    for (const x of r.refused.slice(0, 8)) console.log(`      · ${x.key} (${x.writeField}) — ${x.why}; ${x.onRows}, e.g. ${x.eg}`)
    if (r.refused.length > 8) console.log(`      · … and ${r.refused.length - 8} more`)
  }
}
const allChecked = rows.every((r) => !r.notMeasured && r.checked === r.attrs)
console.log(
  red ? `\n🔴 RED — ${red} coordinate(s) offer columns the write path refuses. An operator typing in one gets 400.`
  : !allChecked ? '\n🔶 NOT MEASURED — some coordinates were not fully checked; this is not a pass.'
  : '\n✅ green — every declared attr_* column resolves in the registry the write path will use.')

/* ── self-test: prove the red branch can fire ─────────────────────────────────────────────── */
if (SELF_TEST) {
  console.log('\n── self-test ────────────────────────────────────────────────────────────────')
  const planted = 'attr_sc1_planted_contradiction_does_not_exist'
  const def = await getFieldDefinition(planted, { marketplace: 'DE' })
  const redFires = !def
  console.log(`  planted a column declared writable whose writeField the registry cannot resolve`)
  console.log(`  getFieldDefinition("${planted}", {marketplace:"DE"}) -> ${def ? 'FOUND (self-test invalid)' : 'absent'}`)
  console.log(`  red branch fires: ${redFires ? 'YES ✅' : 'NO 🔴 — this witness cannot fail, and a witness that cannot fail proves nothing'}`)
  const known = await getFieldDefinition('attr_weave_type', { marketplace: 'DE' })
  const greenFires = !!known && known.editable !== false
  console.log(`  positive control  attr_weave_type @DE -> ${known ? `found, editable=${known.editable}` : 'ABSENT'}; green branch reachable: ${greenFires ? 'YES ✅' : 'NO 🔴'}`)
  const nullMkt = await getFieldDefinition('attr_weave_type', { marketplace: null })
  console.log(`  discriminator     attr_weave_type @null -> ${nullMkt ? 'found' : 'ABSENT'} (must differ from @DE, or the marketplace argument is inert)`)
  // the helper must actually recover a channel-less context, or master silently reverts to null
  const helperMaster = validationMarketplace([{ marketplace: 'DE', locale: 'de' }])
  const helperChannel = validationMarketplace([{ channel: 'AMAZON', marketplace: 'IT' }])
  const helperEmpty = validationMarketplace([])
  console.log(`  helper            channel-less [{marketplace:"DE"}] -> ${JSON.stringify(helperMaster)} (must be "DE"; this is the master fix)`)
  console.log(`  helper            with channel  [{AMAZON, IT}]      -> ${JSON.stringify(helperChannel)} (must be "IT")`)
  console.log(`  helper            no contexts   []                  -> ${JSON.stringify(helperEmpty)} (must be null)`)
  const helperOk = helperMaster === 'DE' && helperChannel === 'IT' && helperEmpty === null
  if (!redFires || !greenFires || !!nullMkt || !helperOk) { console.log('  🔴 SELF-TEST FAILED'); await app.close(); await prisma.$disconnect(); process.exit(3) }
  console.log('  ✅ self-test passed — both branches reachable, the marketplace argument is load-bearing, and the helper recovers a channel-less context')
}

/* ── did the build move under the run? ────────────────────────────────────────────────────── */
const stampsAfter = stampsNow()
const moved = Object.keys(stampsAfter).filter((k) => stampsAfter[k] !== stampsBefore[k])
if (moved.length) {
  console.log(`\n🔶 THE BUILD MOVED DURING THIS RUN — ${moved.map((k) => `${k} ${stampsBefore[k]} → ${stampsAfter[k]}`).join(', ')}`)
  console.log('   The rows above span two builds. Re-run before quoting them, or quote them with this line attached.')
}
console.log(`  load(1m) at finish ${load1()} · ${new Date().toISOString()}`)

await app.close()
await prisma.$disconnect()
process.exit(red ? 1 : moved.length ? 2 : allChecked ? 0 : 2)
