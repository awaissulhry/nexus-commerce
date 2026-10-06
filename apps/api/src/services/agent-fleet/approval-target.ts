/**
 * Approvals grid (docs/approvals-grid/PLAN.md §2, contract packages/shared/approval-queue.ts) — what a request is ABOUT,
 * read from what Nexus stored: the thing it changes (product, listing, campaign, order …), where (channel, market),
 * and its before → after lines in plain words.
 *
 * Pure: no database, no clock. The caller (approval-queue.service.ts) passes the request's arguments, the preview as
 * THIS viewer may see it (`storedOutputOf`, so a money field the viewer may not see is already gone), and the names it
 * looked up in one batch (`productRefsOf`).
 *
 * Sources, in this order (research/01 §3):
 *   1. the preview convention (tool-types.ts PreviewConvention): `summary`/`effect`, `changes` ({field: {from, to}} or
 *      a list of lines), `sku`, `product`/`productName`, `listing`, `totals`, `family`, `destination`;
 *   2. each tool's own preview shape, for the kinds whose preview says more than the convention (ads, publish, the
 *      Matrix, refunds, messages, plans …) — the knowledge the web's ApprovalCard `describe()` held, now on the server;
 *   3. the request's arguments, for the ids only (productId, listingIds, orderId, campaignId …): an argument never
 *      becomes a change line, because the arguments are what Claude typed and the preview is what Nexus worked out.
 *
 * Honesty: a value the preview does not give is null, never guessed; a target the request does not name is null.
 * Money carries its currency when the preview (or, for master prices, the business's master currency) says it.
 */
import type { QueueChange, QueueTarget } from '@nexus/shared/approval-queue'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import { PLAN_TOOL } from '../agents/tool-types.js'

type Rec = Record<string, unknown>

export interface TargetContext {
  /** The currency master prices are kept in (fx-rate.service.ts `masterCurrency()`). */
  masterCurrency: string
  /** Products the page names, keyed by id AND by SKU (one batched lookup of `productRefsOf`). */
  products?: ReadonlyMap<string, { id: string; sku: string; name: string }>
  /** Ad entity names (fleet-labels.service.ts) for a request whose preview does not name them. */
  labels?: {
    campaigns: Record<string, { name: string; marketplace: string | null }>
    targets: Record<string, { text: string; matchType: string; campaignName: string; marketplace: string | null }>
  }
}

export interface ResolvedRequest {
  target: QueueTarget | null
  channel: string | null
  market: string | null
  /** Every before → after line the preview gives, in plain words (not capped; the caller caps the grid's 3). */
  changes: QueueChange[]
  /** How many changes the request makes in total: a bulk preview keeps 20 lines and counts the rest. */
  changeCount: number
  /** The preview's own one-line summary (`summary`, else `effect`), or null. */
  summary: string | null
  /** One entry per item of a bulk request (sku + name + its change), as far as the preview lists them. */
  items: Array<{ sku: string | null; name: string | null; change: QueueChange | null }>
  /**
   * It changes a record Nexus keeps (a master price, warehouse stock, a product's photos — `NEXUS_RECORD_TOOLS`), so
   * its Where is Nexus, even when the listings that follow that record then send the change on to a marketplace.
   */
  nexusRecord: boolean
}

/**
 * The kinds that change Nexus's OWN record. They are marked as reaching a marketplace (registry `openWorld`) because
 * the listings that follow the record are sent on, but the change itself is made in Nexus: the grid's Where says
 * "Nexus", as it does for a kind that never leaves Nexus (apply-content). A change plan is one when every kind in it is.
 */
export const NEXUS_RECORD_TOOLS: ReadonlySet<string> = new Set([
  // master prices (in the master currency)
  'set-price', 'set-master-prices', 'bulk-price-change', 'schedule-price-change', 'set-tier-prices', 'set-price-bounds',
  // stock at the business's own warehouses
  'set-stock', 'transfer-stock', 'reconcile-stock-count', 'reserve-stock', 'receive-stock',
  // the product's photos in Nexus
  'add-photo-from-url',
])

/* ── small readers ─────────────────────────────────────────────────────────────────────────────── */

const rec = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const recs = (v: unknown): Rec[] => list(v).map(rec).filter((r): r is Rec => r !== null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strings = (v: unknown): string[] => list(v).map(text).filter((s): s is string => s !== null)
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const distinct = <T>(values: T[]): T[] => [...new Set(values)]

/** The value a person reads when nothing is set. */
export const EMPTY = '(empty)'

/** Cut a long text (a description, a message) for a line; the drawer keeps more. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' }

/** An amount in its currency: "€49.90", "SEK 120.00". Without a currency the bare amount ("49.90"), never a guess. */
export function money(amount: number, currency: string | null | undefined): string {
  const abs = Math.abs(amount).toFixed(2)
  const sign = amount < 0 ? '−' : ''
  const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : null
  if (!code) return `${sign}${abs}`
  return SYMBOL[code] ? `${sign}${SYMBOL[code]}${abs}` : `${sign}${code} ${abs}`
}

/**
 * An ad amount in cents, in its campaign's own currency. An ad preview written before previews named a currency is in
 * euros, as everything was then (the web card's `adMoney`, MCP full control A4).
 */
function adMoney(cents: unknown, currency: unknown): string | null {
  const value = num(cents)
  if (value === null) return null
  return money(value / 100, text(currency) ?? 'EUR')
}

/**
 * A value in words, never raw JSON: a short list joins its first three items, a flat object reads "key: value", anything
 * deeper is counted (as the web's `plainValue` in apps/web/src/app/fleet/approvals/grid/planWords.ts, so the grid's rows and a
 * plan's steps read the same).
 */
export function plainValue(value: unknown, depth = 0): string {
  if (value == null || value === '') return EMPTY
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY
    const flat = value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))
    if (depth > 1 || (depth > 0 && !flat)) return plural(value.length, 'item')
    const shown = value.slice(0, 3).map((item) => plainValue(item, depth + 1))
    return `${shown.join(', ')}${value.length > 3 ? ` and ${value.length - 3} more` : ''}`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Rec)
    if (entries.length === 0) return EMPTY
    if (depth > 0) return plural(entries.length, 'field')
    const shown = entries.slice(0, 4).map(([key, item]) => `${key}: ${plainValue(item, depth + 1)}`)
    return `${shown.join(', ')}${entries.length > 4 ? ` and ${entries.length - 4} more` : ''}`
  }
  return EMPTY
}

/** A money field of a changes map, by its name (the web card's rule): "base price", "cost", "fee", "budget", "amount". */
const MONEY_FIELD = /price|cost|fee|budget|amount/i

/** One side of a change: absent = null (nothing before, e.g. something new); set but empty = "(empty)". */
function side(change: Rec, key: 'from' | 'to', currency: string | null | false): string | null {
  if (!(key in change)) return null
  const value = change[key]
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return EMPTY
  if (currency !== false && typeof value === 'number') return money(value, currency)
  return plainValue(value)
}

