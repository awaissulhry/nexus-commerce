import type { TransferRow } from '@nexus/shared/catalog-transfer'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { CatalogueField } from './mapping/field-catalogue.service.js'
import { contentField, isLocalizableContent, resolveContent, type ContentProduct } from './content-resolver.js'
import { contentListing } from './content-read.js'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'

export interface TransferContentWrite { address: ContentAddress; values: Record<string, unknown>; reset: string[] }
export function channelContentField(field: CatalogueField): string | null {
  for (const key of [field.sheetKey, field.fieldKey, field.channelStore?.kind === 'listingColumn' ? field.channelStore.column : null]) {
    if (key && isLocalizableContent(key)) return contentField(key)
  }
  return null
}
export function transferContentAddress(row: TransferRow, languages: readonly string[] = []): ContentAddress {
  // LX.F F4 — the ORDER matters. `normalizeLanguage('')` throws
  // `Invalid content language: ` (a developer sentence) and it ran BEFORE the check
  // below, so `product_description@amazon:BE:` — a two-language market with no explicit
  // language, the exact case the check exists for — never reached the operator sentence
  // that names the market and its languages. Resolve the candidate first, refuse with
  // the right words, and normalise only a value that survived.
  const requested = row.locale || (row.entity === 'Products' ? PRIMARY_CONTENT_LOCALE : languages.length === 1 ? languages[0] : '')
  if (!requested) throw Object.assign(new Error(`Choose an explicit language available on ${row.channel} · ${row.marketplace}${languages.length ? ` (${languages.join(', ')})` : ''}`), { statusCode: 400 })
  let language: string
  try { language = normalizeLanguage(requested) }
  catch { throw Object.assign(new Error(`Choose an explicit language available on ${row.channel} · ${row.marketplace}${languages.length ? ` (${languages.join(', ')})` : ''}`), { statusCode: 400 }) }
  if (row.entity === 'Products') return language === PRIMARY_CONTENT_LOCALE ? { tier: 'source' } : { tier: 'language', language }
  if (!languages.includes(language)) throw Object.assign(new Error(`Choose an explicit language available on ${row.channel} · ${row.marketplace}${languages.length ? ` (${languages.join(', ')})` : ''}`), { statusCode: 400 })
  return { tier: 'pin', language, coordinate: { channel: row.channel, market: row.marketplace, accountId: row.accountId, ...(row.aliasKey ? { aliasId: row.aliasKey } : {}) } }
}
export function planContentWrite(writes: TransferContentWrite[], address: ContentAddress, field: string, action: TransferRow['action'], value: unknown) {
  let write = writes.find(w => JSON.stringify(w.address) === JSON.stringify(address))
  if (!write) { write = { address, values: {}, reset: [] }; writes.push(write) }
  if (action === 'INHERIT') write.reset.push(contentField(field)); else write.values[contentField(field)] = value
}
export function channelContentState(product: Record<string, any>, listing: Record<string, any>, field: string, language: string, languages: readonly string[]) {
  const coordinate = { channel: listing.channel, market: listing.marketplace, accountId: listing.channelConnectionId, aliasId: listing.aliasKey || null }
  const resolved = resolveContent({ product: product as ContentProduct, parent: product.parent as ContentProduct | null, listing: contentListing(product, listing, coordinate, languages), field, address: { requested: normalizeLanguage(language), coordinate } })
  return resolved.tier === 'pin' && resolved.follows === false ? { state: 'stored' as const, value: resolved.value } : { state: 'inherited' as const, value: null }
}
/** Preview graph mutation only; effective values still come from the single resolver. */
export function projectContentWrites<T extends Record<string, any>>(record: T, writes: TransferContentWrite[]): T {
  const next = JSON.parse(JSON.stringify(record))
  for (const write of writes) {
    let owner = next
    if (write.address.tier !== 'source') {
      next.translations ??= []
      const language = write.address.language
      owner = next.translations.find((r: any) => r.language === language)
      if (!owner) { owner = { language: write.address.language, workspaceId: record.workspaceId, source: 'manual', attributes: {} }; next.translations.push(owner) }
    }
    const bag = write.address.tier === 'source' ? 'categoryAttributes' : 'attributes'
    owner[bag] ??= {}
    for (const [field, value] of Object.entries(write.values)) {
      const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      if (column) owner[column] = value
      owner[bag][field] = value
      if (owner.follows) owner.follows = owner.follows.filter((f: string) => f !== field)
    }
    for (const field of write.reset) {
      const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      if (column) owner[column] = null
      delete owner[bag][field]
      if (write.address.tier === 'pin') owner.follows = [...new Set([...(owner.follows ?? []), field])]
    }
  }
  return next
}
