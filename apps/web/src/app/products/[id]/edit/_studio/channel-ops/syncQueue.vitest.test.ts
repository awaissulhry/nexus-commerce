/**
 * PES.3 — the console's grouping, which is the whole feature.
 *
 * The failure this guards is not a crash: it is a console that shows 2,553 problems where there
 * are three, or three where there are 2,553. Both look tidy and both send the operator the wrong way.
 */
import { describe, expect, it } from 'vitest'

import { actionableCount, gateNote, groupIsQuiet, jumpTargetOf, modeForChannel, causeOf, groupByCause, matchesFilter, normaliseMessage, summarise, OUTCOME_CODES, STUCK_AFTER_MS, type SyncQueueRow } from './syncQueue'

const row = (over: Partial<SyncQueueRow> = {}): SyncQueueRow => ({
  id: Math.random().toString(36).slice(2), productId: 'p1',
  channelListingId: 'cl1', targetChannel: 'EBAY', targetRegion: 'IT', syncStatus: 'FAILED',
  syncType: 'PRICE_UPDATE', errorMessage: null, errorCode: null, retryCount: 0, maxRetries: 3,
  isDead: false, diedAt: null, holdUntil: null, externalListingId: '257584954808',
  sku: 'GALE-JACKET-BLACK-MEN-M', aliasId: null, aliasKey: '', aliasResolved: true,
  reason: 'rejected', reasonSummary: 'The marketplace refused it', reasonActionable: true, reasonWillRetry: false,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  syncedAt: null, nextRetryAt: null, ...over,
})

describe('one incident must not read as thousands of problems', () => {
  it('collapses the same failure carrying different ids and numbers into ONE cause', () => {
    const rows = [
      row({ errorMessage: 'Rate limit exceeded for item 257584954808 after 3 retries' }),
      row({ errorMessage: 'Rate limit exceeded for item 257584954999 after 7 retries' }),
      row({ errorMessage: 'Rate limit exceeded for item 257584954111 after 12 retries' }),
    ]
    expect(groupByCause(rows)).toHaveLength(1)
    expect(groupByCause(rows)[0].rows).toHaveLength(3)
  })

  it('does NOT collapse two genuinely different failures', () => {
    // The opposite error, and the worse one: a tidy console hiding a real second problem.
    const rows = [
      row({ errorMessage: 'Rate limit exceeded' }),
      row({ errorMessage: 'Invalid item specifics' }),
    ]
    expect(groupByCause(rows)).toHaveLength(2)
  })

  it('prefers the channel error CODE over the prose when there is one', () => {
    expect(causeOf(row({ errorCode: 'EBAY_VALIDATION', errorMessage: 'anything at all' }))).toBe('EBAY_VALIDATION')
  })

  it('does NOT group under a code that names the queue giving up', () => {
    // Measured: MAX_RETRIES_EXCEEDED covers 2,490 rows and 308 distinct messages, WRITE_GATE_DENIED
    // 2,198 and 300 — 97% of every coded row. Grouping by code renders the console as two buckets
    // named after the lifecycle, hiding an eBay 404, our own circuit breaker, and 368 rows that are
    // a publish flag switched off on purpose.
    const flagOff = row({ errorCode: 'MAX_RETRIES_EXCEEDED', errorMessage: 'NEXUS_ENABLE_AMAZON_PUBLISH=false — set true to enable Amazon outbound sync.' })
    const notFound = row({ errorCode: 'MAX_RETRIES_EXCEEDED', errorMessage: 'get offers 404: item not found' })
    expect(causeOf(flagOff)).not.toBe('MAX_RETRIES_EXCEEDED')
    expect(groupByCause([flagOff, notFound])).toHaveLength(2)
  })

  it('keeps the lifecycle code visible even though it is not the group name', () => {
    const g = groupByCause([row({ errorCode: 'MAX_RETRIES_EXCEEDED', errorMessage: 'circuit open' })])[0]
    expect(g.cause).toBe('circuit open')
    expect(g.codes).toEqual(['MAX_RETRIES_EXCEEDED'])
  })

  it('falls back to the code when it is a lifecycle code with NO message', () => {
    // Not "No error recorded": the code is the only thing known, and discarding it would lose it.
    expect(causeOf(row({ errorCode: 'WRITE_GATE_DENIED' }))).toBe('WRITE_GATE_DENIED')
    expect(OUTCOME_CODES.has('WRITE_GATE_DENIED')).toBe(true)
  })

  it('collapses a number glued to its unit — the retry-timer regression', () => {
    // 🔴 The real one. Written as `\b\d+\b`, the digit rule skipped `427s` (7→s is no boundary) and
    // the real GALE eBay·IT queue grouped into 33 causes for 36 rows — one per retry timer.
    const rows = [64, 427, 531].map((n) =>
      row({ errorCode: 'MAX_RETRIES_EXCEEDED', errorMessage: `eBay publish circuit open after 3 consecutive failures. Retry in ${n}s.` }),
    )
    expect(groupByCause(rows)).toHaveLength(1)
  })

  it('collapses cuid-shaped ids, which the hex rule cannot see', () => {
    // A cuid contains letters past f, so `[0-9a-f]{8,}` never matched one: four campaign_allowlist
    // groups differing only by a campaign id. Measured collapse: 4 groups → 1 (1,143 rows).
    // Real ids from this database, 25 chars — the `{20,}` threshold is measured against these, not
    // guessed: a 20+ character alphanumeric run is never a word.
    const rows = ['cmsik3icj9lupo1v4hp0q2wty', 'cmsik8ihm2luqo7ie9xk1p4dz', 'cmokmy3a40078pm0p1fvnu523'].map((id) =>
      row({ errorCode: 'WRITE_GATE_DENIED', errorMessage: `[ADS-WRITE-GATE-DENY] campaign_allowlist: campaign ${id} is not on the live-write allowlist` }),
    )
    expect(groupByCause(rows)).toHaveLength(1)
  })

  it('says so when no error was recorded rather than grouping under empty', () => {
    expect(causeOf(row())).toBe('No error recorded')
  })
})