const FIELD_WORDS: Record<string, string> = {
  title: 'Title',
  name: 'Name',
  description: 'Description',
  bulletPoints: 'Bullet points',
  keywords: 'Search keywords',
  SKU: 'SKU',
}

/** A field as a person reads it: "bulletPoints" → "Bullet points", "base price" → "Base price", a SKU stays a SKU. */
export function fieldLabel(field: string): string {
  if (FIELD_WORDS[field]) return FIELD_WORDS[field]
  if (/\s/.test(field)) return /^[a-z]/.test(field) ? field[0].toUpperCase() + field.slice(1) : field
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ').trim()
  if (!words) return field
  if (/^[A-Z0-9-]+$/.test(words)) return words // a code: SKU, EAN, GTIN
  const lower = words.toLowerCase()
  return lower[0].toUpperCase() + lower.slice(1)
}

const CHANNEL_WORDS: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

/** Upper-case channel, one of the four Nexus sells on; anything else is null. */
export function channelOf(value: unknown): string | null {
  const v = text(value)?.toUpperCase()
  return v && CHANNEL_WORDS[v] ? v : null
}

/** A market code (`IT`, `DE`, `EU`, `UK`); a marketplace id, "DEFAULT" or anything else is null. */
export function marketOf(value: unknown): string | null {
  const v = text(value)?.toUpperCase()
  return v && /^[A-Z]{2,3}$/.test(v) ? v : null
}

/** A Matrix coordinate key ("EBAY:IT", "AMAZON:EU", "EBAY:IT#alias") as channel and market. */
export function coordinateOf(key: unknown): { channel: string | null; market: string | null } {
  const raw = text(key)
  if (!raw) return { channel: null, market: null }
  const [head] = raw.split('#')
  const [channel, market] = head.split(':')
  return { channel: channelOf(channel), market: marketOf(market) }
}

/** "eBay IT", "Amazon", "IT" — where, as a person reads it; null when nothing is known. */
function whereWords(channel: string | null, market: string | null): string | null {
  const parts = [channel ? CHANNEL_WORDS[channel] : null, market].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** The one value every entry agrees on, else null (a request across several markets has no single market). */
function agreed(values: Array<string | null>): string | null {
  const known = distinct(values.filter((v): v is string => v !== null))
  return known.length === 1 && values.every((v) => v === null || v === known[0]) ? known[0] : null
}

const MATRIX_CELLS: Record<string, string> = {
  listing: 'Listing',
  fulfilment: 'Fulfilment',
  syncMode: 'Stock mode',
  syncQty: 'Quantity',
  syncBuffer: 'Buffer',
  syncState: 'Stock sync',
  price: 'Price',
  salePrice: 'Sale price',
}

function languageName(code: unknown): string | null {
  const value = text(code)
  if (!value) return null
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(value) ?? value
  } catch {
    return value
  }
}

/* ── targets ───────────────────────────────────────────────────────────────────────────────────── */

type Kind = QueueTarget['kind']

function target(kind: Kind, t: { id?: string | null; sku?: string | null; name?: string | null; count?: number | null; href?: string | null }): QueueTarget {
  return { kind, id: t.id ?? null, sku: t.sku ?? null, name: t.name ?? null, count: Math.max(1, t.count ?? 1), href: t.href ?? null }
}

const seg = (value: string) => encodeURIComponent(value)

/** A product: its id, SKU and name, completed from the page's one product lookup (by id or SKU). */
function productTarget(ref: { id?: string | null; sku?: string | null; name?: string | null }, count: number, ctx: TargetContext): QueueTarget {
  const known = (ref.id ? ctx.products?.get(ref.id) : undefined) ?? (ref.sku ? ctx.products?.get(ref.sku) : undefined)
  const id = known?.id ?? ref.id ?? null
  return target('product', {
    id,
    sku: ref.sku ?? known?.sku ?? null,
    name: ref.name ?? known?.name ?? null,
    count,
    // /products/[id] only redirects to /edit; the edit workspace takes the product id.
    href: id ? `/products/${seg(id)}/edit` : null,
  })
}

