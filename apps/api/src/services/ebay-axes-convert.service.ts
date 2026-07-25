/**
 * Convert a LIVE eBay listing's variation AXIS NAMES to the operator's Italian
 * standard (Color→Colore, Size→Taglia) via ReviseFixedPriceItem.
 *
 * ⚠️ PROVEN LIVE 2026-07-25: an in-place axis rename is IMPOSSIBLE on a Trading
 * listing. eBay identifies each variation BY its VariationSpecifics, so changing
 * Color→Colore makes every variation unmatchable: eBay treats them as NEW
 * variations, collides with the existing SKUs, and rejects the whole call with
 * code 21916664 ("Le specifiche delle varianti fornite non corrispondono … |
 * Etichetta personalizzata della variante duplicata"). The revise is ATOMIC —
 * read-back confirmed the listing was left byte-identical — but renaming on the
 * Trading lane would require ending + relisting (losing the ItemID, watchers and
 * sales history). Do not retry it blindly.
 *
 * Two obstacles were cleared on the way and are still REQUIRED for any variation
 * revise: per-variation EAN (code 21919301) and per-variation StartPrice +
 * Quantity (code 73 — a <Variation> is a full definition, not a patch; omitting
 * them makes eBay read 0 and reject). Both are echoed from the LIVE listing, so
 * a revise can never move money or stock.
 *
 * WHAT DOES WORK: Inventory-API-managed listings reject Trading revises outright
 * ("non consentita per gli oggetti del magazzino") and are reported as
 * `inventory-managed`; their axis names are set wholesale by re-publishing the
 * group, which now emits the market's own names.
 */
import { callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** Map a live axis name to the operator's Italian standard; unknown → unchanged. */
export function italianAxisName(name: string): string {
  const l = name.trim().toLowerCase()
  if (l === 'color' || l === 'colour') return 'Colore'
  if (l === 'size') return 'Taglia'
  return name
}

export interface LiveVar {
  sku: string
  specifics: Array<[string, string]>
  ean: string
  /** eBay rejects a variation revise that omits price/qty (code 73: "price is
   *  invalid or below the minimum … quantity must be greater than 0") — a
   *  <Variation> node is a full definition, not a patch. Echo the LIVE values
   *  back unchanged so a rename never moves a price or a stock level. */
  startPrice: string
  quantity: string
}
export interface LiveAxis { name: string; values: string[] }

/** Parse GetItem XML → variations (SKU + specifics + EAN) and the axis set. */
export function parseVariationsForRename(raw: string): { vars: LiveVar[]; axisSet: LiveAxis[] } {
  const vars: LiveVar[] = []
  for (const vm of raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const b = vm[1]
    const sku = /<SKU>([^<]*)<\/SKU>/.exec(b)?.[1] ?? ''
    const ean = /<EAN>([^<]*)<\/EAN>/.exec(b)?.[1] ?? 'Does not apply'
    const startPrice = /<StartPrice[^>]*>([^<]*)<\/StartPrice>/.exec(b)?.[1] ?? ''
    const quantity = /<Quantity>([^<]*)<\/Quantity>/.exec(b)?.[1] ?? ''
    const sb = /<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/.exec(b)?.[1] ?? ''
    const specs: Array<[string, string]> = []
    for (const nv of sb.matchAll(/<NameValueList>[\s\S]*?<Name>([^<]*)<\/Name>[\s\S]*?<Value>([^<]*)<\/Value>[\s\S]*?<\/NameValueList>/g)) specs.push([nv[1], nv[2]])
    vars.push({ sku, specifics: specs, ean, startPrice, quantity })
  }
  const setB = /<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(raw)?.[1] ?? ''
  const axisSet: LiveAxis[] = []
  for (const nv of setB.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) {
    const name = /<Name>([^<]*)<\/Name>/.exec(nv[1])?.[1] ?? ''
    const values = [...nv[1].matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1])
    if (name) axisSet.push({ name, values })
  }
  return { vars, axisSet }
}

/** Pure builder — the ReviseFixedPriceItem XML that renames axes to Italian,
 *  matching by SKU and carrying each variation's EAN. */
