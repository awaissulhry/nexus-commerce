/**
 * P4.1c — "the description engine in every builder".
 *
 * ## The measurement, and it is a COUNTERWEIGHT
 *
 * The plan row reads as a gap. It is not one: every eBay builder that sends a
 * description a buyer can see already runs it through
 * `renderListingDescriptionSafe`. Seven call sites, both channel models:
 *
 *   Trading   ebay-shared-listing-push.service.ts:401
 *   Trading   pim/studio-publication-ebay.ts:199
 *   Trading   ebay-description-push.service.ts:355
 *   Trading   ebay-presentation-publication.service.ts:30
 *   Trading   routes/ebay-flat-file.routes.ts:2313, 2681
 *   Inventory images/ebay-inventory-image-publish.service.ts:317
 *
 * Say so and mark the row — that is P2.6's lesson, and the third time this
 * programme has hit it.
 *
 * ## But the rule lived in the CALLERS, which is the drift shape
 *
 * `pushVariationGroup` is the Inventory-API group publisher (2,900 lines). It
 * takes the parent's content as an argument and, when it was omitted, fell back
 * to `parentRow.description` — the RAW body, with no theme around it. Both of its
 * callers render first, so the fallback was dead. **Dead only until somebody
 * writes a third caller**, who would publish an unthemed listing to eBay with no
 * error, nothing unusual in the ledger, and a listing that simply looks wrong.
 *
 * That is exactly "two column builders drift: put the rule in the ENGINE".
 * `parentContent` is required now — at compile time inside `opts`, and refused at
 * run time when `opts` is omitted altogether (TypeScript cannot make `opts`
 * itself required, because the parameters before it are optional).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'test-support') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (entry.endsWith('.ts') && !/\.(test|vitest\.test)\.ts$/.test(entry) && !entry.includes('.vitest.')) found.push(full)
  }
  return found
}

/* ── the counterweight, measured ──────────────────────────────────────────── */

describe('the description engine IS in every builder (a result, not a gap)', () => {
  const renderers = sourceFiles(SRC).filter((f) => /renderListingDescriptionSafe\s*\(/.test(readFileSync(f, 'utf8')))

  it('is called from both channel models, not only Trading', () => {
    const rel = renderers.map((f) => f.replace(SRC + '/', ''))
    expect(rel.length).toBeGreaterThan(4) // positive control
    // Trading
    expect(rel).toContain('services/pim/studio-publication-ebay.ts')
    expect(rel).toContain('services/ebay-shared-listing-push.service.ts')
    // Inventory — the one a Trading-only reading of the row would have missed
    expect(rel).toContain('services/images/ebay-inventory-image-publish.service.ts')
  })

  it('has exactly one engine, so there is one place to change a theme', () => {
    const definers = sourceFiles(SRC).filter((f) =>
      /export async function renderListingDescriptionSafe|export function renderListingDescriptionSafe/.test(readFileSync(f, 'utf8')))
    expect(definers.map((f) => f.replace(SRC + '/', ''))).toEqual(['services/ebay-description-theme.service.ts'])
  })
})

/* ── the rule, moved into the engine ──────────────────────────────────────── */

describe('pushVariationGroup cannot publish an unthemed description', () => {
  const push = readFileSync(join(SRC, 'services', 'ebay-variation-push.service.ts'), 'utf8')

  it('requires parentContent at COMPILE time', () => {
    // Inside `opts` it is no longer optional: `opts: {}` will not compile.
    expect(push).toMatch(/parentContent: \{ title: string; subtitle: string; description: string \}/)
    expect(push).not.toMatch(/parentContent\?: \{ title: string; subtitle: string; description: string \}/)
  })

  it('refuses at RUN time when opts is omitted altogether', () => {
    // TypeScript cannot make `opts` itself required — the parameters before it
    // are optional, and a required parameter cannot follow an optional one.
    expect(push).toContain('if (!opts?.parentContent) {')
    expect(push).toContain('EBAY_WRITE_REFUSED: this push has no theme-rendered parent content')
  })

  it('refuses AFTER the publish mode, the push lock and the review gate', () => {
    // 🔴 This refusal sat first at the first attempt and MASKED all four: a
    // paused listing reported a missing theme instead of the pause, and the
    // existing tests caught it. The most important reason has to win.
    const iOf = (needle: string) => push.indexOf(needle)
    expect(iOf('const modeRefusal = ebayWriteRefusal(')).toBeGreaterThan(0)
    expect(iOf('if (!opts?.parentContent) {')).toBeGreaterThan(iOf('const modeRefusal = ebayWriteRefusal('))
    expect(iOf('if (!opts?.parentContent) {')).toBeGreaterThan(iOf('const refusal = assertPushAllowed(row)'))
    expect(iOf('if (!opts?.parentContent) {')).toBeGreaterThan(iOf('await assertListingContentReviewed('))
  })

  it('still has the runtime fallback, as belt and braces rather than the contract', () => {
    expect(push).toContain("description: opts?.parentContent?.description ?? parentRow.description ?? ''")
  })
})

/* ── every caller renders, derived from source ────────────────────────────── */

describe('every caller of pushVariationGroup renders first', () => {
  function callers(): string[] {
    return sourceFiles(SRC)
      .filter((f) => !f.endsWith('ebay-variation-push.service.ts'))
      .filter((f) => /pushVariationGroup\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC + '/', ''))
  }

  it('finds the callers at all', () => {
    // Positive control: an empty set makes the claim below vacuous.
    expect(callers().length).toBeGreaterThan(0)
  })

  it('each one calls the description engine in the same file', () => {
    const unrendered = callers().filter((rel) => !/renderListingDescriptionSafe\s*\(/.test(readFileSync(join(SRC, rel), 'utf8')))
    expect(unrendered).toEqual([])
  })
})

/* ── behaviour, not just shape ────────────────────────────────────────────── */

describe('the refusal actually refuses', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true')
    vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('THE PUSH SENT SOMETHING') }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  it('returns an error per row and sends nothing when parentContent is missing', async () => {
    // The arm this takes was WITNESSED before the assertions were written: it
    // returns the refusal (not a throw from a lock or a gate), one row each,
    // with `fetch` stubbed to throw if anything were sent. An escape hatch for
    // "a lock threw first" was in the first draft and is deliberately gone — a
    // branch that never runs turns a test into a pass that proves nothing.
    vi.doMock('../db.js', () => ({ default: { channelListing: { findMany: async () => [] }, product: { findFirst: async () => null } } }))
    const { pushVariationGroup } = await import('./ebay-variation-push.service.js')
    const rows = [{ sku: 'A-1', _isParent: true }, { sku: 'A-2' }]
    const out = await pushVariationGroup('g', rows as any, 'DE', 't', 'conn', {}, 'https://api.ebay.test', 'EBAY_DE')
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.sku)).toEqual(['A-1', 'A-2'])
    for (const row of out) {
      expect(row.status).toBe('ERROR')
      expect(row.message).toContain('no theme-rendered parent content')
      expect(row.message).toContain('nothing was sent')
    }
    // The positive control on the negative: the stubbed fetch would have thrown
    // a recognisable message if a single request had gone out.
    expect(JSON.stringify(out)).not.toContain('THE PUSH SENT SOMETHING')
  })
})