describe('row count and SKU count answer different questions', () => {
  it('separates one SKU retrying itself from a channel-wide outage', () => {
    const deep = groupByCause(Array.from({ length: 50 }, () => row({ errorCode: 'RATE_LIMIT', productId: 'p1' })))
    const broad = groupByCause(Array.from({ length: 50 }, (_, i) => row({ errorCode: 'RATE_LIMIT', productId: `p-${i}` })))
    expect(deep[0].rows).toHaveLength(50)
    expect(deep[0].products).toBe(1)      // one product, failing over and over
    expect(broad[0].products).toBe(50)    // fifty products, failing once — a different problem
  })

  it('orders the biggest cause first, so triage starts where the volume is', () => {
    const g = groupByCause([
      row({ errorCode: 'SMALL' }),
      ...Array.from({ length: 5 }, () => row({ errorCode: 'BIG' })),
    ])
    expect(g[0].cause).toBe('BIG')
  })

  it('reports the shape, not just the size', () => {
    const g = groupByCause([row({ errorCode: 'A', productId: 'X' }), row({ errorCode: 'B', productId: 'Y' })])
    expect(g).toHaveLength(2) // client-side message grouping, a finer axis than the server's
    expect(summarise([], 0, 'queued writes')).toMatch(/nothing queued/i)
  })
})

describe('filters', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z')

  it('dead means dead', () => {
    expect(matchesFilter(row({ isDead: true }), 'dead', now)).toBe(true)
    expect(matchesFilter(row({ isDead: false }), 'dead', now)).toBe(false)
  })

  it('stuck means old AND still unresolved — not merely old', () => {
    const old = '2026-08-01T00:00:00.000Z'
    expect(matchesFilter(row({ createdAt: old }), 'stuck', now)).toBe(true)
    // Succeeded three weeks ago: old, and not a problem.
    expect(matchesFilter(row({ createdAt: old, syncedAt: old }), 'stuck', now)).toBe(false)
    // Dead rows have their own filter; counting them twice would inflate both.
    expect(matchesFilter(row({ createdAt: old, isDead: true }), 'stuck', now)).toBe(false)
  })

  it('does not call a fresh row stuck', () => {
    const fresh = new Date(now - STUCK_AFTER_MS / 2).toISOString()
    expect(matchesFilter(row({ createdAt: fresh }), 'stuck', now)).toBe(false)
  })
})

