import { etsyContentState } from '../../etsy/information-content.js'
import { presentationContexts } from './presentation-context.js'
import { effectivePresentationRule, resolvePresentationOrder } from './presentation-rules.js'
import { primaryConnectionIds } from '../../connection-resolver.service.js'
import { isBlankValue, projectCellValue } from '../sheet-values.js'
import { normalizeEbayListingValue } from '../ebay-listing-values.js'
import { storedChannelState } from '../channel-value-mutation.js'
import { validateChannelValue } from './validate-channel-value.js'
import { masterDefaultRule } from './master-default-rule.js'
import { exprDependenciesDeep } from './expr.js'
import { evaluateSchemaRequirements } from './schema-requirements.js'
/**
 * PES.6.2 — the batched channel-field resolver. THE seam.
 *
 * One endpoint answers "what does channel field F resolve to for these N products?" for the
 * mapping editor's Preview Value column AND for the product sheet's 🔗 derived channel cells.
 * There is deliberately ONE implementation: a preview must RUN the engine
 * (reference_preview_must_run_the_engine), and a sheet that re-derived values in the browser
 * would drift from what publishes the moment a transform changed.
 *
 * It is `payload-preview` widened on two axes and nothing else:
 *   - N products instead of 1, with each per-product load done ONCE (product + parent +
 *     listing + link groups) and each per-template load done once (rules, value maps, size
 *     scales, business rules). `previewPayload` in a loop would be ~6 queries per product.
 *   - the full field CATALOGUE instead of `Object.keys(rules)`, so an unmapped field comes back
 *     as a row with `status: 'unmapped'` rather than not coming back at all.
 *
 * Every value still goes through `resolveChannelField`, so provenance, warnings, applied
 * transforms and the value itself are the same objects publish will use.
 *
 * AUTO-CORRECTION is reported, never performed silently. When the schema closes a field's value
 * list and the resolved value differs only by case/whitespace from a legal option, the corrected
 * value is what would ship, and `autoCorrected` carries the before → after so the cell can say
 * so (Rithum's magenta chip). When it matches nothing, that is an ERROR, not a correction.
 */

import prisma from '../../../db.js'
import { languageForMarketplace } from '../../products/translation-resolver.service.js'
import { resolveAttributes } from '../attribute-resolver.js'
import { getMappingForMarketplace, getRulesFor, type FieldMappingRule, type MarketplaceSchemaMapping } from '../schema-mapping.service.js'
import {
  resolveChannelField, isPresent, linkForCoordinate, type FieldLinkGroupLike,
} from '../resolve-channel-field.js'
import { getFieldCatalogue, type CatalogueField, type FieldCatalogue } from './field-catalogue.service.js'
import { categoryForListing, resolveCategoriesForProducts, type ResolvedCategory, type MappingRow } from './category-mapping.service.js'

export interface ResolvedCell {
  sourceOwner?: CatalogueField['sourceOwner']

  label?: string
  sourceDependencies?: string[]
  ruleOrigin?: 'master' | 'default' | 'category' | null
  fieldKey: string
  supplyingRule?: { id: string; name: string; version: number; href: string }
  rule?: FieldMappingRule | null
  raw?: unknown
  legacySource?: 'source' | 'fallback' | 'default' | 'missing'
  needsTranslation?: boolean
  requestedLocale?: string
  effectiveLocale?: string
  translationState?: import('../attribute-resolver.js').ResolvedValue['translationState']
  /** The value that would ship, AFTER any enum auto-correction. */
  value: unknown
  status: 'mapped' | 'unmapped'
  /** FM.2 provenance — locked / override / linked / fallback / default / catalogRule / missing. */
  provenance: string | null
  appliedTransforms: string[]
  warnings: string[]
  /** Blocking problems for this cell. A required field with no value; a value outside a closed
   *  list. Distinct from `warnings`, and distinct from `status` — Rithum shows a field that is
   *  Mapped AND errored, and so do we. */
  errors: string[]
  /** Errors in an authored rule or its populated result; missing data is separate. */
  mappingErrors?: string[]
  /** Set when a closed-list value was normalised to the schema's own spelling. */
  autoCorrected: { from: string; to: string } | null
  required: boolean
  requirementReasons?: Array<{ message: string; schemaPath: string }>
  /** Length limits actually exceeded, reported not enforced. */
  overLimit: { chars?: number; bytes?: number } | null
}

