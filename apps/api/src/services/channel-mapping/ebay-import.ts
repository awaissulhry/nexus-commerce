import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { readerMapping, type ReaderMapping } from './decisions.js'
import { buildEbayDraftFields, ebayChannelKeyOf } from './ebay-draft.js'
import { ebayFormOf, formLabel } from './form.js'
import type { ImportMappingInfo } from './amazon-import.js'
import { ensureSetForForm, fieldRowOf } from './store.js'

/**
 * CHMAP M2 — the mapping version our eBay workbook is read with (host side). Without every category's schema the
 * aspect columns cannot be keyed, so no version is made: the file is read with the rules and the reader already
 * refuses those rows ("Refresh this marketplace and category schema").
 */
export async function ebayImportMapping(table: { marketplace: string; sheet: string; headers: readonly string[] }, specs: ReadonlyMap<string, ChannelSpec>):
  Promise<{ mapping: ReaderMapping | null; info: ImportMappingInfo | null; warnings: string[] }> {
  const missing = [...specs].filter(([, spec]) => !spec || spec.absent).map(([category]) => category)
  if (!specs.size || missing.length) return { mapping: null, info: null, warnings: [`No mapping version was used: the eBay ${table.marketplace} schema of ${missing.join(', ') || 'this file’s category'} is not cached yet.`] }
  const channelKeys = table.headers.map(h => ebayChannelKeyOf(h, specs).channelKey)
  const form = ebayFormOf({ marketplace: table.marketplace, sheet: table.sheet, categories: [...specs.keys()], channelKeys })
  const build = () => buildEbayDraftFields(table.headers, specs, table.marketplace)
  const { set, created } = await ensureSetForForm(form, build)
  const fields = set.fields.map(fieldRowOf)
  const label = formLabel(form, set.version, set.status)
  const warnings: string[] = []
  if (created) warnings.push(`${label}: the first file with these columns. Nexus made a new mapping version from its rules; review it on the Mapping page.`)
  else {
    const fresh = new Map(build().map(r => [r.channelKey, r]))
    const stale = fields.filter(f => { const now = fresh.get(f.channelKey); return f.decidedBy === 'rule' && now && (now.state !== f.state || now.targetKind !== f.targetKind || now.targetKey !== f.targetKey) }).map(f => f.channelKey)
    if (stale.length) warnings.push(`${label}: the rules for ${stale.length} column${stale.length === 1 ? '' : 's'} changed since this version was made (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}). The current rules were used; make a new version on the Mapping page to record them.`)
  }
  return { mapping: readerMapping(set, label, fields), info: { setId: set.id, version: set.version, status: set.status, label, created }, warnings }
}