describe('normaliseMessage is conservative on purpose', () => {
  it('strips ids, timestamps and counts', () => {
    expect(normaliseMessage('Failed at 2026-08-01T03:00:00Z for 257584954808 (attempt 4)'))
      .not.toMatch(/2026|2575|4/)
  })

  it('keeps the words that distinguish one cause from another', () => {
    expect(normaliseMessage('Invalid item specifics for 123')).toContain('Invalid item specifics')
  })
})

describe('the publish gate decides whether a retry could ever work', () => {
  it('says the flag is what has to change, not the retry', () => {
    // Measured, not inferred: outbound-sync.service.ts:1209 calls the SAME getEbayPublishMode() the
    // sheet reports, and on 'gated' fails with the message on 368 real queue rows.
    expect(gateNote('gated', 'eBay')).toMatch(/switched off on the server/)
    expect(gateNote('gated', 'eBay')).toMatch(/flag, not the retry/)
  })

  it('distinguishes dry-run from gated — a cleared queue would not mean the channel was updated', () => {
    expect(gateNote('dry-run', 'eBay')).toMatch(/without touching the real listing/)
    expect(gateNote('dry-run', 'eBay')).not.toBe(gateNote('gated', 'eBay'))
  })

  it('says nothing when the mode is live — the ONLY mode that earns silence', () => {
    expect(gateNote('live', 'eBay')).toBeNull()
  })

  it('🔴 WARNS on an unrecognised mode rather than treating it as live', () => {
    // A shared `default: return null` made "we do not know this mode" indistinguishable from
    // "publishing is real". Silence there reads as "normal" at exactly the moment the console
    // cannot vouch for what a retry would do. This branch is also the precondition for the union
    // being open at all (P2-4).
    const note = gateNote('canary' as never, 'eBay')
    expect(note).not.toBeNull()
    expect(note).toMatch(/unrecognised publish mode \(canary\)/)
    expect(note).toMatch(/cannot say what a retry would do/)
  })

  it('returns null for a channel the response does not describe, never a guess', () => {
    const r = { amazon: { enabled: false, mode: 'gated' as const }, ebay: { enabled: false, mode: 'gated' as const }, shopify: { enabled: false, mode: 'gated' as const } }
    // 🔴 'live' would be the most dangerous possible default for an undescribed channel.
    expect(modeForChannel(r, 'WOOCOMMERCE')).toBeNull()
    expect(modeForChannel(r, 'EBAY')).toBe('gated')
    expect(modeForChannel(null, 'EBAY')).toBeNull()
    // 🔴 And an UNDESCRIBED channel gets its own sentence, distinct from the unknown-mode one:
    // "the response does not describe this gate" is a different fact from "the server named a mode
    // we do not recognise", and one message for both would repeat the collapse being fixed here.
    const note = gateNote(null, 'WooCommerce')
    expect(note).not.toBeNull()
    expect(note).toMatch(/not described by this server response/)
  })
})

describe('jumping to a row, and refusing to guess when it cannot be known', () => {
  it('composes the sheet row id HERE — the server returns components on purpose', () => {
    // An empty aliasKey with aliasResolved:true is the server saying "known PRIMARY".
    expect(jumpTargetOf(row({ productId: 'p1', aliasKey: '', aliasResolved: true }))).toBe('primary:p1')
    expect(jumpTargetOf(row({ productId: 'p1', aliasId: 'a2', aliasResolved: true }))).toBe('a2:p1')
  })

  it('🔴 returns null rather than guessing `primary` when the alias is unknown', () => {
    // 45 of 441 rows are product-only. Guessing is right today and silently wrong the moment a
    // second alias exists — and a jump to the WRONG row is worse than no jump, because the
    // operator believes it.
    expect(jumpTargetOf(row({ productId: 'p1', aliasKey: null, aliasResolved: false }))).toBeNull()
    expect(jumpTargetOf(row({ productId: null, aliasResolved: true }))).toBeNull()
  })
})

