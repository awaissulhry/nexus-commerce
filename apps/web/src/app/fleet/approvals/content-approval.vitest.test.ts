/**
 * MCP full control T6 (docs/mcp-full-control/sections/03-content.md §4, §6 step 6) — the Approvals card of a content
 * change, held against the previews set-content (and the later listing and bulk content tools) store. Every SKU and
 * text here is invented.
 *
 *   · per field: the text now, the new text and its English meaning side by side (the approver reads English, and the
 *     approval is the text's review, d8); a field that shows another language's text now says so; a reset says what
 *     the field shows afterwards
 *   · where the text shows: the listings that follow it and those that keep their own
 *   · the glossary's avoid words and the writer's warnings, as warnings
 *   · the Apply button names the fields and the language, never a whole description
 *   · the content tools have their own words, reject reasons, and count as Nexus only
 *
 * Rendered HTML (node SSR), as ApprovalCard.cannotApprove.vitest.test.ts does.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TOOL_CARDS } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { ApprovalCard, rejectCodesFor, type CardApproval } from './ApprovalCard'
import { approveLabelFor, contentDiffOf, moreThanShown, outsideHeading } from './approval-words'

const setContent = {
  action: 'set-content',
  productId: 'product-1',
  sku: 'TEST-JACKET',
  language: 'de',
  layer: 'language',
  changes: {
    title: { from: 'Giacca moto', fromLanguage: 'it', to: 'Motorradjacke aus Leder', englishMeaning: 'Leather motorcycle jacket' },
    bulletPoints: { from: ['Pelle'], fromLanguage: 'it', to: ['Rindsleder', 'CE-Protektoren'], englishMeaning: 'Cowhide; CE armour' },
    description: { from: 'Alte Beschreibung.', to: null, reset: true, thenShows: 'Giacca da moto in pelle.', thenShowsLanguage: 'it' },
  },
  reach: {
    title: { follow: ['eBay · DE · TEST-JACKET'], ownPin: ['Amazon · DE · TEST-JACKET'] },
    bulletPoints: { follow: [], ownPin: [] },
  },
  basis: 'abc123',
  glossaryHits: [{ field: 'title', avoid: 'Blouson', use: 'Jacke', context: 'Say Jacke.' }],
  warnings: ['title: eBay · DE takes at most 80 characters'],
  note: 'This changes Nexus only.',
}

const base: CardApproval = {
  id: 'approval-content',
  toolName: 'set-content',
  charterKey: null,
  riskTier: 'high',
  status: 'pending',
  args: { product: 'TEST-JACKET', language: 'de' },
  preview: setContent,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  reason: null,
  trackRecord: null,
  reversibility: 'full',
}
const noop = () => {}
const html = (approval: Partial<CardApproval> = {}) =>
  renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...base, ...approval },
    labels: { campaigns: {}, targets: {} },
    workerName: 'Claude',
    busy: false,
    canExecute: true,
    onDecide: noop,
    onRecheck: async () => ({ stale: false, why: null }),
    onAmend: async () => ({ ok: true }),
    onSnooze: noop,
  }))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

describe('contentDiffOf — what the card says per field', () => {
  it('the text now, the new text and its English meaning; a fallback and a reset say what they mean', () => {
    const diff = contentDiffOf('set-content', setContent)!
    expect(diff.language).toBe('German')
    expect(diff.rows).toEqual([
      { key: 'title', product: null, field: 'Title', now: 'Giacca moto', next: 'Motorradjacke aus Leder', english: 'Leather motorcycle jacket',
        note: 'There is no German text yet: it shows the Italian text now.' },
      { key: 'bulletPoints', product: null, field: 'Bullet points', now: ['Pelle'], next: ['Rindsleder', 'CE-Protektoren'], english: 'Cowhide; CE armour',
        note: 'There is no German text yet: it shows the Italian text now.' },
      { key: 'description', product: null, field: 'Description', now: 'Alte Beschreibung.', next: 'Giacca da moto in pelle.', english: null,
        note: 'Drops the German text: it shows the Italian text again.' },
    ])
    expect(diff.reach).toEqual([
      'Title: shown on eBay · DE · TEST-JACKET; kept as their own text on Amazon · DE · TEST-JACKET, which do not change.',
      'Bullet points: no listing in German shows it yet.',
    ])
    expect(diff.glossary).toEqual(['Title uses “Blouson”: the glossary says “Jacke” (Say Jacke.).'])
    expect(diff.warnings).toEqual(['title: eBay · DE takes at most 80 characters'])
  })

  it('a bulk change lists its rows by product, counts the rest, and is not a content diff for other tools', () => {
    const bulk = {
      action: 'bulk-content-change', language: 'de', totals: { products: 30, changes: 31 },
      changes: [{ sku: 'TEST-A', field: 'title', from: 'Giacca A', to: 'Jacke A', englishMeaning: 'Jacket A' }],
      moreChanges: 30,
      reach: { listingsFollowing: 12, listingsWithOwnText: 1 },
    }
    const diff = contentDiffOf('bulk-content-change', bulk)!
    expect(diff.rows).toEqual([{ key: '0', product: 'TEST-A', field: 'Title', now: 'Giacca A', next: 'Jacke A', english: 'Jacket A', note: null }])
    expect(diff.reach).toEqual(['12 listings show the new text; 1 listing keeps its own text.'])
    expect(moreThanShown('bulk-content-change', bulk)).toBe('and 30 more changes')
    expect(approveLabelFor('bulk-content-change', [], bulk, 'Apply these texts')).toBe('Apply — title in German on 30 products')
    expect(contentDiffOf('apply-content', { changes: { title: { from: 'a', to: 'b' } } })).toBeNull()
  })

  it('the Apply label names the fields and the language — never a whole text', () => {
    expect(approveLabelFor('set-content', [], setContent, 'Apply this text')).toBe('Apply — title, bullet points, description in German')
    expect(approveLabelFor('set-listing-content', [], { language: 'de', listing: 'Amazon · DE · TEST-JACKET', changes: { title: { from: 'a', to: 'b', kind: 'pin' } } }, 'x'))
      .toBe('Apply — title in German on Amazon · DE · TEST-JACKET')
  })
})

describe('the content card, rendered', () => {
  it('shows each new text beside its English meaning, where it shows, and the warnings', () => {
    const markup = html()
    const words = text(markup)
    // KeyValue, one per field: Now, New (German), English meaning.
    expect(markup.match(/<dl[^>]*class="nds-kv[ "]/g)?.length).toBe(3)
    expect(words).toContain('Title Now Giacca moto New (German) Motorradjacke aus Leder English meaning Leather motorcycle jacket')
    expect(markup).toContain('<li class="aq-contenttext">CE-Protektoren</li>')
    expect(words).toContain('English meaning No new text to translate.')
    expect(words).toContain('Title: shown on eBay · DE · TEST-JACKET; kept as their own text on Amazon · DE · TEST-JACKET, which do not change.')
    expect(words).toContain('The glossary says otherwise')
    expect(words).toContain('Saved with a warning')
    expect(words).toContain('on SKU TEST-JACKET')
    // The button names fields and language; the long texts stay in the table.
    expect(markup).toMatch(/class="acr-btn go"[^>]*>.*Apply — title, bullet points, description in German<\/button>/s)
    // Its own words: Nexus only, approval is the review — never "Not recorded for this action".
    expect(words).toContain('Approving it counts as its review')
    expect(words).not.toContain('Not recorded for this action')
  })

  it('offers reasons a content change can be wrong for, and counts as Nexus only', () => {
    // The reject reasons render only after Reject is pressed (state); the list itself is read here.
    for (const tool of ['set-content', 'set-listing-content', 'bulk-content-change', 'set-shopify-content']) {
      expect(rejectCodesFor(tool)).toContain('The English meaning does not match the text')
      expect(rejectCodesFor(tool)).toContain('The suggestion itself is wrong')
    }
    expect(TOOL_CARDS['set-content']).toMatchObject({ nexusOnly: true, wants: "wants to change a product's text" })
    expect(TOOL_CARDS['set-listing-content']?.nexusOnly).toBe(true)
    expect(TOOL_CARDS['bulk-content-change']?.nexusOnly).toBe(true)
    expect(TOOL_CARDS['set-shopify-content']?.nexusOnly).toBe(true)
    expect(approveLabelFor('set-shopify-content', [], { language: 'en', listing: 'Shopify · TEST-JACKET', changes: { vendor: { from: 'Old', to: 'New' } } }, 'x'))
      .toBe('Apply — vendor in English on Shopify · TEST-JACKET')
    expect(outsideHeading(['set-content', 'bulk-content-change'])).toBe('2 requests can change Nexus — none of them reaches a sales channel')
  })
})
