import { channelContentField, channelContentState } from './catalog-transfer-content.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { contentLanguages } from './content-read.js'
import { normalizeLanguage } from './content-language.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { TRANSFER_CHANNELS, transferCategoryField, transferIsStore, type TransferRow, type ProductTransferBoundary } from '@nexus/shared/catalog-transfer'
import { MANAGED_FIELDS, managedChannelField, masterTransferState, transferContracts, type TransferProduct } from './catalog-transfer-plan.js'
import { jsonRecord, storedChannelState } from './channel-value-mutation.js'
import { writeTransferWorkbook } from './catalog-transfer-file.js'
import { writeTransferDownload } from './catalog-transfer-download.js'
import { masterWorkbookField, channelWorkbookField, relationshipFields, workbookScopesForRows } from './catalog-workbook-scopes.js'
import { writeCatalogWorkbook, type WorkbookField } from './catalog-workbook.js'
import { marketLanguages } from './market-languages.js'
import { readinessLanguages } from './readiness-model.js'

const empty = { row: 0, entity: 'Products' as const, sku: '', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: '', action: 'SET' as const }
const contentFields = new Set(['name', 'title', 'description', 'bulletPoints', 'keywords'])

/** Shared destination choices without loading category dictionaries or provider metadata. */
export async function catalogDestinationOptions() {
  const [families, accounts, markets] = await Promise.all([
    prisma.productFamily.findMany({ select: { id: true, code: true, label: true }, orderBy: { label: 'asc' } }),
    Promise.all(TRANSFER_CHANNELS.map(channel => listActiveConnections(channel))).then(accounts => accounts.flat()),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, name: true, language: true, languages: true }, orderBy: { code: 'asc' } }),
  ])
  return { families,
    accounts: accounts.map(a => ({ id: a.id, channelType: a.channelType, marketplace: a.marketplace, accountLabel: a.accountLabel, isPrimary: a.isPrimary, displayName: `${a.accountLabel || a.displayName || a.channelType}${a.isPrimary ? ' · Primary account' : ''} · ${a.id.slice(-6)}` })),
    markets: markets.filter(m => TRANSFER_CHANNELS.includes(m.channel) && (m.code === 'GLOBAL' || /^[A-Z]{2}$/.test(m.code))).map(m => ({ ...m, language: marketLanguages(m.channel, m.code, [m])[0] })),
  }
}
/** Language choices use every active market's configured language authority. */
export async function catalogTransferLanguages() {
  const markets = await prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, languages: true, language: true } })
  return { sourceLanguage: PRIMARY_CONTENT_LOCALE, languages: readinessLanguages(markets) }
}

/** Readiness includes all active markets, beyond the transfer destination subset. */
export async function catalogReadinessOptions() {
  const [options, markets] = await Promise.all([catalogDestinationOptions(), prisma.marketplace.findMany({ where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }], select: { channel: true, code: true, name: true } })])
  return { ...options, markets }
}

export async function catalogTransferOptions() {
  const [destinations, categories, channelCategories, categoryLabels] = await Promise.all([
    catalogDestinationOptions(),
    prisma.category.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true, parentId: true }, orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }] }),
    prisma.categorySchema.findMany({ where: { channel: { in: TRANSFER_CHANNELS }, isActive: true }, distinct: ['channel', 'marketplace', 'productType'], select: { channel: true, marketplace: true, productType: true }, orderBy: [{ channel: 'asc' }, { productType: 'asc' }] }),
    prisma.categoryChannelMapping.findMany({ where: { channel: { in: TRANSFER_CHANNELS }, reviewedAt: { not: null }, channelCategoryPath: { not: null } }, select: { channel: true, marketplace: true, channelCategoryId: true, channelCategoryPath: true }, orderBy: { updatedAt: 'desc' } }),
  ])
  const labels = new Map<string, string>()
  for (const label of categoryLabels) {
    const key = JSON.stringify([label.channel, label.marketplace, label.channelCategoryId])
    if (label.channelCategoryPath && !labels.has(key)) labels.set(key, label.channelCategoryPath)
  }
  return { ...destinations, categories, channelCategories: channelCategories.map(c => ({ ...c,
    label: labels.get(JSON.stringify([c.channel, c.marketplace?.replace(/^EBAY_/, ''), c.productType]))
      ?? labels.get(JSON.stringify([c.channel, '*', c.productType])) ?? null,
  })) }
}

