/** LX.FIN item 5 (R-LX-26) — the store rows vs what the stores report. READ ONLY unless a delta exists. */
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const { normalizeLanguage } = await import('../src/services/pim/content-language.js')
console.log('current_database', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])

/** Measured live from each store at 2026-09-13T09:53:47Z by `_lxfin-storelocales.mts`. */
const measured: Record<string, { primaryTag: string | null; publishedTags: string[]; source: string }> = {
  SHOPIFY: { primaryTag: 'en', publishedTags: ['en', 'de', 'es', 'fr', 'it'], source: 'shopLocales (GraphQL query, read-only)' },
  ETSY: { primaryTag: 'en-US', publishedTags: ['en-US'], source: 'GET /v3/application/shops/57783036 → languages' },
  WOOCOMMERCE: { primaryTag: null, publishedTags: [], source: 'NO CONNECTION on this database — nothing to ask' },
}
const rows = await prisma.marketplace.findMany({ where: { channel: { in: ['SHOPIFY', 'ETSY', 'WOOCOMMERCE'] } }, select: { id: true, channel: true, code: true, language: true, languages: true } })
for (const row of rows) {
  const m = measured[row.channel]
  const primary = m.primaryTag ? normalizeLanguage(m.primaryTag) : null
  const published = [...new Set(m.publishedTags.map(normalizeLanguage))]
  const underRuling = primary ? [primary] : null
  console.log(JSON.stringify({
    channel: row.channel, code: row.code,
    stored: { language: row.language, languages: row.languages },
    storeReported: { primaryTag: m.primaryTag, publishedTags: m.publishedTags, source: m.source },
    'R-LX-26 value (primary only)': underRuling,
    'alternative (published locales)': published.length ? published : null,
    matchesRuling: underRuling ? JSON.stringify(row.languages) === JSON.stringify(underRuling) : 'UNMEASURABLE',
  }))
}
await prisma.$disconnect()
