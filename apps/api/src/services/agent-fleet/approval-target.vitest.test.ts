/**
 * Approvals grid — the target resolver (approval-target.ts): what a request is about, where, and its before → after
 * lines in plain words, from the preview a tool stores (shapes copied from each tool's own handler) and the ids of its
 * arguments. Pure: no database.
 */
import { describe, expect, it, vi } from 'vitest'

// The tool registry is imported (every change tool is resolved below); no queue connection is opened for it.
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
import { listTools } from '../agents/tool-registry.js'
import {
  channelOf,
  coordinateOf,
  fieldLabel,
  marketOf,
  money,
  NEXUS_RECORD_TOOLS,
  plainValue,
  productRefsOf,
  resolveRequest,
  stepChangesOf,
  type TargetContext,
} from './approval-target.js'

const products = new Map<string, { id: string; sku: string; name: string }>()
for (const p of [
  { id: 'prod-gale', sku: 'XR-GLOVE-M', name: 'Gale glove M' },
  { id: 'prod-helm', sku: 'XR-HELM-L', name: 'Helm L' },
  { id: 'prod-jkt', sku: 'XR-JKT-S', name: 'Jacket S' },
]) {
  products.set(p.id, p)
  products.set(p.sku, p)
}
const ctx: TargetContext = { masterCurrency: 'EUR', products }

interface Case {
  tool: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  target: Record<string, unknown> | null
  channel?: string | null
  market?: string | null
  first?: { label: string; from: string | null; to: string | null } | null
  changeCount?: number
  summary?: string | null
}