export function buildAxisRenameReviseXml(itemId: string, vars: LiveVar[], axisSet: LiveAxis[]): string {
  const newSet = axisSet.map((a) => `<NameValueList><Name>${esc(italianAxisName(a.name))}</Name>${a.values.map((v) => `<Value>${esc(v)}</Value>`).join('')}</NameValueList>`).join('')
  const newVars = vars.map((v) => {
    const nvl = v.specifics.map(([n, val]) => `<NameValueList><Name>${esc(italianAxisName(n))}</Name><Value>${esc(val)}</Value></NameValueList>`).join('')
    // Price + quantity are echoed from the LIVE listing, unchanged — a
    // <Variation> is a full definition, so omitting them made eBay read 0 and
    // reject the whole revise (code 73). This rename must never move money or
    // stock; if eBay somehow returned neither, the field is omitted rather than
    // guessed (better a clear eBay error than a fabricated price).
    const price = v.startPrice ? `<StartPrice>${esc(v.startPrice)}</StartPrice>` : ''
    const qty = v.quantity ? `<Quantity>${esc(v.quantity)}</Quantity>` : ''
    return `<Variation><SKU>${esc(v.sku)}</SKU>${price}${qty}<VariationSpecifics>${nvl}</VariationSpecifics><VariationProductListingDetails><EAN>${esc(v.ean)}</EAN></VariationProductListingDetails></Variation>`
  }).join('')
  return `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${esc(itemId)}</ItemID><Variations><VariationSpecificsSet>${newSet}</VariationSpecificsSet>${newVars}</Variations></Item></ReviseFixedPriceItemRequest>`
}

export interface ConvertAxesResult {
  itemId: string
  outcome: 'converted' | 'already-italian' | 'inventory-managed' | 'no-sku' | 'failed'
  renames: Array<{ from: string; to: string }>
  before?: string[]
  after?: string[]
  variationsBefore?: number
  variationsAfter?: number
  message?: string
}

const GET_XML = (itemId: string) => `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${esc(itemId)}</ItemID>
  <OutputSelector>Item.Variations.Variation.SKU</OutputSelector>
  <OutputSelector>Item.Variations.Variation.VariationSpecifics</OutputSelector>
  <OutputSelector>Item.Variations.Variation.StartPrice</OutputSelector>
  <OutputSelector>Item.Variations.Variation.Quantity</OutputSelector>
  <OutputSelector>Item.Variations.Variation.VariationProductListingDetails</OutputSelector>
  <OutputSelector>Item.Variations.VariationSpecificsSet</OutputSelector>
</GetItemRequest>`

/** Convert ONE listing's axis names to Italian. Read-only GetItem first; a single
 *  ReviseFixedPriceItem; then a verifying GetItem. Nothing is written to our DB. */
export async function convertListingAxesToItalian(
  itemId: string,
  marketplace: string,
  ctx: { oauthToken: string },
): Promise<ConvertAxesResult> {
  const siteId = siteIdForMarket(marketplace)
  const { vars, axisSet } = parseVariationsForRename((await callTradingApi('GetItem', GET_XML(itemId), { oauthToken: ctx.oauthToken, siteId })).raw)
  const renames = axisSet.map((a) => ({ from: a.name, to: italianAxisName(a.name) })).filter((r) => r.from !== r.to)
  const before = axisSet.map((a) => a.name)
  if (renames.length === 0) return { itemId, outcome: 'already-italian', renames, before }
  if (!vars.every((v) => v.sku !== '')) return { itemId, outcome: 'no-sku', renames, before, message: 'Some variations have no SKU — cannot match safely.' }

  try {
    await callTradingApi('ReviseFixedPriceItem', buildAxisRenameReviseXml(itemId, vars, axisSet), { oauthToken: ctx.oauthToken, siteId })
  } catch (e) {
    const msg = (e as Error).message
    if (/inventory|magazzino|non consentita/i.test(msg)) {
      return { itemId, outcome: 'inventory-managed', renames, before, message: 'Inventory-managed listing — convert by re-publishing via the flat-file/images push (now emits Italian).' }
    }
    return { itemId, outcome: 'failed', renames, before, message: msg }
  }
  const after = parseVariationsForRename((await callTradingApi('GetItem', GET_XML(itemId), { oauthToken: ctx.oauthToken, siteId })).raw)
  return {
    itemId,
    outcome: 'converted',
    renames,
    before,
    after: after.axisSet.map((a) => a.name),
    variationsBefore: vars.length,
    variationsAfter: after.vars.length,
  }
}
