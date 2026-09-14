import { normalizeLanguage } from './content-language.js'
import type { TransferRow, TransferIssue } from '@nexus/shared/catalog-transfer'
import { detectAmazonTemplate, type AmazonTemplateParse } from '../amazon/template-workbook.js'
import type { ChannelSpec, ChannelFieldSpec } from './channel-specs/types.js'
import { managedChannelField } from './catalog-transfer-plan.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { checkWorkbookSize } from './catalog-source-file.js'
import { TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'

type Destination = { accountId: string; marketplace: string; language: string; existingListingSkus?: Set<string> }
const pathOf = (header: string) => header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.')
const slotOf = (header: string) => [...header.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
const sourceValue = (parsed: AmazonTemplateParse, header: string, value: string) => {
  const aliases = parsed.valueAliases?.[header]
  return aliases && Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value] : value
}

/** Exact Amazon paths and provider dictionaries only; no label guessing or cross-channel promotion. */
export function mapAmazonWorkbook(parsed: AmazonTemplateParse, specs: Map<string, ChannelSpec>, destination: Destination) {
  if (!destination.accountId) throw new Error('Select the Amazon account that owns these listings')
  if (parsed.meta.grammar !== 'v2' || !parsed.meta.marketplace || !parsed.meta.contentLanguageTag) throw new Error('This Amazon workbook has no reliable marketplace/language metadata. Use column mapping with an explicit destination.')
  if (parsed.meta.marketplace !== destination.marketplace) throw new Error(`This workbook belongs to Amazon ${parsed.meta.marketplace}, not ${destination.marketplace}`)
  if (normalizeLanguage(parsed.meta.contentLanguageTag) !== normalizeLanguage(destination.language)) throw new Error('The workbook language does not match the configured destination language')
  const rows: TransferRow[] = [], issues: TransferIssue[] = [], exclusions: SourceExclusion[] = []
  const skuHeader = parsed.headers.find(h => h === 'contribution_sku#1.value')
  const typeHeader = parsed.headers.find(h => h === 'product_type#1.value')
  if (!skuHeader || !typeHeader) throw new Error('Amazon SKU and product-type columns are required')
  for (const [index, record] of parsed.rows.entries()) {
    const row = parsed.rowNumbers?.[index] ?? (parsed.meta.dataStartRow ?? 2) + index, sku = (record[skuHeader] ?? '').trim()
    const issue = (field: string, message: string) => issues.push({ row, sku, field, message: `${parsed.meta.sheet}: ${message}` })
    const exclude = (field: string, message: string) => exclusions.push({ row, sku, field, message: `${parsed.meta.sheet}: ${message}` })
    if (!sku) { issue(skuHeader, 'SKU is required'); continue }
    if (!['replace', 'partial'].includes(record.__action)) { issue('::record_action', 'Delete or unknown listing actions cannot run through a catalog import'); continue }
    const category = record[typeHeader]?.trim().toUpperCase(), spec = specs.get(category)
    if (!spec || spec.absent) { issue(typeHeader, `Refresh the ${destination.marketplace} / ${category} category schema first`); continue }
    const identity = { row, sku, entity: 'Overrides' as const, channel: 'AMAZON', accountId: destination.accountId, marketplace: destination.marketplace, aliasKey: '', locale: '', action: 'SET' as const }
    rows.push({ ...identity, entity: 'Listings', field: 'productType', value: category })
    const identifierType = sourceValue(parsed, 'amzn1.volt.ca.product_id_type', record['amzn1.volt.ca.product_id_type'] ?? '')
    const grouped = new Map<string, { field: ChannelFieldSpec; values: { header: string; path: string[]; value: string; slots: number[] }[] }>()
    for (const header of parsed.headers) {
      const raw = record[header]
      if (!raw?.trim() || header === skuHeader || header === typeHeader) continue
      if (header === '::record_action') { exclude(header, 'Amazon full/partial update is imported as explicit populated attribute changes; omitted cells preserve data. No publication or deletion occurs.'); continue }
      const path = pathOf(header), root = path[0]
      if (managedChannelField({ fieldKey: root })) { exclude(header, 'Managed commercial field: use the dedicated pricing or inventory workflow.'); continue }
      const qualifiers = [...header.matchAll(/\[(marketplace_id|language_tag)=([^\]]+)\]/g)]
      if (qualifiers.some(([, key, value]) => key === 'marketplace_id' ? value !== parsed.meta.primaryMarketplaceId : normalizeLanguage(value) !== normalizeLanguage(parsed.meta.contentLanguageTag!))) {
        issue(header, 'The attribute carries a different marketplace or language from the workbook destination'); continue
      }
      if (['parentage_level', 'child_parent_sku_relationship'].includes(root)) { exclude(header, 'Amazon variation relationship retained as source evidence; shared parentSku is managed on the Products sheet.'); continue }
      if (header === 'amzn1.volt.ca.product_id_value' && identifierType === 'asin') {
        if (!/^[A-Z0-9]{10}$/.test(raw.trim()) || !spec.fields.some(f => f.key === 'merchant_suggested_asin')) issue(header, 'The declared ASIN needs a valid ten-character value and a Merchant Suggested ASIN schema field')
        else rows.push({ ...identity, field: 'merchant_suggested_asin', value: raw.trim() })
        continue
      }
      if (header.startsWith('amzn1.volt.ca.')) { exclude(header, 'Amazon catalog identifier/reference. A declared ASIN is imported as Merchant Suggested ASIN; confirmed remote links are reconciled from Amazon.'); continue }
      const candidates = spec.fields.filter(f => {
        const base = [f.attribute, ...f.path]
        return path.join('.') === base.join('.') || path.join('.') === [...base, 'value'].join('.') || f.shape === 'measure' && path.join('.') === [...base, 'unit'].join('.')
      })
      if (candidates.length !== 1) {
        // Selector-only leaves are generated by the same current schema used for publishing.
        const selector = path[path.length - 1]
        const rootSchema = (spec.validationSchema?.properties as Record<string, any> | undefined)?.[root]
        const selectorSchema = rootSchema?.items?.properties?.[selector]
        const value = sourceValue(parsed, header, raw)
        if (rootSchema?.selectors?.includes(selector) && (selectorSchema?.enum?.includes(value) || selectorSchema?.const === value)) {
          exclude(header, `Validated schema selector ${selector}=${value}; the channel writer supplies it.`)
        } else issue(header, 'This populated attribute has no unambiguous destination in the current schema')
        continue
      }
      const field = candidates[0]
      if (!field.editable && destination.existingListingSkus?.has(sku)) { exclude(header, `The current Amazon schema makes this field read-only on an existing listing. Source reference: ${JSON.stringify(raw)}`); continue }
      if (managedChannelField({ fieldKey: field.key, channelStore: field.channelStore })) { exclude(header, 'Managed commercial field: use the dedicated pricing or inventory workflow.'); continue }
      if (!grouped.has(field.key)) grouped.set(field.key, { field, values: [] })
      grouped.get(field.key)!.values.push({ header, path, value: sourceValue(parsed, header, raw), slots: slotOf(header) })
    }
    for (const { field, values } of grouped.values()) {
      values.sort((a, b) => { for (let i = 0; i < Math.max(a.slots.length, b.slots.length); i++) { const d = (a.slots[i] ?? 1) - (b.slots[i] ?? 1); if (d) return d } return 0 })
      const typed = (value: string): unknown => {
        if (field.kind === 'number') { const number = Number(value); if (!value.trim() || !Number.isFinite(number)) throw new Error('Enter a finite number, using a decimal point'); return number }
        if (field.kind === 'boolean') { if (!['true', 'false'].includes(value.toLowerCase())) throw new Error('No unambiguous boolean translation exists'); return value.toLowerCase() === 'true' }
        return value
      }
      try {
        let value: unknown
        if (field.shape === 'measure') {
          const measures = values.filter(v => v.path.at(-1) === 'value'), units = values.filter(v => v.path.at(-1) === 'unit')
          if (measures.length !== 1 || units.length !== 1 || JSON.stringify(measures[0].slots) !== JSON.stringify(units[0].slots)) throw new Error('A measure needs exactly one value and its matching unit')
          value = { value: typed(measures[0].value), unit: units[0].value }
        } else if (field.shape === 'list') value = values.map(v => typed(v.value))
        else { if (values.length !== 1) throw new Error('Multiple values target a scalar attribute'); value = typed(values[0].value) }
        rows.push({ ...identity, field: field.key, value })
      } catch (e) { issue(field.key, e instanceof Error ? e.message : String(e)) }
    }
    if (rows.length + issues.length + exclusions.length > TRANSFER_MAX_ROWS) throw new Error('Amazon workbook exceeds 50,000 attribute outcomes')
  }
  return { rows, issues, exclusions }
}