/** The listings page of a channel, searched for the SKU (the products page's own link). */
function listingHref(channel: string | null, sku: string | null): string | null {
  if (!sku || !channel || !['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) return null
  return `/listings/${channel.toLowerCase()}?search=${seg(sku)}`
}

const EBAY_AD_TOOLS = new Set(['set-ebay-ad-rates', 'promote-ebay-listings', 'set-ebay-campaign-budget', 'ebay-keywords-change', 'create-ebay-campaign'])
const AMAZON_AD_TOOLS = new Set([
  'set-target-bid', 'create-negative-keyword', 'graduate-keyword', 'set-campaign-budget', 'set-placement-multipliers',
  'bulk-ad-bid-change', 'suppress-campaign', 'restore-campaign', 'set-campaign-live-writes', 'create-ad-campaign', 'undo-ad-change',
  'set-campaign-target-acos', 'pause-ads', 'enable-ads', 'archive-ads', 'lower-ad-bids-for-stock', 'restore-ad-bids-after-stock', 'apply-ads-playbook',
])

/** A campaign page: Amazon's by its Nexus Campaign id, eBay's by its Nexus eBay campaign id. */
function campaignHref(toolName: string, id: string | null): string | null {
  if (!id) return null
  return EBAY_AD_TOOLS.has(toolName) ? `/marketing/ads/ebay/campaigns/${seg(id)}` : `/marketing/ads/campaigns/${seg(id)}`
}

/** The products a request names in its arguments, in order, once each. */
function productIdsOfArgs(a: Rec): string[] {
  return distinct([
    // set-content / set-listing-content / set-shopify-content name one product (id or SKU); a merge names the duplicate.
    ...[text(a.product), text(a.duplicateId)].filter((s): s is string => s !== null),
    ...strings(a.productIds),
    ...strings(a.products),
    ...recs(a.items).map((i) => text(i.productId) ?? text(i.product)).filter((s): s is string => s !== null),
    ...recs(a.prices).map((i) => text(i.product) ?? text(i.productId)).filter((s): s is string => s !== null),
    ...recs(a.costs).map((i) => text(i.productId)).filter((s): s is string => s !== null),
  ])
}

/**
 * The product ids and SKUs whose names the caller should look up for this request (one batched Product query per
 * page): the first product (it names the row), and with `all` every SKU of the items (the drawer's list).
 */
export function productRefsOf(toolName: string, args: unknown, preview: unknown, all = false): string[] {
  const a = rec(args) ?? {}
  const p = rec(preview) ?? {}
  const family = rec(p.family)
  const refs = [
    text(p.productId), text(family?.productId), text(a.productId), text(p.sku), text(family?.sku),
    ...productIdsOfArgs(a).slice(0, all ? 50 : 1),
  ]
  if (toolName === 'publish-listing' || toolName === 'create-draft-listings') refs.push(text(rec(p.destination)?.sku))
  // The Matrix and the stock sync name the listing's own SKU (a variation), not the family's parent.
  if (MATRIX_TOOLS.has(toolName)) refs.push(text(recs(p.changes)[0]?.sku), text(recs(p.changes)[0]?.rowId))
  if (toolName === 'bulk-listing-stock') refs.push(text(recs(p.cells)[0]?.sku))
  if (all) {
    for (const line of recs(p.changes).slice(0, 50)) refs.push(text(line.sku))
    for (const line of recs(p.listings).slice(0, 50)) refs.push(text(line.sku))
    for (const line of recs(p.cells).slice(0, 50)) refs.push(text(line.sku))
  }
  return distinct(refs.filter((r): r is string => r !== null))
}

/** What the request is about, from the preview first and then the arguments' ids. Null when it names nothing. */
function genericTarget(toolName: string, a: Rec, p: Rec, ctx: TargetContext): QueueTarget | null {
  const totals = rec(p.totals) ?? {}
  const family = rec(p.family)

  // A product, or many products.
  const many = productIdsOfArgs(a)
  const productId = text(p.productId) ?? text(family?.productId) ?? text(a.productId) ?? many[0] ?? null
  const sku = text(p.sku) ?? text(family?.sku)
  const name = text(p.product) ?? text(p.productName)
  if (productId || sku || name) {
    const count = num(totals.products) ?? Math.max(many.length, 1)
    return productTarget({ id: productId, sku, name }, count, ctx)
  }

  // Listings.
  const rows = [...recs(p.listings), ...recs(p.remove)].filter((r) => text(r.listingId))
  const listingIds = distinct([
    text(a.listingId), text(a.extraListingId), ...strings(a.listingIds),
    ...recs(a.prices).map((r) => text(r.listingId)), ...rows.map((r) => text(r.listingId)),
  ].filter((s): s is string => s !== null))
  if (listingIds.length) {
    const first = rows.find((r) => text(r.listingId) === listingIds[0]) ?? rows[0] ?? recs(p.changes)[0] ?? null
    const firstSku = text(first?.sku)
    const ch = channelOf(first?.channel)
    const known = firstSku ? ctx.products?.get(firstSku) : undefined
    return target('listing', {
      id: listingIds[0],
      sku: firstSku,
      name: known?.name ?? null,
      count: num(totals.listings) ?? listingIds.length,
      href: listingHref(ch, firstSku),
    })
  }

  // An ad target (a keyword or product target in a campaign).
  const adTarget = rec(p.target)
  const targetId = text(adTarget?.id) ?? text(a.targetId)
  if (targetId || text(adTarget?.expression)) {
    const label = targetId ? ctx.labels?.targets[targetId] : undefined
    const expression = text(adTarget?.expression) ?? label?.text ?? null
    const matchType = text(adTarget?.matchType) ?? label?.matchType ?? null
    const campaign = rec(p.campaign)
    return target('ad-target', {
      id: targetId,
      name: expression ? `“${expression}”${matchType ? ` (${matchType.toLowerCase()})` : ''}` : null,
      href: campaignHref(toolName, text(campaign?.id)),
    })
  }

  // A campaign: the preview's, the arguments' Nexus id, or an Amazon id the fleet labels name.
  const campaign = rec(p.campaign)
  const plan = AMAZON_AD_TOOLS.has(toolName) || EBAY_AD_TOOLS.has(toolName) ? rec(p.plan) : null
  const external = text(a.externalCampaignId) ?? text(a.sourceExternalCampaignId) ?? text(a.destExternalCampaignId)
  const campaignId = text(campaign?.id) ?? text(a.campaignId) ?? text(a.ebayCampaignId)
  if (campaign || campaignId || external || text(plan?.name)) {
    const label = external ? ctx.labels?.campaigns[external] : undefined
    const adGroup = text(rec(p.adGroup)?.name)
    const campaignName = text(campaign?.name) ?? label?.name ?? (text(plan?.name) ? `New campaign “${text(plan?.name)}”` : null)
    return target('campaign', {
      id: campaignId ?? external,
      name: campaignName && adGroup ? `${campaignName} › ${adGroup}` : campaignName,
      href: campaignHref(toolName, campaignId),
    })
  }

  // An order (a return is shown on its order: it has no page of its own in the grid's kinds).
  const order = rec(p.order)
  const orderIds = distinct([text(order?.id), text(a.orderId), ...strings(a.orderIds)].filter((s): s is string => s !== null))
  if (orderIds.length) {
    const channelOrderId = text(order?.channelOrderId)
    const ret = rec(p.return)
    const rma = text(ret?.rmaNumber)
    return target('order', {
      id: orderIds[0],
      name: channelOrderId ? `Order ${channelOrderId}${rma ? ` · return ${rma}` : ''}` : null,
      count: orderIds.length,
      href: `/orders/${seg(orderIds[0])}`,
    })
  }

  // A purchase order.
  const po = rec(p.purchaseOrder)
  const poId = text(po?.id) ?? text(a.purchaseOrderId)
  if (poId) {
    const number = text(po?.poNumber) ?? text(po?.number)
    const supplier = text(po?.supplier)
    return target('purchase-order', {
      id: poId,
      name: number ? `${number}${supplier ? ` · ${supplier}` : ''}` : supplier,
      href: `/fulfillment/purchase-orders/${seg(poId)}`,
    })
  }

  // Shipments.
  const shipmentIds = distinct([text(a.shipmentId), ...strings(a.shipmentIds), ...recs(a.shipments).map((s) => text(s.shipmentId) ?? text(s.id))]
    .filter((s): s is string => s !== null))
  if (shipmentIds.length) return target('shipment', { id: shipmentIds[0], count: shipmentIds.length })

  // A customer, a supplier.
  const customer = rec(p.customer)
  const customerId = text(customer?.id) ?? text(a.customerId)
  if (customerId) return target('customer', { id: customerId, name: text(customer?.firstName), href: `/customers/${seg(customerId)}` })
  const supplierId = text(rec(p.supplier)?.id) ?? text(a.supplierId)
  if (supplierId) return target('supplier', { id: supplierId, name: text(rec(p.supplier)?.name) ?? (toolName === 'upsert-supplier' ? text(a.name) : null) })

  // A rule.
  const rule = rec(p.rule)
  const ruleId = text(rule?.id) ?? text(a.ruleId) ?? text(a.priceRuleId) ?? text(a.opsRuleId)
  if (ruleId || text(rule?.name)) return target('rule', { id: ruleId, name: text(rule?.name) })

  return null
}

/* ── change lines ─────────────────────────────────────────────────────────────────────────────── */

/** The `changes` map of the convention: one line per field. */
function mapLines(changes: Rec, currency: string | null, opts: { language?: string | null } = {}): QueueChange[] {
  const lines: QueueChange[] = []
  for (const [field, raw] of Object.entries(changes)) {
    const ch = rec(raw)
    if (!ch || !('from' in ch || 'to' in ch)) continue
    const cur = MONEY_FIELD.test(field) ? currency : false
    // A content field put back to the shared text shows what it then reads.
    const to = ch.reset === true ? side({ to: ch.thenShows }, 'to', cur) : side(ch, 'to', cur)
    lines.push({
      label: `${fieldLabel(field)}${opts.language ? ` (${opts.language})` : ''}${ch.reset === true ? ', back to the shared text' : ''}`,
      from: side(ch, 'from', cur),
      to,
    })
  }
  return lines
}

/** A line of a `changes` list: whatever names it (SKU, where, field) and its before → after. */
function listLine(item: Rec, currency: string | null): { sku: string | null; name: string | null; change: QueueChange } {
  const sku = text(item.sku)
  const coordinate = coordinateOf(item.coordinateKey)
  const where = whereWords(coordinate.channel ?? channelOf(item.channel), coordinate.market ?? marketOf(item.market ?? item.marketplace))
  const field = text(item.label) ?? text(item.field) ?? (text(item.cell) ? (MATRIX_CELLS[String(item.cell)] ?? fieldLabel(String(item.cell))) : null)
  const location = text(item.location)
  const label = [sku, where, location, field ? fieldLabel(field) : null].filter(Boolean).join(' · ') || 'Change'
  const lineCurrency = text(item.currency) ?? currency
  const isMoney = !!text(item.currency) || (field ? MONEY_FIELD.test(field) : false)
  let from: string | null
  let to: string | null
  if (text(item.fromLabel) || text(item.toLabel)) {
    // The Matrix renders its own values (`€105.00 → €99.75`, `Follow 403 → Pinned 10`).
    from = text(item.fromLabel)
    to = text(item.toLabel)
  } else if ('fromCents' in item || 'toCents' in item) {
    from = adMoney(item.fromCents, lineCurrency)
    to = adMoney(item.toCents, lineCurrency)
  } else {
    from = side(item, 'from', isMoney ? lineCurrency : false)
    to = side(item, 'to', isMoney ? lineCurrency : false)
  }
  return { sku, name: text(item.name), change: { label, from, to } }
}

/** How many more lines the request covers than the preview kept. */
function moreOf(p: Rec): number {
  return num(p.moreChanges) ?? num(p.moreProducts) ?? num(p.moreLines) ?? num(p.moreSent) ?? 0
}

/** The convention's lines: a `changes` map or list, else nothing. */
function genericLines(p: Rec, currency: string | null): { changes: QueueChange[]; items: ResolvedRequest['items'] } {
  if (Array.isArray(p.changes)) {
    const lines = recs(p.changes).map((item) => listLine(item, currency))
    return { changes: lines.map((l) => l.change), items: lines.filter((l) => l.sku).map(({ sku, name, change }) => ({ sku, name, change })) }
  }
  const map = rec(p.changes)
  if (map) return { changes: mapLines(map, currency, { language: languageName(p.language) }), items: [] }
  return { changes: [], items: [] }
}

/* ── ADS AUTONOMY W1-4: a change of the ads strategy ─────────────────────────────────────────── */

/** The strategy's columns that hold money, in cents of the market's currency (apps/api ads-strategy/fields.ts). */
const STRATEGY_MONEY_COLUMNS = new Set(['monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'negateMinSpendCents', 'stopBidCents'])

/**
 * set-ads-strategy — each setting from → to in words, money in the market's currency (Amazon's checked limits table;
 * a market it does not know shows cents, never a guessed currency), a group as one line, the scope as its target. The
 * preview's labels carry their unit ("Highest bid (cents)"), which the amounts now say themselves.
 */
function strategyPart(p: Rec): Part {
  const scope = rec(p.scope)
  const market = marketOf(scope?.market)
  const currency = marketLimitsOf(market)?.currency ?? null
  const cents = (value: unknown) => (num(value) === null ? EMPTY : currency ? adMoney(value, currency) ?? EMPTY : `${num(value)} cents`)
  const show = (field: string, value: unknown): string => {
    if (value === null || value === undefined) return 'not set'
    const v = rec(value)
    if (STRATEGY_MONEY_COLUMNS.has(field)) return cents(value)
    if (field === 'target' && v) return `${v.targetKind === 'TACOS' ? 'TACoS' : 'ACoS'} ${plainValue(v.targetPct)}%`
    if (field === 'harvest' && v) return `${plainValue(v.harvestMinOrders)} orders, ${plainValue(v.harvestMinClicks)} clicks, ${num(v.harvestMaxAcosPct) === null ? 'any ACoS' : `ACoS at most ${v.harvestMaxAcosPct}%`}, ${plainValue(v.harvestWindowDays)} days`
    if (field === 'negate' && v) return `${plainValue(v.negateMinClicks)} clicks, ${cents(v.negateMinSpendCents)} spent, at most ${plainValue(v.negateMaxOrders)} orders, ${plainValue(v.negateWindowDays)} days`
    if (field === 'stop' && v) return v.stopMethod === 'PAUSE' ? 'pause' : `low bids at ${num(v.stopBidCents) === null ? 'the 2-cent floor' : cents(v.stopBidCents)}`
    if (field === 'maxChangePct' || field === 'targetAcosPct') return `${plainValue(value)}%`
    if (field === 'protect' || field === 'protectedTerms') return value === true ? 'protected' : 'not protected'
    return plainValue(value)
  }
  const changes = recs(p.changes).map((c): QueueChange => {
    const field = text(c.field) ?? ''
    const label = text(c.campaign)
      ? `Own target ACoS · ${text(c.campaign)}`
      : text(c.term) ? `Protected term “${text(c.term)}”` : (text(c.label) ?? fieldLabel(field)).replace(/\s\((cents|%|actions|days)\)$/, '')
    return { label, from: show(field, c.from), to: show(field, c.to) }
  })
  const label = text(scope?.label)
  const said = text(p.summary)
  return {
    channel: 'AMAZON',
    market,
    changes,
    ...(said ? { summary: said.replace(/\s\((cents|%|actions|days)\)/g, '') } : {}),
    ...(label ? { target: target('other', { name: `Ads strategy · ${label}`, href: `/marketing/ads/rules-automation/control-room?tab=strategy${market ? `&market=${seg(market)}` : ''}` }) } : {}),
  }
}

/** ADS PLAYBOOK PB-3 — a playbook change: each row field or section, from → to, the money in the market's currency. */
function playbookPart(p: Rec): Part {
  const t = rec(p.target)
  const market = marketOf(t?.market)
  const currency = marketLimitsOf(market)?.currency ?? null
  const money = new Set(['dailyBudgetCents', 'baseBidCents'])
  const show = (field: string, value: unknown): string => {
    if (value === null || value === undefined) return 'not set'
    if (money.has(field)) return num(value) === null ? EMPTY : currency ? adMoney(value, currency) ?? EMPTY : `${num(value)} cents`
    if (field === 'enrolled') return value === true ? 'enrolled' : 'not enrolled'
    if (typeof value === 'object') return 'set'
    return plainValue(value)
  }
  const changes = recs(p.changes).map((c): QueueChange => ({ label: text(c.label) ?? text(c.field) ?? 'Change', from: show(text(c.field) ?? '', c.from), to: show(text(c.field) ?? '', c.to) }))
  const label = text(t?.label) ?? (text(t?.name) ? `Template ${text(t?.name)}` : null)
  const said = text(p.summary)
  return {
    channel: 'AMAZON',
    market,
    changes,
    ...(said ? { summary: said } : {}),
    ...(label ? { target: target('other', { name: `Ads playbook · ${label}`, href: `/marketing/ads/rules-automation/control-room${market ? `?market=${seg(market)}` : ''}` }) } : {}),
  }
}

/* ── per tool: what the convention does not say ──────────────────────────────────────────────── */

type Part = Partial<ResolvedRequest>
type Reader = (p: Rec, a: Rec, ctx: TargetContext, toolName: string) => Part

const MASTER_PRICE_TOOLS = new Set(['set-price', 'bulk-price-change', 'set-master-prices', 'schedule-price-change', 'set-tier-prices', 'set-price-bounds'])

/** A bulk change keyed `<sku> <field>` (bulk-price-change, set-master-prices, bulk-attribute-change). */
function skuKeyedLines(changes: Rec, suffix: string | null, currency: string | null | false): ResolvedRequest['items'] {
  const items: ResolvedRequest['items'] = []
  for (const [key, raw] of Object.entries(changes)) {
    const ch = rec(raw)
    if (!ch) continue
    let sku: string | null
    let field: string
    if (suffix && key.endsWith(` ${suffix}`)) {
      sku = key.slice(0, -suffix.length - 1)
      field = suffix
    } else {
      const at = key.lastIndexOf(' ')
      sku = at > 0 ? key.slice(0, at) : null
      field = at > 0 ? key.slice(at + 1) : key
    }
    items.push({ sku, name: null, change: { label: fieldLabel(field), from: side(ch, 'from', currency), to: side(ch, 'to', currency) } })
  }
  return items
}

const withSku = (items: ResolvedRequest['items']): QueueChange[] =>
  items.map((i) => ({ ...i.change!, label: i.sku ? `${i.sku} · ${i.change!.label}` : i.change!.label }))

const adCampaign = (p: Rec, toolName: string): Part => {
  const campaign = rec(p.campaign)
  return {
    channel: EBAY_AD_TOOLS.has(toolName) ? 'EBAY' : 'AMAZON',
    market: marketOf(campaign?.marketplace),
  }
}

const READERS: Record<string, Reader> = {
  /* Prices of the master record, in the master currency. */
  'bulk-price-change': (p, _a, ctx) => {
    const currency = text(rec(p.change)?.currency) ?? ctx.masterCurrency
    const items = skuKeyedLines(rec(p.changes) ?? {}, 'base price', currency)
    const totals = rec(p.totals) ?? {}
    const first = items[0]?.sku ?? null
    return {
      changes: withSku(items),
      items,
      changeCount: num(totals.changing) ?? items.length + moreOf(p),
      ...(first ? { target: productTarget({ sku: first }, num(totals.products) ?? items.length, ctx) } : {}),
    }
  },
  'bulk-attribute-change': (p) => {
    const items = skuKeyedLines(rec(p.changes) ?? {}, null, false)
    return { changes: withSku(items), items, changeCount: num(rec(p.totals)?.changes) ?? items.length + moreOf(p) }
  },

  /* The Matrix: listing price and stock per channel and market (VerbChange: fromLabel/toLabel). */
  'set-listing-stock': (p, _a, ctx) => matrixPart(p, ctx),
  'set-listing-price': (p, _a, ctx) => matrixPart(p, ctx),
  'revert-listing-change': (p) => matrixWhere(p),
  /* The stock sync of many listings: one line per listing (or Amazon EU group, or shared eBay variant). */
  'bulk-listing-stock': (p, _a, ctx) => {
    const cells = recs(p.cells)
    const skus = distinct(cells.map((c) => text(c.sku)).filter((s): s is string => s !== null))
    // An Amazon EU group reads "EU (DE, FR)": its market is a group, not a code, so it is named as written.
    const wheres = cells.map((c) => [channelOf(c.channel) ? CHANNEL_WORDS[channelOf(c.channel)!] : null, text(c.market)].filter(Boolean).join(' ') || null)
    const manyWheres = distinct(wheres).length > 1
    const items = cells.map((c, i) => ({
      sku: text(c.sku),
      name: null,
      change: {
        label: [skus.length > 1 ? text(c.sku) : null, manyWheres ? wheres[i] : null, c.kind === 'shared variant' ? 'Shared variant stock sync' : 'Stock sync'].filter(Boolean).join(' · '),
        from: text(c.from),
        to: text(c.to),
      },
    }))
    const totals = rec(p.totals) ?? {}
    const rows = (num(totals.listings) ?? 0) + (num(totals.sharedVariants) ?? 0)
    const first = skus[0] ?? null
    const channel = agreed(cells.map((c) => channelOf(c.channel)))
    return {
      channel,
      // An EU group is a market too: it agrees with no single code.
      market: marketOf(agreed(cells.map((c) => text(c.market)?.toUpperCase() ?? null))),
      changes: items.map((i) => i.change),
      items,
      changeCount: rows || cells.length + (num(p.moreCells) ?? 0),
      ...(first
        ? { target: target('listing', { sku: first, name: ctx.products?.get(first)?.name ?? null, count: rows || cells.length, href: listingHref(channel, first) }) }
        : {}),
    }
  },

  /* Publishing: what is sent (the channel's value now → Nexus's), to which channel and market. */
  'publish-listing': (p) => {
    const dest = rec(p.destination)
    const send = recs(p.send)
    const skus = distinct(send.map((s) => text(s.sku)))
    const lines = send.map((s) => ({
      sku: text(s.sku),
      name: null,
      change: {
        label: `${skus.length > 1 && text(s.sku) ? `${text(s.sku)} · ` : ''}${text(s.label) ?? fieldLabel(text(s.field) ?? 'field')}`,
        from: text(s.channel) ?? EMPTY,
        to: text(s.nexus) ?? EMPTY,
      },
    }))
    return {
      channel: channelOf(dest?.channel),
      market: marketOf(dest?.marketplace ?? dest?.market),
      changes: lines.map((l) => l.change),
      items: lines,
      changeCount: num(p.sendCount) ?? lines.length,
    }
  },
  'create-draft-listings': (p, _a, ctx) => {
    const dest = rec(p.destination)
    const create = recs(p.create)
    const where = whereWords(channelOf(dest?.channel), marketOf(dest?.market ?? dest?.marketplace))
    const items = create.map((c) => ({ sku: text(c.sku), name: null, change: { label: text(c.sku) ?? 'Listing', from: null, to: `Draft listing${where ? ` on ${where}` : ''}` } }))
    return {
      channel: channelOf(dest?.channel),
      market: marketOf(dest?.market ?? dest?.marketplace),
      changes: items.map((i) => i.change),
      items,
      changeCount: create.length,
      ...(text(p.sku) ? { target: productTarget({ sku: text(p.sku) }, Math.max(create.length, 1), ctx) } : {}),
    }
  },
  'remove-draft-listings': (p) => listingRows(recs(p.remove), () => ({ from: 'Draft listing', to: 'Removed' })),
  'close-listing': (p) => listingRows(recs(p.listings), (row) => ({ from: null, to: row.does === 'skip' ? 'Already paused' : 'Paused' })),
  'reopen-listing': (p) => listingRows(recs(p.listings), (row) => ({ from: null, to: row.does === 'skip' ? 'Already on sale' : 'Resumed' })),
  'set-listing-fields': (p) => {
    const dest = rec(p.destination)
    return { channel: channelOf(dest?.channel), market: marketOf(dest?.market ?? dest?.marketplace) }
  },

  /* Amazon ads: names and amounts in the campaign's currency (the web card's describe()). */
  'set-ads-strategy': (p) => strategyPart(p),
  'set-ads-playbook': (p) => playbookPart(p),
  'set-target-bid': (p, _a, _ctx, tool) => {
    const from = adMoney(p.currentBidCents, p.currency)
    const to = adMoney(num(p.effectiveBidCents) ?? p.proposedBidCents, p.currency)
    return { ...adCampaign(p, tool), changes: from || to ? [{ label: 'Bid', from, to }] : [] }
  },
  'create-negative-keyword': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: text(p.term)
      ? [{ label: `Negative keyword${text(p.matchType) ? ` (${String(p.matchType).replace(/^NEGATIVE_/, '').toLowerCase()})` : ''}`, from: null, to: `“${text(p.term)}”` }]
      : [],
  }),
  'graduate-keyword': (p, _a, _ctx, tool) => {
    const destination = rec(p.destination)
    const bid = adMoney(p.suggestedBidCents, p.currency)
    return {
      ...adCampaign(p, tool),
      market: marketOf(destination?.marketplace) ?? marketOf(rec(p.campaign)?.marketplace),
      changes: text(p.query) ? [{ label: 'New exact keyword', from: null, to: `“${text(p.query)}”${bid ? ` at ${bid}` : ''}` }] : [],
      ...(text(destination?.name)
        ? { target: target('campaign', { id: text(destination?.id), name: `${text(destination?.name)}${text(rec(p.destinationAdGroup)?.name) ? ` › ${text(rec(p.destinationAdGroup)?.name)}` : ''}`, href: campaignHref(tool, text(destination?.id)) }) }
        : {}),
    }
  },
  'set-campaign-budget': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: [{ label: 'Daily budget', from: adMoney(p.currentBudgetCents, p.currency), to: adMoney(p.proposedBudgetCents, p.currency) }],
  }),
  'set-ebay-campaign-budget': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: [{ label: 'Daily budget', from: adMoney(p.currentBudgetCents, p.currency), to: adMoney(p.proposedBudgetCents, p.currency) }],
  }),
  'set-placement-multipliers': (p, _a, _ctx, tool) => {
    const names: Record<string, string> = { topOfSearchPct: 'Top of search', productPagesPct: 'Product pages', restOfSearchPct: 'Rest of search' }
    const current = rec(p.current) ?? {}
    const proposed = rec(p.proposed) ?? {}
    const changes: QueueChange[] = []
    for (const [key, label] of Object.entries(names)) {
      const from = num(current[key]) ?? 0
      const to = num(proposed[key]) ?? 0
      if (from !== to) changes.push({ label: `${label} adjustment`, from: `${from}%`, to: `${to}%` })
    }
    return { ...adCampaign(p, tool), changes }
  },
  'bulk-ad-bid-change': (p, _a, _ctx, tool) => {
    const lines = recs(p.changes).map((c) => ({
      sku: null,
      name: text(c.text),
      change: { label: `“${text(c.text) ?? '?'}”${text(c.campaignName) ? ` · ${text(c.campaignName)}` : ''}`, from: adMoney(c.fromCents, c.currency), to: adMoney(c.toCents, c.currency) },
    }))
    const changing = num(rec(p.totals)?.changing)
    const first = recs(p.changes)[0]
    return {
      ...adCampaign(p, tool),
      market: agreed(recs(p.changes).map((c) => marketOf(c.marketplace))) ?? marketOf(rec(p.campaign)?.marketplace),
      changes: lines.map((l) => l.change),
      items: lines,
      changeCount: changing ?? lines.length + moreOf(p),
      target: target('ad-target', { id: text(first?.targetId), name: text(first?.text) ? `“${text(first?.text)}”` : null, count: changing ?? lines.length }),
    }
  },
  'suppress-campaign': (p, _a, _ctx, tool) => {
    const moves = rec(p.moves) ?? {}
    return {
      ...adCampaign(p, tool),
      changes: [{ label: 'Bids', from: `${plainValue(moves.targets)} targets, ${plainValue(moves.adGroups)} ad group defaults`, to: 'the 2-cent floor (never paused)' }],
    }
  },
  'restore-campaign': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: recs(p.bids).map((b) => ({ label: `“${text(b.text) ?? '?'}”`, from: adMoney(b.fromCents, p.currency), to: adMoney(b.toCents, p.currency) })),
    changeCount: (num(rec(p.restores)?.targets) ?? 0) + (num(rec(p.restores)?.adGroups) ?? 0) || recs(p.bids).length,
  }),
  'set-campaign-live-writes': (p, _a, _ctx, tool) => {
    const live = rec(p.liveWrites) ?? {}
    const word = (on: unknown) => (on ? 'On the live-write allowlist' : 'Off the allowlist')
    return { ...adCampaign(p, tool), changes: [{ label: 'Live writes', from: word(live.from), to: word(live.to) }] }
  },
  'create-ad-campaign': (p) => {
    const plan = rec(p.plan) ?? {}
    const products = recs(plan.products)
    return {
      channel: 'AMAZON',
      market: marketOf(plan.market),
      changes: [
        { label: 'Daily budget', from: null, to: adMoney(plan.dailyBudgetCents, plan.currency) },
        { label: 'Advertises', from: null, to: plural(products.length, 'product') },
      ],
    }
  },
  // PB-5a — a build's campaigns and their daily budget, or an adopt's bindings (Nexus only).
  'apply-ads-playbook': (p) => {
    if (p.op === 'adopt') {
      return {
        channel: 'AMAZON',
        market: marketOf(p.market),
        changes: [
          ...recs(p.bindings).map((b) => ({ label: `Slot ${plainValue(b.slot)}`, from: null, to: `“${text(b.name) ?? '?'}”` })),
          ...recs(p.unbinds).map((u) => ({ label: `Slot ${plainValue(u.slot)}`, from: 'Adopted', to: 'Not linked' })),
        ],
      }
    }
    // PB-10 — a sync: what it adds, part by part (it never removes anything).
    if (p.op === 'sync' || p.op === 'sync-negatives') {
      const t = (p.totals ?? {}) as Record<string, unknown>
      const line = (label: string, n: unknown, what: string) => (num(n) ? [{ label, from: null, to: `${plural(num(n)!, what)}` }] : [])
      return {
        channel: 'AMAZON',
        market: marketOf(p.market),
        changes: [
          ...line('Negatives', t.negatives, 'negative'),
          ...line('Keywords and targets', t.positives, 'keyword or target at the 2-cent floor'),
          ...line('Product ads', t.productAds, 'product ad'),
          ...line('Slots built', t.slots, 'campaign at the 2-cent floor, off the allowlist'),
          ...line('Compiled parts', t.artifacts, 'part saved again in Nexus'),
        ],
      }
    }
    const campaigns = recs(p.campaigns)
    return {
      channel: 'AMAZON',
      market: marketOf(p.market),
      changes: [
        { label: 'Builds', from: null, to: `${plural(campaigns.length, 'campaign')} at the 2-cent floor, off the allowlist` },
        { label: 'Daily budget', from: null, to: adMoney(p.dailyBudgetCents, p.currency) },
      ],
    }
  },
  'set-ebay-ad-rates': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: recs(p.changes).map((c) => ({ label: `Ad rate · item ${plainValue(c.itemId)}`, from: num(c.fromPct) === null ? EMPTY : `${c.fromPct}%`, to: num(c.toPct) === null ? null : `${c.toPct}%` })),
  }),
  'promote-ebay-listings': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: recs(p.adds).map((x) => ({ label: `Item ${plainValue(x.itemId)}${text(x.sku) ? ` (${text(x.sku)})` : ''}`, from: null, to: num(x.ratePct) === null ? 'Promoted' : `Promoted at ${x.ratePct}%` })),
  }),
  'ebay-keywords-change': (p, _a, _ctx, tool) => ({
    ...adCampaign(p, tool),
    changes: [
      ...recs(p.bidChanges).map((b) => ({ label: `“${text(b.text) ?? '?'}” ${String(b.matchType ?? '').toLowerCase()}`.trim(), from: adMoney(b.fromCents, p.currency), to: adMoney(b.toCents, p.currency) })),
      ...recs(p.adds).map((x) => ({ label: `New “${text(x.text) ?? '?'}” ${String(x.matchType ?? '').toLowerCase()}`.trim(), from: null, to: adMoney(x.bidCents, p.currency) })),
      ...recs(p.negatives).map((n) => ({ label: 'Negative keyword', from: null, to: `“${text(n.text) ?? '?'}”` })),
    ],
  }),
  'create-ebay-campaign': (p) => {
    const plan = rec(p.plan) ?? {}
    return {
      channel: 'EBAY',
      market: marketOf(plan.market),
      changes: [plan.fundingModel === 'COST_PER_CLICK'
        ? { label: 'Daily budget', from: null, to: adMoney(plan.dailyBudgetCents, plan.currency) }
        : { label: 'Ad rate', from: null, to: `${plainValue(plan.ratePct)}%, no listings yet` }],
    }
  },

  /* A buyer, an order: the message, the refund, the cancel. */
  'send-customer-message': (p) => {
    const order = rec(p.order) ?? {}
    const subject = text(p.subject)
    const body = text(p.body)
    return {
      channel: channelOf(order.channel),
      market: marketOf(order.marketplace),
      changes: [
        ...(subject ? [{ label: 'Message', from: null, to: subject }] : []),
        ...(body ? [{ label: 'Text', from: null, to: body }] : []),
      ],
    }
  },
  'issue-refund': (p) => {
    const order = rec(p.order) ?? {}
    const refund = rec(p.refund) ?? {}
    const amount = num(refund.amount)
    return {
      channel: channelOf(order.channel),
      market: marketOf(order.marketplace),
      changes: amount === null ? [] : [{ label: 'Refund', from: null, to: money(amount, text(refund.currencyCode)) }],
    }
  },
  'cancel-order': (p) => {
    const order = rec(p.order) ?? {}
    return {
      channel: channelOf(order.channel),
      market: marketOf(order.marketplace),
      changes: [{ label: 'Status', from: text(order.status), to: 'CANCELLED' }],
    }
  },

  /* Stock rows name a location, not a market; the product count is the products named. */
  'set-stock': (p, a, ctx) => {
    const ids = distinct(recs(a.items).map((i) => text(i.productId)).filter((s): s is string => s !== null))
    const first = recs(p.changes)[0]
    return {
      changeCount: num(rec(p.totals)?.rows) ?? recs(p.changes).length + moreOf(p),
      ...(ids.length || first ? { target: productTarget({ id: ids[0] ?? null, sku: text(first?.sku), name: text(first?.name) }, Math.max(ids.length, 1), ctx) } : {}),
    }
  },

  /* A change plan: one line per kind of change (its steps are read by the caller). */
  [PLAN_TOOL]: (p) => {
    const kinds = recs(p.kinds)
    const title = text(p.title)
    const summary = text(p.summary)
    return {
      changes: kinds.map((k) => ({ label: text(k.title) ?? text(k.tool) ?? 'Change', from: null, to: plural(num(k.count) ?? 0, 'change') })),
      // One line per kind, so the grid's "+N more" counts kinds, never steps (the step count is QueueRow.plan.steps).
      changeCount: kinds.length,
      summary: title && summary ? `${title} — ${summary}` : (title ?? summary),
      target: null,
      channel: null,
      market: null,
      // Every kind in it changes Nexus's own record, or never leaves Nexus: the plan is made in Nexus.
      nexusRecord: kinds.length > 0 && kinds.every((k) => NEXUS_RECORD_TOOLS.has(text(k.tool) ?? '') || k.outbound === false),
    }
  },
}
READERS['set-master-prices'] = READERS['bulk-price-change']