export async function catalogTransferTemplate(market: string, familyId: string, channel?: { channel: string; accountId: string; marketplace: string; category: string }) {
  const family = await prisma.productFamily.findUnique({ where: { id: familyId }, select: { code: true } })
  if (!family) throw new Error('Select a product family for the template')
  const contracts = transferContracts(market)
  const cols = await contracts.master(familyId)
  const localizedOnly = cols.some(col => col.storage === 'localizedContent' && !contentFields.has(col.key))
  const templateLocale = localizedOnly ? (await marketLanguages(channel?.channel ?? 'AMAZON', market))[0] : ''
  if (localizedOnly && !templateLocale) throw new Error('Configure a marketplace language before creating this localized template')
  const rows: TransferRow[] = [
    { ...empty, field: 'family', value: family.code },
    { ...empty, field: 'parentSku', action: '' as TransferRow['action'] },
  ]
  const dictionary: Record<string, unknown>[] = [
    { entity: 'Products', field: 'parentSku', label: 'Parent SKU', group: 'Product relationships', type: 'text', editable: true, required: false, options: [],
      help: 'SET the parent SKU on a child. Include a new parent and its children in the same file. Blank action and value preserve the current parent. CLEAR explicitly unlinks. Product role is calculated, never imported as a separate attribute.' },
  ]
  for (const col of cols) {
    dictionary.push({ entity: 'Products', field: col.key, label: col.label, group: col.group, type: col.shape === 'scalar' || !col.shape ? col.kind : col.shape, editable: col.editable && !MANAGED_FIELDS.has(col.key), required: col.requiredBy.length > 0, options: col.options ?? [], help: col.helpText ?? '' })
    if (col.editable && !MANAGED_FIELDS.has(col.key)) rows.push({ ...empty, field: col.key, locale: col.storage === 'localizedContent' && !contentFields.has(col.key) ? templateLocale! : '', action: '' as TransferRow['action'] })
  }
  if (channel) {
    const account = await prisma.channelConnection.findUnique({ where: { id: channel.accountId }, select: { channelType: true, marketplace: true, isActive: true } })
    if (!account || account.isActive === false || account.channelType !== channel.channel || account.marketplace && !['GLOBAL', channel.marketplace].includes(account.marketplace)) throw new Error('Select an active account that matches the channel and marketplace')
    const identity = { ...empty, channel: channel.channel, accountId: channel.accountId, marketplace: channel.marketplace }
    rows.push({ ...identity, entity: 'Listings', field: transferCategoryField(channel.channel), action: channel.category ? 'SET' : '' as TransferRow['action'], value: channel.category ? channel.channel === 'ETSY' ? Number(channel.category) : channel.category : undefined })
    const contract = await contracts.channel(channel.channel, channel.marketplace, channel.category)
    for (const field of contract.fields) {
      if (field.fieldKey === transferCategoryField(channel.channel)) continue
      if (managedChannelField(field)) continue
      dictionary.push({ entity: 'Overrides', field: field.fieldKey, label: field.label, group: field.group, type: field.shape ?? field.kind, editable: field.editable, required: field.priority, options: field.options ?? [], help: field.helpText ?? '' })
      rows.push({ ...identity, entity: 'Overrides', field: field.fieldKey, action: '' as TransferRow['action'] })
    }
  }
  return writeTransferWorkbook(rows, dictionary)
}

type ExportInput = { skus?: string[]; familyId?: string; market: string; marketplaces?: string[]; effective?: boolean; layout?: 'wide' | 'attributes'; boundary?: ProductTransferBoundary; fields?: string[]; workbookWriter?: (scopes: import('./catalog-workbook.js').WorkbookScope[]) => Promise<Buffer> }
const productInclude = { translations: true, categories: { select: { categoryId: true, isPrimary: true } }, parent: { include: { translations: true } } } as const

