import { channelContentField } from './catalog-transfer-content.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { TRANSFER_CHANNELS, transferCategoryField, transferIsStore, type TransferRow } from '@nexus/shared/catalog-transfer'
import type { SheetColumn } from './sheet-columns.service.js'
import type { CatalogueField } from './mapping/field-catalogue.service.js'
import { MANAGED_FIELDS, managedChannelField, transferContracts } from './catalog-transfer-plan.js'
import { writeCatalogWorkbook, type WorkbookField, type WorkbookScope } from './catalog-workbook.js'
import prisma from '../../db.js'
import { marketLanguages } from './market-languages.js'

export const masterWorkbookField = (c: SheetColumn): WorkbookField => ({ field: c.key, label: c.label, type: c.shape && c.shape !== 'scalar' ? c.shape : c.kind,
  editable: c.editable && !MANAGED_FIELDS.has(c.key), required: c.requiredBy.length ? 'required' : 'optional', options: c.options ?? [], selectionOnly: c.mode === undefined ? undefined : c.mode === 'strict',
  maxLength: c.maxLength, unitOptions: c.unitOptions, help: c.helpText ?? '' })
export const channelWorkbookField = (f: CatalogueField): WorkbookField => ({ field: f.fieldKey, label: f.label, type: f.shape && f.shape !== 'scalar' ? f.shape : f.kind ?? 'text',
  editable: f.editable && !managedChannelField(f), required: f.priority, options: f.options ?? [], help: `${f.helpText ?? ''}${managedChannelField(f) ? ' Managed in the dedicated commercial workflow.' : !f.editable ? ' Authorable on creation; the channel marks this read-only on existing listings.' : ''}`,
  maxLength: f.maxLength, unitOptions: f.unitOptions, selectionOnly: f.selectionOnly })
