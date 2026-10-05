import { channelContentField, channelContentState } from './catalog-transfer-content.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { contentLanguages, contentWireValue } from './content-read.js'
import { normalizeLanguage } from './content-language.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { TRANSFER_CHANNELS, transferCategoryField, transferIsStore, type TransferRow, type ProductTransferBoundary } from '@nexus/shared/catalog-transfer'
import { MANAGED_FIELDS, isEmptyChannelValue, managedChannelField, masterTransferState, transferContracts, type TransferProduct } from './catalog-transfer-plan.js'
import { jsonRecord, storedChannelState } from './channel-value-mutation.js'
import { writeTransferWorkbook } from './catalog-transfer-file.js'
import { writeTransferDownload } from './catalog-transfer-download.js'
import { masterWorkbookField, channelWorkbookField, relationshipFields, workbookScopesForRows } from './catalog-workbook-scopes.js'
import { writeCatalogWorkbook, type WorkbookField } from './catalog-workbook.js'
import { marketLanguages } from './market-languages.js'
import { readinessLanguages } from './readiness-model.js'
import { ebayListingPhotos, type PhotoFile } from '../images/listing-photos.pure.js'

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
    const contract = await contracts.channel(channel.channel, channel.marketplace, channel.category, channel.accountId)
    for (const field of contract.fields) {
      if (field.fieldKey === transferCategoryField(channel.channel)) continue
      if (managedChannelField(field)) continue
      dictionary.push({ entity: 'Overrides', field: field.fieldKey, label: field.label, group: field.group, type: field.shape ?? field.kind, editable: field.editable, required: field.priority, options: field.options ?? [], help: field.helpText ?? '' })
      rows.push({ ...identity, entity: 'Overrides', field: field.fieldKey, action: '' as TransferRow['action'] })
    }
  }
  return writeTransferWorkbook(rows, dictionary)
}

export type ExportInput = { skus?: string[]; familyId?: string; market: string; marketplaces?: string[]; effective?: boolean; layout?: 'wide' | 'attributes'; boundary?: ProductTransferBoundary; fields?: string[]; workbookWriter?: (scopes: import('./catalog-workbook.js').WorkbookScope[]) => Promise<Buffer>
  /**
   * PSIE — the product sheet's export. Nothing is left out silently: a listing without an account is skipped with a
   * note (instead of stopping the whole export), and a stored listing value the current schema does not declare is
   * exported as a read-only column that says so (instead of being dropped). Each note is pushed onto `notes`.
   */
  sheet?: { notes: string[] } }
export const productInclude = { translations: true, categories: { select: { categoryId: true, isPrimary: true } }, parent: { include: { translations: true } } } as const

