// Step 3.2 M3 — which language goes out, per Amazon market, for EVERY local product with a listing there. LOCAL ONLY.
//
// Calls `buildAmazonContentAttributes` — the function the studio publication calls for each product's content
// (`studio-publication-amazon.ts`) — inside ONE read-only transaction that is rolled back. `fetch` is stubbed to throw.
// For each content entry it finds the language the TEXT is in (the product's or parent's own columns = the primary
// content language; each ProductTranslation = its language) and compares it with the entry's `language_tag`.
//
//   cd apps/api && npx tsx ../../docs/product-cheat/tools/content-language.mts [--markets IT,DE,FR,ES]
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
const network: string[] = []
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error(`content-language: network refused (${String(input)})`) }) as typeof fetch
const API = '/Users/awais/nexus-commerce/apps/api/src'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const MARKETS = (flag('markets') ?? 'IT,DE,FR,ES').split(',').map(m => m.trim().toUpperCase())
const CONTENT = ['item_name', 'product_description', 'bullet_point', 'generic_keyword']

await import(`${API}/env.js`)
const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/').hostname
if (host !== '127.0.0.1') { console.error(`REFUSE: database host ${host} is not local`); process.exit(1) }
const { default: prisma } = await import(`${API}/db.js`)
const { inDatabaseReadTransaction } = await import(`${API}/lib/database-context.js`)
const { withWorkspace, LEGACY_WORKSPACE_ID } = await import(`${API}/lib/workspace-context.js`)
const { buildAmazonContentAttributes } = await import(`${API}/services/pim/amazon-content-payload.js`)
const { configuredAmazonMarketplaceId } = await import(`${API}/services/categories/marketplace-ids.js`)
const { marketLanguages } = await import(`${API}/services/pim/market-languages.js`)
const { PRIMARY_CONTENT_LOCALE } = await import(`${API}/services/pim/content-locale.js`)

const fieldOf: Record<string, [string, string]> = { item_name: ['name', 'name'], product_description: ['description', 'description'], bullet_point: ['bulletPoints', 'bulletPoints'], generic_keyword: ['keywords', 'keywords'] }
const textsOf = (p: any, key: string) => {
  const [column, tcol] = fieldOf[key]
  const out: Array<{ language: string; text: string }> = []
  const push = (language: string, v: unknown) => { for (const t of (Array.isArray(v) ? v : [v])) if (typeof t === 'string' && t) out.push({ language, text: t }) }
  if (p) { push(PRIMARY_CONTENT_LOCALE, p[column]); for (const t of p.translations ?? []) push(t.language, t[tcol]) }
  return out
}

const report: Record<string, unknown> = { database: host, primaryContentLanguage: PRIMARY_CONTENT_LOCALE }
await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => inDatabaseReadTransaction(prisma, async () => {
  for (const market of MARKETS) {
    const languages = await marketLanguages('AMAZON', market)
    const marketplaceId = await configuredAmazonMarketplaceId(market)
    const listings = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace: market, product: { deletedAt: null } },
      include: { translations: true, product: { include: { translations: true, parent: { include: { translations: true } } } } } })
    const t = { listings: listings.length, languages, withEntries: 0, withoutEntries: 0, withoutEntriesButHasMarketText: 0, refused: 0,
      entries: 0, tagMatchesText: 0, tagMismatch: 0, textNotFound: 0, tags: {} as Record<string, number>, sources: {} as Record<string, number>, mismatches: [] as unknown[], refusals: {} as Record<string, number>, missed: [] as unknown[] }
    for (const l of listings as any[]) {
      let attrs: Record<string, any[]>
      try {
        attrs = await buildAmazonContentAttributes({ product: l.product, parent: l.product.parent, listing: l, marketplace: market, marketplaceId: marketplaceId! })
      } catch (error) {
        t.refused++; const m = (error instanceof Error ? error.message : String(error)).slice(0, 80); t.refusals[m] = (t.refusals[m] ?? 0) + 1; continue
      }
      const keys = CONTENT.filter(k => attrs[k]?.length)
      const hasMarketText = CONTENT.some(k => [...textsOf(l.product, k), ...textsOf(l.product.parent, k)].some(x => languages.includes(x.language)))
      if (keys.length) t.withEntries++; else { t.withoutEntries++; if (hasMarketText && t.missed.length < 5) t.missed.push(l.product.sku); if (hasMarketText) t.withoutEntriesButHasMarketText++ }
      // The listing's own layer: its translations (a known language) and its own columns (language NOT recorded).
      const listingTexts = (k: string) => {
        const out: Array<{ language: string; text: string }> = []
        const push = (language: string, v: unknown) => { for (const x of (Array.isArray(v) ? v : [v])) if (typeof x === 'string' && x) out.push({ language, text: x }) }
        for (const tr of l.translations ?? []) push(tr.language, tr[fieldOf[k][1]])
        push('listing-own-column', k === 'item_name' ? l.title : k === 'product_description' ? l.description : k === 'bullet_point' ? l.bulletPointsOverride : null)
        return out
      }
      for (const k of keys) for (const e of attrs[k]) {
        t.entries++
        t.tags[e.language_tag] = (t.tags[e.language_tag] ?? 0) + 1
        const own = [...textsOf(l.product, k), ...textsOf(l.product.parent, k), ...listingTexts(k)]
        const langs = [...new Set(own.filter(x => x.text === e.value).map(x => x.language))]
        const tagLanguage = String(e.language_tag).split('_')[0]
        const src = langs.length ? langs.join('+') : 'not-found'
        ;(t as any).sources[src] = ((t as any).sources[src] ?? 0) + 1
        if (!langs.length) t.textNotFound++
        else if (langs.includes(tagLanguage)) t.tagMatchesText++
        else if (langs.includes('listing-own-column')) (t as any).listingOwnColumn = ((t as any).listingOwnColumn ?? 0) + 1
        else { t.tagMismatch++; if (t.mismatches.length < 8) t.mismatches.push({ sku: l.product.sku, key: k, tag: e.language_tag, textIsIn: langs, text: String(e.value).slice(0, 50) }) }
      }
    }
    report[market] = t
  }
}))
report.networkAttempts = network
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