export interface ResolvedProduct {
  validationContext?: { schema: FieldCatalogue['schema']; mappingVersion: number }
  readiness?: { state: 'blocked' | 'locally-valid'; populated: number; total: number; invalid: number; translationPending: number; listingOwnerFields?: number; schemaValidation: 'evaluated' | 'missing' | 'unavailable'; channelValidation: 'not-checked' }
  productId: string
  sku: string
  name: string | null
  /** Which channel category (and how it was found) drove the rule set for this product. */
  category: ResolvedCategory
  cells: Record<string, ResolvedCell>
  presentationContext?: import('./presentation-rules.js').PresentationContext
  presentationOrder?: ReturnType<typeof resolvePresentationOrder>
  counts: { mapped: number; unmapped: number; errors: number; requiredMissing: number }
}

export interface ResolveBatchResult {
  channel: string
  marketplace: string
  locale: string
  /** The catalogue the cells were resolved against — the UI needs its priorities + groups
   *  anyway, so returning it saves a second round trip. Omitted when `includeCatalogue` is
   *  false (the sheet already has its columns). */
  catalogue: FieldCatalogue | null
  products: ResolvedProduct[]
  /** Products asked for but not found. Named rather than silently dropped. */
  missingProductIds: string[]
}

/**
 * Link groups for MANY products in ONE query.
 *
 * `payload-preview.loadFieldLinkGroups` is per product, so calling it in a loop cost one SELECT
 * per row — 21 identical-shaped queries for a 21-SKU family, scaling with the batch. It is also
 * the module whose import chain reaches the Redis-backed event bus
 * (payload-preview → value-map.service → value-translate → … → lib/queue), which made merely
 * IMPORTING this file block when Redis was unreachable. Doing the query here fixes both: one
 * round trip, and nothing heavy in the import graph.
 */
async function loadLinkGroupsForProducts(
  productIds: string[],
): Promise<Map<string, FieldLinkGroupLike[]>> {
  const out = new Map<string, FieldLinkGroupLike[]>()
  for (const id of productIds) out.set(id, [])
  if (productIds.length === 0) return out
  const rows = await prisma.fieldLinkGroup.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true, fieldKey: true, variantId: true,
      translatePolicy: true, sourceLanguage: true, members: true,
    },
  })
  for (const r of rows) {
    out.get(r.productId)?.push({
      fieldKey: r.fieldKey,
      variantId: r.variantId,
      translatePolicy: r.translatePolicy as FieldLinkGroupLike['translatePolicy'],
      sourceLanguage: r.sourceLanguage,
      members: r.members,
    })
  }
  return out
}

