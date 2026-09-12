// PES.8 — seed hand-written drafts for the ✦ path walk-through, and tear them down again.
//
//   npx tsx scripts/_pes8-seed-fixture-drafts.mts          seed
//   npx tsx scripts/_pes8-seed-fixture-drafts.mts --clean   remove
//
// ZERO AI calls: hub ruling #13 holds live generation, and these drafts are written by hand. That
// is the point — `approveDrafts` cannot tell where a draft came from, so the whole review path is
// provable without spending anything. The 8.3 end-to-end proved the same thing in one process;
// this leaves drafts SITTING there so the surface can be looked at.
//
// Writes go to the XAVIA test family only. `--clean` removes every draft this script created and
// touches nothing else — it never restores product values, because seeding does not change any.
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const { recordDrafts } = await import('../src/services/ai/enrichment/draft.service.js')
const { encodeCellKey } = await import('../src/services/ai/enrichment/cell-key.js')

const RUN_PREFIX = 'pes8-fixture-'
const clean = process.argv.includes('--clean')

if (clean) {
  const res = await prisma.productAiDraft.deleteMany({ where: { runId: { startsWith: RUN_PREFIX } } })
  console.log(`removed ${res.count} fixture draft(s)`)
  await prisma.$disconnect()
  process.exit(0)
}

const products = await prisma.product.findMany({
  where: { sku: { in: ['AIREON', 'AIRMESH-JACKET'] } },
  select: { id: true, sku: true, name: true, description: true, categoryAttributes: true },
})
if (products.length === 0) throw new Error('no XAVIA fixture products found')

const runId = `${RUN_PREFIX}${Date.now()}`
const master = (writeField: string) => ({
  channel: null,
  marketplace: null,
  aliasId: null,
  locale: null,
  writeField,
})

const rows = products.flatMap((p) => {
  const attrs = (p.categoryAttributes as Record<string, unknown> | null) ?? {}
  return [
    // A clean, approvable draft — the ordinary case.
    {
      productId: p.id,
      market: 'IT',
      cellKey: encodeCellKey(master('description')),
      address: master('description'),
      columnKey: 'description',
      draftValue: `${p.sku}: giacca da moto four-season con membrana impermeabile, fodera termica rimovibile e protezioni CE. (fixture draft — not model-written)`,
      baseValue: p.description ?? null,
      baseSource: 'stored',
      status: 'pending' as const,
      confidence: 'high' as const,
      rationale: 'fixture: the ordinary approvable case',
      promptHash: 'fixture',
      capsUsed: { maxLength: 2000, maxBytes: 2000, capFrom: 'Amazon · IT' },
      violations: null,
    },
    // One that breaks a HARD cap: must render with its reason, must NOT tint a cell, and must
    // offer no approve control anywhere.
    {
      productId: p.id,
      market: 'IT',
      cellKey: encodeCellKey(master('name')),
      address: master('name'),
      columnKey: 'item_name',
      draftValue: `${p.sku} ${'giacca moto impermeabile con protezioni CE livello 2 '.repeat(6)}`,
      baseValue: p.name ?? null,
      baseSource: 'stored',
      status: 'failed' as const,
      confidence: 'medium' as const,
      rationale: 'fixture: over the Amazon IT title cap',
      promptHash: 'fixture',
      capsUsed: { maxLength: 200, maxBytes: 200, capFrom: 'Amazon · IT' },
      violations: [
        {
          kind: 'over_max_length',
          severity: 'error',
          message: '276 of 200 characters — the Amazon · IT cap',
          limit: 200,
          actual: 276,
        },
      ],
    },
    // An off-list select value: offerable, but flagged. The eBay-flat-file rule, on screen.
    {
      productId: p.id,
      market: 'IT',
      cellKey: encodeCellKey(master('attr_material')),
      address: master('attr_material'),
      columnKey: 'material',
      draftValue: 'Cordura',
      baseValue: attrs.material ?? null,
      baseSource: 'stored',
      status: 'pending' as const,
      confidence: 'medium' as const,
      rationale: 'fixture: off-list value, warns but stays approvable',
      promptHash: 'fixture',
      capsUsed: { maxLength: 500, maxBytes: 2000, capFrom: 'Amazon · IT', mode: 'strict' },
      violations: [
        {
          kind: 'off_list',
          severity: 'warn',
          message: '"Cordura" is not in the channel\'s list — it may be rejected at publish',
        },
      ],
    },
  ]
})

const res = await recordDrafts(runId, 'fixture', 'none', rows)
console.log(`runId ${runId}`)
console.log(`created ${res.created} draft(s), superseded ${res.superseded}`)
for (const p of products) console.log(`  ${p.sku}  ${p.id}`)
console.log('')
console.log('To make one of them STALE (so the ✦ stale state and the approve-anyway path can be')
console.log('walked), edit that cell in the studio, or change the value any other way — the overlay')
console.log('recomputes staleness against what is stored on every read.')
console.log('')
console.log('Tear down with: npx tsx scripts/_pes8-seed-fixture-drafts.mts --clean')
await prisma.$disconnect()
