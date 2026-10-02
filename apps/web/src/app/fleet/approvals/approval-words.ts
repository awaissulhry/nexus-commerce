/**
 * MCP.12 — what the Approvals page SAYS about a request, kept apart from how it is drawn so a test can hold it.
 *
 * A local end-to-end run (2026-09-30, a copy of the development data, requests queued by Claude over MCP) found three
 * sentences on this page that were not true for the bulk tools:
 *
 *   · the Apply button named only the FIRST product of a 3-product price change
 *     ("Apply — <first SKU> base price €100.00 → €105.00");
 *   · the card showed the master prices and nothing of what each marketplace would get, although the preview carries
 *     it (one line per listing, "eBay IT: 90.00 → 105.00", and the listings that keep their own price);
 *   · the section heading said "3 requests can actually change something on Amazon" for an eBay price change and a
 *     change that touches Nexus only.
 */
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'

export interface Delta {
  field: string
  from: string | null
  to: string
}

type Preview = Record<string, unknown> | null | undefined

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const money = (value: number, currency: unknown) =>
  currency === 'EUR' || currency == null ? `€${value.toFixed(2)}` : `${String(currency)} ${value.toFixed(2)}`

/**
 * C2 — the requests whose preview is a bulk price preview: a bulk price change, and setting each product to its own
 * price (what Undo of a bulk price change asks for). Same totals, same listing lines, same "and N more".
 */
const PRICE_PREVIEWS = new Set(['bulk-price-change', 'set-master-prices'])

/** What a bulk price change does to each price, as one phrase: "+5 %", "−€2.50", "set to €99.00", "set one by one". */
function priceMove(change: Record<string, unknown> | undefined): string | null {
  if (change?.operation === 'each') return 'set one by one'
  const value = num(change?.value)
  if (value == null) return null
  const sign = value > 0 ? '+' : '−'
  if (change?.operation === 'percent') return `${sign}${Math.abs(value)} %`
  if (change?.operation === 'amount') return `${sign}${money(Math.abs(value), change?.currency)}`
  if (change?.operation === 'set') return `set to ${money(value, change?.currency)}`
  return null
}

/* ── Section 03 · content changes ─────────────────────────────────────────────────────────────────── */

/**
 * The requests whose preview is a content change (MCP full control, section 03): per field from → to, and the English
 * meaning Claude wrote for the person who approves it. The approval is the review of the text (the Owner's d8), and the
 * operators read English, so the meaning sits beside every new text, never behind a click.
 */
export const CONTENT_PREVIEWS = new Set(['set-content', 'set-listing-content', 'bulk-content-change', 'set-shopify-content'])

/** A text value as the card shows it: a list stays a list, nothing set is a word. */
export type ContentValue = string | string[]
export const NOT_SET = '(empty)'

export interface ContentRow {
  key: string
  /** The product's SKU, when the request covers several products. */
  product: string | null
  field: string
  now: ContentValue
  next: ContentValue
  /** What the new text says in English, as Claude wrote it; null when none was needed (English, or a reset). */
  english: string | null
  /** A sentence about the row: the text shown now is another language's, the field goes back to the shared text. */
  note: string | null
}

export interface ContentDiff {
  /** "German", from the preview's language code. */
  language: string | null
  rows: ContentRow[]
  /** Rows the preview counted but did not keep. */
  more: number
  /** Per field: the listings that show the text, and those that keep their own. */
  reach: string[]
  /** The glossary's avoid words found in the new text. */
  glossary: string[]
  /** The product writer's warnings (a text over a channel's limit). */
  warnings: string[]
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', description: 'Description', bulletPoints: 'Bullet points', keywords: 'Search keywords',
}
export const contentFieldLabel = (field: string) =>
  FIELD_LABELS[field] ?? `${field.replace(/[_-]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase())}`

