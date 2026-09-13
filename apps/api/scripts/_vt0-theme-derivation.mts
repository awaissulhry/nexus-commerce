/**
 * VT.0 — read-only measurement for the Variation theme column design (docs/2026-09-13-variation-theme-column-design.md §4).
 *
 *   npx tsx scripts/_vt0-theme-derivation.mts <DATABASE_URL>
 *
 * The URL is passed EXPLICITLY (reference_which_database_is_this_api_on) and named in the output with a discriminator
 * (Product.version on GALE-JACKET). Every statement is a SELECT. Nothing is written.
 *
 * Answers: (a) the Amazon variation_theme enum for the fixture product type on IT and DE; (c) for every family on the
 * catalogue, whether the derived tier (§3.2) resolves UNIQUELY, AMBIGUOUSLY, as a SET only, or NOT AT ALL, per Amazon
 * marketplace it lists on; plus the `_NAME` vs bare-form duplicates that decide the tie-break (D-VT8).
 */
const url = process.argv[2]
if (!url) { console.error('usage: tsx _vt0-theme-derivation.mts <DATABASE_URL>'); process.exit(2) }
const direct = url.replace('-pooler', '')
console.log('database host:', direct.split('@')[1]?.split('/')[0], '| db:', direct.split('/').pop()?.split('?')[0])

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: direct } } })
const q = <T = Record<string, unknown>>(s: string, ...args: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...args)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

// ── the canonicaliser the sheet uses (services/pim/variant-attribute-keys.ts), verbatim ──────────────────────
function canonicalVariantAxis(value: string): string {
  const key = value.toLowerCase().replace(/[\s_-]/g, '')
  return ({ colore: 'color', colour: 'color', farbe: 'color', couleur: 'color',
    taglia: 'size', taille: 'size', talla: 'size', größe: 'size', groesse: 'size',
    stylename: 'style' } as Record<string, string>)[key] ?? key
}
/** A theme SEGMENT is not an axis label: `COLOR_NAME` canonicalises to `colorname`, not `color`. Strip the suffix first. */
function canonicalThemeSegment(seg: string): string {
  return canonicalVariantAxis(seg.replace(/_?NAME$/i, ''))
}
function themeSegments(theme: string): string[] { return theme.split('/').map((s) => s.trim()).filter(Boolean) }
function themeValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).themes)) return (raw as any).themes.filter((x: unknown) => typeof x === 'string')
  return []
}
type Outcome = 'unique-in-order' | 'ambiguous-in-order' | 'set-only' | 'none' | 'no-schema' | 'no-axes'
function derive(axes: string[], themes: string[]): { outcome: Outcome; inOrder: string[]; asSet: string[] } {
  if (axes.length === 0) return { outcome: 'no-axes', inOrder: [], asSet: [] }
  if (themes.length === 0) return { outcome: 'no-schema', inOrder: [], asSet: [] }
  const want = axes.map(canonicalVariantAxis)
  const inOrder = themes.filter((t) => { const s = themeSegments(t).map(canonicalThemeSegment); return s.length === want.length && s.every((x, i) => x === want[i]) })
  const asSet = themes.filter((t) => { const s = themeSegments(t).map(canonicalThemeSegment); return s.length === want.length && [...s].sort().join('|') === [...want].sort().join('|') })
  const outcome: Outcome = inOrder.length === 1 ? 'unique-in-order' : inOrder.length > 1 ? 'ambiguous-in-order' : asSet.length > 0 ? 'set-only' : 'none'
  return { outcome, inOrder, asSet }
}

// ── 0. which database, and the positive control ─────────────────────────────────────────────────────────────
const who = await q<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
  `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`)