describe('how many of these actually need a person', () => {
  it('separates our own throttle from a marketplace refusal', () => {
    // Measured on the real coordinate: 36 dead, 33 throttled (self-healing), 3 rejected.
    const rows = [
      ...Array.from({ length: 33 }, () => row({ reason: 'throttled' as const, reasonActionable: false, reasonWillRetry: true, errorMessage: 'circuit open' })),
      ...Array.from({ length: 3 }, () => row({ reason: 'rejected' as const, reasonActionable: true, errorMessage: 'get offers 404' })),
    ]
    // Row-level: which of the rows IN HAND need a person. The headline's equivalent now comes from
    // the server's rollup (see the describe below), because a page cannot count the whole queue.
    expect(actionableCount(rows)).toBe(3)
  })

  it('counts none when nothing in hand needs a person', () => {
    expect(actionableCount([row({ reason: 'gated' as const, reasonActionable: false })])).toBe(0)
  })
})

describe('🔴 a cause is not a verdict — tone follows state, not label', () => {
  /**
   * The defect this guards, found by PES.5 after my weighting work exposed it: EVERY `throttled`
   * row in the database is `isDead` with retries exhausted. "Deferred — it will retry without you"
   * was false for all 377 of them; those writes never reached the channel. My pane rendered them
   * quiet and told an operator "3 need you" when the answer was 36.
   */
  const throttledAlive = row({ reason: 'throttled' as const, reasonActionable: false, reasonWillRetry: true, errorMessage: 'circuit open' })
  const throttledDead = row({ reason: 'throttled' as const, reasonActionable: true, reasonWillRetry: false, isDead: true, errorMessage: 'circuit open' })

  it('renders a self-healing throttle quiet', () => {
    expect(groupIsQuiet(groupByCause([throttledAlive])[0])).toBe(true)
  })

  it('🔴 does NOT render a throttle that died mid-defer quiet — same cause, opposite verdict', () => {
    expect(groupIsQuiet(groupByCause([throttledDead])[0])).toBe(false)
    expect(actionableCount([throttledDead])).toBe(1)
  })

  it('counts a dead throttle among the rows that need a person', () => {
    // The exact on-screen regression: 33 dead-throttled + 3 rejected must read 36, not 3.
    const rows = [
      ...Array.from({ length: 33 }, () => throttledDead),
      ...Array.from({ length: 3 }, () => row({ reason: 'rejected' as const, reasonActionable: true, reasonWillRetry: false, errorMessage: 'get offers 404' })),
    ]
    // The on-screen regression, at row level: 33 dead-throttled + 3 rejected must read 36, not 3.
    expect(actionableCount(rows)).toBe(36)
  })

  it('a group is quiet only when EVERY row in it needs nobody', () => {
    // One lost write inside a hundred deferred ones must not inherit the quiet tone.
    expect(groupIsQuiet(groupByCause([throttledAlive, throttledDead])[0])).toBe(false)
  })
})

describe('🔴 the headline comes from the SERVER rollup, never from the page', () => {
  /**
   * Measured on `normal-knee-slider-yellow`: 1,239 rows, server reports **3** causes —
   * `unknown` 1,167 · `throttled` 52 (37 actionable) · `rejected` 20 — while the 200-row page held
   * only 2, one cause having sorted entirely below the boundary. A page-derived count would have
   * told an operator "only rejections here", which is worse than incomplete.
   */
  const sc = (reason: string, count: number, actionableCount: number) =>
    ({ reason, count, actionableCount, mostRecent: '2026-09-01T00:00:00.000Z', sampleSummary: '' }) as never

  it('reports every cause the server found, not the ones that fit in the page', () => {
    const line = summarise([sc('unknown', 1167, 1167), sc('throttled', 52, 37), sc('rejected', 20, 20)], 1239, 'queued writes')
    expect(line).toContain('1,239 queued writes across 3 causes')
  })

  it('sums "needs you" from the server totals too', () => {
    // 1167 + 37 + 20 = 1224 of 1239 — a figure the page could not have produced.
    expect(summarise([sc('unknown', 1167, 1167), sc('throttled', 52, 37), sc('rejected', 20, 20)], 1239, 'queued writes'))
      .toContain('1,224 need you')
  })

  it('stays silent about "needs you" when every write needs one', () => {
    expect(summarise([sc('rejected', 20, 20)], 20, 'dead writes')).not.toContain('need you')
  })

  it('still says nothing is queued when the true total is zero', () => {
    expect(summarise([], 0, 'dead writes')).toBe('Nothing queued or failing on this coordinate.')
  })
})
