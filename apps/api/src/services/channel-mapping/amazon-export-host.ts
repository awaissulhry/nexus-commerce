import { amazonChannelKey } from '@nexus/shared/channel-mapping'
import prisma from '../../db.js'
import { detectAmazonTemplate, rewriteTemplateDataRows } from '../amazon/template-workbook.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { amazonExportValues, buildAmazonTemplateRows, type AmazonExportOptions, type AmazonExportRecord, type AmazonOfferExportCell } from './amazon-export.js'
import { AMAZON_OFFER_LEAVES, amazonOfferKeysOf } from '../amazon/offer-fields.js'
import { keyFingerprint, formLabel } from './form.js'
import { fieldRowOf, MappingError, recordUse } from './store.js'

/**
 * CHMAP M3 (E-1) — write Amazon's own template from what Nexus holds, through ONE mapping version.
 *
 * The version names its template (`templateIdentifier`); the template's bytes come from `AmazonTemplateVault`
 * (captured when the Owner uploads or imports it). The values come from the product sheet's own reader
 * (`catalogRows`) — the same store the import writes — so a file read in and written out goes through the same
 * mapping both ways. Nothing is sent to Amazon; the Owner uploads the file.
 *
 * B2 (2026-10-05) — the file holds what the sheet shows: a cell that follows Shared carries the value Nexus sends
 * (`catalogRows(…, { effective: true })`, the sheet's own `resolveBatch` read). B3 — the offer settings come from the
 * sheet's own loader (`loadAmazonOfferCells`): the LIVE value, the parent and FBA holds, the saved change waiting.
 */
export interface AmazonExportRequest {
  marketplace: string
  /** A specific version (any status); otherwise the form's ACTIVE version. */
  setId?: string
  /** The form (`COAT+PANTS`) when no setId is given. */
  formKey?: string
  /** Product SKUs; each one brings its whole product group (parent and variations). */
  skus: string[]
  recordAction?: AmazonExportOptions['recordAction']
  includePrices?: boolean
}

type ChannelValueRow = { sku: string; aliasKey: string; channel: string; marketplace: string; field: string; locale: string; action: string; value?: unknown; entity: string }

