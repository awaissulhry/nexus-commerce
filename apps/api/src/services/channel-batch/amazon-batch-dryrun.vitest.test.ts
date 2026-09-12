/**
 * PES.7 — the dry-run invariant, pinned.
 *
 * 🔴 This test exists because the guard it protects looks redundant.
 *
 * With the publish gate closed — which it is on every environment today — `isDryRunEnv()` is always
 * true, so `input.dryRun === true` never changes an outcome and reads like dead code beside it. It
 * was dropped once already: `amazon-image-feed.service.ts` spread the caller's flag as
 * `...(dryRun ? {} : {})` (an empty object in both branches) into a submission type that had no
 * such field, so a request asking for a rehearsal submitted a real feed the moment the gate opened,
 * and the audit log recorded `dryRun: true` beside it.
 *
 * So the assertions below deliberately run with the gate **LIVE**. That is the only configuration
 * in which the caller's flag is load-bearing, and therefore the only one that can catch its removal.
 *
 * ⚠ `amazon-sp-api` is mocked to throw on construction. A regression must fail this test loudly
 * rather than reach Amazon from a test run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('amazon-sp-api', () => ({
  SellingPartner: class {
    constructor() {
      throw new Error('TEST GUARD: the live SP-API path was reached during a dry-run test')
    }
  },
}))

import { submitAmazonListingsBatch } from './amazon-batch-feed.service.js'

const submission = (over: Record<string, unknown> = {}) => ({
  marketplaceIds: ['APJ6JRA9NG5V4'],
  sellerId: 'A_TEST_SELLER',
  operations: [{ type: 'stock' as const, sku: 'TEST-SKU', quantity: 1 }],
  ...over,
})

const ENV = { ...process.env }
afterEach(() => { process.env = { ...ENV } })

describe('with the publish gate CLOSED (every environment today)', () => {
  beforeEach(() => { process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'false' })

  it('never submits, whatever the caller asks for', async () => {
    for (const dryRun of [true, false, undefined]) {
      const r = await submitAmazonListingsBatch(submission({ dryRun }))
      expect(r.dryRun).toBe(true)
    }
  })
})

describe('with the publish gate LIVE — where the caller flag is load-bearing', () => {
  beforeEach(() => {
    process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'true'
    process.env.AMAZON_PUBLISH_MODE = 'live'
  })

  it('🔴 honours an explicit dryRun:true and does NOT submit', async () => {
    const r = await submitAmazonListingsBatch(submission({ dryRun: true }))
    expect(r.dryRun).toBe(true)
    expect(r.feedId).toMatch(/^dryrun-/)
  })

  it('is one-way: dryRun:false does not force a submission past a closed gate', async () => {
    process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'false'
    const r = await submitAmazonListingsBatch(submission({ dryRun: false }))
    expect(r.dryRun).toBe(true)
  })

  it('confirms the gate really is live here — otherwise the test above proves nothing', async () => {
    // Without this, a future change defaulting the mode to dry-run would make the assertion above
    // pass for the wrong reason: the caller flag would be untested and look protected.
    const { getAmazonPublishMode } = await import('../amazon-publish-gate.service.js')
    expect(getAmazonPublishMode()).toBe('live')
  })

  it('reaches the live path when nothing asks for a rehearsal — proving the guard is not blanket', async () => {
    // The mocked client throws, which is the evidence: with the gate live and no caller flag, the
    // submission path IS entered. If this ever stops throwing, the dry-run branch has swallowed
    // everything and the tests above became vacuous.
    await expect(submitAmazonListingsBatch(submission({ dryRun: false }))).rejects.toThrow(
      /TEST GUARD: the live SP-API path was reached|Reconnect the Amazon account/,
    )
  })
})

describe('input validation is unaffected', () => {
  beforeEach(() => { process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'false' })

  it('still rejects an empty operation list', async () => {
    await expect(submitAmazonListingsBatch(submission({ operations: [] })))
      .rejects.toThrow(/operations must be non-empty/)
  })

  it('still requires a sellerId', async () => {
    await expect(submitAmazonListingsBatch(submission({ sellerId: '' })))
      .rejects.toThrow(/sellerId required/)
  })
})

describe('the forward from the image-feed service', () => {
  /*
   * 🔴 A type check CANNOT catch the removal of this forward.
   *
   * `dryRun` is optional on `AmazonBatchSubmission` — deliberately, so the bulk-action callers that
   * have no per-call opinion are unaffected — which means deleting `dryRun,` from the call site
   * compiles cleanly and silently restores the original defect. Verified: with the forward removed,
   * `tsc --noEmit` still exits 0.
   *
   * So this asserts on the source. It is a narrow check and it knows it: it proves the argument is
   * written, not that it is honoured (the tests above do that). Its job is to catch the one
   * regression that actually happened.
   */
  const SOURCE = new URL('../images/amazon-image-feed.service.ts', import.meta.url)

  /**
   * 🔴 Comments are stripped first.
   *
   * Both assertions below failed on their first run — because the fix's own comment *quotes* the
   * bad pattern to explain it, so the "must not contain" check matched the explanation, and the
   * `})` inside that quote truncated the extracted call. A source guard that reads comments is
   * testing the prose, not the code.
   */
  async function code(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(SOURCE, 'utf8')
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  }

  it('passes dryRun to the batch service', async () => {
    const src = await code()
    const start = src.indexOf('submitAmazonListingsBatch({')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, src.indexOf('})', start))
    expect(call).toMatch(/^\s*dryRun,\s*$/m)
  })

  it('never returns to the spread that dropped it', async () => {
    // `...(dryRun ? {} : {})` — an empty object in both branches. It typechecks, it reads as a
    // conditional forward, and it forwards nothing.
    expect(await code()).not.toMatch(/\.\.\.\(\s*\w+\s*\?\s*\{\s*\}\s*:\s*\{\s*\}\s*\)/)
  })
})
