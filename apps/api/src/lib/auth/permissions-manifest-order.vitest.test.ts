/**
 * PES.5 (hub ruling #10) — the permission manifest is ORDER-SENSITIVE, and the
 * shadowing it permits is invisible when reading the file.
 *
 * `pfx` is `startsWith` and `permissionForRoute` is first-match-wins. So a rule
 * whose prefix EXTENDS an earlier rule's prefix can never be reached:
 *
 *   RW(productsView, productsEdit, pfx('/api/products'))     <- matches first
 *   ...
 *   RW(aiView, aiRun,             pfx('/api/products-ai'))   <- unreachable
 *
 * That shipped. `/api/products-ai/bulk-generate` — a route that SPENDS MONEY on
 * model calls — resolved to `products.edit`, so anyone who could edit a product
 * could run it, and nobody holding `ai.run` alone could. Found by PES.8.
 *
 * Reordering fixes the instance; only a test fixes the class. Both cases below
 * matter: the first catches a NEW shadowed rule, the second pins the specific
 * regression so a future "tidy the manifest into alphabetical order" cannot
 * quietly reintroduce it.
 *
 * The expected permissions here are written from the ROUTE'S PURPOSE, never by
 * calling `permissionForRoute` and recording what it said — a test that asks
 * the code what it does can only ever agree with it.
 */
import { describe, it, expect } from 'vitest'
import { ENTRIES, permissionForRoute } from './permissions-manifest.js'

describe('permission manifest ordering', () => {
  it('separates Shopify inspection, local edits, and publishing including shared entries', () => {
    const root = '/api/products/:productId/shopify-linked'
    expect(permissionForRoute('GET', root)).toBe('products.view')
    expect(permissionForRoute('PUT', root)).toBe('products.edit')
    for (const suffix of ['reference-names', 'products', 'read-links', 'field-values', 'import', 'discover', 'suggest-sharing', 'preview']) expect(permissionForRoute('POST', `${root}/${suffix}`)).toBe('products.view')
    for (const suffix of ['synchronize', 'advance', 'entry', 'automation', 'automation-check']) expect(permissionForRoute('POST', `${root}/${suffix}`)).toBe('products.publish')
    expect(permissionForRoute('GET', `${root}/entry`)).toBe('products.view')
    expect(permissionForRoute('POST', `${root}/rebase`)).toBe('products.edit')
  })
  /**
   * How specific a rule is FOR THIS PATH: the length of the shortest prefix of
   * `path` the rule still matches. For a `pfx` rule that is exactly its own
   * prefix length, recovered without reading the closure.
   */
  const specificity = (when: (m: string, p: string) => boolean, path: string): number => {
    for (let i = 1; i <= path.length; i++) {
      if (when('GET', path.slice(0, i))) return i
    }
    return Number.MAX_SAFE_INTEGER
  }

  it('the winning rule is the MOST SPECIFIC match, never merely the first', () => {
    // Several rules matching one path is normal and fine — `/api/products-ai`
    // is matched by both the AI rule and the catalogue rule. What must never
    // happen is a LATER rule being more specific than the winner, because
    // first-match-wins then silently hands the route the broader permission.
    const samples = [
      '/api/products', '/api/products-ai', '/api/products/bulk',
      '/api/products-ai/bulk-generate', '/api/catalog', '/api/catalog-matrix',
      '/api/matrix', '/api/agents', '/api/ai-usage', '/ai',
      '/api/field-links', '/api/mapping', '/api/mapping-propagation',
      '/api/terminology',
    ]

    const shadowed: string[] = []
    for (const path of samples) {
      const matching = (ENTRIES as any[])
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.when('GET', path))
      if (matching.length < 2) continue

      const winner = matching[0]
      const winnerSpec = specificity(winner.e.when, path)
      for (const { e, i } of matching.slice(1)) {
        const spec = specificity(e.when, path)
        if (spec > winnerSpec) {
          shadowed.push(
            `${path}: entry #${i} is more specific (prefix len ${spec}) than the winning entry #${winner.i} (len ${winnerSpec}) — it can never be reached`,
          )
        }
      }
    }

    expect(shadowed).toEqual([])
  })

  it('the AI routes resolve to AI permissions, not catalogue ones', () => {
    // Written from purpose: generating content with a model is an AI spend
    // action. It must never be reachable with only catalogue-edit rights.
    expect(permissionForRoute('POST', '/api/products-ai/bulk-generate')).toBe('ai.run')
    expect(permissionForRoute('GET', '/api/products-ai/anything')).toBe('ai.view')
  })

  it('the catalogue routes are unaffected by that fix', () => {
    expect(permissionForRoute('GET', '/api/products/123')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/products/bulk')).toBe('products.edit')
  })

  it('allows product readers to check readiness without granting import writes', () => {
    expect(permissionForRoute('GET', '/api/catalog-transfer/products/:productId/options')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/catalog-transfer/products/:productId/export')).toBe('products.export')
    expect(permissionForRoute('POST', '/api/catalog-transfer/products/:productId/preview')).toBe('products.import')
    expect(permissionForRoute('GET', '/api/catalog-transfer/readiness')).toBe('products.view')
    expect(permissionForRoute('GET', '/api/catalog-transfer/readiness/options')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/catalog-transfer/preview')).toBe('products.import')
    expect(permissionForRoute('POST', '/api/catalog-transfer/jobs/job/apply')).toBe('products.import')
  })

  it('requires import permission for legacy import writes and view permission for history', () => {
    expect(permissionForRoute('GET', '/api/import-jobs')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/import-jobs')).toBe('products.import')
    expect(permissionForRoute('POST', '/api/import-jobs/job/apply')).toBe('products.import')
    expect(permissionForRoute('POST', '/api/import-jobs/job/retry-failed')).toBe('products.import')
    // Rollback retains the existing explicit permission; historical unversioned imports refuse it.
    expect(permissionForRoute('POST', '/api/import-jobs/job/rollback')).toBe('bulk.rollback')
  })

  it('PES.5 studio routes inherit the products prefix rule', () => {
    // The studio adds no permission wiring; it relies entirely on living under
    // /api/products. If that ever stops being true these go null (= deny + CI
    // failure), which is the signal to wire them explicitly.
    expect(permissionForRoute('GET', '/api/products/abc/studio/sheet')).toBe('products.view')
    expect(permissionForRoute('GET', '/api/products/abc/readiness')).toBe('products.view')
    expect(permissionForRoute('GET', '/api/products/abc/studio/history')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/products/abc/aliases')).toBe('products.edit')
    expect(permissionForRoute('DELETE', '/api/products/abc/aliases/xyz')).toBe('products.edit')
  })
})
