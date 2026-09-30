/**
 * MCP.12 — what the Approvals page says about a request that can run, held against the previews the bulk tools
 * really store (the shapes seen in a local end-to-end run, 2026-09-30; every SKU and value here is invented).
 *
 *   · the Apply button names the whole request, not its first line;
 *   · the two bulk tools have their own card vocabulary, so neither says "Not recorded for this action … cannot be
 *     taken back once it runs, by any means";
 *   · a bulk price card shows what each marketplace gets;
 *   · the section heading and the parked row name no one channel, and a Nexus-only request is not counted as
 *     reaching one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TOOL_CARDS, toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { ApprovalCard, ChannelEffectDetail, type CardApproval } from './ApprovalCard'
import { ParkedRow } from './ApprovalLists'
import { approveLabelFor, channelEffectOf, claudeDoorSentence, moreThanShown, outsideHeading } from './approval-words'

const bulkPrice = {
  action: 'bulk-price-change',
  effect: 'Master price raised by 5 % on 3 products. 3 listings that follow the master price are sent to their marketplace after a hold of 30 seconds.',
  change: { operation: 'percent', value: 5, currency: 'EUR' },
  changes: {
    'TEST-PANT-L base price': { from: 100, to: 105 },
    'TEST-PANT-M base price': { from: 100, to: 105 },
    'TEST-PANT-S base price': { from: 100, to: 105 },
  },
  listings: ['TEST-PANT-L · eBay IT: 90.00 → 105.00', 'TEST-PANT-M · eBay IT: 90.00 → 105.00', 'TEST-PANT-S · eBay IT: 90.00 → 105.00'],
  totals: {
    products: 3, changing: 3, alreadyAtPrice: 0, listingsSent: 3, listingsPaused: 0,
    listingsWithOwnPrice: 6, listingsOtherCurrency: 0, listingsAlreadyAtPrice: 0,
  },
}

const bulkAttribute = {
  action: 'bulk-attribute-change',
  scope: 'Nexus only',
  effect: 'This changes Nexus only. Amazon, eBay, Shopify and Etsy do not change until you publish from Nexus. Sets 1 attribute on 2 products: 2 changes.',
  changes: { 'TEST-A number_of_pockets': { from: null, to: 4 }, 'TEST-B number_of_pockets': { from: null, to: 4 } },
  attributes: [{ attribute: 'number_of_pockets', value: 4, changing: 2, alreadySet: 0 }],
  totals: { products: 2, changes: 2, alreadySet: 0 },
}

const setPrice = {
  action: 'set-price',
  sku: 'TEST-SLIDER',
  scope: 'master',
  changes: { 'base price': { from: 20, to: 20.5 } },
  deltaPct: 2.5,
}

function card(toolName: string, preview: Record<string, unknown>, reason?: string): string {
  const approval: CardApproval = {
    id: 'ap-1', toolName, charterKey: null, riskTier: 'high', status: 'pending', args: {}, preview,
    requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    reason,
  }
  return renderToStaticMarkup(createElement(ApprovalCard, {
    approval, labels: { campaigns: {}, targets: {} }, workerName: 'Someone using Claude', busy: false, canExecute: true,
    onDecide: () => undefined, onRecheck: async () => ({ stale: false, why: null }),
    onAmend: async () => ({ ok: true }), onSnooze: () => undefined,
  }))
}

/** The primary's visible text, markup stripped. */
const applyButton = (html: string) =>
  (/<button class="acr-btn go"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '').trim()

describe('MCP.12 — the Apply button names the whole request', () => {
  it('one change keeps its wording', () => {
    expect(applyButton(card('set-price', setPrice))).toBe('Apply — base price €20.00 → €20.50')
  })

  it('a bulk price change names the move and how many products, never only the first', () => {
    const label = applyButton(card('bulk-price-change', bulkPrice))
    expect(label).toBe('Apply — base price +5 % on 3 products')
    expect(label).not.toContain('TEST-PANT-L')
    const deltas = [{ field: 'a', from: '1', to: '2' }, { field: 'b', from: '1', to: '2' }]
    expect(approveLabelFor('bulk-price-change', deltas, { ...bulkPrice, change: { operation: 'amount', value: -2.5, currency: 'EUR' } }, 'x'))
      .toBe('Apply — base price −€2.50 on 3 products')
    expect(approveLabelFor('bulk-price-change', deltas, { ...bulkPrice, change: { operation: 'set', value: 99, currency: 'GBP' } }, 'x'))
      .toBe('Apply — base price set to GBP 99.00 on 3 products')
  })

  it('a bulk attribute change names the attribute, the value and how many products', () => {
    expect(applyButton(card('bulk-attribute-change', bulkAttribute))).toBe('Apply — number_of_pockets: 4 on 2 products')
    const two = { ...bulkAttribute, attributes: [{ attribute: 'fit', value: 'slim' }, { attribute: 'lining', value: 'mesh' }], totals: { products: 5 } }
    expect(approveLabelFor('bulk-attribute-change', [{ field: 'a', from: null, to: 'x' }, { field: 'b', from: null, to: 'y' }], two, 'x'))
      .toBe('Apply — 2 attributes on 5 products')
  })

  it('any other request with several changes names them all, not the first', () => {
    const deltas = [{ field: 'title', from: 'Old', to: 'New' }, { field: 'description', from: 'a', to: 'b' }]
    expect(approveLabelFor('apply-content', deltas, {}, 'Apply this content change')).toBe('Apply — 2 changes: title, description')
  })

  it('a preview that kept 20 lines says how many more the request covers', () => {
    expect(moreThanShown('bulk-price-change', { ...bulkPrice, moreProducts: 230 })).toBe('and 230 more products')
    expect(moreThanShown('bulk-attribute-change', { ...bulkAttribute, moreChanges: 1 })).toBe('and 1 more change')
    expect(moreThanShown('bulk-price-change', bulkPrice)).toBeNull()
    expect(card('bulk-price-change', { ...bulkPrice, moreProducts: 230 })).toContain('<li class="aq-dmore">and 230 more products</li>')
  })
})

