#!/usr/bin/env node
// SR.1 — Verifies sentiment extraction end-to-end.
//
//   1. Insert 3 synthetic Review rows with varying sentiment
//   2. Run extractSentiment() on each
//   3. Assert: persistSentiment writes ReviewSentiment with non-empty
//      categories + topPhrases. AiUsageLog row created (unless rule-based
//      fallback was used — flagged in output).

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}

let exitCode = 0
function fail(msg) {
  console.error(`  ✗ ${msg}`)
  exitCode = 1
}
function pass(msg) {
  console.log(`  ✓ ${msg}`)
}

const c = new pg.Client({ connectionString: url })
await c.connect()

const ts = Date.now()
const cleanup = []

const samples = [
  {
    title: 'Taglia totalmente sbagliata',
    body: 'La giacca è troppo piccola, vestibilità completamente fuorviante. La cerniera si è anche bloccata dopo poco.',
    rating: 2,
    expectedLabel: 'NEGATIVE',
    expectedCategoriesAny: ['FIT_SIZING', 'DURABILITY', 'QUALITY'],
  },
  {
    title: 'Casco fantastico',
    body: 'Comodissimo, ottima ventilazione e bellissimo design. Spedizione rapidissima. Lo consiglio.',
    rating: 5,
    expectedLabel: 'POSITIVE',
    expectedCategoriesAny: ['COMFORT', 'DESIGN', 'SHIPPING', 'QUALITY'],
  },
  {
    title: 'Spedizione lenta',
    body: 'Il prodotto è ok ma è arrivato con due settimane di ritardo. Imballaggio anche danneggiato.',
    rating: 3,
    expectedLabel: 'NEGATIVE',
    expectedCategoriesAny: ['SHIPPING'],
  },
]

const reviewIds = []
for (const [i, s] of samples.entries()) {
  const reviewId = `verif-sentiment-${ts}-${i}`
  await c.query(
    `INSERT INTO "Review" (id, channel, marketplace, "externalReviewId", rating, title, body, "postedAt")
     VALUES ($1, 'AMAZON', 'IT', $2, $3, $4, $5, NOW())`,
    [reviewId, `verif-${ts}-${i}`, s.rating, s.title, s.body],
  )
  cleanup.push(['Review', reviewId])
  reviewIds.push(reviewId)
}

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { extractSentiment, persistSentiment } from './src/services/reviews/sentiment-extraction.service.ts'
    const cases = ${JSON.stringify(
      reviewIds.map((id, i) => ({
        reviewId: id,
        title: samples[i].title,
        body: samples[i].body,
        rating: samples[i].rating,
      })),
    )}
    const out = []
    for (const c of cases) {
      const r = await extractSentiment({ reviewId: c.reviewId, body: c.body, title: c.title, rating: c.rating, marketplace: 'IT' })
      await persistSentiment(r)
      out.push({ reviewId: r.reviewId, label: r.label, categories: r.categories, topPhrases: r.topPhrases, model: r.model, cacheHit: r.cacheHitTokens, cacheWrite: r.cacheWriteTokens })
    }
    console.log(JSON.stringify(out))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`extraction failed: ${runResult.stderr}`)
  await teardown()
  process.exit(1)
}
const results = JSON.parse(runResult.stdout.trim().split('\n').pop())
const usingRealLLM = results.every((r) => r.model !== 'rule-based-fallback')
console.log(
  `Extraction mode: ${usingRealLLM ? 'real LLM (' + results[0].model + ')' : 'rule-based fallback'}`,
)

for (const [i, r] of results.entries()) {
  if (r.label === samples[i].expectedLabel) {
    pass(`row[${i}] label=${r.label} (expected ${samples[i].expectedLabel})`)
  } else {
    fail(`row[${i}] label=${r.label}, expected ${samples[i].expectedLabel}`)
  }
  const intersect = r.categories.filter((c) => samples[i].expectedCategoriesAny.includes(c))
  if (intersect.length > 0) {
    pass(`row[${i}] categories contain one of expected: ${intersect.join(', ')}`)
  } else {
    fail(
      `row[${i}] no expected categories matched (got ${r.categories.join(',')}, expected one of ${samples[i].expectedCategoriesAny.join(',')})`,
    )
  }
  if (r.topPhrases.length === 0) {
    fail(`row[${i}] topPhrases empty`)
  } else {
    pass(`row[${i}] topPhrases=${r.topPhrases.length}`)
  }
}

// Sentiment persisted check.
const sentimentCount = await c.query(
  `SELECT COUNT(*) FROM "ReviewSentiment" WHERE "reviewId" = ANY($1)`,
  [reviewIds],
)
if (Number(sentimentCount.rows[0].count) === reviewIds.length) {
  pass(`${reviewIds.length} ReviewSentiment rows persisted`)
} else {
  fail(`expected ${reviewIds.length} ReviewSentiment rows, got ${sentimentCount.rows[0].count}`)
}

// AiUsageLog check — only when using real LLM.
if (usingRealLLM) {
  const usageCount = await c.query(
    `SELECT COUNT(*) FROM "AiUsageLog" WHERE "entityType" = 'Review' AND "entityId" = ANY($1)`,
    [reviewIds],
  )
  if (Number(usageCount.rows[0].count) === reviewIds.length) {
    pass(`${reviewIds.length} AiUsageLog rows recorded`)
  } else {
    fail(`expected ${reviewIds.length} AiUsageLog rows, got ${usageCount.rows[0].count}`)
  }
  // Prompt-cache check — at least one cache_write on the first call,
  // ideally cache_hit on subsequent calls within 5min.
  const cacheHits = results.reduce((a, r) => a + r.cacheHit, 0)
  const cacheWrites = results.reduce((a, r) => a + r.cacheWrite, 0)
  console.log(`Prompt cache: ${cacheWrites} writes, ${cacheHits} hits`)
  if (cacheWrites + cacheHits > 0) {
    pass(`prompt caching observed (writes=${cacheWrites} hits=${cacheHits})`)
  } else {
    console.log('  · Note: no cache writes/hits (may be due to model not supporting caching on free tier)')
  }
}

await teardown()
await c.end()
process.exit(exitCode)

async function teardown() {
  for (const [table, id] of cleanup.reverse()) {
    await c.query(`DELETE FROM "${table}" WHERE id = $1`, [id]).catch(() => {})
  }
}