export async function readAmazonCatalogWorkbook(buffer: Buffer, accountId: string, marketplace: string, options: { familyId?: string; mode?: string } = {}) {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty Amazon workbook up to 10 MB')
  await checkWorkbookSize(buffer)
  const parsed = await detectAmazonTemplate(buffer, { strict: true })
  if (!parsed) throw new Error('No Amazon template was detected. Use an Amazon-downloaded XLSX/XLSM workbook.')
  const { default: prisma } = await import('../../db.js')
  const market = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace, isActive: true }, select: { language: true } })
  if (!market?.language) throw new Error('Configure the Amazon marketplace language first')
  const { loadAmazonSpec } = await import('./channel-specs/index.js')
  const specs = new Map<string, ChannelSpec>()
  for (const category of parsed.meta.productTypes) specs.set(category, await loadAmazonSpec(marketplace, category))
  const listingRows = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace, channelConnectionId: accountId, aliasKey: '', product: { sku: { in: parsed.rows.map(r => r['contribution_sku#1.value']?.trim()).filter(Boolean) } } }, select: { product: { select: { sku: true } } } })
  const result = mapAmazonWorkbook(parsed, specs, { accountId, marketplace, language: market.language, existingListingSkus: new Set(listingRows.map(l => l.product.sku)) })
  // A native template creates only missing shared products. Existing shared content is never
  // replaced by marketplace copy. Relationships still pass the canonical planner's cycle checks.
  if (options.mode === 'create' || options.mode === 'upsert') {
    const skus = [...new Set(result.rows.map(r => r.sku))]
    const existing = new Set((await prisma.product.findMany({ where: { sku: { in: skus } }, select: { sku: true } })).map(p => p.sku))
    const missing = skus.filter(sku => !existing.has(sku))
    if (missing.length) {
      const family = options.familyId ? await prisma.productFamily.findUnique({ where: { id: options.familyId }, select: { code: true } }) : null
      if (!family) throw new Error('Select a product family before creating new products from an Amazon workbook')
      const parentHeader = parsed.headers.find(h => pathOf(h).join('.') === 'child_parent_sku_relationship.parent_sku')
      for (const sku of missing) {
        const title = result.rows.find(r => r.sku === sku && r.field === 'item_name')
        if (!title) { result.issues.push({ row: 0, sku, field: 'item_name', message: 'A new product needs a verified name in the Amazon workbook' }); continue }
        const record = parsed.rows.find(r => r['contribution_sku#1.value']?.trim() === sku)!
        const base = { row: title.row, sku, entity: 'Products' as const, channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', action: 'SET' as const }
        result.rows.push({ ...base, field: 'family', value: family.code }, { ...base, field: 'name', value: title.value }, { ...base, locale: normalizeLanguage(market.language), field: 'name', value: title.value })
        if (parentHeader && record[parentHeader]?.trim()) result.rows.push({ ...base, field: 'parentSku', value: record[parentHeader].trim() })
      }
    }
  }
  return result
}