async function catalogRows(
  products: Prisma.ProductGetPayload<{ include: typeof productInclude }>[],
  input: ExportInput,
  contracts: ReturnType<typeof transferContracts>,
  families: { id: string; code: string }[],
  workbookMeta?: WeakMap<TransferRow, { fields: WorkbookField[]; category: string; note?: string }>,
  languages?: Map<string, string[]>,
) {
  const rows: TransferRow[] = []
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: products.map(p => p.id) }, channel: { in: TRANSFER_CHANNELS }, ...(input.boundary ? { id: { in: input.boundary.listings.map(l => l.id) } } : input.marketplaces ? input.marketplaces.length ? { marketplace: { in: input.marketplaces } } : {} : { marketplace: input.market }) }, include: { translations: true }, orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { aliasKey: 'asc' }] })
  if (!input.effective && (!input.boundary || input.boundary.includeShared)) for (const product of products) {
    const start = rows.length
    const identity = { ...empty, sku: product.sku, version: product.version }
    const allColumns = await contracts.master(product.familyId ?? product.parent?.familyId ?? null, product as unknown as TransferProduct)
    const columns = input.boundary ? allColumns.filter(c => c.editable && !MANAGED_FIELDS.has(c.key)) : allColumns
    const metadata: Record<string, unknown> = { family: families.find(f => f.id === product.familyId)?.code ?? null, parentSku: product.parent?.sku ?? null, categoryIds: product.categories.map(c => c.categoryId).sort(), primaryCategoryId: product.categories.find(c => c.isPrimary)?.categoryId ?? null }
    for (const [field, value] of Object.entries(metadata)) rows.push({ ...identity, field, action: value === null ? 'INHERIT' : 'SET', value: value ?? undefined })
    for (const col of columns) {
      if (col.key === 'sku' || col.slot) continue
      if (col.storage !== 'localizedContent' || contentFields.has(col.key)) {
        const own = masterTransferState(product, col)
        rows.push({ ...identity, field: col.key, action: own.state === 'inherited' ? 'INHERIT' : own.value === null ? 'CLEAR' : 'SET', value: own.value })
      }
      const locales = new Set(input.boundary?.locales ?? [...contentLanguages(product, product.parent), ...listings.filter(l => l.productId === product.id).flatMap(l => languages?.get(JSON.stringify([l.channel, l.marketplace])) ?? [])])
      for (const locale of locales) {
        // Source core fields already have their existing language-neutral row. Explicitly selected languages retain their sheet.
        if (locale === PRIMARY_CONTENT_LOCALE && contentFields.has(col.key)) continue
        if (!contentFields.has(col.key) && col.storage !== 'localizedContent') continue
        const localized = masterTransferState(product, col, normalizeLanguage(locale))
        const present = localized.state === 'stored'
        // R-LX-8: a child whose language text is owned by the parent exports with
        // the TEXT, as `INHERIT` (its ownership), instead of being skipped — an
        // export of the child alone used to drop the family's German title with
        // nothing on the file to show it had ever existed.
        const inheritedText = localized.state === 'inherited' && localized.value !== null && localized.value !== undefined
        if (!present && !inheritedText && !workbookMeta) continue
        rows.push({ ...identity, field: col.key, locale, action: !present ? 'INHERIT' : localized.value === null ? 'CLEAR' : 'SET', value: localized.value })
      }
    }
    if (workbookMeta) {
      const localized = columns.filter(c => !c.slot && (contentFields.has(c.key) || c.storage === 'localizedContent')).map(masterWorkbookField)
      const shared = [...relationshipFields.map(f => input.boundary && f.field === 'parentSku' ? { ...f, editable: false, help: 'Reference only in a product import. Manage parent relationships in the product relationship tools.' } : f), ...columns.filter(c => !c.slot && (c.storage !== 'localizedContent' || contentFields.has(c.key))).map(masterWorkbookField)]
      for (const row of rows.slice(start)) workbookMeta.set(row, { category: '', fields: row.locale ? localized : shared })
    }
  }
  const { resolveCategoriesForProducts } = await import('./mapping/category-mapping.service.js')
  const defaults = new Map<string, Awaited<ReturnType<typeof resolveCategoriesForProducts>>>()
  for (const coordinate of new Set(listings.map(l => JSON.stringify([l.channel, l.marketplace])))) {
    const [channel, marketplace] = JSON.parse(coordinate)
    defaults.set(coordinate, await resolveCategoriesForProducts({ productIds: products.map(p => p.id), channel, marketplace }))
  }
  for (const listing of listings) {
    const start = rows.length
    const sku = products.find(p => p.id === listing.productId)!.sku
    if (!listing.channelConnectionId) throw new Error(`${sku}: a ${listing.channel} listing has no account attribution. Assign its account before exporting an editable listing.`)
    const identity = { ...empty, sku, entity: 'Overrides' as const, channel: listing.channel, accountId: listing.channelConnectionId, marketplace: listing.marketplace, aliasKey: listing.aliasKey, version: listing.version }
    const categoryKey = transferCategoryField(listing.channel)
    const platform = jsonRecord(listing.platformAttributes)
    const hasCategory = Object.prototype.hasOwnProperty.call(platform, categoryKey)
    const storedCategory = platform[categoryKey]
    const category = String((hasCategory && transferIsStore(listing.channel) ? storedCategory : storedCategory ?? defaults.get(JSON.stringify([listing.channel, listing.marketplace]))?.[listing.productId]?.channelCategoryId) ?? '')
    const contract = await contracts.channel(listing.channel, listing.marketplace, category)
    const listingLanguages = languages?.get(JSON.stringify([listing.channel, listing.marketplace])) ?? await marketLanguages(listing.channel, listing.marketplace)
    if (input.effective) {
      const { resolveBatch } = await import('./mapping/resolve-batch.service.js')
      for (const locale of listingLanguages) {
      const result = await resolveBatch({ locale, productIds: [listing.productId], channel: listing.channel, marketplace: listing.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey, productType: category, includeCatalogue: false })
      for (const value of Object.values(result.products[0]?.cells ?? {})) rows.push({ ...identity, locale, field: value.fieldKey, action: 'SET', value: value.value })
      }
    } else {
      rows.push({ ...identity, entity: 'Listings', field: categoryKey, action: storedCategory != null ? 'SET' : hasCategory && transferIsStore(listing.channel) ? 'CLEAR' : 'INHERIT', value: storedCategory ?? undefined })
      for (const field of contract.fields) {
        if (field.fieldKey === categoryKey) continue
        if (input.boundary && managedChannelField(field)) continue
        const textField = channelContentField(field)
        for (const locale of textField ? listingLanguages : ['']) {
          const own = textField ? channelContentState(products.find(p => p.id === listing.productId)!, listing, textField, locale, listingLanguages) : storedChannelState(listing, field.channelStore, [field.fieldKey, field.sheetKey].filter((k): k is string => !!k))
          const value = typeof own.value === 'object' && own.value && 'toNumber' in own.value ? (own.value as { toNumber(): number }).toNumber() : own.value
          rows.push({ ...identity, locale, field: field.fieldKey, action: own.state === 'inherited' ? 'INHERIT' : value === null ? 'CLEAR' : 'SET', value })
        }
      }
    }
    if (workbookMeta) {
      const fields = [{ field: categoryKey, label: 'Channel category', type: listing.channel === 'ETSY' ? 'number' : 'text' }, ...contract.fields.filter(f => f.fieldKey !== categoryKey && (!input.boundary || !managedChannelField(f))).map(f => ({ ...channelWorkbookField(f), schemaVersion: contract.schemaVersion, help: `${channelWorkbookField(f).help} ${contract.fetchedAt ? `Schema retrieved ${contract.fetchedAt}.` : `Field definition ${contract.schemaVersion ?? 'unversioned'}.`}` }))]
      const textFields = new Set(contract.fields.filter(f => channelContentField(f)).map(f => f.fieldKey))
      const facts = fields.filter(f => !textFields.has(f.field)), text = fields.filter(f => textFields.has(f.field))
      for (const row of rows.slice(start)) workbookMeta.set(row, { category, fields: row.locale ? text : facts, note: contract.warning })
    }
  }
  return rows
}