const MATRIX_TOOLS = new Set(['set-listing-stock', 'set-listing-price'])

/** Channel and market of a Matrix request: the one every cell agrees on, else null. */
function matrixWhere(p: Rec): Part {
  const coordinates = recs(p.changes).map((c) => coordinateOf(c.coordinateKey))
  return {
    channel: agreed(coordinates.map((c) => c.channel)),
    market: agreed(coordinates.map((c) => c.market)),
  }
}

/** A Matrix sale (`{ value, start, end }`) in words: the amount (no currency is stored with it) and its dates. */
function saleWords(value: unknown): string {
  const sale = rec(value)
  const amount = num(sale?.value)
  if (amount === null) return 'No sale'
  const day = (v: unknown) => text(v)?.slice(0, 10) ?? null
  const dates = [day(sale?.start) ? `from ${day(sale?.start)}` : null, day(sale?.end) ? `until ${day(sale?.end)}` : null].filter(Boolean).join(' ')
  return `${money(amount, null)}${dates ? ` (${dates})` : ''}`
}

/**
 * The Matrix (set-listing-stock, set-listing-price): one line per cell. The request is about the LISTING's own SKU (a
 * variation), not the family's parent the preview also names; the SKU and the market have their own places (Product,
 * Where), so a line repeats them only when the request spans several: "Quantity: Follow 403 → Pinned 10".
 */
