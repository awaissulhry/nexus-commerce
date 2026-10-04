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
  it.each([
    ['POST', '/api/amazon/flat-file/remove', 'products.delete'],
    // 🔴 PLAN Step 1.4 / A-10. The eBay twin of the line above, which was missing from this list
    // AND from the manifest: it fell through to `pfx('/api/ebay/flat-file')` and resolved to
    // `listings.flatfile.edit`, so an EDIT-class permission permanently ended live eBay listings.
    // Written from the ROUTE'S PURPOSE, as this file's header requires — a permanent channel
    // removal is a delete — never by asking permissionForRoute what it currently says.
    ['POST', '/api/ebay/flat-file/delete', 'products.delete'],
    // The neighbours, so a future carve-out cannot widen past the one route it meant to name.
    ['POST', '/api/ebay/flat-file/save', 'listings.flatfile.edit'],
    ['POST', '/api/amazon/flat-file/save', 'listings.flatfile.edit'],
    ['POST', '/api/products/bulk-hard-delete', 'products.delete'],
    ['POST', '/api/products/operational-impact', 'products.view'],
    ['GET', '/api/products/operational-impact', 'products.view'],
    ['POST', '/api/products/delist-cascade/cancel', 'products.delete'],
    ['PUT', '/api/products/:id/matrix/channel-listing/:listingId', 'products.edit'],
    ['POST', '/api/products/:id/recover', 'products.delete'],
    ['POST', '/api/products/:id/recover/preview', 'products.view'],
    ['GET', '/api/products/:id/recover/events', 'products.view'],
    // Sheet pop-up A3 — "New attribute" changes the business's attribute dictionary (what /api/attributes needs); the
    // pop-up's read of "Values from" and the theme save beside it stay product edits.
    ['POST', '/api/products/:id/studio/own-axis-attribute', 'pim.manage'],
    ['GET', '/api/products/:id/studio/own-axis-sources', 'products.view'],
    ['PATCH', '/api/products/:id/studio/projection', 'products.edit'],
    ['POST', '/etsy/sync/listings', 'products.edit'],
    ['POST', '/etsy/sync/inventory/from-etsy', 'inventory.adjust'],
    ['POST', '/etsy/sync/orders', 'orders.edit'],
    ['POST', '/etsy/sync/inventory/to-etsy', 'products.publish'],
    ['POST', '/etsy/orders/:orderId/status', 'products.publish'],
    ['POST', '/etsy/orders/:orderId/fulfillment', 'products.publish'],
  ])('PR.1: %s %s requires %s before a broader prefix can match', (method, path, permission) => {
    expect(permissionForRoute(method, path)).toBe(permission)
    expect(permissionForRoute('POST', '/api/products/bulk')).toBe('products.edit')
  })

  // MCP full control R18 (part 06 gap 13) — `has('/automation')` was a broad ads matcher listed before the
  // replenishment, review and returns prefixes, so their automation routes asked for ads.automation.manage: a
  // replenishment planner could not see their own rules, and an ads manager could edit them. Written from purpose.
  it.each([
    ['GET', '/api/fulfillment/replenishment/automation/rules', 'replenishment.view'],
    ['POST', '/api/fulfillment/replenishment/automation/rules', 'replenishment.run'],
    ['PATCH', '/api/fulfillment/replenishment/automation/rules/:id', 'replenishment.run'],
    ['POST', '/api/fulfillment/replenishment/automation/rules/:id/test', 'replenishment.run'],
    ['POST', '/api/fulfillment/replenishment/automation/emergency-disable-all', 'replenishment.run'],
    ['GET', '/api/reviews/automation-rules', 'reviews.view'],
    ['POST', '/api/reviews/automation-rules/seed-templates', 'reviews.manage'],
    ['POST', '/api/fulfillment/returns/automation/apply', 'returns.process'],
    // The ads automation routes keep theirs (control).
    ['POST', '/api/advertising/automation/halt', 'ads.automation.manage'],
    // R16 — a person's engine switch in the Control Room.
    ['POST', '/api/advertising/automation/engine-switch/:key', 'ads.automation.manage'],
    ['POST', '/api/advertising/automation/engine-switch/rank-defend', 'ads.automation.manage'],
    ['POST', '/api/advertising/automation-rules', 'ads.automation.manage'],
    ['GET', '/api/advertising/automation-rules', 'ads.view'],
    ['PUT', '/api/ebay-ads/campaigns/:id/automation-policy', 'ads.automation.manage'],
  ])('R18: %s %s requires %s', (method, path, permission) => {
    expect(permissionForRoute(method, path)).toBe(permission)
  })

  // Owner 2026-10-04 (2a) — the live campaigns rank left bids changed on: the list is a read; giving one back changes
  // bids and asks for what changing a rank schedule asks for.
  it.each([
    ['GET', '/api/advertising/rank-release/enabled-orphans', 'ads.view'],
    ['POST', '/api/advertising/rank-release/enabled-orphans/:campaignId/release', 'ads.campaigns.manage'],
    ['PATCH', '/api/advertising/rank-schedule-groups/:id', 'ads.campaigns.manage'],
  ])('2a: %s %s requires %s', (method, path, permission) => {
    expect(permissionForRoute(method, path)).toBe(permission)
  })

  it('separates catalogue language reads and estimates from translation edits and model spend', () => {
    for (const path of ['languages', 'translate/runs']) expect(permissionForRoute('GET', `/api/catalog-transfer/${path}`)).toBe('products.view')
    expect(permissionForRoute('POST', '/api/products/grid')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/catalog-transfer/translate/preview')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/catalog-transfer/translate/run-id/revert')).toBe('products.translations.edit')
    expect(permissionForRoute('POST', '/api/catalog-transfer/translate/apply')).toBe('ai.run')
    expect(permissionForRoute('POST', '/api/catalog-transfer/preview')).toBe('products.import')
  })
  it('separates Shopify inspection, local edits, and publishing including shared entries', () => {
    const root = '/api/products/:productId/shopify-linked'
    expect(permissionForRoute('GET', root)).toBe('products.view')
    expect(permissionForRoute('PUT', root)).toBe('products.edit')
    for (const suffix of ['reference-names', 'products', 'read-links', 'field-values', 'import', 'discover', 'suggest-sharing', 'preview']) expect(permissionForRoute('POST', `${root}/${suffix}`)).toBe('products.view')
    for (const suffix of ['synchronize', 'advance', 'entry', 'enable-field', 'automation', 'automation-check']) expect(permissionForRoute('POST', `${root}/${suffix}`)).toBe('products.publish')
    expect(permissionForRoute('GET', `${root}/entry`)).toBe('products.view')
    expect(permissionForRoute('POST', `${root}/rebase`)).toBe('products.edit')
    const colour = '/api/products/p1/shopify-colour-products'
    expect([permissionForRoute('GET', colour), permissionForRoute('GET', `${colour}/settings`)]).toEqual(['products.view', 'products.view'])
    expect(permissionForRoute('POST', `${colour}/find`)).toBe('products.edit')
    expect(permissionForRoute('PUT', `${colour}/settings`)).toBe('products.publish')
    expect(permissionForRoute('POST', `${colour}/confirm`)).toBe('products.publish')
    expect(permissionForRoute('POST', `${colour}/link`)).toBe('products.publish')
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
      // MX.1 — the Matrix routes sit under /api/products and must be the MOST specific match, never the fall-through.
      '/api/products/:id/studio/matrix', '/api/products/:id/studio/matrix/verbs', '/api/products/:id/studio/matrix/verbs/:operationId/revert',
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

  it("a tool's policy needs the security setting, not only ai.run", () => {
    // Turning a tool on, dropping its approval or raising its hourly limit changes what the
    // assistant may do for everyone in the business.
    expect(permissionForRoute('PUT', '/api/agent/tools/:name')).toBe('settings.security.manage')
    expect(permissionForRoute('GET', '/api/agent/tools')).toBe('ai.view')
    expect(permissionForRoute('POST', '/api/agent/tools/:name/invoke')).toBe('ai.run')
    expect(permissionForRoute('POST', '/api/agent/tools/seed')).toBe('ai.run')
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

  it('MX.1 — the Matrix routes read with products.view and write with products.edit, and price-edit is a cell-level gate', () => {
    // Written from purpose: reading the Matrix is reading the catalogue; every write goes through the one door
    // and is a catalogue edit. `products.price.edit` is the FINANCIAL permission on the price cells, enforced by
    // the service per cell, so the route level must resolve to the catalogue pair and never to price-edit.
    expect(permissionForRoute('GET', '/api/products/:id/studio/matrix')).toBe('products.view')
    expect(permissionForRoute('PATCH', '/api/products/:id/studio/matrix')).toBe('products.edit')
    expect(permissionForRoute('POST', '/api/products/:id/studio/matrix/verbs')).toBe('products.edit')
    expect(permissionForRoute('POST', '/api/products/:id/studio/matrix/verbs/:operationId/revert')).toBe('products.edit')
    // Positive control for the order claim: the neighbouring studio route still falls through to the prefix rule.
    expect(permissionForRoute('GET', '/api/products/:id/studio/matrixes')).toBe('products.view')
    expect(permissionForRoute('POST', '/api/products/:id/studio/sheet')).toBe('products.edit')
  })

  it('a refund from a return needs orders.refund, not only returns.process (MCP full control #15)', () => {
    // Written from purpose: issuing or retrying a refund sends money back to the buyer through the channel, the same
    // act `orders.refund` guards on /api/orders. The returns rule matched these first, so anyone who could process a
    // return could also refund it.
    expect(permissionForRoute('POST', '/api/fulfillment/returns/:id/refund')).toBe('orders.refund')
    expect(permissionForRoute('POST', '/api/fulfillment/returns/:id/refund/retry')).toBe('orders.refund')
    // The neighbours: refund READS stay with returns.view, the other return writes with returns.process.
    expect(permissionForRoute('GET', '/api/fulfillment/returns/:id/refunds')).toBe('returns.view')
    expect(permissionForRoute('GET', '/api/fulfillment/returns/:id/refund/retry-status')).toBe('returns.view')
    expect(permissionForRoute('GET', '/api/fulfillment/returns/refund-deadline-summary')).toBe('returns.view')
    expect(permissionForRoute('GET', '/api/fulfillment/returns/refund-channel-status')).toBe('returns.view')
    expect(permissionForRoute('POST', '/api/fulfillment/returns/:id/receive')).toBe('returns.process')
    expect(permissionForRoute('POST', '/api/fulfillment/returns/:id/restock')).toBe('returns.process')
    expect(permissionForRoute('POST', '/api/fulfillment/returns/bulk/approve')).toBe('returns.process')
  })

  it('receiving a PO needs po.receive and the legacy straight-to-SUBMITTED route needs po.approve (MCP full control #21, F1)', () => {
    // Written from purpose: receiving books goods into stock (po.receive); `…/:id/submit` moves any PO to SUBMITTED
    // past the approval step, so it is an approval (po.approve). The PO rule matched every PO path first, so both
    // permissions were dead and po.create did everything. Approving through `…/:id/transition` is checked in the
    // route itself, because the transition is in the body (po-transition-permission.vitest.test.ts).
    expect(permissionForRoute('POST', '/api/fulfillment/purchase-orders/:id/receive')).toBe('po.receive')
    expect(permissionForRoute('POST', '/api/fulfillment/purchase-orders/:id/quick-receive')).toBe('po.receive')
    expect(permissionForRoute('POST', '/api/fulfillment/purchase-orders/:id/submit')).toBe('po.approve')
    // The neighbours stay with the PO pair.
    expect(permissionForRoute('POST', '/api/fulfillment/purchase-orders/:id/transition')).toBe('po.create')
    expect(permissionForRoute('POST', '/api/fulfillment/purchase-orders')).toBe('po.create')
    expect(permissionForRoute('PATCH', '/api/fulfillment/purchase-orders/:id')).toBe('po.create')
    expect(permissionForRoute('GET', '/api/fulfillment/purchase-orders/:id')).toBe('po.view')
    expect(permissionForRoute('GET', '/api/fulfillment/purchase-orders/:id/match')).toBe('po.view')
  })

  it('S1 (08 §1.4 F4, F11) — stock, supply and pricing routes resolve on their REAL paths, from their purpose', () => {
    // F4 — the cost grid's write is a cost edit (the rule named /api/product-costs, which no route has).
    expect(permissionForRoute('PATCH', '/api/products/costs')).toBe('pricing.costs.edit')
    expect(permissionForRoute('GET', '/api/products/costs')).toBe('products.view')
    // F11 — a product's B2B tier prices are restricted money, read and write (they were products.view / products.edit).
    expect(permissionForRoute('GET', '/api/products/:id/tier-prices')).toBe('pricing.tiers.manage')
    expect(permissionForRoute('POST', '/api/products/:id/tier-prices')).toBe('pricing.tiers.manage')
    // F11 — an eBay volume promotion is a price: changing one is a pricing edit (it was the channel-sync default).
    expect(permissionForRoute('POST', '/api/ebay/volume-promotions/:id/push')).toBe('pricing.edit')
    expect(permissionForRoute('PATCH', '/api/ebay/volume-tier-templates/:id')).toBe('pricing.edit')
    expect(permissionForRoute('GET', '/api/ebay/volume-promotions')).toBe('listings.view')
    // F11 — the replenishment automation is purchasing, not advertising (has('/automation') handed it ads.automation.manage).
    expect(permissionForRoute('POST', '/api/fulfillment/replenishment/automation/rules')).toBe('replenishment.run')
    expect(permissionForRoute('GET', '/api/fulfillment/replenishment/automation/rules')).toBe('replenishment.view')
    // F11 — FBA inbound v1 is inbound work (it was inventory.adjust / inventory.view).
    expect(permissionForRoute('POST', '/api/fulfillment/fba/plan-shipment')).toBe('inbound.manage')
    expect(permissionForRoute('GET', '/api/fulfillment/fba/shipments')).toBe('inbound.manage')
    // F11 — PO templates make purchase orders (they fell to inventory.adjust).
    expect(permissionForRoute('POST', '/api/fulfillment/po-templates/:id/instantiate')).toBe('po.create')
    expect(permissionForRoute('GET', '/api/fulfillment/po-templates')).toBe('po.view')
    // Transfers, counts and lots carry their own permissions; their reads stay stock reads.
    expect(permissionForRoute('POST', '/api/stock/transfer')).toBe('stock.transfer')
    expect(permissionForRoute('POST', '/api/stock/bulk-transfer')).toBe('stock.transfer')
    expect(permissionForRoute('POST', '/api/stock/bins/move')).toBe('stock.transfer')
    expect(permissionForRoute('GET', '/api/stock/transfers')).toBe('inventory.view')
    expect(permissionForRoute('POST', '/api/fulfillment/cycle-counts/:id/items/:itemId/reconcile')).toBe('stock.count')
    expect(permissionForRoute('GET', '/api/fulfillment/cycle-counts')).toBe('inventory.view')
    expect(permissionForRoute('POST', '/api/stock/recalls/:id/close')).toBe('lots.manage')
    expect(permissionForRoute('GET', '/api/stock/lots')).toBe('inventory.view')
    // The neighbours do not move: a stock adjustment, the ad automation, the other replenishment routes.
    expect(permissionForRoute('POST', '/api/stock/adjust-location')).toBe('inventory.adjust')
    expect(permissionForRoute('POST', '/api/stock/bins')).toBe('inventory.adjust')
    expect(permissionForRoute('POST', '/api/advertising/automation-rules')).toBe('ads.automation.manage')
    expect(permissionForRoute('POST', '/api/ebay-ads/automation/rules')).toBe('ads.automation.manage')
    expect(permissionForRoute('POST', '/api/fulfillment/replenishment/bulk-draft-po')).toBe('replenishment.run')
    expect(permissionForRoute('POST', '/api/fulfillment/inbound/:id/receive')).toBe('inbound.manage')
    expect(permissionForRoute('PATCH', '/api/products/:id')).toBe('products.edit')
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