export function languageName(code: unknown): string | null {
  if (typeof code !== 'string' || !code) return null
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function contentValue(value: unknown): ContentValue {
  if (Array.isArray(value)) {
    const items = value.filter((item) => item != null && item !== '').map(String)
    return items.length ? items : NOT_SET
  }
  if (value == null || value === '') return NOT_SET
  return typeof value === 'string' ? value : JSON.stringify(value)
}

type ContentChange = {
  from?: unknown; to?: unknown; fromLanguage?: unknown; fromParent?: unknown; reset?: unknown; thenShows?: unknown
  thenShowsLanguage?: unknown; englishMeaning?: unknown; kind?: unknown; sku?: unknown; field?: unknown
}

function contentRow(key: string, product: string | null, field: string, c: ContentChange, language: string | null): ContentRow {
  const fallback = languageName(c.fromLanguage)
  const notes: string[] = []
  if (fallback && language) notes.push(`There is no ${language} text yet: it shows the ${fallback} text now.`)
  else if (c.fromParent === true) notes.push('It shows the parent product\'s text now.')
  let next = contentValue(c.to)
  if (c.reset === true) {
    next = contentValue(c.thenShows)
    const then = languageName(c.thenShowsLanguage)
    notes.push(language ? `Drops the ${language} text${then ? `: it shows the ${then} text again` : ''}.` : 'Drops this text.')
  } else if (c.kind === 'follow') {
    notes.push(`This listing stops keeping its own text and shows the shared${language ? ` ${language}` : ''} text again.`)
  } else if (c.kind === 'pin') {
    notes.push('This listing keeps its own text; the shared text and the other listings do not change.')
  }
  const english = typeof c.englishMeaning === 'string' && c.englishMeaning.trim() ? c.englishMeaning : null
  return { key, product, field: contentFieldLabel(field), now: contentValue(c.from), next, english, note: notes.length ? notes.join(' ') : null }
}

const listedNames = (names: string[], more: number) =>
  `${names.join(', ')}${more ? ` and ${plural(more, 'more listing')}` : ''}`

function reachLines(reach: unknown, language: string | null): string[] {
  if (!reach || typeof reach !== 'object' || Array.isArray(reach)) return []
  const r = reach as Record<string, unknown>
  // A bulk preview counts listings for the whole request.
  if (typeof r.listingsFollowing === 'number' || typeof r.listingsWithOwnText === 'number') {
    const follow = num(r.listingsFollowing) ?? 0
    const own = num(r.listingsWithOwnText) ?? 0
    return [`${plural(follow, 'listing')} ${follow === 1 ? 'shows' : 'show'} the new text; ${plural(own, 'listing')} ${own === 1 ? 'keeps its' : 'keep their'} own text.`]
  }
  const lines: string[] = []
  for (const [field, value] of Object.entries(r)) {
    if (!value || typeof value !== 'object') continue
    const v = value as { follow?: unknown; ownPin?: unknown; moreFollow?: unknown; moreOwnPin?: unknown }
    const follow = Array.isArray(v.follow) ? v.follow.filter((x): x is string => typeof x === 'string') : []
    const own = Array.isArray(v.ownPin) ? v.ownPin.filter((x): x is string => typeof x === 'string') : []
    const moreFollow = num(v.moreFollow) ?? 0
    const moreOwn = num(v.moreOwnPin) ?? 0
    const parts = [
      follow.length ? `shown on ${listedNames(follow, moreFollow)}` : `no listing${language ? ` in ${language}` : ''} shows it yet`,
      own.length ? `kept as their own text on ${listedNames(own, moreOwn)}, which do not change` : '',
    ].filter(Boolean)
    lines.push(`${contentFieldLabel(field)}: ${parts.join('; ')}.`)
  }
  return lines
}

/** The content diff of a request, or null when it is not a content change. */
export function contentDiffOf(toolName: string, preview: Preview): ContentDiff | null {
  if (!CONTENT_PREVIEWS.has(toolName)) return null
  const p = (preview ?? {}) as Record<string, unknown>
  const language = languageName(p.language)
  const rows: ContentRow[] = []
  if (Array.isArray(p.changes)) {
    for (const [i, c] of (p.changes as ContentChange[]).entries()) {
      if (!c || typeof c !== 'object' || typeof c.field !== 'string') continue
      rows.push(contentRow(`${i}`, typeof c.sku === 'string' ? c.sku : null, c.field, c, language))
    }
  } else if (p.changes && typeof p.changes === 'object') {
    for (const [field, c] of Object.entries(p.changes as Record<string, ContentChange>)) {
      if (c && typeof c === 'object') rows.push(contentRow(field, null, field, c, language))
    }
  }
  const glossary = Array.isArray(p.glossaryHits)
    ? (p.glossaryHits as Array<Record<string, unknown>>).map((hit) =>
        `${typeof hit.sku === 'string' ? `${hit.sku} ` : ''}${contentFieldLabel(String(hit.field ?? ''))} uses “${String(hit.avoid)}”: the glossary says “${String(hit.use)}”${typeof hit.context === 'string' && hit.context ? ` (${hit.context})` : ''}.`)
    : []
  const warnings = Array.isArray(p.warnings) ? (p.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : []
  return { language, rows, more: num(p.moreChanges) ?? 0, reach: reachLines(p.reach, language), glossary, warnings }
}

/** The Apply label of a content change: what changes, in which language, on how many products. */
function contentApproveLabel(toolName: string, preview: Preview): string | null {
  const diff = contentDiffOf(toolName, preview)
  if (!diff || !diff.rows.length) return null
  const fields = [...new Set(diff.rows.map((row) => row.field.toLowerCase()))]
  const what = `${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` and ${fields.length - 3} more` : ''}`
  const p = (preview ?? {}) as Record<string, any>
  const products = num(p.totals?.products)
  const where = (toolName === 'set-listing-content' || toolName === 'set-shopify-content') && typeof p.listing === 'string' ? ` on ${p.listing}` : ''
  return `Apply — ${what}${diff.language ? ` in ${diff.language}` : ''}${where}${products && products > 1 ? ` on ${plural(products, 'product')}` : ''}`
}

/**
 * The primary button's label. One change keeps the wording the card has always used ("Apply — bid €0.31 → €0.84");
 * more than one says what the WHOLE request does, never only its first line.
 */
export function approveLabelFor(toolName: string, deltas: Delta[], preview: Preview, fallback: string): string {
  // A content change names its fields and language: a whole description does not fit on a button.
  if (CONTENT_PREVIEWS.has(toolName)) return contentApproveLabel(toolName, preview) ?? fallback
  if (deltas.length === 0) return fallback
  if (toolName === 'create-ebay-campaign') {
    // MCP full control A15 — one new eBay campaign: its name and how it starts.
    const plan = ((preview ?? {}) as Record<string, any>).plan ?? {}
    const cents = num(plan.dailyBudgetCents)
    const start = plan.fundingModel === 'COST_PER_CLICK' && cents != null
      ? `${plan.currency && plan.currency !== 'EUR' ? `${plan.currency} ${(cents / 100).toFixed(2)}` : `€${(cents / 100).toFixed(2)}`} a day`
      : `at ${num(plan.ratePct) ?? 2}%, no listings`
    return `Create “${typeof plan.name === 'string' ? plan.name : 'the campaign'}” — ${start}`
  }
  if (toolName === 'create-ad-campaign') {
    // MCP full control A11 — one new campaign, not "4 changes": its name and budget, in its own currency.
    const plan = ((preview ?? {}) as Record<string, any>).plan ?? {}
    const cents = num(plan.dailyBudgetCents)
    const money = cents == null ? null : plan.currency && plan.currency !== 'EUR' ? `${plan.currency} ${(cents / 100).toFixed(2)}` : `€${(cents / 100).toFixed(2)}`
    return `Create “${typeof plan.name === 'string' ? plan.name : 'the campaign'}”${money ? ` — ${money} a day, bids at the floor` : ''}`
  }
  if (deltas.length === 1) {
    const [d] = deltas
    return d.from ? `Apply — ${d.field} ${d.from} → ${d.to}` : `Apply — ${d.field}: ${d.to}`
  }
  const p = (preview ?? {}) as Record<string, any>
  if (PRICE_PREVIEWS.has(toolName)) {
    const products = num(p.totals?.changing) ?? deltas.length
    const move = priceMove(p.change)
    return `Apply — base price ${move ? `${move} ` : ''}on ${plural(products, 'product')}`
  }
  if (toolName === 'bulk-attribute-change') {
    const products = num(p.totals?.products) ?? deltas.length
    const attributes = Array.isArray(p.attributes) ? (p.attributes as Array<{ attribute?: unknown; value?: unknown }>) : []
    if (attributes.length === 1 && typeof attributes[0].attribute === 'string') {
      const value = attributes[0].value
      const shown = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
      return `Apply — ${attributes[0].attribute}${shown != null ? `: ${shown}` : ''} on ${plural(products, 'product')}`
    }
    return `Apply — ${plural(attributes.length || deltas.length, 'attribute')} on ${plural(products, 'product')}`
  }
  // Any other request with several changes (apply-content's title and description): the count and what they are.
  const fields = deltas.map((d) => d.field)
  return `Apply — ${deltas.length} changes: ${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` and ${fields.length - 3} more` : ''}`
}

/**
 * How many more lines the request covers than the card lists: a bulk preview keeps 20 lines and counts the rest
 * (`moreProducts`, `moreChanges`), so the card must say "and N more" or it contradicts its own button.
 */
export function moreThanShown(toolName: string, preview: Preview): string | null {
  const p = (preview ?? {}) as Record<string, unknown>
  if (PRICE_PREVIEWS.has(toolName)) {
    const n = num(p.moreProducts)
    return n ? `and ${plural(n, 'more product')}` : null
  }
  if (toolName === 'bulk-attribute-change' || toolName === 'bulk-content-change') {
    const n = num(p.moreChanges)
    return n ? `and ${plural(n, 'more change')}` : null
  }
  return null
}

export interface ChannelEffect {
  /** "SKU · eBay IT: 90.00 → 105.00", as the tool wrote them, at most the 20 it keeps. */
  lines: string[]
  /** Listing lines the preview counted but did not keep. */
  more: number
  /** One clause per non-zero count: "3 listings are sent to their marketplace", "6 keep their own price". */
  counts: string[]
}

/**
 * What each channel gets from a bulk price change, from its preview: the listing lines and the counts the master price
 * service will act on. Null for a request whose preview carries no listing effect.
 */
export function channelEffectOf(toolName: string, preview: Preview): ChannelEffect | null {
  if (!PRICE_PREVIEWS.has(toolName)) return null
  const p = (preview ?? {}) as Record<string, any>
  const t = (p.totals ?? {}) as Record<string, unknown>
  const lines = Array.isArray(p.listings) ? (p.listings as unknown[]).filter((l): l is string => typeof l === 'string') : []
  const count = (key: string) => num(t[key]) ?? 0
  const sent = count('listingsSent')
  const counts = [
    sent ? `${plural(sent, 'listing')} ${sent === 1 ? 'is' : 'are'} sent to ${sent === 1 ? 'its' : 'their'} marketplace` : 'no listing is sent to a marketplace',
    count('listingsPaused') ? `${plural(count('listingsPaused'), 'paused listing')} ${count('listingsPaused') === 1 ? 'takes' : 'take'} the new price but ${count('listingsPaused') === 1 ? 'is' : 'are'} not sent` : '',
    count('listingsWithOwnPrice') ? `${plural(count('listingsWithOwnPrice'), 'listing')} ${count('listingsWithOwnPrice') === 1 ? 'keeps its' : 'keep their'} own price` : '',
    count('listingsOtherCurrency') ? `${plural(count('listingsOtherCurrency'), 'listing')} in another currency ${count('listingsOtherCurrency') === 1 ? 'is' : 'are'} not sent` : '',
    count('listingsAlreadyAtPrice') ? `${plural(count('listingsAlreadyAtPrice'), 'listing')} ${count('listingsAlreadyAtPrice') === 1 ? 'is' : 'are'} already at the new price` : '',
  ].filter(Boolean)
  return { lines, more: num(p.moreListings) ?? 0, counts }
}

/** A request in the outside queue, as far as the heading needs it: its tool, and the registry's openWorld (C9). */
export interface OutsideRequest {
  toolName: string
  openWorld?: boolean | null
}

/**
 * The heading of the section of requests that can run. "N requests can actually change something on Amazon" was
 * wrong twice: the channel can be any of them, and a Nexus-only request reaches none.
 */
export function outsideHeading(requests: Array<string | OutsideRequest>): string {
  const n = requests.length
  const nexusOnly = requests.filter((request) => {
    const { toolName, openWorld } = typeof request === 'string' ? { toolName: request, openWorld: undefined } : request
    // The card's own word stands (set-shopify-content reads the store live but writes the Nexus draft only); a tool
    // with no card lands where the registry's openWorld says; not stated reads as reaching a channel.
    return toolCardFor(toolName).nexusOnly === true || openWorld === false
  }).length
  const reach = n - nexusOnly
  if (nexusOnly === 0) return `${plural(n, 'request')} can change something on your sales channels`
  if (reach === 0) return n === 1 ? '1 request can change Nexus — it does not reach a sales channel' : `${n} requests can change Nexus — none of them reaches a sales channel`
  return `${plural(n, 'request')} can change something — ${reach} on your sales channels, ${nexusOnly} in Nexus only`
}

/** MCP.12 — whether a person can ask for a change in Claude here: MCP on for this business, and its live connections. */
export interface ClaudeDoor {
  enabled: boolean
  connections: number
}

/**
 * The empty queue named only the two scheduled checks as the things that could put a request here. A person asking
 * in Claude, over their Nexus connection, is the third; this says whether that door is open, from the API's answer.
 */
export function claudeDoorSentence(door: ClaudeDoor): string {
  if (!door.enabled) return 'Connecting Claude is switched off for this business, so nothing can arrive from Claude.'
  if (door.connections === 0) {
    return 'People can also ask for a change in Claude over a Nexus connection; no one has connected Claude to this business yet.'
  }
  return `People can also ask for a change in Claude over a Nexus connection; ${plural(door.connections, 'connection')} to this business ${door.connections === 1 ? 'is' : 'are'} live, and each request waits here for a person.`
}

/* ── C9 · the generic card: a change tool with no card of its own ─────── */

/**
 * A value in words, never raw JSON: a list joins its first three items ("IT, DE", "a, b, c and 2 more"), a flat
 * object reads "key: value, …", anything deeper is counted ("a: 1 field"). The card shows only what this returns.
 */
export function plainValue(value: unknown, depth = 0): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    // A short list of plain values reads as itself, inside an object too; a list of objects is counted.
    const flat = value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))
    if (depth > 1 || (depth > 0 && !flat)) return plural(value.length, 'item')
    const shown = value.slice(0, 3).map((item) => plainValue(item, depth + 1))
    return `${shown.join(', ')}${value.length > 3 ? ` and ${value.length - 3} more` : ''}`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '—'
    if (depth > 0) return plural(entries.length, 'field')
    const shown = entries.slice(0, 4).map(([key, item]) => `${key}: ${plainValue(item, depth + 1)}`)
    return `${shown.join(', ')}${entries.length > 4 ? ` and ${entries.length - 4} more` : ''}`
  }
  return '—'
}