const CASES: Case[] = [
  {
    tool: 'set-price',
    args: { productId: 'prod-gale', price: 44.9 },
    preview: { action: 'set-price', sku: 'XR-GLOVE-M', scope: 'master', changes: { 'base price': { from: 49.9, to: 44.9 } }, deltaPct: -10 },
    target: { kind: 'product', id: 'prod-gale', sku: 'XR-GLOVE-M', name: 'Gale glove M', count: 1, href: '/products/prod-gale/edit' },
    first: { label: 'Base price', from: '€49.90', to: '€44.90' },
    changeCount: 1,
  },
  {
    tool: 'bulk-price-change',
    args: { products: ['XR-GLOVE-M', 'XR-HELM-L', 'XR-JKT-S'], operation: 'percent', value: 5 },
    preview: {
      action: 'bulk-price-change',
      effect: 'Master price raised by 5 % on 3 products. 2 listings that follow the master price are sent to their marketplace after a hold of 30 seconds.',
      change: { operation: 'percent', value: 5, currency: 'EUR' },
      changes: { 'XR-GLOVE-M base price': { from: 100, to: 105 }, 'XR-HELM-L base price': { from: 60, to: 63 } },
      moreProducts: 1,
      totals: { products: 3, changing: 3, alreadyAtPrice: 0, listingsSent: 2 },
    },
    target: { kind: 'product', sku: 'XR-GLOVE-M', name: 'Gale glove M', count: 3, href: '/products/prod-gale/edit' },
    first: { label: 'XR-GLOVE-M · Base price', from: '€100.00', to: '€105.00' },
    changeCount: 3,
    summary: 'Master price raised by 5 % on 3 products. 2 listings that follow the master price are sent to their marketplace after a hold of 30 seconds.',
  },
  {
    tool: 'apply-content',
    args: { productId: 'prod-jkt', title: 'Jacket S, new' },
    preview: { action: 'apply-content', productId: 'prod-jkt', changes: { title: { from: 'Jacket S', to: 'Jacket S, new' }, bulletPoints: { from: [], to: ['Warm', 'Dry'] } } },
    target: { kind: 'product', id: 'prod-jkt', sku: 'XR-JKT-S', name: 'Jacket S', count: 1 },
    first: { label: 'Title', from: 'Jacket S', to: 'Jacket S, new' },
    changeCount: 2,
  },
  {
    tool: 'set-stock',
    args: { items: [{ productId: 'prod-helm', location: 'IT-MAIN', quantity: 5 }] },
    preview: {
      action: 'set-stock',
      effect: 'On-hand set on 1 row: 2 units up, 0 down.',
      changes: [{ sku: 'XR-HELM-L', name: 'Helm L', location: 'IT-MAIN', locationName: 'Main', from: 3, to: 5, delta: 2, reserved: 0 }],
      totals: { rows: 1, unchanged: 0, unitsUp: 2, unitsDown: 0 },
    },
    target: { kind: 'product', id: 'prod-helm', sku: 'XR-HELM-L', name: 'Helm L', count: 1 },
    channel: null,
    market: null,
    first: { label: 'XR-HELM-L · IT-MAIN', from: '3', to: '5' },
    changeCount: 1,
  },
  {
    tool: 'set-listing-stock',
    args: { productId: 'prod-helm', action: 'set', quantity: 4, targets: [{ rowId: 'prod-helm', coordinateKey: 'EBAY:IT' }] },
    preview: {
      action: 'set-listing-stock',
      family: { productId: 'prod-helm', sku: 'XR-HELM-L' },
      verb: 'set-quantity',
      changes: [{ rowId: 'prod-helm', sku: 'XR-HELM-L', coordinateKey: 'EBAY:IT', cell: 'syncQty', from: 2, to: 4, fromLabel: 'Pinned 2', toLabel: 'Pinned 4' }],
    },
    target: { kind: 'product', id: 'prod-helm', sku: 'XR-HELM-L', count: 1 },
    channel: 'EBAY',
    market: 'IT',
    // The SKU and the market have their own places (Product, Where): the line says only what changes.
    first: { label: 'Quantity', from: 'Pinned 2', to: 'Pinned 4' },
  },
  {
    // A variation's listing: the preview names the family's PARENT too; the request is about the listing's own SKU.
    tool: 'set-listing-stock',
    args: { productId: 'prod-jkt', action: 'set-buffer', buffer: 2, targets: [{ rowId: 'prod-jkt', coordinateKey: 'EBAY:IT' }] },
    preview: {
      action: 'set-listing-stock',
      family: { productId: 'prod-jkt-parent', sku: 'XR-JKT' },
      verb: 'set-buffer',
      changes: [{ rowId: 'prod-jkt', sku: 'XR-JKT-S', coordinateKey: 'EBAY:IT', cell: 'syncBuffer', from: 0, to: 2, fromLabel: 'Buffer 0', toLabel: 'Buffer 2', note: 'Follow pushes 7' }],
    },
    target: { kind: 'product', id: 'prod-jkt', sku: 'XR-JKT-S', name: 'Jacket S', count: 1, href: '/products/prod-jkt/edit' },
    channel: 'EBAY',
    market: 'IT',
    first: { label: 'Buffer', from: 'Buffer 0', to: 'Buffer 2' },
    changeCount: 1,
  },
  {
    tool: 'set-listing-price',
    args: { productId: 'prod-helm', action: 'set', price: 99.75, targets: [{ rowId: 'prod-helm', coordinateKey: 'EBAY:IT' }, { rowId: 'prod-helm', coordinateKey: 'EBAY:DE' }] },
    preview: {
      action: 'set-listing-price',
      family: { productId: 'prod-helm', sku: 'XR-HELM-L' },
      changes: [
        { rowId: 'prod-helm', sku: 'XR-HELM-L', coordinateKey: 'EBAY:IT', cell: 'price', from: 105, to: 99.75, fromLabel: '€105.00', toLabel: '€99.75' },
        { rowId: 'prod-helm', sku: 'XR-HELM-L', coordinateKey: 'EBAY:DE', cell: 'price', from: 105, to: 99.75, fromLabel: '€105.00', toLabel: '€99.75' },
      ],
    },
    target: { kind: 'product', id: 'prod-helm', sku: 'XR-HELM-L', count: 1 },
    channel: 'EBAY',
    market: null, // two markets: no single one, so each line names its own
    first: { label: 'eBay IT · Price', from: '€105.00', to: '€99.75' },
    changeCount: 2,
  },
  {
    tool: 'set-listing-price',
    args: { productId: 'prod-helm', action: 'sale', sale: { price: 89, start: '2026-10-10', end: null }, targets: [{ rowId: 'prod-helm', coordinateKey: 'AMAZON:IT' }] },
    preview: {
      action: 'set-listing-price',
      family: { productId: 'prod-helm', sku: 'XR-HELM-L' },
      verb: 'sale',
      changes: [{ rowId: 'prod-helm', sku: 'XR-HELM-L', coordinateKey: 'AMAZON:IT', from: { value: null, start: null, end: null }, to: { value: 89, start: '2026-10-10', end: null }, version: 3 }],
    },
    target: { kind: 'product', sku: 'XR-HELM-L', name: 'Helm L' },
    channel: 'AMAZON',
    market: 'IT',
    first: { label: 'Sale price', from: 'No sale', to: '89.00 (from 2026-10-10)' },
  },
  {
    tool: 'bulk-listing-stock',
    args: { action: 'BUFFER', buffer: 1, listingIds: ['lst-1', 'lst-2'] },
    preview: {
      action: 'bulk-listing-stock',
      verb: 'BUFFER',
      summary: 'Buffer 2 rows (2 listings, 0 shared eBay variants).',
      cells: [
        { sku: 'XR-GLOVE-M', channel: 'EBAY', market: 'IT', account: null, kind: 'listing', from: 'Follow', to: 'Follow, buffer 1' },
        { sku: 'XR-GLOVE-M', channel: 'AMAZON', market: 'EU (DE, FR)', account: 'Xavia EU', kind: 'listing', from: 'Follow', to: 'Follow, buffer 1' },
      ],
      totals: { listings: 2, sharedVariants: 0, unchanged: 0, leftOut: 0 },
    },
    target: { kind: 'listing', sku: 'XR-GLOVE-M', name: 'Gale glove M', count: 2 },
    channel: null, // two channels
    market: null,
    first: { label: 'eBay IT · Stock sync', from: 'Follow', to: 'Follow, buffer 1' },
    changeCount: 2,
    summary: 'Buffer 2 rows (2 listings, 0 shared eBay variants).',
  },
  {
    tool: 'publish-listing',
    args: { productId: 'prod-jkt', channel: 'AMAZON', marketplace: 'IT', fields: ['title'] },
    preview: {
      action: 'publish-listing',
      productId: 'prod-jkt',
      sku: 'XR-JKT-S',
      destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc-1', accountLabel: 'Xavia IT' },
      publish: 're-publish',
      sendCount: 2,
      send: [
        { sku: 'XR-JKT-S', field: 'title', label: 'Title', status: 'changed', nexus: 'Jacket S, new', channel: 'Jacket S' },
        { sku: 'XR-JKT-S', field: 'bullets', label: 'Bullet points', status: 'changed', nexus: 'Warm; Dry', channel: 'Warm' },
      ],
    },
    target: { kind: 'product', id: 'prod-jkt', sku: 'XR-JKT-S', name: 'Jacket S', href: '/products/prod-jkt/edit' },
    channel: 'AMAZON',
    market: 'IT',
    first: { label: 'Title', from: 'Jacket S', to: 'Jacket S, new' },
    changeCount: 2,
  },
  {
    tool: 'set-target-bid',
    args: { targetId: 'ctarget000000000000000001', proposedBidCents: 84 },
    preview: {
      action: 'set-target-bid',
      target: { id: 'ctarget000000000000000001', expression: 'giacca moto', matchType: 'EXACT' },
      campaign: { id: 'camp-1', name: 'Giacche IT', marketplace: 'IT' },
      currency: 'EUR',
      currentBidCents: 31,
      proposedBidCents: 84,
      effect: 'Moves "giacca moto" from €0.31 to €0.84 in Giacche IT.',
    },
    target: { kind: 'ad-target', id: 'ctarget000000000000000001', name: '“giacca moto” (exact)', href: '/marketing/ads/campaigns/camp-1' },
    channel: 'AMAZON',
    market: 'IT',
    first: { label: 'Bid', from: '€0.31', to: '€0.84' },
  },
  {
    tool: 'set-target-bid',
    args: { targetId: 'ctarget000000000000000002', proposedBidCents: 50 },
    preview: { action: 'set-target-bid', target: { id: 'ctarget000000000000000002', expression: 'kask', matchType: 'PHRASE' }, campaign: { id: 'camp-uk', name: 'Helmets UK', marketplace: 'UK' }, currency: 'GBP', currentBidCents: 40, proposedBidCents: 60, effectiveBidCents: 50 },
    target: { kind: 'ad-target', name: '“kask” (phrase)' },
    market: 'UK',
    first: { label: 'Bid', from: '£0.40', to: '£0.50' }, // the bid that lands, after the campaign's clamps
  },
  {
    tool: 'create-negative-keyword',
    args: { externalCampaignId: '218394170642485', keywordText: 'cheap', matchType: 'NEGATIVE_EXACT', scope: 'adGroup' },
    preview: {
      action: 'create-negative-keyword',
      term: 'cheap',
      matchType: 'NEGATIVE_EXACT',
      scope: 'adGroup',
      campaign: { id: 'camp-1', name: 'Giacche IT', marketplace: 'IT' },
      adGroup: { id: 'ag-1', name: 'Giacche', externalAdGroupId: '1' },
      currency: 'EUR',
    },
    target: { kind: 'campaign', id: 'camp-1', name: 'Giacche IT › Giacche', href: '/marketing/ads/campaigns/camp-1' },
    channel: 'AMAZON',
    market: 'IT',
    first: { label: 'Negative keyword (exact)', from: null, to: '“cheap”' },
  },
  {
    tool: 'send-customer-message',
    args: { orderId: 'order-1', template: 'shipping-delay' },
    preview: {
      action: 'send-customer-message',
      order: { id: 'order-1', channel: 'EBAY', marketplace: 'IT', channelOrderId: '12-34567-89012' },
      to: { firstName: 'Marco', city: 'Rimini', country: 'IT', email: null },
      subject: 'Il tuo ordine è in ritardo',
      body: 'Ciao Marco, il tuo ordine partirà domani.',
      mode: 'live',
    },
    target: { kind: 'order', id: 'order-1', name: 'Order 12-34567-89012', count: 1, href: '/orders/order-1' },
    channel: 'EBAY',
    market: 'IT',
    first: { label: 'Message', from: null, to: 'Il tuo ordine è in ritardo' },
    changeCount: 2, // the subject and the text: two lines of one message
  },
  {
    tool: 'issue-refund',
    args: { returnId: 'ret-1', amount: 25 },
    preview: {
      action: 'issue-refund',
      return: { id: 'ret-1', rmaNumber: 'RMA-7', status: 'RECEIVED', channel: 'EBAY' },
      order: { id: 'order-2', channel: 'EBAY', marketplace: 'DE', channelOrderId: '99-1' },
      refund: { amount: 25, currencyCode: 'EUR' },
      refundable: { paid: 80, refunded: 0, leftAfter: 55, currencyCode: 'EUR' },
    },
    target: { kind: 'order', id: 'order-2', name: 'Order 99-1 · return RMA-7', href: '/orders/order-2' },
    channel: 'EBAY',
    market: 'DE',
    first: { label: 'Refund', from: null, to: '€25.00' },
  },
  {
    tool: 'submit-change-plan',
    args: { title: 'Autumn prices', steps: 3 },
    preview: {
      action: 'submit-change-plan',
      title: 'Autumn prices',
      summary: '3 changes: 2 × Set master price, 1 × Apply product content. 2 of them reach a marketplace or a buyer.',
      kinds: [
        { tool: 'set-price', title: 'Set master price', count: 2, outbound: true, reversibility: 'full' },
        { tool: 'apply-content', title: 'Apply product content', count: 1, outbound: false, reversibility: 'full' },
      ],
      totals: { steps: 3, reachOutside: 2 },
    },
    target: null, // the service names a plan by its first step
    first: { label: 'Set master price', from: null, to: '2 changes' },
    changeCount: 2, // two kinds = two lines; the 3 steps are the plan's own count
    summary: 'Autumn prices — 3 changes: 2 × Set master price, 1 × Apply product content. 2 of them reach a marketplace or a buyer.',
  },
  {
    tool: 'set-alert-rule',
    args: { name: 'Sync errors', metric: 'errorRate', operator: 'gt', threshold: 5 },
    preview: { action: 'set-alert-rule', changes: { threshold: { from: 10, to: 5 } } },
    target: null, // a request about no product, listing, order or campaign
    channel: null,
    market: null,
    first: { label: 'Threshold', from: '10', to: '5' },
  },
  {
    tool: 'bulk-listing-price-change',
    args: { listingIds: ['lst-1', 'lst-2'], mode: 'percent', value: -5 },
    preview: {
      action: 'bulk-listing-price-change',
      summary: 'New prices on 2 listings: 0 up, 2 down or handed back.',
      changes: [
        { sku: 'XR-GLOVE-M', channel: 'EBAY', market: 'IT', currency: 'EUR', from: 50, to: 47.5, changePct: -5 },
        { sku: 'XR-GLOVE-M', channel: 'EBAY', market: 'UK', currency: 'GBP', from: 45, to: 42.75, changePct: -5 },
      ],
      totals: { listings: 2, unchanged: 0, up: 0, maxChangePct: 5, held: 0 },
    },
    target: { kind: 'listing', id: 'lst-1', sku: 'XR-GLOVE-M', name: 'Gale glove M', count: 2, href: '/listings/ebay?search=XR-GLOVE-M' },
    channel: 'EBAY',
    market: null,
    first: { label: 'XR-GLOVE-M · eBay IT', from: '€50.00', to: '€47.50' },
    summary: 'New prices on 2 listings: 0 up, 2 down or handed back.',
  },
  {
    tool: 'update-order',
    args: { orderId: 'order-3', addTags: ['vip'] },
    preview: { action: 'update-order', order: { id: 'order-3', channel: 'SHOPIFY', channelOrderId: '#1001', status: 'PAID' }, changes: { tags: { from: [], to: ['vip'] } } },
    target: { kind: 'order', id: 'order-3', name: 'Order #1001', href: '/orders/order-3' },
    channel: 'SHOPIFY',
    first: { label: 'Tags', from: '(empty)', to: 'vip' },
  },
  {
    tool: 'close-listing',
    args: { listingIds: ['lst-9'] },
    preview: { action: 'close-listing', listings: [{ listingId: 'lst-9', sku: 'XR-JKT-S', channel: 'AMAZON', market: 'DE', does: 'amazon-offer' }] },
    target: { kind: 'listing', id: 'lst-9', sku: 'XR-JKT-S', name: 'Jacket S', href: '/listings/amazon?search=XR-JKT-S' },
    channel: 'AMAZON',
    market: 'DE',
    first: { label: 'XR-JKT-S · Amazon DE', from: null, to: 'Paused' },
  },
  {
    tool: 'set-campaign-budget',
    args: { campaignId: 'camp-1', dailyBudgetCents: 1500 },
    preview: { action: 'set-campaign-budget', campaign: { id: 'camp-1', name: 'Giacche IT', marketplace: 'IT' }, currency: 'EUR', currentBudgetCents: 1000, proposedBudgetCents: 1500 },
    target: { kind: 'campaign', id: 'camp-1', name: 'Giacche IT', href: '/marketing/ads/campaigns/camp-1' },
    channel: 'AMAZON',
    market: 'IT',
    first: { label: 'Daily budget', from: '€10.00', to: '€15.00' },
  },
  {
    tool: 'set-ebay-campaign-budget',
    args: { ebayCampaignId: 'ebc-1', dailyBudgetCents: 500 },
    preview: { action: 'set-ebay-campaign-budget', campaign: { id: 'ebc-1', name: 'Caschi', marketplace: 'IT' }, currency: 'EUR', currentBudgetCents: 300, proposedBudgetCents: 500 },
    target: { kind: 'campaign', id: 'ebc-1', href: '/marketing/ads/ebay/campaigns/ebc-1' },
    channel: 'EBAY',
    market: 'IT',
    first: { label: 'Daily budget', from: '€3.00', to: '€5.00' },
  },
]