/** Exported for AE.3 (services/assortment/copy-source.service.ts): the same rows, read in the lending business. */
export async function catalogRows(
  products: Prisma.ProductGetPayload<{ include: typeof productInclude }>[],
  input: ExportInput,
  contracts: ReturnType<typeof transferContracts>,
  families: { id: string; code: string }[],
  workbookMeta?: WeakMap<TransferRow, { fields: WorkbookField[]; category: string; note?: string }>,
  languages?: Map<string, string[]>,
) {
  const rows: TransferRow[] = []
  const effectiveRows: TransferRow[][] = []
  const effectiveBatches = new Map<string, {
    input: Parameters<typeof import('./mapping/resolve-batch.service.js').resolveBatch>[0]
    outputs: { productId: string; identity: TransferRow; rows: TransferRow[] }[]
  }>()
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
  const ebayPhotos = !input.effective && listings.some(l => l.channel === 'EBAY') ? await ebayPhotoReader(products, listings) : null
  for (const listing of listings) {
    const start = rows.length
    const sku = products.find(p => p.id === listing.productId)!.sku
    if (!listing.channelConnectionId && input.sheet) { input.sheet.notes.push(`${sku}: its ${listing.channel} ${listing.marketplace} listing has no account, so it was left out. Assign the account in the sheet, then export again.`); continue }
    if (!listing.channelConnectionId) throw new Error(`${sku}: a ${listing.channel} listing has no account attribution. Assign its account before exporting an editable listing.`)
    const identity = { ...empty, sku, entity: 'Overrides' as const, channel: listing.channel, accountId: listing.channelConnectionId, marketplace: listing.marketplace, aliasKey: listing.aliasKey, version: listing.version }
    const categoryKey = transferCategoryField(listing.channel)
    const platform = jsonRecord(listing.platformAttributes)
    const hasCategory = Object.prototype.hasOwnProperty.call(platform, categoryKey)
    const storedCategory = platform[categoryKey]
    const category = String((hasCategory && transferIsStore(listing.channel) ? storedCategory : storedCategory ?? defaults.get(JSON.stringify([listing.channel, listing.marketplace]))?.[listing.productId]?.channelCategoryId) ?? '')
    const contract = await contracts.channel(listing.channel, listing.marketplace, category, listing.channelConnectionId)
    const listingLanguages = languages?.get(JSON.stringify([listing.channel, listing.marketplace])) ?? await marketLanguages(listing.channel, listing.marketplace)
    if (input.effective) {
      for (const locale of listingLanguages) {
        const key = JSON.stringify([listing.channel, listing.marketplace, listing.channelConnectionId, listing.aliasKey, category, locale])
        let batch = effectiveBatches.get(key)
        if (!batch) {
          batch = { input: { locale, productIds: [], channel: listing.channel, marketplace: listing.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey, productType: category, includeCatalogue: false }, outputs: [] }
          effectiveBatches.set(key, batch)
        }
        const output: TransferRow[] = []
        effectiveRows.push(output)
        batch.input.productIds.push(listing.productId)
        batch.outputs.push({ productId: listing.productId, identity: { ...identity, locale }, rows: output })
      }
    } else {
      rows.push({ ...identity, entity: 'Listings', field: categoryKey, action: storedCategory != null ? 'SET' : hasCategory && transferIsStore(listing.channel) ? 'CLEAR' : 'INHERIT', value: storedCategory ?? undefined })
      for (const field of contract.fields) {
        if (field.fieldKey === categoryKey) continue
        if (input.boundary && managedChannelField(field)) continue
        const textField = channelContentField(field, contract.masterLocalizableKeys)
        for (const locale of textField ? listingLanguages : ['']) {
          let own = textField ? channelContentState(products.find(p => p.id === listing.productId)!, listing, textField, locale, listingLanguages) : storedChannelState(listing, field.channelStore, [field.fieldKey, field.sheetKey].filter((k): k is string => !!k))
          if (textField) own.value = contentWireValue(own.value, field.shape, textField)
          // Owner 2026-10-05 — an eBay listing's Image URLs are the photos Publish sends, the same list as the sheet's Product
          // media cell (after a save in Product media the old list is gone, and the file's Image columns read blank).
          const photos = !textField && listing.channel === 'EBAY' && field.fieldKey === EBAY_PHOTOS_FIELD ? ebayPhotos?.(listing, listingLanguages[0] ?? 'und')?.urls : undefined
          if (photos?.length) own = { state: 'stored', value: photos }
          const value = typeof own.value === 'object' && own.value && 'toNumber' in own.value ? (own.value as { toNumber(): number }).toNumber() : own.value
          rows.push({ ...identity, locale, field: field.fieldKey, action: own.state === 'inherited' ? 'INHERIT' : value === null ? 'CLEAR' : 'SET', value })
        }
      }
      if (input.sheet) for (const [key, value] of undeclaredListingValues(listing, contract.fields)) rows.push({ ...identity, locale: '', field: key, action: 'SET', value })
    }
    if (workbookMeta) {
      const fields = [{ field: categoryKey, label: 'Channel category', type: listing.channel === 'ETSY' ? 'number' : 'text' }, ...contract.fields.filter(f => f.fieldKey !== categoryKey && (!input.boundary || !managedChannelField(f))).map(f => ({ ...channelWorkbookField(f), schemaVersion: contract.schemaVersion, help: `${channelWorkbookField(f).help} ${contract.fetchedAt ? `Schema retrieved ${contract.fetchedAt}.` : `Field definition ${contract.schemaVersion ?? 'unversioned'}.`}` }))]
      const textFields = new Set(contract.fields.filter(f => channelContentField(f, contract.masterLocalizableKeys)).map(f => f.fieldKey))
      const facts = fields.filter(f => !textFields.has(f.field)), text = fields.filter(f => textFields.has(f.field))
      // PSIE — the undeclared stored keys of THIS listing join its sheet's dictionary as read-only columns.
      if (input.sheet) for (const [key] of undeclaredListingValues(listing, contract.fields)) if (!facts.some(f => f.field === key)) facts.push({ field: key, label: `${key} (not in the current ${listing.channel} ${listing.marketplace} schema)`, type: 'json', editable: false,
        help: 'Stored on this listing, but the current channel schema does not list it. Shown so nothing is hidden; it cannot be changed here.' })
      for (const row of rows.slice(start)) workbookMeta.set(row, { category, fields: row.locale ? text : facts, note: contract.warning })
    }
  }
  if (input.effective) {
    const { resolveBatch } = await import('./mapping/resolve-batch.service.js')
    // catalogRows receives at most one export page (100 products). Keep every
    // destination axis in the key and preserve the original listing/language order.
    for (const batch of effectiveBatches.values()) {
      const result = await resolveBatch(batch.input)
      const byProduct = new Map(result.products.map(product => [product.productId, product]))
      for (const output of batch.outputs) for (const value of Object.values(byProduct.get(output.productId)?.cells ?? {})) {
        output.rows.push({ ...output.identity, field: value.fieldKey, action: 'SET', value: value.value })
      }
    }
    return effectiveRows.flat()
  }
  return rows
}