console.log('role:', j(who))
const products = await q<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "Product"`)
console.log('Product rows visible (positive control; 0 = RLS is hiding rows, NOT an empty catalogue):', Number(products[0]?.n))
const gale = await q<{ id: string; sku: string; version: number; productType: string | null; variationAxes: string[]; variationTheme: string | null }>(
  `SELECT id, sku, version, "productType", "variationAxes", "variationTheme" FROM "Product" WHERE sku = 'GALE-JACKET'`)
console.log('GALE-JACKET (discriminator = version):', j(gale))
if (!gale[0]) { console.log('fixture not visible — stop'); await p.$disconnect(); process.exit(1) }

// ── (a) the fixture product type's theme enum per Amazon marketplace ────────────────────────────────────────
const galePT = gale[0].productType
const galeMarkets = await q<{ marketplace: string; n: bigint }>(
  `SELECT cl."marketplace", count(*)::bigint AS n FROM "ChannelListing" cl JOIN "Product" c ON c.id = cl."productId"
   WHERE cl.channel = 'AMAZON' AND (c."parentId" = $1 OR c.id = $1) GROUP BY 1 ORDER BY 1`, gale[0].id)
console.log('\n(a) GALE Amazon marketplaces with listings:', j(galeMarkets))
const schemas = await q<{ marketplace: string | null; productType: string; schemaVersion: string; fetchedAt: Date; expiresAt: Date; isActive: boolean; themes: unknown }>(
  `SELECT "marketplace", "productType", "schemaVersion", "fetchedAt", "expiresAt", "isActive", "variationThemes" AS themes
   FROM "CategorySchema" WHERE channel = 'AMAZON' AND "productType" = $1 ORDER BY "marketplace", "fetchedAt" DESC`, galePT ?? '')
console.log(`CategorySchema rows for productType ${galePT}: ${schemas.length}`)
const latestByMarket = new Map<string, string[]>()
for (const s of schemas) {
  const mk = s.marketplace ?? '(null)'
  if (latestByMarket.has(mk)) continue
  const themes = themeValues(s.themes)
  latestByMarket.set(mk, themes)
  console.log(`  ${mk}: ${themes.length} themes · version ${s.schemaVersion} · fetched ${s.fetchedAt.toISOString().slice(0, 10)} · expires ${s.expiresAt.toISOString().slice(0, 10)} · active ${s.isActive}`)
}
for (const mk of ['IT', 'DE']) {
  const themes = latestByMarket.get(mk) ?? []
  const d = derive(gale[0].variationAxes, themes)
  console.log(`\n  ${mk} — derivation for axes ${j(gale[0].variationAxes)} → ${d.outcome}; in-order ${j(d.inOrder)}; as-set ${j(d.asSet)}`)
  console.log(`  ${mk} — full enum: ${j(themes)}`)
}
const it = latestByMarket.get('IT') ?? [], de = latestByMarket.get('DE') ?? []
console.log(`\n  IT vs DE enum: same set = ${[...it].sort().join('|') === [...de].sort().join('|')} · only IT ${j(it.filter((t) => !de.includes(t)))} · only DE ${j(de.filter((t) => !it.includes(t)))}`)

// ── the _NAME vs bare duplicates across EVERY cached Amazon schema (decides D-VT8) ───────────────────────────
const allSchemas = await q<{ marketplace: string | null; productType: string; themes: unknown; fetchedAt: Date }>(
  `SELECT DISTINCT ON ("marketplace", "productType") "marketplace", "productType", "variationThemes" AS themes, "fetchedAt"
   FROM "CategorySchema" WHERE channel = 'AMAZON' AND "isActive" = true ORDER BY "marketplace", "productType", "fetchedAt" DESC`)
const allThemes = new Set<string>()
let withThemes = 0
for (const s of allSchemas) { const t = themeValues(s.themes); if (t.length) withThemes++; t.forEach((x) => allThemes.add(x)) }
console.log(`\nAmazon schemas cached: ${allSchemas.length} (marketplace × productType); with a theme enum: ${withThemes}; distinct theme values: ${allThemes.size}`)
const byCanon = new Map<string, string[]>()
for (const t of allThemes) { const k = themeSegments(t).map(canonicalThemeSegment).join('/'); byCanon.set(k, [...(byCanon.get(k) ?? []), t]) }
const dupes = [...byCanon.entries()].filter(([, v]) => v.length > 1)
console.log(`canonical keys that have MORE THAN ONE spelling (the tie-break cases): ${dupes.length}`)
for (const [k, v] of dupes) console.log(`  ${k}: ${j(v)}`)
const segs = new Set<string>(); for (const t of allThemes) themeSegments(t).forEach((s) => segs.add(s))
console.log(`distinct segments: ${j([...segs].sort())}`)

// ── (c) derivation outcome for every family on the catalogue ────────────────────────────────────────────────
const roots = await q<{ id: string; sku: string; productType: string | null; variationAxes: string[]; children: bigint }>(
  `SELECT r.id, r.sku, r."productType", r."variationAxes", (SELECT count(*) FROM "Product" c WHERE c."parentId" = r.id)::bigint AS children
   FROM "Product" r WHERE r."parentId" IS NULL AND EXISTS (SELECT 1 FROM "Product" c WHERE c."parentId" = r.id) ORDER BY r.sku`)
console.log(`\n(c) families (roots with ≥1 child): ${roots.length}`)
const familyMarkets = await q<{ rootId: string; marketplace: string }>(
  `SELECT DISTINCT COALESCE(c."parentId", c.id) AS "rootId", cl."marketplace" FROM "ChannelListing" cl JOIN "Product" c ON c.id = cl."productId"
   WHERE cl.channel = 'AMAZON'`)
const marketsByRoot = new Map<string, string[]>()
for (const fm of familyMarkets) marketsByRoot.set(fm.rootId, [...(marketsByRoot.get(fm.rootId) ?? []), fm.marketplace])
const schemaIndex = new Map<string, string[]>()
for (const s of allSchemas) schemaIndex.set(`${s.marketplace ?? ''}|${s.productType}`, themeValues(s.themes))
const tally: Record<string, number> = {}
const rows: string[] = []
for (const r of roots) {
  const mks = marketsByRoot.get(r.id) ?? []
  if (mks.length === 0) { tally['no-amazon-listing'] = (tally['no-amazon-listing'] ?? 0) + 1; rows.push(`${r.sku} · ${r.children} children · axes ${j(r.variationAxes)} · PT ${r.productType} · no Amazon listing`); continue }
  for (const mk of mks) {
    const themes = schemaIndex.get(`${mk}|${r.productType ?? ''}`) ?? []
    const d = derive(r.variationAxes ?? [], themes)
    tally[d.outcome] = (tally[d.outcome] ?? 0) + 1
    rows.push(`${r.sku} · ${r.children} children · axes ${j(r.variationAxes)} · PT ${r.productType} · ${mk} → ${d.outcome}${d.inOrder.length ? ' ' + j(d.inOrder) : d.asSet.length ? ' set ' + j(d.asSet) : ''}`)
  }
}
console.log('outcome tally (per family × Amazon marketplace):', j(tally))
for (const line of rows) console.log('  ' + line)

// ── the two theme stores, counted (T2) ──────────────────────────────────────────────────────────────────────
const stores = await q(`SELECT
  (SELECT count(*) FROM "Product" WHERE "variationTheme" IS NOT NULL)::bigint AS product_theme_rows,
  (SELECT count(*) FROM "ChannelListing" WHERE "variationTheme" IS NOT NULL)::bigint AS listing_theme_rows,
  (SELECT count(*) FROM "ChannelListing" WHERE "variationMapping" IS NOT NULL)::bigint AS listing_mapping_rows,
  (SELECT count(*) FROM "ChannelListing" WHERE channel = 'AMAZON' AND "variationTheme" IS NOT NULL)::bigint AS amazon_listing_theme_rows,
  (SELECT count(*) FROM "ChannelListing" WHERE channel = 'EBAY' AND "variationTheme" IS NOT NULL)::bigint AS ebay_listing_theme_rows`)
console.log('\nstore counts:', j(stores[0]))
await p.$disconnect()