describe('MCP.12 — the bulk tools have their own card, and it is honest', () => {
  it('neither falls through to "not recorded"', () => {
    for (const tool of ['bulk-price-change', 'bulk-attribute-change']) {
      expect(TOOL_CARDS[tool]).toBeDefined()
      expect(toolCardFor(tool).undoable).not.toBe('unknown')
      const html = card(tool, tool === 'bulk-price-change' ? bulkPrice : bulkAttribute)
      expect(html).not.toContain('proposes to run')
      expect(html).not.toContain('Not recorded for this action')
      expect(html).not.toContain('cannot be taken back once it runs, by any means')
      expect(html).not.toContain('and that it cannot be undone')
      expect(html).toContain('I have read what this does')
    }
  })

  it('the price change says the marketplaces follow, and that what they did stands', () => {
    const html = card('bulk-price-change', bulkPrice)
    expect(html).toContain('wants to change master prices')
    expect(html).toContain('every listing that follows the master price sells at the wrong price on its marketplace')
    expect(html).toContain('This cannot be undone, only compensated for.')
    expect(toolCardFor('bulk-price-change').nexusOnly).toBeFalsy()
  })

  it('the attribute change says Nexus only, and that another change puts it back', () => {
    const html = card('bulk-attribute-change', bulkAttribute)
    expect(html).toContain('wants to change product attributes')
    expect(html).toContain('No marketplace changes until someone publishes from Nexus')
    expect(html).toContain('We can put this back the way it was')
    expect(toolCardFor('bulk-attribute-change').nexusOnly).toBe(true)
  })
})

describe('MCP.12 — a bulk price card shows what each marketplace gets', () => {
  it('the listing lines and every count that is not zero', () => {
    const effect = channelEffectOf('bulk-price-change', bulkPrice)!
    expect(effect.lines).toEqual(bulkPrice.listings)
    expect(effect.counts).toEqual(['3 listings are sent to their marketplace', '6 listings keep their own price'])
    const html = renderToStaticMarkup(createElement(ChannelEffectDetail, { effect }))
    expect(html).toContain('<li>TEST-PANT-L · eBay IT: 90.00 → 105.00</li>')
    expect(html).toContain('3 listings are sent to their marketplace; 6 listings keep their own price.')
  })

  it('a cut list says how many more, and nothing sent is said', () => {
    const effect = channelEffectOf('bulk-price-change', {
      ...bulkPrice, moreListings: 7,
      totals: { listingsSent: 0, listingsPaused: 1, listingsWithOwnPrice: 0, listingsOtherCurrency: 2, listingsAlreadyAtPrice: 1 },
    })!
    expect(effect.more).toBe(7)
    expect(effect.counts).toEqual([
      'no listing is sent to a marketplace',
      '1 paused listing takes the new price but is not sent',
      '2 listings in another currency are not sent',
      '1 listing is already at the new price',
    ])
    expect(renderToStaticMarkup(createElement(ChannelEffectDetail, { effect }))).toContain('and 7 more listings')
    expect(channelEffectOf('set-price', setPrice)).toBeNull()
  })
})

