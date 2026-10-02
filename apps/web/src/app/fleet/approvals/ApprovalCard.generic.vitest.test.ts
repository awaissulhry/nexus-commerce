import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalCard, type CardApproval } from './ApprovalCard'
import { plainValue, previewSummary, previewTotals, previewWarnings } from './approval-words'

/**
 * MCP full control C9 — the GENERIC card: every change tool without a card of its own (dozens arrive from every part
 * of the plan) must still be approvable from it. It names the tool by its own title and the business, says in one
 * plain line what the change does (the preview's `summary`, the tool-contract convention in tool-types.ts), shows a
 * from → to table for a `changes` map, the counts (`totals`), the warnings, whether it can be put back and whether it
 * reaches a marketplace or a buyer — and never raw JSON. Rendered HTML (node SSR).
 */
const base: CardApproval = {
  id: 'approval-generic',
  toolName: 'set-listing-stock',
  charterKey: null,
  riskTier: 'high',
  status: 'pending',
  args: { listingId: 'listing-1', quantity: 6 },
  preview: {
    action: 'set-listing-stock',
    summary: 'Stock 4 → 6 on eBay IT for TEST-SKU-1.',
    changes: { quantity: { from: 4, to: 6 }, settings: { from: { handling: 1 }, to: { handling: 2, markets: ['IT', 'DE'] } } },
    totals: { listings: 2, markets: 1 },
    warnings: ['One listing is paused: it takes the new stock but is not sent.'],
  },
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  reason: null,
  trackRecord: null,
  reversibility: 'full',
  title: 'Set listing stock',
  openWorld: true,
  business: 'Xavia Racing',
}
const noop = () => {}
const html = (approval: Partial<CardApproval> = {}, canExecute = true) =>
  renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...base, ...approval },
    labels: { campaigns: {}, targets: {} },
    workerName: 'Claude',
    busy: false,
    canExecute,
    onDecide: noop,
    onRecheck: async () => ({ stale: false, why: null }),
    onAmend: async () => ({ ok: true }),
    onSnooze: noop,
  }))

describe('C9 — the generic card can be approved from', () => {
  it('names the tool by its own title and the business it changes', () => {
    const markup = html()
    expect(markup).toContain('Set listing stock')
    expect(markup).toContain('Xavia Racing')
    expect(markup).not.toContain('set listing stock') // never the humanised id when the tool has a title
  })

  it('one plain line of what it does, the from → to table, the counts and the warnings', () => {
    const markup = html()
    expect(markup).toContain('Stock 4 → 6 on eBay IT for TEST-SKU-1.')
    expect(markup).toMatch(/quantity<\/span><span class="aq-dfrom">4<\/span>/)
    expect(markup).toContain('handling: 2, markets: IT, DE')
    expect(markup).toMatch(/<dt>listings<\/dt><dd>2/)
    expect(markup).toContain('One listing is paused: it takes the new stock but is not sent.')
  })

  it('whether it can be put back, and that it reaches a marketplace or a buyer', () => {
    const markup = html()
    expect(markup).toContain('We can put this back the way it was')
    expect(markup).toContain('It reaches a marketplace or a buyer.')
    expect(html({ openWorld: false })).toContain('It changes Nexus only.')
    expect(markup).not.toContain('Not recorded for this action')
  })

  it('never raw JSON, whatever the preview holds', () => {
    const markup = html({ preview: { action: 'x', changes: { deep: { from: { a: { b: { c: 1 } } }, to: [{ x: 1 }, { y: 2 }] } }, totals: { odd: { nested: true } } } })
    expect(markup).not.toMatch(/\{&quot;|\{"|&quot;:/)
  })

  it('without a summary, the effect line; without either, the card says it did not describe itself', () => {
    expect(html({ preview: { action: 'x', effect: 'Closes the listing on eBay IT.' } })).toContain('Closes the listing on eBay IT.')
    expect(html({ preview: { action: 'x' } })).toContain('did not describe itself')
  })
})

describe('C9 — a Nexus-only tool with no card of its own (set-product-tags, from the 2026-10-02 end-to-end run)', () => {
  const tags: Partial<CardApproval> = {
    toolName: 'set-product-tags',
    args: { sku: 'TEST-SKU-1', add: ['new'] },
    preview: {
      action: 'set-product-tags', productId: 'product-1', sku: 'TEST-SKU-1', product: 'Test jacket',
      changes: { tags: { from: ['summer', 'sale'], to: ['summer', 'sale', 'new'] } }, added: ['new'], removed: [],
    },
    title: 'Set product tags',
    openWorld: false,
  }

  it('names the product it changes, by name and SKU', () => {
    const markup = html(tags)
    expect(markup).toMatch(/on <strong>Test jacket \(SKU TEST-SKU-1\)<\/strong>/)
    expect(markup).toContain('summer, sale, new')
  })

  it('says it changes Nexus only, and never that it reaches a marketplace', () => {
    const markup = html(tags)
    expect(markup).toContain('It changes Nexus only.')
    expect(markup).not.toMatch(/reaches a marketplace|sales channel/)
  })
})

describe('C9 — the preview convention, read', () => {
  it('a value in words: a list, a flat object, a deep one counted', () => {
    expect(plainValue(['IT', 'DE'])).toBe('IT, DE')
    expect(plainValue(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
    expect(plainValue({ handling: 2, markets: ['IT'] })).toBe('handling: 2, markets: IT')
    expect(plainValue({ a: { b: 1 } })).toBe('a: 1 field')
    expect(plainValue(null)).toBe('—')
    expect(plainValue(true)).toBe('yes')
  })

  it('summary, totals and warnings, only when the preview says them', () => {
    expect(previewSummary({ summary: '  One line.  ' })).toBe('One line.')
    expect(previewSummary({ effect: 'The effect.' })).toBe('The effect.')
    expect(previewSummary({})).toBeNull()
    expect(previewTotals({ totals: { products: 3, odd: 'x', listingsSent: 2 } })).toEqual([
      { label: 'products', value: '3' },
      { label: 'listings sent', value: '2' },
    ])
    expect(previewWarnings({ warning: 'A', warnings: ['B', 7, 'C'] })).toEqual(['A', 'B', 'C'])
  })
})