function matrixPart(p: Rec, ctx: TargetContext): Part {
  const rows = recs(p.changes)
  const coordinates = rows.map((c) => coordinateOf(c.coordinateKey))
  const skus = distinct(rows.map((r) => text(r.sku)).filter((s): s is string => s !== null))
  const wheres = coordinates.map((c) => whereWords(c.channel, c.market))
  const manyWheres = distinct(wheres).length > 1
  const sale = p.verb === 'sale'
  const items = rows.map((row, i) => {
    const cell = text(row.cell)
    const field = cell ? (MATRIX_CELLS[cell] ?? fieldLabel(cell)) : sale ? 'Sale price' : 'Change'
    const value = (key: 'from' | 'to'): string | null => {
      const shown = text(row[`${key}Label`])
      // The Matrix's own words ("Buffer 2", "Pinned 10"): they stay whole, because the grid drops a lone line's label.
      if (shown) return shown
      if (sale) return saleWords(row[key])
      return side(row, key, false)
    }
    return {
      sku: text(row.sku),
      name: null,
      change: { label: [skus.length > 1 ? text(row.sku) : null, manyWheres ? wheres[i] : null, field].filter(Boolean).join(' · '), from: value('from'), to: value('to') },
    }
  })
  const first = rows[0]
  return {
    ...matrixWhere(p),
    ...(rows.length ? { changes: items.map((i) => i.change), items, changeCount: rows.length } : {}),
    ...(text(first?.sku) ? { target: productTarget({ id: text(first?.rowId), sku: text(first?.sku) }, Math.max(skus.length, 1), ctx) } : {}),
  }
}

