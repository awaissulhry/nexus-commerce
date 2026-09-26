import { readerMapping, type ReaderMapping } from './decisions.js'
import { buildShopifyDraftFields, shopifyChannelKeyOf } from './shopify-draft.js'
import { formLabel, shopifyFormOf } from './form.js'
import type { ImportMappingInfo } from './amazon-import.js'
import { ensureSetForForm, fieldRowOf } from './store.js'

/**
 * NCF N6 — the mapping version Shopify's product CSV is read with (host side). One form per store; the first file
 * with a new column set makes a DRAFT from the rules (`shopify-draft.ts`), with the Owner's decisions of the store's
 * earlier version laid over it. The store's metafield types are not needed here: the reader types each value.
 */
export async function shopifyImportMapping(table: { headers: readonly string[] }, accountId: string):
  Promise<{ mapping: ReaderMapping; info: ImportMappingInfo; warnings: string[] }> {
  const form = shopifyFormOf({ accountId, channelKeys: table.headers.map(shopifyChannelKeyOf) })
  const build = () => buildShopifyDraftFields(table.headers)
  const { set, created } = await ensureSetForForm(form, build)
  const fields = set.fields.map(fieldRowOf)
  const label = formLabel(form, set.version, set.status)
  const warnings: string[] = []
  if (created) warnings.push(`${label}: the first file with these columns. Nexus made a new mapping version from its rules; review it on the File mappings page.`)
  else {
    const fresh = new Map(build().map(r => [r.channelKey, r]))
    const stale = fields.filter(f => { const now = fresh.get(f.channelKey); return f.decidedBy === 'rule' && now && (now.state !== f.state || now.targetKind !== f.targetKind || now.targetKey !== f.targetKey) }).map(f => f.channelKey)
    if (stale.length) warnings.push(`${label}: the rules for ${stale.length} column${stale.length === 1 ? '' : 's'} changed since this version was made (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}). The current rules were used; make a new version on the File mappings page to record them.`)
  }
  return { mapping: readerMapping(set, label, fields), info: { setId: set.id, version: set.version, status: set.status, label, created }, warnings }
}