describe('resolveRequest — table of tools', () => {
  it.each(CASES.map((c, i) => [`${c.tool} #${i}`, c] as const))('%s', (_name, c) => {
    const out = resolveRequest(c.tool, c.args, c.preview, ctx)
    if (c.target === null) expect(out.target).toBeNull()
    else expect(out.target).toMatchObject(c.target)
    if (c.channel !== undefined) expect(out.channel).toBe(c.channel)
    if (c.market !== undefined) expect(out.market).toBe(c.market)
    if (c.first !== undefined) expect(out.changes[0] ?? null).toEqual(c.first)
    if (c.changeCount !== undefined) expect(out.changeCount).toBe(c.changeCount)
    if (c.summary !== undefined) expect(out.summary).toBe(c.summary)
    // Never raw JSON in a line.
    for (const line of out.changes) for (const part of [line.label, line.from, line.to]) expect(part ?? '').not.toMatch(/^[[{]/)
  })
})

describe('resolveRequest — honesty', () => {
  it('a preview the viewer may not see gives no change line; the ids of the arguments still name the target', () => {
    const out = resolveRequest('set-price', { productId: 'prod-gale', price: 44.9 }, null, ctx)
    expect(out.changes).toEqual([])
    expect(out.summary).toBeNull()
    expect(out.target).toMatchObject({ kind: 'product', id: 'prod-gale', sku: 'XR-GLOVE-M', name: 'Gale glove M' })
  })

  it('an argument is never a change line: the price Claude typed is not shown when the preview is hidden', () => {
    const out = resolveRequest('set-price', { productId: 'prod-gale', price: 1 }, null, ctx)
    expect(JSON.stringify(out)).not.toContain('1.00')
  })

  it('a product the page did not look up keeps the id it has, and no name is invented', () => {
    const out = resolveRequest('set-price', { productId: 'unknown-id', price: 5 }, { changes: { 'base price': { from: 4, to: 5 } } }, { masterCurrency: 'EUR' })
    expect(out.target).toEqual({ kind: 'product', id: 'unknown-id', sku: null, name: null, count: 1, href: '/products/unknown-id/edit' })
  })

  it('money without a known currency is the bare amount; a master price carries the master currency', () => {
    const generic = resolveRequest('set-tier-prices', { productId: 'prod-gale' }, { changes: { 'tier price': { from: 10, to: 9 } } }, { masterCurrency: 'CHF' })
    expect(generic.changes[0]).toMatchObject({ from: 'CHF 10.00', to: 'CHF 9.00' })
    const unknown = resolveRequest('set-promotion', {}, { changes: { 'sale price': { from: 10, to: 9 } } }, ctx)
    expect(unknown.changes[0]).toMatchObject({ from: '10.00', to: '9.00' })
  })

  it('an ad amount from before previews named a currency is in euros (the web card rule)', () => {
    const out = resolveRequest('set-target-bid', { targetId: 'x' }, { target: { id: 'x', expression: 'a' }, currentBidCents: 10, proposedBidCents: 20 }, ctx)
    expect(out.changes[0]).toEqual({ label: 'Bid', from: '€0.10', to: '€0.20' })
  })

  it('a bulk preview that keeps 20 lines counts the rest', () => {
    const changes = Object.fromEntries(Array.from({ length: 20 }, (_v, i) => [`SKU-${i} base price`, { from: 1, to: 2 }]))
    const out = resolveRequest('set-master-prices', { prices: [] }, { changes, moreProducts: 30, totals: { products: 50, changing: 50 } }, ctx)
    expect(out.changes).toHaveLength(20)
    expect(out.changeCount).toBe(50)
    expect(out.items[0]).toEqual({ sku: 'SKU-0', name: null, change: { label: 'Base price', from: '€1.00', to: '€2.00' } })
  })

  it('an ad request whose preview names nothing is named by the fleet labels, else by its id only', () => {
    const labelled = resolveRequest('set-target-bid', { targetId: 'ctarget000000000000000009' }, {}, {
      ...ctx,
      labels: { campaigns: {}, targets: { ctarget000000000000000009: { text: 'guanti', matchType: 'BROAD', campaignName: 'G', marketplace: 'IT' } } },
    })
    expect(labelled.target).toMatchObject({ kind: 'ad-target', name: '“guanti” (broad)' })
    const bare = resolveRequest('set-target-bid', { targetId: 'ctarget000000000000000009' }, {}, ctx)
    expect(bare.target).toMatchObject({ kind: 'ad-target', id: 'ctarget000000000000000009', name: null })
  })

  it('W1-4 — a change of the ads strategy: money in the market\'s currency, groups in words, the scope as its target', () => {
    const preview = {
      summary: 'Raises the market strategy for Amazon IT: 4 settings; it raises Highest bid (cents).',
      scope: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT market' },
      changes: [
        { field: 'maxBidCents', label: 'Highest bid (cents)', from: 150, to: 200, direction: 'raise' },
        { field: 'target', label: 'Target', from: null, to: { targetKind: 'ACOS', targetPct: 25 }, direction: 'lower' },
        { field: 'stop', label: 'Temporary stop', from: null, to: { stopMethod: 'LOW_BIDS', stopBidCents: null }, direction: 'same' },
        { field: 'targetAcosPct', label: "Campaign's own target ACoS (%)", campaignId: 'c1', campaign: 'Test helmets', from: 28, to: null, direction: 'lower' },
      ],
    }
    const out = resolveRequest('set-ads-strategy', {}, preview, ctx)
    expect(out.changes).toEqual([
      { label: 'Highest bid', from: '€1.50', to: '€2.00' },
      { label: 'Target', from: 'not set', to: 'ACoS 25%' },
      { label: 'Temporary stop', from: 'not set', to: 'low bids at the 2-cent floor' },
      { label: 'Own target ACoS · Test helmets', from: '28%', to: 'not set' },
    ])
    expect(out.summary).toBe('Raises the market strategy for Amazon IT: 4 settings; it raises Highest bid.')
    expect(out).toMatchObject({ channel: 'AMAZON', market: 'IT', target: { kind: 'other', name: 'Ads strategy · IT market', href: '/marketing/ads/rules-automation/control-room?tab=strategy&market=IT' } })
    // A market Amazon's limits table does not know: cents, never a guessed currency.
    const elsewhere = resolveRequest('set-ads-strategy', {}, { ...preview, scope: { ...preview.scope, market: 'ZZ', label: 'ZZ market' } }, ctx)
    expect(elsewhere.changes[0]).toEqual({ label: 'Highest bid', from: '150 cents', to: '200 cents' })
  })
})

describe('Where — a change to Nexus’s own record', () => {
  it('master prices, warehouse stock and photos are made in Nexus, even when the listings that follow them are sent on', () => {
    for (const tool of ['set-price', 'set-master-prices', 'bulk-price-change', 'schedule-price-change', 'set-stock']) {
      expect(resolveRequest(tool, { productId: 'prod-gale' }, {}, ctx).nexusRecord, tool).toBe(true)
    }
    // A listing's own price or stock, a publish, an ad bid: made on the channel, not in Nexus.
    for (const tool of ['set-listing-price', 'set-listing-stock', 'publish-listing', 'set-target-bid']) {
      expect(resolveRequest(tool, {}, {}, ctx).nexusRecord, tool).toBe(false)
    }
  })

  it('every kind named as Nexus’s own record is a registered change tool', () => {
    const changeTools = new Set(listTools().filter((tool) => !tool.readOnly).map((tool) => tool.name))
    for (const name of NEXUS_RECORD_TOOLS) expect(changeTools.has(name), name).toBe(true)
  })

  it('a change plan is made in Nexus only when every kind in it is', () => {
    const plan = (kinds: Array<{ tool: string; outbound: boolean }>) =>
      resolveRequest('submit-change-plan', {}, { action: 'submit-change-plan', kinds: kinds.map((k) => ({ ...k, title: k.tool, count: 1 })), totals: { steps: kinds.length } }, ctx).nexusRecord
    expect(plan([{ tool: 'set-price', outbound: true }, { tool: 'apply-content', outbound: false }])).toBe(true)
    expect(plan([{ tool: 'set-price', outbound: true }, { tool: 'set-listing-price', outbound: true }])).toBe(false)
    expect(plan([])).toBe(false)
  })
})

describe('stepChangesOf — a plan step in the grid’s words', () => {
  it('a master-price step reads in the master currency, as a single request does', () => {
    const preview = { action: 'set-price', sku: 'XR-GLOVE-M', scope: 'master', changes: { 'base price': { from: 154, to: 149 } } }
    expect(stepChangesOf('set-price', preview, ctx)).toEqual({ changes: [{ label: 'Base price', from: '€154.00', to: '€149.00' }], changeCount: 1 })
    expect(stepChangesOf('set-price', preview, ctx).changes[0]).toEqual(resolveRequest('set-price', {}, preview, ctx).changes[0])
  })

  it('a step whose preview is hidden has no lines; a long step keeps three and counts the rest', () => {
    expect(stepChangesOf('set-price', null, ctx)).toEqual({ changes: [], changeCount: 0 })
    const many = Object.fromEntries(Array.from({ length: 5 }, (_v, i) => [`field${i}`, { from: i, to: i + 1 }]))
    const out = stepChangesOf('apply-content', { changes: many }, ctx)
    expect(out.changes).toHaveLength(3)
    expect(out.changeCount).toBe(5)
  })
})

describe('the small readers', () => {
  it('money, values, fields, channels, markets, coordinates', () => {
    expect(money(49.9, 'EUR')).toBe('€49.90')
    expect(money(-2.5, 'GBP')).toBe('−£2.50')
    expect(money(120, 'SEK')).toBe('SEK 120.00')
    expect(money(3, null)).toBe('3.00')
    expect(plainValue(['a', 'b', 'c', 'd'])).toBe('a, b, c and 1 more')
    expect(plainValue({ status: 'PAID', deliveredAt: null })).toBe('status: PAID, deliveredAt: (empty)')
    expect(plainValue(true)).toBe('yes')
    expect(fieldLabel('bulletPoints')).toBe('Bullet points')
    expect(fieldLabel('base price')).toBe('Base price')
    expect(fieldLabel('SKU')).toBe('SKU')
    expect(fieldLabel('listingsSent')).toBe('Listings sent')
    expect(channelOf('ebay')).toBe('EBAY')
    expect(channelOf('WOOCOMMERCE')).toBeNull()
    expect(marketOf('it')).toBe('IT')
    expect(marketOf('DEFAULT')).toBeNull()
    expect(marketOf('APJ6JRA9NG5V4')).toBeNull()
    expect(coordinateOf('EBAY:IT#alias-1')).toEqual({ channel: 'EBAY', market: 'IT' })
    expect(coordinateOf('AMAZON:EU')).toEqual({ channel: 'AMAZON', market: 'EU' })
  })

  it('productRefsOf names the first product, and every item for the drawer', () => {
    expect(productRefsOf('set-price', { productId: 'p1' }, { sku: 'S1' })).toEqual(['p1', 'S1'])
    expect(productRefsOf('bulk-price-change', { products: ['a', 'b', 'c'] }, null)).toEqual(['a'])
    expect(productRefsOf('set-stock', { items: [] }, { changes: [{ sku: 'A' }, { sku: 'B' }] }, true)).toEqual(['A', 'B'])
    // A Matrix request names the listing's own SKU (looked up), besides the family's parent.
    expect(productRefsOf('set-listing-stock', { productId: 'child' }, { family: { productId: 'parent', sku: 'P' }, changes: [{ rowId: 'child', sku: 'P-S' }] }))
      .toEqual(['parent', 'child', 'P', 'P-S'])
    expect(productRefsOf('bulk-listing-stock', { listingIds: ['l1'] }, { cells: [{ sku: 'C-1' }] })).toEqual(['C-1'])
  })
})

describe('every registered change tool', () => {
  const changeTools = listTools().filter((tool) => !tool.readOnly)

  it('resolves without throwing for empty, odd and missing previews', () => {
    for (const tool of changeTools) {
      for (const preview of [null, {}, { changes: 'x', totals: 3, campaign: 'y', order: [], plan: 1 }]) {
        expect(() => resolveRequest(tool.name, {}, preview, ctx), tool.name).not.toThrow()
      }
    }
  })

  it('most change tools name a target from the ids of their arguments alone', () => {
    // A value for every id-like argument the tool takes, as Claude would send it.
    const ID_KEYS = /^(productId|productIds|products|items|prices|costs|listingId|listingIds|extraListingId|targetId|campaignId|ebayCampaignId|externalCampaignId|sourceExternalCampaignId|orderId|orderIds|purchaseOrderId|shipmentId|shipmentIds|shipments|customerId|supplierId|ruleId|priceRuleId|opsRuleId)$/
    const named = changeTools.filter((tool) => {
      const keys = Object.keys((tool.input as unknown as { shape?: Record<string, unknown> }).shape ?? {}).filter((k) => ID_KEYS.test(k))
      if (!keys.length) return false
      const args = Object.fromEntries(keys.map((k) => [k, /Ids$|^products$/.test(k) ? ['id-1'] : /^(items|prices|costs|shipments)$/.test(k) ? [{ productId: 'id-1', product: 'id-1', listingId: 'id-1', shipmentId: 'id-1' }] : 'id-1']))
      return resolveRequest(tool.name, args, null, ctx).target !== null
    })
    // Recorded for the report (docs/approvals-grid/reports/A-api-read.md): how far the arguments alone name a target.
    expect(named.length).toBeGreaterThanOrEqual(60)
  })
})