export async function exportAmazonTemplate(request: AmazonExportRequest) {
  const marketplace = request.marketplace.toUpperCase()
  const set = request.setId
    ? await prisma.channelMappingSet.findUnique({ where: { id: request.setId }, include: { fields: true } })
    : await prisma.channelMappingSet.findFirst({ where: { channel: 'AMAZON', marketplace, formKind: 'AMAZON_TEMPLATE', formKey: request.formKey ?? '', status: 'ACTIVE' }, include: { fields: true } })
  if (!set) throw new MappingError(request.setId ? 'This mapping version does not exist' : `No ACTIVE mapping version for Amazon ${marketplace} · ${request.formKey ?? '?'}. Activate one on the Mapping page first.`, request.setId ? 404 : 409)
  if (set.channel !== 'AMAZON' || set.marketplace !== marketplace) throw new MappingError(`Mapping v${set.version} is for ${set.channel} ${set.marketplace}, not Amazon ${marketplace}`)
  const label = formLabel(set as never, set.version, set.status)
  if (!set.templateIdentifier) throw new MappingError(`${label} names no Amazon template; export needs one.`, 409)
  const vault = await prisma.amazonTemplateVault.findUnique({ where: { workspace_templateIdentifier: workspaceKey({ templateIdentifier: set.templateIdentifier }) } })
  if (!vault) throw new MappingError(`Nexus does not hold the Amazon template of ${label} (template ${set.templateVersion ?? set.templateIdentifier}). Upload it once on the Mapping page, then export.`, 409)
  const template = await detectAmazonTemplate(vault.bytes)
  if (!template) throw new MappingError('The stored file is not an Amazon template. Upload the template again.', 409)
  if (keyFingerprint(template.headers.map(amazonChannelKey)) !== set.keyFingerprint) throw new MappingError(`The stored template's columns differ from ${label}. Upload the template this version was made from.`, 409)

  // The product groups: every requested SKU brings its parent and its variations.
  const requested = [...new Set(request.skus.map(s => s.trim()).filter(Boolean))]
  if (!requested.length) throw new MappingError('Choose the products to export')
  const seeds = await prisma.product.findMany({ where: { sku: { in: requested }, deletedAt: null }, select: { id: true, parentId: true } })
  if (seeds.length !== requested.length) throw new MappingError('Some requested SKUs are missing or archived; correct the selection before exporting')
  const roots = [...new Set(seeds.map(p => p.parentId ?? p.id))]
  const { catalogRows, productInclude } = await import('../pim/catalog-transfer-export.js')
  const { transferContracts } = await import('../pim/catalog-transfer-plan.js')
  const { marketLanguages } = await import('../pim/market-languages.js')
  const { readSaleWindows } = await import('../pim/sale-window.js')
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, include: productInclude, orderBy: { sku: 'asc' } })
  const listings = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace, productId: { in: products.map(p => p.id) } },
    select: { id: true, productId: true, aliasKey: true, externalListingId: true, platformAttributes: true, price: true, priceOverride: true, salePrice: true } })
  const market = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace }, select: { language: true, languages: true, currency: true } })
  if (!market) throw new MappingError(`Amazon ${marketplace} is not a configured market`)
  const languages = new Map([[JSON.stringify(['AMAZON', marketplace]), marketLanguages('AMAZON', marketplace, [{ channel: 'AMAZON', code: marketplace, language: market.language, languages: market.languages ?? [] }])]])
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true } })
  const scope = { market: marketplace, marketplaces: [marketplace] }
  const contracts = transferContracts(marketplace, { allowIncompleteSchema: true })
  const rows = await catalogRows(products, scope, contracts, families, undefined, languages) as ChannelValueRow[]
  // B2 — what Nexus sends for every cell: the stored rows say which cells follow Shared, these give their values.
  const sent = await catalogRows(products, { ...scope, effective: true }, contracts, families, undefined, languages) as ChannelValueRow[]
  const windows = await readSaleWindows(prisma as never, listings.map(l => l.id))
  const { amazonOfferCellOf, loadAmazonOfferCells, offerValueWords } = await import('../pim/amazon-offer-cells.js')
  const { liveDraftValues } = await import('../amazon/offer-facts.js')
  const { pricingRuleLabel } = await import('@nexus/shared/listing-price')
  // B3 — the sheet's own offer facts. The price permission is a sheet EDIT hold, not a read one: the file only reads.
  const offerBook = await loadAmazonOfferCells({ listingIds: listings.map(l => l.id), canEditPrice: true })
  const offerCellsOf = (listingId: string, isParent: boolean): AmazonOfferExportCell[] => {
    const facts = offerBook.listing(listingId)
    if (!facts) return []
    const rule = pricingRuleLabel(facts.pricingRule, facts.priceAdjustmentPercent as never)
    const liveNow = liveDraftValues(facts.live)
    return AMAZON_OFFER_LEAVES.map(leaf => {
      const cell = amazonOfferCellOf({ key: amazonOfferKeysOf(leaf)[0], listing: facts, isParent, canEditPrice: true })!
      const entry = facts.facts.draft?.leaves[leaf]
      return { leaf, hold: cell.hold, live: cell.pendingPublish ? cell.pendingPublish.live : cell.value ?? null,
        waiting: cell.pendingPublish && entry ? { saved: offerValueWords(leaf, entry.value, rule), live: offerValueWords(leaf, liveNow[leaf], rule), sent: cell.pendingPublish.sent } : null }
    })
  }
  const listingRows = (list: ChannelValueRow[]) => {
    const out = new Map<string, ChannelValueRow[]>()
    for (const r of list) {
      if (r.entity !== 'Overrides' || r.channel !== 'AMAZON' || r.marketplace !== marketplace) continue
      const key = `${r.sku}\u0000${r.aliasKey ?? ''}`
      out.set(key, [...(out.get(key) ?? []), r])
    }
    return out
  }
  const storedOf = listingRows(rows), sentOf = listingRows(sent)
  const { normalizeLanguage } = await import('../pim/content-language.js')
  const primaryLanguage = normalizeLanguage(market.language)
  let inherited = 0

  const productById = new Map(products.map(p => [p.id, p]))
  const sellerSkuOf = (l: { productId: string; platformAttributes: unknown }) => {
    const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
    return typeof pa.sellerSku === 'string' && pa.sellerSku.trim() ? pa.sellerSku.trim() : productById.get(l.productId)!.sku
  }
  const primaryListing = new Map(listings.filter(l => !l.aliasKey).map(l => [l.productId, l]))
  const num = (v: unknown) => v == null ? null : typeof v === 'object' && 'toNumber' in (v as object) ? (v as { toNumber(): number }).toNumber() : Number(v)
  const records: AmazonExportRecord[] = listings.map(l => {
    const product = productById.get(l.productId)!
    const isParent = !product.parentId && !!product.isParent
    const key = `${product.sku}\u0000${l.aliasKey ?? ''}`
    const { values, cleared, offers, inherited: followed } = amazonExportValues(storedOf.get(key) ?? [], sentOf.get(key) ?? [], offerCellsOf(l.id, isParent), primaryLanguage)
    inherited += followed
    const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
    const parent = product.parentId ? primaryListing.get(product.parentId) : null
    const window = windows.get(l.id)
    const sale = num(l.salePrice)
    return {
      // Item 12 (2026-10-05) — the role is the family's: a single product (no parent, not a parent) is neither, so it
      // exports a blank role and keeps its price (it was written as a "parent" with a blank price).
      sku: product.sku, sellerSku: sellerSkuOf(l), parentSellerSku: parent ? sellerSkuOf(parent) : product.parent?.sku ?? null,
      isParent, role: product.parentId ? 'child' as const : product.isParent ? 'parent' as const : 'single' as const,
      productType: String(pa.productType ?? set.formKey.split('+')[0]), asin: l.externalListingId ?? (typeof values.get('merchant_suggested_asin\u0000') === 'string' ? values.get('merchant_suggested_asin\u0000') as string : null),
      values, cleared, offers, price: num(l.priceOverride ?? l.price), sale: sale != null && window?.start && window?.end ? { value: sale, start: window.start, end: window.end } : null,
    }
  }).sort((a, b) => (a.isParent === b.isParent ? a.sellerSku.localeCompare(b.sellerSku) : a.isParent ? -1 : 1))
  const built = buildAmazonTemplateRows(template, set.fields.map(fieldRowOf), records, {
    recordAction: request.recordAction ?? 'partial_update', primaryLanguage, currency: market.currency ?? null, includePrices: request.includePrices ?? true,
  })
  const file = await rewriteTemplateDataRows(vault.bytes, built.rows)
  const filename = `Amazon ${marketplace} ${set.formKey} v${set.version}.xlsm`
  await recordUse(set.id, 'EXPORT', filename, { rows: built.rows.length, gaps: built.gaps.length, blankColumns: built.blankByDesign.size })
  return {
    filename, bytes: file.bytes, set: { id: set.id, version: set.version, status: set.status, label },
    rows: built.rows.length, gaps: built.gaps, blankByDesign: [...built.blankByDesign].map(([header, reason]) => ({ header, reason })), blankForRow: built.blankForRow,
    truncated: built.truncated, notes: built.notes, inherited,
    template, exportedRows: built.rows,
  }
}