export async function exportCatalogTransfer(input: ExportInput) {
  if (input.marketplaces && (!Array.isArray(input.marketplaces) || input.marketplaces.length > 50 || input.marketplaces.some(m => !/^(?:[A-Z]{2}|GLOBAL)$/.test(m)))) throw new Error('Select valid marketplace codes')
  if (!input.boundary && !input.skus?.length && !input.familyId) throw new Error('Choose a family or specify the SKUs to export')
  const requested = input.skus?.length ? [...new Set(input.skus.map(sku => sku.trim()))] : undefined
  // Capture identities once; fetch full records in bounded pages. A family export has no SKU cap.
  const selection = await prisma.product.findMany({ where: { deletedAt: null,
    ...(input.boundary ? { id: { in: input.boundary.products.map(p => p.id) } } : requested ? { sku: { in: requested } } : { OR: [{ familyId: input.familyId }, { familyId: null, parent: { familyId: input.familyId } }] }),
  }, select: { id: true, sku: true }, orderBy: { sku: 'asc' } })
  if (!selection.length) throw new Error('No products matched this export')
  const selectedSkus = new Set(selection.map(product => product.sku))
  if (requested?.some(sku => !selectedSkus.has(sku))) throw new Error('Some requested SKUs are missing or archived; correct the selection before exporting')
  const contracts = transferContracts(input.market, { allowIncompleteSchema: true })
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true } })
  const workbookMeta = input.layout === 'wide' && !input.effective ? new WeakMap<TransferRow, { fields: WorkbookField[]; category: string; note?: string }>() : undefined
  // Match resolveBatch’s default locale from the same channel-qualified authority.
  const languages = new Map((await prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, language: true, languages: true } })).map(m => [JSON.stringify([m.channel, m.code]), marketLanguages(m.channel, m.code, [m])]))
  async function* productRows() {
    for (let offset = 0; offset < selection.length; offset += 100) {
      const ids = selection.slice(offset, offset + 100).map(product => product.id)
      const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, include: productInclude, orderBy: { sku: 'asc' } })
      if (products.length !== ids.length) throw new Error('The selected catalog changed during export. Download it again to include every product.')
      const rows = await catalogRows(products, input, contracts, families, workbookMeta, languages)
      const bySku = new Map<string, TransferRow[]>()
      for (const row of rows.filter(r => !input.fields || ['family', 'parentSku', 'productType', 'categoryId'].includes(r.field) || input.fields.includes(r.field))) {
        if (!bySku.has(row.sku)) bySku.set(row.sku, [])
        bySku.get(row.sku)!.push(row)
      }
      for (const product of products) yield bySku.get(product.sku) ?? []
    }
  }
  return writeTransferDownload(productRows(), !!input.effective, workbookMeta ? rows => {
    const filtered = new WeakMap<WorkbookField[], WorkbookField[]>()
    const scopes = workbookScopesForRows(rows, row => {
      const fields = workbookMeta.get(row)?.fields ?? []
      if (!input.fields) return fields
      if (!filtered.has(fields)) filtered.set(fields, fields.filter(f => ['family', 'parentSku', 'productType', 'categoryId'].includes(f.field) || input.fields!.includes(f.field)))
      return filtered.get(fields)!
    }, row => workbookMeta.get(row)?.category ?? '')
    for (const scope of scopes) scope.note = workbookMeta.get(scope.rows[0])?.note
    return input.workbookWriter ? input.workbookWriter(scopes) : writeCatalogWorkbook(scopes, !!input.boundary)
  } : undefined, !!input.boundary)
}
