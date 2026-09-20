/**
 * P4.1d — eBay business policies: one reconciliation, both builders.
 *
 * ## What was measured (2026-09-20)
 *
 * The plan row is "business policies per account". Per ACCOUNT was already
 * right: the ids come from `ChannelConnection.connectionMetadata.ebayPolicies`
 * for the resolved connection, and P0.7's wrong-account guard refuses a write
 * that would reach a different account than the listing's.
 *
 * Per MARKET was where the defect was, and it was a DRIFT rather than a gap.
 * Both publishers ran the same three-tier waterfall and the same "replace any id
 * not in this market's list" rule. They disagreed on the one case that matters:
 *
 *   group publisher   → REFUSES when the account snapshot cannot be fetched
 *                       (FFP.12, learned from an incident)
 *   single-SKU publisher → WARNED and wrote the unverified ids anyway
 *                       (R12, which stopped one step short)
 *
 * The single-SKU path therefore kept exactly the behaviour FFP.12 exists to
 * prevent. And the group publisher held the block TWICE — `pushVariationGroup`
 * and `pushOffersOnly` — so it was three copies of one rule in two files.
 *
 * The banked lesson says: put the rule in one accessor and assert parity in a
 * gate. Both are below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')

const snapshot = {
  fulfillmentPolicies: [{ id: 'F-IT-1' }, { id: 'F-IT-2' }],
  paymentPolicies: [{ id: 'P-IT-1' }],
  returnPolicies: [{ id: 'R-IT-1' }],
  locations: [{ key: 'LOC-IT' }],
}
const getSnapshot = vi.fn(async () => snapshot as any)
vi.mock('./ebay-account.service.js', () => ({
  ebayAccountService: { getSnapshot: (...a: any[]) => getSnapshot(...(a as [])) },
  resolvePolicyDisplayNames: async () => ({}),
}))

const { reconcileEbayPolicies } = await import('./ebay-policy-reconcile.service.js')

const IT = { connectionId: 'conn-A', marketplaceId: 'EBAY_IT', market: 'IT' }

beforeEach(() => {
  getSnapshot.mockReset()
  getSnapshot.mockResolvedValue(snapshot as any)
})
afterEach(() => vi.restoreAllMocks())

/* ── 1. the waterfall ─────────────────────────────────────────────────────── */

describe('1. the waterfall: row, then account, then this market', () => {
  it('lets the row column win over the account default', async () => {
    const out = await reconcileEbayPolicies({
      ...IT,
      rowOverrides: { fulfillment_policy_id: 'F-IT-2' },
      accountDefaults: { fulfillmentPolicyId: 'F-IT-1' },
    })
    expect(out.message).toBeNull()
    expect(out.policies!.fulfillmentPolicyId).toBe('F-IT-2')
  })

  it('falls to the account default when the row says nothing', async () => {
    const out = await reconcileEbayPolicies({ ...IT, accountDefaults: { fulfillmentPolicyId: 'F-IT-2' } })
    expect(out.policies!.fulfillmentPolicyId).toBe('F-IT-2')
  })

  it('falls to this market’s first policy when neither says anything', async () => {
    const out = await reconcileEbayPolicies(IT)
    expect(out.policies).toEqual({
      fulfillmentPolicyId: 'F-IT-1', paymentPolicyId: 'P-IT-1',
      returnPolicyId: 'R-IT-1', merchantLocationKey: 'LOC-IT',
    })
  })

  it('treats a blank string as nothing, not as a value', async () => {
    const out = await reconcileEbayPolicies({ ...IT, rowOverrides: { fulfillment_policy_id: '   ' } })
    expect(out.policies!.fulfillmentPolicyId).toBe('F-IT-1')
  })
})

/* ── 2. REPLACE, don't top up ─────────────────────────────────────────────── */

