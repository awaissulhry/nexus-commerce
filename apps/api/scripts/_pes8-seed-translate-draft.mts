// D7 — seed a hand-written TRANSLATION draft (zero AI calls) and tear it down.
//   npx tsx scripts/_pes8-seed-translate-draft.mts [--clean]
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { recordDrafts } = await import('../src/services/ai/enrichment/draft.service.js')
const { encodeCellKey } = await import('../src/services/ai/enrichment/cell-key.js')
const { getPrimaryLanguage } = await import('../src/services/products/translation-resolver.service.js')

const RUN_PREFIX = 'pes8-d7-'
if (process.argv.includes('--clean')) {
  const d = await prisma.productAiDraft.deleteMany({ where: { runId: { startsWith: RUN_PREFIX } } })
  const t = await prisma.productTranslation.deleteMany({ where: { productId: 'cmr1b1yxl0000s4rcvopsqv42', language: 'de' } })
  console.log(`removed ${d.count} draft(s), ${t.count} translation row(s)`)
  await prisma.$disconnect(); process.exit(0)
}

console.log('primary language (must NOT be the target):', getPrimaryLanguage())
const P = 'cmr1b1yxl0000s4rcvopsqv42'
const LOCALE = 'de'
const addr = (writeField: string) => ({ channel: null, marketplace: null, aliasId: null, locale: LOCALE, writeField })

const existing = await prisma.productTranslation.findUnique({ where: { productId_language: { productId: P, language: LOCALE } } })
console.log('existing de translation row:', existing ? `name=${JSON.stringify(existing.name)} reviewedAt=${existing.reviewedAt}` : '(none)')

const runId = `${RUN_PREFIX}${Date.now()}`
const res = await recordDrafts(runId, 'fixture', 'none', [
  {
    productId: P, market: 'DE', cellKey: encodeCellKey(addr('description')), address: addr('description'),
    columnKey: 'description',
    draftValue: 'Viersaison-Motorradjacke mit wasserdichter Membran, herausnehmbarem Thermofutter und CE-Protektoren. (Fixture — nicht vom Modell geschrieben.)',
    baseValue: existing?.description ?? null, baseSource: 'stored', status: 'pending' as const,
    confidence: 'high' as const, rationale: 'D7 fixture: ordinary approvable translation',
    promptHash: 'fixture', capsUsed: { maxLength: 2000, maxBytes: 2000, capFrom: 'Amazon · DE' }, violations: null,
  },
  {
    productId: P, market: 'DE', cellKey: encodeCellKey(addr('title')), address: addr('title'),
    columnKey: 'title',
    draftValue: 'XAVIA AIREON Motorradjacke Herren — CE Level 2, wasserdicht, Thermofutter',
    baseValue: existing?.name ?? null, baseSource: 'stored', status: 'pending' as const,
    confidence: 'high' as const, rationale: 'D7 fixture: maps to ProductTranslation.name',
    promptHash: 'fixture', capsUsed: { maxLength: 200, maxBytes: 200, capFrom: 'Amazon · DE' }, violations: null,
  },
])
console.log(`runId ${runId} — created ${res.created}, superseded ${res.superseded}`)
await prisma.$disconnect()