function listingRows(rows: Rec[], words: (row: Rec) => { from: string | null; to: string | null }): Part {
  const lines = rows.map((row) => ({
    sku: text(row.sku),
    name: null,
    change: { label: [text(row.sku), whereWords(channelOf(row.channel), marketOf(row.market ?? row.marketplace))].filter(Boolean).join(' · ') || 'Listing', ...words(row) },
  }))
  return {
    channel: agreed(rows.map((r) => channelOf(r.channel))),
    market: agreed(rows.map((r) => marketOf(r.market ?? r.marketplace))),
    changes: lines.map((l) => l.change),
    items: lines,
    changeCount: rows.length,
  }
}

/** Channel and market from the convention and the arguments, when the tool's own reader did not say. */
function genericWhere(toolName: string, a: Rec, p: Rec): { channel: string | null; market: string | null } {
  const dest = rec(p.destination)
  const order = rec(p.order)
  const campaign = rec(p.campaign)
  const lines = [...recs(p.changes), ...recs(p.listings)]
  const coordinates = lines.map((l) => (text(l.coordinateKey) ? coordinateOf(l.coordinateKey) : { channel: channelOf(l.channel), market: marketOf(l.market ?? l.marketplace) }))
  const channel = channelOf(a.channel) ?? channelOf(dest?.channel) ?? channelOf(order?.channel)
    ?? (EBAY_AD_TOOLS.has(toolName) ? 'EBAY' : AMAZON_AD_TOOLS.has(toolName) ? 'AMAZON' : null)
    ?? agreed(coordinates.map((c) => c.channel))
  const market = marketOf(a.marketplace) ?? marketOf(a.market) ?? marketOf(dest?.marketplace ?? dest?.market)
    ?? marketOf(order?.marketplace) ?? marketOf(campaign?.marketplace) ?? agreed(coordinates.map((c) => c.market))
  return { channel, market }
}