const content = new Set(['name', 'title', 'description', 'bulletPoints', 'keywords'])
export const relationshipFields: WorkbookField[] = [
  { field: 'family', label: 'Family code', type: 'text', required: 'required for new products' },
  { field: 'parentSku', label: 'Parent SKU', type: 'text', help: 'SET the parent SKU on a child. CLEAR unlinks. Leave blank to preserve. Never derive size from SKU.' },
  { field: 'categoryIds', label: 'Internal category IDs', type: 'list' },
  { field: 'primaryCategoryId', label: 'Primary internal category', type: 'text' },
]
export type WorkbookDestination = { channel: string; accountId: string; marketplace: string; category: string }
const emptyScope = { channel: '', accountId: '', marketplace: '', locale: '', category: '' }
export async function catalogWorkbookTemplate(input: { market: string; familyId: string; locales?: string[]; channels?: WorkbookDestination[] }) {
  if (input.locales !== undefined && (!Array.isArray(input.locales) || input.locales.some(l => typeof l !== 'string')) || input.channels !== undefined && !Array.isArray(input.channels)) throw new Error('Languages and channel destinations must be lists')
  const locales = [...new Set((input.locales ?? []).map(l => normalizeLanguage(l.trim())))]
  if (input.channels?.some(c => !c || typeof c !== 'object' || ['channel', 'accountId', 'marketplace', 'category'].some(k => typeof c[k as keyof WorkbookDestination] !== 'string'))) throw new Error('Each destination needs a channel, account, marketplace and category')
  const channels = (input.channels ?? []).map(c => ({ channel: c.channel.trim().toUpperCase(), accountId: c.accountId.trim(), marketplace: c.marketplace.trim().toUpperCase(), category: c.category.trim() }))
  if (locales.length > 30 || locales.some(l => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(l))) throw new Error('Choose at most 30 valid language codes, such as it, de or en-gb')
  if (channels.length > 30 || channels.some(c => !TRANSFER_CHANNELS.includes(c.channel) || !c.accountId || !/^(?:[A-Z]{2}|GLOBAL)$/.test(c.marketplace) || !transferIsStore(c.channel) && !c.category?.trim())) throw new Error('Each destination needs a supported channel, account, marketplace and category (at most 30)')
  if (new Set(channels.map(c => JSON.stringify([c.channel, c.accountId, c.marketplace, c.category]))).size !== channels.length) throw new Error('This account, marketplace and category is selected more than once. Remove the duplicate destination.')
  const family = await prisma.productFamily.findUnique({ where: { id: input.familyId }, select: { code: true } })
  if (!family) throw new Error('Select a product family')
  const contracts = transferContracts(input.market), cols = await contracts.master(input.familyId)
  const scopes: WorkbookScope[] = [{ ...emptyScope, sheet: 'Products', entity: 'Products', fields: [...relationshipFields, ...cols.filter(c => !c.slot && (c.storage !== 'localizedContent' || content.has(c.key))).map(masterWorkbookField)],
    rows: [{ ...emptyScope, row: 2, entity: 'Products', sku: '', aliasKey: '', field: 'family', action: 'SET', value: family.code }] }]
  const includedLocales = new Set(locales.filter(l => l !== PRIMARY_CONTENT_LOCALE))
  for (const [i, c] of channels.entries()) {
    const [account, market] = await Promise.all([
      prisma.channelConnection.findUnique({ where: { id: c.accountId }, select: { channelType: true, marketplace: true, isActive: true } }),
      prisma.marketplace.findFirst({ where: { channel: c.channel, code: c.marketplace, isActive: true }, select: { language: true } }),
    ])
    if (!account?.isActive || account.channelType !== c.channel || account.marketplace && !['GLOBAL', c.marketplace].includes(account.marketplace) || !market?.language) throw new Error('Choose an active account and configured marketplace that match this destination')
    const languages = await marketLanguages(c.channel, c.marketplace)
    for (const language of languages) if (language !== PRIMARY_CONTENT_LOCALE) includedLocales.add(language)
    const contract = await contracts.channel(c.channel, c.marketplace, c.category)
    const categoryKey = transferCategoryField(c.channel)
    scopes.push({ ...c, locale: '', sheet: `${c.channel} ${c.marketplace} ${i + 1}`, entity: 'Overrides',
      fields: [{ field: categoryKey, label: 'Channel category', type: c.channel === 'ETSY' ? 'number' : 'text', required: c.channel === 'SHOPIFY' ? 'optional' : 'required' }, ...contract.fields.filter(f => f.fieldKey !== categoryKey && !channelContentField(f)).map(f => ({ ...channelWorkbookField(f), schemaVersion: contract.schemaVersion, help: `${channelWorkbookField(f).help} ${contract.fetchedAt ? `Schema retrieved ${contract.fetchedAt}.` : `Field definition ${contract.schemaVersion ?? 'unversioned'}.`}` }))],
      rows: [{ ...c, locale: '', row: 2, entity: 'Listings', sku: '', aliasKey: '', field: categoryKey, action: c.category ? 'SET' : '' as TransferRow['action'], value: c.category ? c.channel === 'ETSY' ? Number(c.category) : c.category : undefined }] })
    for (const locale of languages) scopes.push({ ...c, locale, sheet: `${c.channel} ${c.marketplace} ${locale} ${i + 1}`, entity: 'Overrides', fields: contract.fields.filter(f => channelContentField(f)).map(channelWorkbookField), rows: [] })
  }
  if (includedLocales.size > 30) throw new Error('Choose at most 30 languages, including the languages of your listing marketplaces')
  scopes.splice(1, 0, ...[...includedLocales].map(locale => ({ ...emptyScope, sheet: `Content ${locale}`, entity: 'Products' as const, locale,
    fields: cols.filter(c => !c.slot && (content.has(c.key) || c.storage === 'localizedContent')).map(masterWorkbookField), rows: [] })))
  return writeCatalogWorkbook(scopes)
}

/** Export grouping includes every account, marketplace, category and language; never merges those axes. */
export function workbookScopesForRows(rows: TransferRow[], fieldsForRow: (row: TransferRow) => WorkbookField[], categoryForRow: (row: TransferRow) => string): WorkbookScope[] {
  const scopes = new Map<string, WorkbookScope>()
  const seenFields = new Map<string, Set<WorkbookField[]>>()
  for (const row of rows) {
    const category = row.entity === 'Products' ? '' : categoryForRow(row)
    const key = JSON.stringify([row.entity === 'Products' ? 'Products' : 'Overrides', row.channel, row.accountId, row.marketplace, row.locale, category])
    let scope = scopes.get(key)
    if (!scope) {
      scope = { ...emptyScope, sheet: row.entity === 'Products' ? row.locale ? `Content ${row.locale}` : 'Products' : `${row.channel} ${row.marketplace}${row.locale ? ` ${row.locale}` : ''} ${scopes.size + 1}`,
        entity: row.entity === 'Products' ? 'Products' : 'Overrides', channel: row.channel, accountId: row.accountId, marketplace: row.marketplace, locale: row.locale, category, fields: [], rows: [] }
      scopes.set(key, scope)
      seenFields.set(key, new Set())
    }
    scope.rows.push(row)
    const fields = fieldsForRow(row)
    if (!seenFields.get(key)!.has(fields)) {
      const known = new Set(scope.fields.map(f => f.field))
      for (const field of fields) if (!known.has(field.field)) { scope.fields.push(field); known.add(field.field) }
      seenFields.get(key)!.add(fields)
    }
  }
  return [...scopes.values()]
}
