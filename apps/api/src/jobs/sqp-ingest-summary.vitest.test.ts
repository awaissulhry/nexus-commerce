/**
 * SQP.1 — the sqp-ingest summary is an interface, and the zero-row verdict is a defect signal.
 *
 * Both are tested through the pure `buildSqpSummary`, with NO mock of Amazon or Prisma. That matters
 * here specifically: the last time this area was "covered", a mocked shape-assertion test pinned the
 * bug in place rather than catching it. So every case below is built from numbers that were actually
 * measured on prod on 2026-08-12 (see docs/2026-08-12-sqp-feed.md) and asserts an observable
 * consequence, not an implementation shape.
 */
import { describe, it, expect } from 'vitest'
import { buildSqpSummary, type SqpMarketOutcome } from './sqp-ingest.job.js'

/**
 * 🔴 This regex is a COPY of the live reader in
 * `services/advertising/keyword-tracker.service.ts` (`/rows=(\d+)/`), which drives the KT page's
 * feed-health line. It is duplicated on purpose: if someone renames the token in the summary, this
 * test fails instead of the page silently reporting a healthy feed. If you change the reader, change
 * this line in the same commit.
 */
const KT_READER = /rows=(\d+)/

const MARKETS = ['DE', 'ES', 'FR', 'IE', 'IT', 'NL', 'PL', 'SE', 'UK']
const EMPTY = ['IE', 'NL', 'PL', 'SE', 'UK']

/** 2026-08-12, measured: 4 markets × 10 reports, every one abandoned at the poll ceiling. */
const allAbandoned: SqpMarketOutcome[] = ['DE', 'ES', 'FR', 'IT'].map((m) => ({
  marketplace: m, asinsRequested: 10, rows: 0, upserted: 0, failedAsins: 10, abandonedAsins: 10,
}))

/** 2026-08-10, measured: the last healthy night — 83 rows, one report abandoned. */
const healthy: SqpMarketOutcome[] = [
  { marketplace: 'DE', asinsRequested: 10, rows: 5, upserted: 5, failedAsins: 0, abandonedAsins: 0 },
  { marketplace: 'ES', asinsRequested: 10, rows: 71, upserted: 71, failedAsins: 0, abandonedAsins: 0 },
  { marketplace: 'FR', asinsRequested: 10, rows: 1, upserted: 1, failedAsins: 0, abandonedAsins: 0 },
  { marketplace: 'IT', asinsRequested: 10, rows: 6, upserted: 6, failedAsins: 1, abandonedAsins: 1 },
]

describe('buildSqpSummary — the KT page has to be able to read it', () => {
  it('exposes rows= as the count WRITTEN, which is what the KT reader extracts', () => {
    const { summary } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: healthy })
    const m = KT_READER.exec(summary)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(83) // 5 + 71 + 1 + 6, the 2026-08-10 total
  })

  it('does not let rows= be captured from the per-market detail instead of the total', () => {
    // The detail says "ES 10/10 done 71 rows" — no '=' — so the reader cannot latch onto a market's
    // number by accident. This is the trap that made the token safe to keep.
    const { summary } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: healthy })
    expect(summary.match(/rows=/g)).toHaveLength(1)
  })

  it('reports parsed and written as SEPARATE numbers', () => {
    // The old summary published only `upserted`, so "40 reports failed" and "40 reports came back
    // empty" printed identically. Parsed-but-not-written must be visible.
    const { summary } = buildSqpSummary({
      candidates: ['IT'], skipped: [],
      outcomes: [{ marketplace: 'IT', asinsRequested: 10, rows: 40, upserted: 12, failedAsins: 0, abandonedAsins: 0 }],
    })
    expect(summary).toContain('parsed=40')
    expect(summary).toContain('rows=12')
  })
})

describe('buildSqpSummary — a run that wrote nothing must not read green', () => {
  it('is fatal when every market wrote zero, and names abandonment as the cause', () => {
    const { summary, fatal } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: allAbandoned })
    expect(fatal).not.toBeNull()
    expect(fatal).toContain('ABANDONED')
    expect(fatal).toContain('docs/2026-08-12-sqp-feed.md')
    // The whole summary has to travel inside the message: recordCronRun persists outputSummary only
    // on the success path, so anything left out of the error is lost for that run.
    expect(fatal).toContain(summary)
    expect(KT_READER.exec(fatal!)?.[1]).toBe('0')
  })

  it('distinguishes abandonment from ordinary failure in the reason it gives', () => {
    const rejected = allAbandoned.map((o) => ({ ...o, abandonedAsins: 0 }))
    const { fatal } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: rejected })
    expect(fatal).toContain('40 of 40 reports failed')
    expect(fatal).not.toContain('ABANDONED')
  })

  it('is NOT fatal when a single row was written anywhere', () => {
    // One row is a working feed, however thin. The signal is "wrote nothing at all", not "wrote less
    // than usual" — a threshold would need a baseline, and FR legitimately writes 1 row a week.
    const barely = allAbandoned.map((o, i) => (i === 2 ? { ...o, upserted: 1, failedAsins: 9, abandonedAsins: 9 } : o))
    const { fatal } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: barely })
    expect(fatal).toBeNull()
  })

  it('is fatal when no market is eligible at all, and says which were considered', () => {
    const { fatal } = buildSqpSummary({ candidates: EMPTY, skipped: EMPTY, outcomes: [] })
    expect(fatal).toContain('no eligible marketplace')
    expect(fatal).toContain('IE,NL,PL,SE,UK')
  })

  it('is fatal when every market threw, rather than reporting 0 markets as success', () => {
    const errored: SqpMarketOutcome[] = ['DE', 'IT'].map((m) => ({
      marketplace: m, asinsRequested: 0, rows: 0, upserted: 0, failedAsins: 0, abandonedAsins: 0, errored: true,
    }))
    const { summary, fatal } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: errored })
    expect(fatal).not.toBeNull()
    expect(summary).toContain('marketErrors=2')
    expect(summary).toContain('DE ERROR')
  })
})

describe('buildSqpSummary — skipped markets are named, never dropped', () => {
  it('names the empty markets so a real failure can no longer hide behind a constant', () => {
    // The old loop iterated all 9 and threw on 5 every night, so `failed=5` was a constant and a
    // sixth, real failure was invisible inside it. Skipping silently would recreate that blindness.
    const { summary } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: healthy })
    expect(summary).toContain('markets=4')
    expect(summary).toContain('skipped=5[IE,NL,PL,SE,UK]')
    expect(summary).toContain('failed=1') // IT's one abandoned report on 2026-08-10 — a real number now
  })

  it('says nothing about skipping when nothing was skipped', () => {
    const { summary } = buildSqpSummary({ candidates: ['DE', 'ES', 'FR', 'IT'], skipped: [], outcomes: healthy })
    expect(summary).not.toContain('skipped')
  })

  it('omits the abandoned counter entirely when no report was abandoned', () => {
    // A zero that is always printed stops being read. This one only appears when it means something.
    const clean = healthy.map((o) => ({ ...o, failedAsins: 0, abandonedAsins: 0 }))
    const { summary } = buildSqpSummary({ candidates: MARKETS, skipped: EMPTY, outcomes: clean })
    expect(summary).not.toContain('abandoned')
    expect(summary).toContain('failed=0')
  })
})