/**
 * Everything the grid shows of one request, from its arguments and the preview this viewer may see (null when the
 * viewer may not see it: then only the ids of the arguments name the target, and there are no change lines).
 */
export function resolveRequest(toolName: string, args: unknown, preview: unknown, ctx: TargetContext): ResolvedRequest {
  const a = rec(args) ?? {}
  const p = rec(preview) ?? {}
  const currency = MASTER_PRICE_TOOLS.has(toolName) ? ctx.masterCurrency : text(p.currency) ?? text(p.currencyCode) ?? null
  const own = rec(preview) ? (READERS[toolName]?.(p, a, ctx, toolName) ?? {}) : {}
  const generic = own.changes ? { changes: own.changes, items: own.items ?? [] } : genericLines(p, currency)
  const changes = generic.changes
  const items = own.items ?? generic.items
  const where = genericWhere(toolName, a, p)
  const said = own.summary !== undefined ? own.summary : (text(p.summary) ?? text(p.effect))
  // 4A + 3A (Owner decided 2026-10-06) — a request past his own limits says so on the card BEFORE he approves: his
  // approval is his "Send anyway". First, so the 400-character card summary never cuts it off.
  const pastReach = rec(p.reach)?.pastOwnLimits
  const past = Array.isArray(pastReach) ? pastReach.map((l) => text(rec(l)?.reason)).filter((x): x is string => !!x) : []
  const warning = past.length ? `Warning — this goes past your own limits: ${past.join('; ')}. Approving it sends it anyway.` : null
  const summary = warning ? (said ? `${warning} ${said}` : warning) : said
  return {
    target: own.target !== undefined ? own.target : genericTarget(toolName, a, p, ctx),
    channel: own.channel !== undefined ? own.channel ?? where.channel : where.channel,
    market: own.market !== undefined ? own.market ?? where.market : where.market,
    changes,
    changeCount: Math.max(own.changeCount ?? changes.length + moreOf(p), changes.length),
    summary: summary ?? null,
    items: items.slice(0, 50),
    nexusRecord: own.nexusRecord ?? NEXUS_RECORD_TOOLS.has(toolName),
  }
}

/**
 * One step of a change plan in the words of a single request (the drawer's step list): its first change lines from the
 * same resolver, so a step reads "Base price: €154.00 → €149.00" as the grid's row does. No preview, no lines.
 */
export function stepChangesOf(toolName: string, preview: unknown, ctx: TargetContext): { changes: QueueChange[]; changeCount: number } {
  if (!rec(preview)) return { changes: [], changeCount: 0 }
  const out = resolveRequest(toolName, {}, preview, ctx)
  return { changes: out.changes.slice(0, 3), changeCount: out.changeCount }
}

/** The tools this file reads beyond the convention (for the report and the tests). */
export const TOOLS_WITH_OWN_READER: readonly string[] = Object.keys(READERS)