describe('MCP.12 — no one channel is named, and Nexus-only is not counted as reaching one', () => {
  it('the section heading', () => {
    expect(outsideHeading(['bulk-price-change', 'set-price'])).toBe('2 requests can change something on your sales channels')
    expect(outsideHeading(['bulk-price-change', 'set-price', 'bulk-attribute-change']))
      .toBe('3 requests can change something — 2 on your sales channels, 1 in Nexus only')
    expect(outsideHeading(['bulk-attribute-change'])).toBe('1 request can change Nexus — it does not reach a sales channel')
    expect(outsideHeading(['bulk-attribute-change', 'bulk-attribute-change'])).toBe('2 requests can change Nexus — none of them reaches a sales channel')
    for (const names of [['set-price'], ['bulk-attribute-change'], ['bulk-price-change', 'bulk-attribute-change']]) {
      expect(outsideHeading(names)).not.toContain('Amazon')
    }
  })

  it('the parked row', () => {
    const html = renderToStaticMarkup(createElement(ParkedRow, {
      id: 'ap-1', toolName: 'bulk-price-change', executeAfter: new Date(Date.now() + 20_000).toISOString(),
      busy: false, onUndo: () => undefined, onCommit: () => undefined,
    }))
    expect(html).toContain('Nothing has changed yet.')
    expect(html).not.toContain('Amazon')
    expect(html).toContain('Approved — change master prices')
  })
})

describe('MCP.12 — an old value that was not set reads as a word', () => {
  const one = {
    ...bulkAttribute,
    changes: { 'TEST-A number_of_pockets': { from: null, to: 4 } },
    totals: { products: 1, changes: 1, alreadySet: 0 },
  }

  it('"(empty) → 4", never "— → 4", on the card and on its button', () => {
    const html = card('bulk-attribute-change', one)
    expect(html).toContain('<span class="aq-dfrom aq-dempty">(empty)</span>')
    expect(html).not.toMatch(/<span class="aq-dfrom[^"]*">—<\/span>/)
    expect(applyButton(html)).toBe('Apply — TEST-A number_of_pockets (empty) → 4')
  })

  it('a value that is set keeps its strike-through', () => {
    expect(card('set-price', setPrice)).toContain('<span class="aq-dfrom">€20.00</span>')
  })
})

describe('MCP.12 — the empty queue names Claude too, from the API\'s answer', () => {
  it('says whether the door is open, and how many connections are live', () => {
    expect(claudeDoorSentence({ enabled: false, connections: 3 })).toBe(
      'Connecting Claude is switched off for this business, so nothing can arrive from Claude.',
    )
    expect(claudeDoorSentence({ enabled: true, connections: 0 })).toBe(
      'People can also ask for a change in Claude over a Nexus connection; no one has connected Claude to this business yet.',
    )
    expect(claudeDoorSentence({ enabled: true, connections: 1 })).toBe(
      'People can also ask for a change in Claude over a Nexus connection; 1 connection to this business is live, and each request waits here for a person.',
    )
    expect(claudeDoorSentence({ enabled: true, connections: 2 })).toContain('2 connections to this business are live')
  })

  it('the page renders it only when the API sends it', () => {
    const source = readFileSync(join(import.meta.dirname, 'ApprovalsClient.tsx'), 'utf8')
    expect(source).toMatch(/\{claude \? <> \{claudeDoorSentence\(claude\)\}<\/> : null\}/)
    expect(source).toMatch(/claude=\{gate\?\.outside\.claude\}/)
  })
})

describe('MCP.12 — the ads inbox names no one channel either', () => {
  it('its parked row says nothing has changed yet', () => {
    const inbox = readFileSync(join(import.meta.dirname, '../../marketing/ads/rules-automation/fleet/ApprovalInbox.tsx'), 'utf8')
    expect(inbox).not.toContain('Nothing has reached Amazon yet')
    expect(inbox).toContain('Nothing has changed yet.')
  })
})

describe('MCP.12 — a request handed back reads as one DS Banner, icon beside the text', () => {
  it('not run: the warning tone, the round arrow in the icon slot, the sentence in the body', () => {
    const html = card('set-price', setPrice, 'not run — the facts moved since you approved it — base price changed')
    expect(html).toMatch(/<div class="nds-banner warning aq-cameback" role="status"><span class="nds-banner-icon"><svg[^>]*lucide-rotate-ccw/)
    expect(html).toContain('<div class="nds-banner-desc"><span class="aq-camebacktext"><strong>You approved this before, and it did not run.</strong>')
    expect(html).toContain('the facts moved since you approved it')
  })

  it('attempted and failed: the danger tone', () => {
    const html = card('set-price', setPrice, 'execution failed: the channel refused it')
    expect(html).toMatch(/<div class="nds-banner danger aq-cameback" role="alert">/)
    expect(html).toContain('<strong>You approved this, it was attempted, and it failed.</strong>')
  })

  it('the page styles only its spacing and measure, never the Banner’s colours', () => {
    const css = readFileSync(join(import.meta.dirname, 'approvals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]*aq-cameback[^{}]*)\{([^}]*)\}/g)].map((m) => m[2])
    expect(rules.length).toBeGreaterThan(0)
    for (const body of rules) expect(body).not.toMatch(/\b(background|border|color)\s*:/)
  })
})