/** The one plain line a preview gives of what the change does: its `summary` (the convention), else its `effect`. */
export function previewSummary(preview: Preview): string | null {
  const p = (preview ?? {}) as Record<string, unknown>
  for (const key of ['summary', 'effect']) {
    if (typeof p[key] === 'string' && (p[key] as string).trim()) return (p[key] as string).trim()
  }
  return null
}

/** The preview's counts (`totals`), each named in words: `listingsSent` → "listings sent". Numbers only. */
export function previewTotals(preview: Preview): Array<{ label: string; value: string }> {
  const totals = ((preview ?? {}) as Record<string, unknown>).totals
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return []
  return Object.entries(totals as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => ({ label: key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), value: String(value) }))
}

/**
 * C9 — the product a change is on, from the preview's `sku` and its name (`product` or `productName`, strings only):
 * "Test jacket (SKU TEST-SKU-1)", or whichever of the two it gives. Null when it names no product.
 */
export function productEntityOf(preview: Preview): string | null {
  const p = (preview ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const sku = text(p.sku)
  const name = text(p.product) ?? text(p.productName)
  if (sku && name && name !== sku) return `${name} (SKU ${sku})`
  if (sku) return `SKU ${sku}`
  return name
}

/** The sentences a person must read before approving: `warning` and `warnings` (strings only). */
export function previewWarnings(preview: Preview): string[] {
  const p = (preview ?? {}) as Record<string, unknown>
  const list = [p.warning, ...(Array.isArray(p.warnings) ? p.warnings : [])]
  return list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}