describe('2. an id from ANOTHER market is replaced, not kept', () => {
  it('replaces a DE id on an IT offer', async () => {
    // The classic eBay 25007. It is not "unconfirmed" — it is wrong, and it
    // would be kept by a rule that only fills in MISSING ids.
    const out = await reconcileEbayPolicies({ ...IT, rowOverrides: { fulfillment_policy_id: 'F-DE-9' } })
    expect(out.policies!.fulfillmentPolicyId).toBe('F-IT-1')
    expect(out.policies!.fulfillmentPolicyId).not.toBe('F-DE-9')
  })

  it('replaces a wrong id on every one of the three policy kinds', async () => {
    const out = await reconcileEbayPolicies({
      ...IT,
      accountDefaults: { fulfillmentPolicyId: 'X', paymentPolicyId: 'X', returnPolicyId: 'X' },
    })
    expect(out.policies).toMatchObject({ fulfillmentPolicyId: 'F-IT-1', paymentPolicyId: 'P-IT-1', returnPolicyId: 'R-IT-1' })
  })

  it('KEEPS an id that really is in this market’s list', async () => {
    // The positive control on the replacement: it must not overwrite a good id.
    const out = await reconcileEbayPolicies({ ...IT, rowOverrides: { fulfillment_policy_id: 'F-IT-2' } })
    expect(out.policies!.fulfillmentPolicyId).toBe('F-IT-2')
  })

  it('asks the snapshot for THIS market', async () => {
    await reconcileEbayPolicies(IT)
    expect(getSnapshot).toHaveBeenCalledWith('conn-A', 'EBAY_IT')
  })
})

/* ── 3. an unverifiable snapshot is a REFUSAL ─────────────────────────────── */

describe('3. an unverifiable snapshot refuses, it does not warn', () => {
  it('returns no policies and an operator sentence', async () => {
    getSnapshot.mockRejectedValue(new Error('eBay account API 503'))
    const out = await reconcileEbayPolicies({ ...IT, accountDefaults: { fulfillmentPolicyId: 'F-DE-9' } })
    expect(out.policies).toBeNull()
    expect(out.message).toContain('Couldn’t verify IT business policies'.replace('’', "'"))
    expect(out.message).toContain('25007')
    expect(out.message).toContain('Retry in a minute')
  })

  it('does NOT hand back the unverified ids it had collected', async () => {
    // This is the whole point. The old single-SKU behaviour returned them with a
    // warning, and a DE id then went onto an IT offer.
    getSnapshot.mockRejectedValue(new Error('down'))
    const out = await reconcileEbayPolicies({ ...IT, rowOverrides: { fulfillment_policy_id: 'F-DE-9' } })
    expect(JSON.stringify(out)).not.toContain('F-DE-9')
  })
})

/* ── 4. parity: one accessor, and nobody keeps a copy ─────────────────────── */

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'test-support') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (entry.endsWith('.ts') && !/\.(test|vitest\.test)\.ts$/.test(entry) && !entry.includes('.vitest.')) found.push(full)
  }
  return found
}

describe('4. parity — the rule has exactly one home', () => {
  it('no file reconciles policies against a snapshot on its own', () => {
    // The shape of the copied rule: building a Set of this market's policy ids.
    // Three copies existed across two files before this package.
    const copies = sourceFiles(SRC)
      .filter((f) => !f.endsWith('ebay-policy-reconcile.service.ts'))
      .filter((f) => /fulfillmentPolicies\.map\(\(p\) => p\.id\)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC + '/', ''))
    expect(copies).toEqual([])
  })

  it('both publishers call the accessor', () => {
    const group = readFileSync(join(SRC, 'services', 'ebay-variation-push.service.ts'), 'utf8')
    const single = readFileSync(join(SRC, 'routes', 'ebay-flat-file.routes.ts'), 'utf8')
    expect(group).toContain('reconcileEbayPolicies({')
    expect(single).toContain('reconcileEbayPolicies({')
    // The group file held the block twice — pushVariationGroup and pushOffersOnly.
    expect((group.match(/reconcileEbayPolicies\(\{/g) ?? []).length).toBe(2)
  })

  it('the single-SKU path REFUSES now instead of warning', () => {
    const single = readFileSync(join(SRC, 'routes', 'ebay-flat-file.routes.ts'), 'utf8')
    // The old sentence, gone. It was the marker of "continue anyway".
    expect(single).not.toContain('policy validation skipped for')
    expect(single).not.toContain('a wrong-market policy ID may fail at publish')
    // And it now ends that SKU rather than proceeding.
    expect(single).toMatch(/if \(sPolicies\.message \|\| !sPolicies\.policies\) \{/)
  })

  it('every caller stops when the reconciliation refuses', () => {
    // A caller that read `.policies` without checking would publish `null`s.
    const files = ['services/ebay-variation-push.service.ts', 'routes/ebay-flat-file.routes.ts']
    for (const rel of files) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      const calls = (text.match(/reconcileEbayPolicies\(\{/g) ?? []).length
      // The backreference matters: it must be the SAME variable on both sides,
      // so `a.message || !b.policies` does not count as a check.
      const checks = (text.match(/if \((\w+)\.message \|\| !\1\.policies\)/g) ?? []).length
      expect(checks, `${rel}: ${calls} call(s), ${checks} refusal check(s)`).toBe(calls)
    }
  })
})