/** The eBay field the sheet calls "Image URLs" (`channel-specs/ebay.ts`). */
const EBAY_PHOTOS_FIELD = 'imageUrls'

/** What `ebayPhotoReader` reads of a product: its Shared Product media and its parent's. */
type PhotoProduct = { id: string; parentId: string | null; localizedContent?: unknown; parent?: { id: string; localizedContent?: unknown } | null }
type PhotoListing = { productId: string; marketplace: string; channelConnectionId: string | null; aliasKey: string | null; platformAttributes: unknown }
/**
 * The photos of each eBay listing of one export page, as the sheet's Product media cell shows them: a family on the photo
 * plan reads the plan's row (`sheetMediaPlan`, what its publisher sends; `own` false: the plan decides), any other
 * `ebayListingPhotos`. Two reads per page (the files, which families are on the plan), plus the plan of each family that
 * is. Owner 2026-10-05 — the import reads the same (`loadTransferContext`), so a re-imported export plans nothing.
 */
export async function ebayPhotoReader(products: readonly PhotoProduct[], listings: readonly { channel: string; productId: string }[],
  db: Pick<typeof prisma, 'productImage' | 'productMediaPlan'> = prisma) {
  const listed = new Set(listings.filter(l => l.channel === 'EBAY').map(l => l.productId))
  const rows = products.filter(p => listed.has(p.id))
  const files: PhotoFile[] = await db.productImage.findMany({ where: { productId: { in: [...new Set(rows.flatMap(p => [p.id, ...(p.parentId ? [p.parentId] : [])]))] } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, productId: true, url: true, mediaType: true } })
  const roots = [...new Set(rows.map(p => p.parentId ?? p.id))]
  const onPlan = roots.length ? await db.productMediaPlan.findMany({ where: { productId: { in: roots }, layer: 'SHARED' }, select: { productId: true } }) : []
  const plans = new Map<string, Awaited<ReturnType<typeof import('../images/media-plan.service.js').sheetMediaPlan>>>()
  if (onPlan.length) {
    const { sheetMediaPlan } = await import('../images/media-plan.service.js')
    for (const root of new Set(onPlan.map(p => p.productId))) plans.set(root, await sheetMediaPlan(root))
  }
  return (listing: PhotoListing, locale: string): { urls: string[]; own: boolean } | undefined => {
    const product = rows.find(p => p.id === listing.productId)
    if (!product) return undefined
    const plan = plans.get(product.parentId ?? product.id)
    if (plan) return { own: false, urls: plan.row(product.id, { channel: 'EBAY', marketplace: listing.marketplace, accountId: listing.channelConnectionId ?? '', aliasKey: listing.aliasKey ?? '' }, locale)
      .items.flatMap(item => item.type === 'IMAGE' && item.preview ? [item.preview] : []) }
    return ebayListingPhotos({ listingAttributes: listing.platformAttributes, locale, product, parent: product.parent, files })
  }
}

/** PSIE — stored listing values (`overrideData`) whose key the listing's current contract does not declare. */
export function undeclaredListingValues(listing: { overrideData?: unknown }, fields: { fieldKey: string; sheetKey?: string | null }[]): [string, unknown][] {
  const declared = new Set(fields.flatMap(f => [f.fieldKey, f.sheetKey].filter((k): k is string => !!k)))
  return Object.entries(jsonRecord(listing.overrideData)).filter(([key, value]) => !declared.has(key) && !isEmptyChannelValue(value)).sort(([a], [b]) => a.localeCompare(b))
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
