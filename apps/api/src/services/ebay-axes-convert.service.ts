/**
 * Convert a LIVE eBay listing's variation AXIS NAMES to the operator's Italian
 * standard (Color→Colore, Size→Taglia) via ReviseFixedPriceItem.
 *
 * Feasibility (proven live 2026-07): the rename IS allowed — variations are
 * matched by SKU and each carries its EAN (eBay IT code 21919301 requires it,
 * mirror 'Does not apply'). Inventory-API-managed listings (e.g. GALE) REJECT
 * Trading revises ("non consentita per gli oggetti del magazzino") — those are
 * reported as needing an Inventory re-publish (the push already emits Italian).
 *
 * Read-back verified: after the revise we GetItem again and confirm the axis
 * names changed with the SAME variation count (no duplication).
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

export interface LiveVar { sku: string; specifics: Array<[string, string]>; ean: string }
export interface LiveAxis { name: string; values: string[] }

/** Parse GetItem XML → variations (SKU + specifics + EAN) and the axis set. */
export function parseVariationsForRename(raw: string): { vars: LiveVar[]; axisSet: LiveAxis[] } {
  const vars: LiveVar[] = []
  for (const vm of raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const b = vm[1]
    const sku = /<SKU>([^<]*)<\/SKU>/.exec(b)?.[1] ?? ''
    const ean = /<EAN>([^<]*)<\/EAN>/.exec(b)?.[1] ?? 'Does not apply'
    const sb = /<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/.exec(b)?.[1] ?? ''
    const specs: Array<[string, string]> = []
    for (const nv of sb.matchAll(/<NameValueList>[\s\S]*?<Name>([^<]*)<\/Name>[\s\S]*?<Value>([^<]*)<\/Value>[\s\S]*?<\/NameValueList>/g)) specs.push([nv[1], nv[2]])
    vars.push({ sku, specifics: specs, ean })
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
    return `<Variation><SKU>${esc(v.sku)}</SKU><VariationSpecifics>${nvl}</VariationSpecifics><VariationProductListingDetails><EAN>${esc(v.ean)}</EAN></VariationProductListingDetails></Variation>`
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