export async function resolveBatch(input: {
  /** Explicit account for catalog transfers; absent preserves the Studio's primary account. */
  channelConnectionId?: string | null
  /** Exact listing projection. An absent key selects the primary listing. */
  aliasKey?: string
  channel: string
  marketplace: string
  productIds: string[]
  /** Restrict to these fields. Omit for the whole catalogue. */
  fieldKeys?: string[]
  locale?: string
  /** Force one category's rule set for every product (the editor pins the category it is
   *  editing); omit to resolve each product's own category. */
  productType?: string | null
  /** Internal review filter: match actual account/alias category before loading field schemas. */
  categoryFilter?: string | null
  includeCatalogue?: boolean
  /** Read-only draft simulation. Never persisted or used as a separate resolver. */
  mappingSnapshot?: MarketplaceSchemaMapping
  categoryMappingSnapshot?: MappingRow[]
  includePresentation?: boolean
  /** Internal, read-only simulation used by propagation. Listing overrides still win. */
  masterChangesByProduct?: Record<string, Record<string, unknown>>
  /** Internal import review: apply the canonical planner's storage patches in memory only. */
  productChangesByProduct?: Record<string, Record<string, unknown>>
  listingChangesByProduct?: Record<string, Record<string, unknown>>
  /** Reconciliation baseline; category and listing-owned fields keep their real context. */
  inheritMappedFields?: boolean
}): Promise<ResolveBatchResult> {
  const channel = input.channel.toUpperCase()
  const { marketplace } = input
  const locale = input.locale ?? await languageForMarketplace(marketplace, channel)
  // Listing ownership alone does not exempt an Information field. Only these
  // workflow-owned values are assembled later; Shopify validates its projected
  // remote/draft owners after the common mapping pass.
  const deferred = (field: CatalogueField | undefined) => !!field?.sourceOwner && (channel === 'SHOPIFY'
    || ['Pricing', 'Inventory', 'Media', 'Product media', 'Channel-reported data'].includes(field.sourceOwner.label))
  const productIds = [...new Set(input.productIds)].filter(Boolean)
  const includeCatalogue = input.includeCatalogue !== false

  // ── per-template loads: once, not per product ────────────────────
  const mapping = input.mappingSnapshot ?? await getMappingForMarketplace(channel, marketplace)
  const namedExpression = (name: string) => mapping.expressions?.[name]
  // Loaded lazily: `value-map.service`'s import chain reaches the Redis-backed event bus, and a
  // static import made this whole module unimportable while Redis was down. Nothing here needs
  // it until a resolve actually runs.
  const { loadValueMapLookup, loadSizeScaleLookup } = await import('../value-map.service.js')
  const [lookupValueMap, lookupSizeScale] = await Promise.all([
    loadValueMapLookup(channel, marketplace, { fresh: !!input.mappingSnapshot }),
    loadSizeScaleLookup({ fresh: !!input.mappingSnapshot }),
  ])

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true, sku: true, name: true, parentId: true, productType: true,
      localizedContent: true, translations: true, categoryAttributes: true, variantAttributes: true,
    },
  })
  const found = new Set(products.map((p) => p.id))
  const missingProductIds = productIds.filter((id) => !found.has(id))
  if (products.length === 0) {
    return {
      channel, marketplace, locale,
      catalogue: includeCatalogue
        ? await getFieldCatalogue({ locale, channel, marketplace, accountId: input.channelConnectionId, productType: input.productType, mappingSnapshot: mapping })
        : null,
      products: [],
      missingProductIds,
    }
  }

  const connectionId = input.channelConnectionId !== undefined ? input.channelConnectionId : (await primaryConnectionIds([channel])).get(channel) ?? null
  const parentIds = [...new Set(products.map((p) => p.parentId).filter(Boolean) as string[])]
  const [parents, listings, categories] = await Promise.all([
    parentIds.length
      ? prisma.product.findMany({ where: { id: { in: parentIds } }, include: { translations: true } })
      : Promise.resolve([]),
    prisma.channelListing.findMany({
      where: { productId: { in: [...found] }, channel, marketplace, aliasKey: input.aliasKey ?? '', channelConnectionId: connectionId },
      orderBy: { id: 'asc' },
    }),
    resolveCategoriesForProducts({ productIds: [...found], channel, marketplace, mappingSnapshot: input.categoryMappingSnapshot }),
  ])
  const parentById = new Map(parents.map((p) => [p.id, { ...p, ...input.productChangesByProduct?.[p.id] }]))
  const listingByProduct = new Map(listings.slice().reverse().map((l) => [l.productId, { ...l, ...input.listingChangesByProduct?.[l.productId] }]))
  for (const product of products) {
    categories[product.id] = categoryForListing(categories[product.id], channel, listingByProduct.get(product.id)?.platformAttributes)
  }
  const matchingIds = [...found].filter(id => !input.categoryFilter || categories[id]?.channelCategoryId === input.categoryFilter)
  if (!matchingIds.length) return { channel, marketplace, locale, catalogue: null, products: [], missingProductIds }

  const linkGroupsByProduct = await loadLinkGroupsForProducts(matchingIds)

  // The full product rows the resolver needs (findMany above selected a subset for speed;
  // resolveAttributes wants the whole row).
  const fullProducts = await prisma.product.findMany({ where: { id: { in: matchingIds } }, include: { translations: true } })
  const fullById = new Map(fullProducts.map((p) => [p.id, { ...p, ...input.productChangesByProduct?.[p.id] }]))
  const presentation = channel === 'EBAY' && (input.includePresentation || mapping.presentationRules?.length) ? await presentationContexts(prisma, fullProducts, parents, categories, connectionId) : null

  // ── one catalogue per DISTINCT category in the batch ─────────────
  // The editor pins a category, so this is normally one. A sheet page can span several.
  const pinned = input.productType?.trim() || null
  const categoryFor = (productId: string): string | null =>
    channel === 'SHOPIFY' ? null : pinned ?? categories[productId]?.channelCategoryId ?? null

  const distinctCategories = [...new Set(matchingIds.map((id) => categoryFor(id)))]
  const catalogueByCategory = new Map<string | null, FieldCatalogue>()
  for (const cat of distinctCategories) {
    catalogueByCategory.set(cat, await getFieldCatalogue({ locale, channel, marketplace, accountId: connectionId, productType: cat, mappingSnapshot: mapping }))
  }

  const wanted = input.fieldKeys && input.fieldKeys.length > 0 ? new Set(input.fieldKeys) : null

  const out: ResolvedProduct[] = []
  for (const p of products) {
    let full = fullById.get(p.id)
    if (!full) continue
    const changes = { ...input.masterChangesByProduct?.[p.id] }
    if ('title' in changes) changes.name = changes.title
    else if ('name' in changes) changes.title = changes.name
    if (Object.keys(changes).length) {
      const localized = (full.localizedContent ?? {}) as Record<string, Record<string, unknown>>
      const copy = Object.fromEntries(['title', 'description', 'bulletPoints', 'keywords'].filter(key => key in changes).map(key => [key, changes[key]]))
      full = { ...full, localizedContent: { ...localized, [locale]: { ...localized[locale], ...copy } } as any }
    }
    const cat = categoryFor(p.id)
    const catalogue = catalogueByCategory.get(cat)!
    const rules = getRulesFor(mapping, cat)
    const linkGroups = linkGroupsByProduct.get(p.id) ?? []

    const resolvedAttrs = resolveAttributes({
      localizableKeys: catalogue.masterLocalizableKeys,
      product: full as any,
      parent: (full.parentId ? parentById.get(full.parentId) : null) as any,
      // Sources are shared Master/variant facts. The destination's explicit override is
      // applied below; feeding another listing field's override into a rule creates a loop
      // and makes the source picker, mapping preview and sheet disagree.
      locale,
    })
    for (const key of catalogue.masterSourceKeys ?? []) {
      resolvedAttrs[key] ??= { value: null, source: 'default', inheritedFrom: null }
    }
    for (const [key, value] of Object.entries(changes)) {
      resolvedAttrs[key] = { value, source: 'master', inheritedFrom: null }
    }

    // Conditions can depend on a field outside the requested projection.
    const fields: CatalogueField[] = catalogue.fields

    const cells: Record<string, ResolvedCell> = {}
    let mapped = 0, unmapped = 0, errorCount = 0, requiredMissing = 0

    for (const field of fields) {
      // A removed or retyped definition cannot keep resolving an old authored mapping.
      if (channel === 'SHOPIFY' && field.schemaKnown === false) continue
      // Historical Master facts remain usable before their keys are added to the family dictionary.
      // Only exact declared semantic matches qualify; an existing operator mapping keeps precedence.
      const rule: FieldMappingRule | null = rules[field.fieldKey] ?? field.rule ?? (field.sourceOwner ? null : masterDefaultRule({
        key: field.fieldKey, masterKey: field.sheetKey, channelStore: field.channelStore,
      }, new Set(Object.keys(resolvedAttrs))))
      const listing = listingByProduct.get(p.id)
      const store = field.channelStore
      const storedState = storedChannelState(listing as unknown as Record<string, unknown> ?? {}, store, [...new Set([field.sheetKey ?? field.fieldKey, field.fieldKey])])
      const stored = storedState.state === 'stored' && !(input.inheritMappedFields && rule && !field.sourceOwner)
        ? storedState.value : undefined
      const systemValue = channel === 'AMAZON' && field.fieldKey === 'parentage_level'
        ? full.isParent ? 'parent' : full.parentId ? 'child' : undefined
        : channel === 'AMAZON' && field.fieldKey === 'child_parent_sku_relationship__parent_sku' && full.parentId
          ? parentById.get(full.parentId)?.sku : undefined
      const effectiveStored = isBlankValue(stored) && ((channel === 'AMAZON' && field.fieldKey === 'productType') || (channel === 'EBAY' && field.fieldKey === 'categoryId'))
        ? categories[p.id]?.channelCategoryId : stored === undefined ? systemValue : stored
      // A deliberately cleared override is still an override; it must not revive Master.
      const hasStored = effectiveStored !== undefined
      const directRaw = channel === 'EBAY' ? normalizeEbayListingValue(field.sheetKey ?? field.fieldKey, effectiveStored) : effectiveStored
      const directValue = projectCellValue({ shape: field.shape }, directRaw)

      if (!hasStored && !rule) {
        const errors: string[] = []
        if (!deferred(field) && (field.priority === 'required' && field.requiredInParent !== false)) {
          errors.push(`Field '${field.label}' is required.`)
          requiredMissing++
          errorCount++
        }
        cells[field.fieldKey] = {
          fieldKey: field.fieldKey, label: field.label, sourceOwner: field.sourceOwner, value: null, status: 'unmapped', provenance: null,
          rule, raw: null, legacySource: 'missing', needsTranslation: false,
          appliedTransforms: [], warnings: [], errors, mappingErrors: [], autoCorrected: null,
          required: !deferred(field) && (field.priority === 'required' && field.requiredInParent !== false), overLimit: null,
        }
        unmapped++
        continue
      }

      const link = linkForCoordinate(linkGroups, field.fieldKey, channel, marketplace, null, locale)
      const etsyContent = channel === 'ETSY' && store?.kind === 'platformAttributes' && store.path[0] === '_etsyInformationLocales'
        ? etsyContentState(listing, locale, store.path[2]) : null
      const r = hasStored ? { value: directValue, raw: directValue, source: stored === undefined ? 'default' : 'override', legacySource: 'source' as const, needsTranslation: false, requestedLocale: undefined, effectiveLocale: undefined, translationState: undefined, ...(etsyContent ? { requestedLocale: locale, effectiveLocale: etsyContent.effectiveLocale, translationState: etsyContent.translationState, needsTranslation: etsyContent.needsTranslation } : {}), warnings: [] as string[], appliedTransforms: [] as string[] } : resolveChannelField({
        fieldKey: field.fieldKey,
        rule: rule!,
        resolvedAttrs,
        product: full as any,
        locale,
        link,
        transformCtx: {
          lookupValueMap,
          lookupSizeScale,
          maxLength: field.maxLength ?? undefined,
          namedExpression,
        },
      })

      const projected = field.shape === 'list' ? projectCellValue({ shape: 'list' }, r.value) : r.value
      const { value, errors, autoCorrected, overLimit } = validateChannelValue(field, projected)
      errors.push(...r.warnings.filter(warning => /^(expr (?:failed|skipped)|Conflicting variant attributes)/.test(warning)))
      const mappingErrors = !hasStored && rule ? [...errors] : []

      // Required-but-empty is the error the whole editor exists to surface.
      const isRequired = !deferred(field) && ((field.priority === 'required' && field.requiredInParent !== false) || rule?.required === true)
      if (!isPresent(value) && isRequired) {
        errors.push(`Field '${field.label}' is required.`)
        requiredMissing++
      }
      if (r.needsTranslation) {
        const message = r.effectiveLocale
          ? `Showing ${r.effectiveLocale} fallback; ${locale} content ${r.translationState === 'outdated' ? 'is outdated' : 'is missing'}.`
          : `Translation into ${locale} is pending.`
        r.warnings.push(message)
        if (isRequired) errors.push(message)
      }

      if (errors.length > 0) errorCount++
      mapped++
      cells[field.fieldKey] = {
        fieldKey: field.fieldKey,
        label: field.label,
        ruleOrigin: rules[field.fieldKey] ? (mapping.byProductType?.[cat ?? '']?.[field.fieldKey] ? 'category' : 'default') : rule ? 'master' : null,
        sourceDependencies: [...new Set([rule?.source, rule?.fallback, ...(rule?.transforms ?? []).flatMap(op =>
          op.type === 'expr' ? exprDependenciesDeep(op.expr ?? `rule(${JSON.stringify(op.ref)})`, mapping.expressions ?? {})?.attributes ?? []
          : op.type === 'template' ? [...(op.expr ?? '').matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map(match => match[1]) : []),
        ].filter((key): key is string => !!key).map(key => key.replace(/^(categoryAttributes|variantAttributes)\./, '').replace(/^localizedContent\.[^.]+\./, '').replace(/^name$/, 'title')))],
        rule, raw: r.raw, legacySource: r.legacySource, needsTranslation: r.needsTranslation,
        ...(r.effectiveLocale ? { requestedLocale: r.requestedLocale, effectiveLocale: r.effectiveLocale, translationState: r.translationState } : {}),
        value: value ?? null,
        status: 'mapped',
        sourceOwner: rule ? null : field.sourceOwner,
        provenance: r.source,
        appliedTransforms: r.appliedTransforms,
        warnings: r.warnings,
        errors,
        mappingErrors,
        autoCorrected,
        required: isRequired,
        overLimit,
      }
    }

    const requirements = evaluateSchemaRequirements(catalogue, Object.fromEntries(Object.values(cells).map(c => [c.fieldKey, c.value])))
    for (const key of requirements.requiredFields ?? []) {
      if (cells[key] && !deferred(fields.find(f => f.fieldKey === key))) cells[key].required = true
    }
    for (const issue of requirements.issues) {
      const cell = cells[issue.fieldKey]
      if (!cell) continue
      // Pricing, stock and media may be assembled only by their owning publisher.
      // An absent preview value is not evidence that its outgoing value is missing.
      if (deferred(fields.find(f => f.fieldKey === issue.fieldKey)) && !isPresent(cell.value)) continue
      cell.required ||= issue.required
      cell.requirementReasons ??= []
      cell.requirementReasons.push({ message: issue.message, schemaPath: issue.schemaPath })
      if (!(issue.required && !isPresent(cell.value) && cell.errors.some(e => e.includes('is required.'))) && !cell.errors.includes(issue.message)) cell.errors.push(issue.message)
      if (!issue.required && isPresent(cell.value) && cell.rule && !['override', 'locked'].includes(cell.provenance ?? '')) cell.mappingErrors?.push(issue.message)
    }
    if (requirements.unavailable) {
      for (const cell of Object.values(cells)) cell.errors.push(`Category requirement validation is unavailable: ${requirements.unavailable}`)
    }

    const context = presentation?.get(p.id)
    const themeCell = cells.descriptionThemeId
    if (context && themeCell && !['override', 'locked'].includes(themeCell.provenance ?? '')) {
      const theme = effectivePresentationRule(mapping.presentationRules ?? [], context, 'themeId')
      if (theme.rule) {
        themeCell.value = theme.value ?? null; themeCell.provenance = 'catalogRule'; themeCell.status = 'mapped'
        themeCell.raw = themeCell.value
        themeCell.errors = validateChannelValue(fields.find(f => f.fieldKey === 'descriptionThemeId')!, themeCell.value).errors
        themeCell.supplyingRule = { id: theme.rule.id, name: theme.rule.name, version: theme.rule.version, href: `/channels/ebay/variation-order-rules?market=${encodeURIComponent(marketplace)}&rule=${encodeURIComponent(theme.rule.id)}` }
      }
      if (theme.conflicts.length) themeCell.errors.push(`Conflicting presentation rules: ${theme.conflicts.join('; ')}`)
    }
    if (categories[p.id]?.conflicts?.length) {
      for (const cell of Object.values(cells)) cell.errors.push(`Conflicting shared categories: ${categories[p.id].conflicts!.join('; ')}. Choose a primary shared category or an explicit listing category.`)
    }
    for (const field of fields) if (field.schemaKnown === false && cells[field.fieldKey]?.rule) {
      const message = 'This rule targets a field absent from the selected category schema. Review the rule or refresh the schema.'
      cells[field.fieldKey].errors.push(message)
      cells[field.fieldKey].mappingErrors?.push(message)
    }
    const completeCells = Object.values(cells)
    const invalid = completeCells.filter(c => c.errors.length).length
    const translationPending = completeCells.filter(c => c.needsTranslation).length
    const schemaValidation = requirements.unavailable ? 'unavailable' as const : catalogue.schema?.present ? 'evaluated' as const : 'missing' as const
    const readiness: NonNullable<ResolvedProduct['readiness']> = {
      state: invalid || translationPending || schemaValidation !== 'evaluated' ? 'blocked' : 'locally-valid',
      populated: completeCells.filter(c => isPresent(c.value)).length, total: completeCells.length, invalid, translationPending,
      schemaValidation, channelValidation: 'not-checked', listingOwnerFields: fields.filter(f => f.sourceOwner).length,
    }
    if (wanted) for (const key of Object.keys(cells)) if (!wanted.has(key)) delete cells[key]
    out.push({
      productId: p.id,
      sku: p.sku,
      name: p.name ?? null,
      category: categories[p.id] ?? {
        channelCategoryId: null, channelCategoryPath: null, browseNodeId: null,
        source: 'none', categoryId: null, categoryName: null, reviewed: false,
      },
      cells,
      readiness,
      validationContext: { schema: catalogue.schema, mappingVersion: catalogue.mappingVersion },
      ...(context ? { presentationContext: context, presentationOrder: resolvePresentationOrder(mapping.presentationRules ?? [], context, (listingByProduct.get(p.id)?.platformAttributes ?? {}) as Record<string, unknown>) } : {}),
      counts: {
        mapped: Object.values(cells).filter(c => c.status === 'mapped').length,
        unmapped: Object.values(cells).filter(c => c.status === 'unmapped').length,
        errors: Object.values(cells).filter(c => c.errors.length > 0).length,
        requiredMissing: Object.values(cells).filter(c => c.required && !isPresent(c.value)).length,
      },
    })
  }

  return {
    channel,
    marketplace,
    locale,
    catalogue: includeCatalogue ? (catalogueByCategory.get(pinned ?? distinctCategories[0]) ?? null) : null,
    products: out,
    missingProductIds,
  }
}
