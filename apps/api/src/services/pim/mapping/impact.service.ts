import { workspaceKey } from '@nexus/database/workspace-context'
import { matchesPresentationScope, validatePresentationRule, type PresentationRule } from './presentation-rules.js'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { getMappingForMarketplace, mergeRulesIntoMapping, removeRulesFromMapping, persistMapping, validateFieldRule, InvalidMappingError, type FieldMappingRule, type MarketplaceSchemaMapping } from '../schema-mapping.service.js'
import { resolveBatch } from './resolve-batch.service.js'
import { mappingInputToken } from './review-inputs.js'
import { expressionDraft, changedFields, validateReviewMapping, type ExpressionChange, type CategoryChange } from './review-draft.js'
import { type MappingRow } from './category-mapping.service.js'
import { languageForMarketplace } from '../../products/translation-resolver.service.js'
import { mappingToken, MappingConflict } from './revision-token.js'
import { isPresent } from '../resolve-channel-field.js'

const KIND = 'mapping-impact-v1'
const CHUNK = 100
const LEASE = 120_000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
export interface MappingChange { fieldKey: string; rule: FieldMappingRule | null }
interface Counts { scanned: number; matchedProducts: number; affectedListings: number; matchedListings?: number; missing?: number; conflicts?: number; changed: number; preservedOverrides: number; invalid: number; introducedInvalid: number; excluded: number }
interface ImpactPayload {
  kind: typeof KIND; channel: string; market: string; category: string | null; changes: MappingChange[]
  before: MarketplaceSchemaMapping; after: MarketplaceSchemaMapping; token: string; cursor: string | null
  cutoff: string; attempts?: number; counts: Counts
  chunkTimestamp?: number
  restoreRevision?: { id: string; version: number }
  presentationChange?: { id: string; rule: PresentationRule | null };
  inputToken?: string; expression?: ExpressionChange; categoryChange?: CategoryChange
  inputModels?: Record<string, string>
  shopifySchemaRevisions?: Record<string, string>
  categoryBefore?: MappingRow[]; categoryAfter?: MappingRow[]
  taxonomySnapshotId?: string
  taxonomySchemaId?: string
  cloneSource?: { channel: string; market: string; token: string; cloned: number; skippedFields: string[] }; allFields?: boolean
}
const payloadOf = (value: unknown) => (value as ImpactPayload)?.kind === KIND ? value as ImpactPayload : null
const running = new Set<string>()

export async function createMappingImpact(input: { channel: string; market: string; category?: string | null; changes?: MappingChange[]; expectedToken: string; userId: string | null;
  expression?: ExpressionChange; categoryChange?: CategoryChange; restoreRevisionId?: string;
  presentationChange?: { id: string; rule: PresentationRule | null };
  clone?: { channel: string; market: string; token: string; addTranslate?: boolean }
}) {
  if ([input.expression, input.categoryChange, input.clone, input.changes, input.presentationChange, input.restoreRevisionId].filter(v => v !== undefined).length !== 1) throw new InvalidMappingError(['Choose one kind of change per review'])
  const specialized = !!(input.expression || input.categoryChange || input.clone || input.presentationChange || input.restoreRevisionId)
  input.changes ??= []
  if (!specialized && (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 500)) throw new InvalidMappingError(['Choose between 1 and 500 field rules'])
  const keys = new Set<string>()
  for (const c of input.changes) {
    if (!c || typeof c.fieldKey !== 'string' || !c.fieldKey.trim()) throw new InvalidMappingError(['Each change needs a field key'])
    if (keys.has(c.fieldKey)) throw new InvalidMappingError([`Conflicting changes target ${c.fieldKey}`])
    keys.add(c.fieldKey)
    if (c.rule !== null) { const errors = validateFieldRule(c.fieldKey, c.rule); if (errors.length) throw new InvalidMappingError(errors) }
  }
  const before = await getMappingForMarketplace(input.channel, input.market)
  const token = mappingToken(before)
  if (!input.expectedToken || input.expectedToken !== token) throw new MappingConflict()
  const inputModels: Record<string, string> = {}
  const inputToken = await mappingInputToken(input.channel, input.market, prisma, (model, token) => { inputModels[model] = token })
  const category = input.category?.trim() || null
  let after = mergeRulesIntoMapping(removeRulesFromMapping(before, input.changes.filter(c => !c.rule).map(c => c.fieldKey), category),
    input.changes.filter((c): c is { fieldKey: string; rule: FieldMappingRule } => c.rule !== null), category)
  let categoryBefore: MappingRow[] | undefined, categoryAfter: MappingRow[] | undefined
  let taxonomySnapshotId: string | undefined
  let taxonomySchemaId: string | undefined
  let cloneSource: ImpactPayload['cloneSource']
  let restoreRevision: ImpactPayload['restoreRevision']
  if (input.restoreRevisionId) {
    if (category) throw new InvalidMappingError(['Restore a marketplace revision without a category filter'])
    const revision = await prisma.mappingRevision.findUnique({ where: { id: input.restoreRevisionId } })
    if (!revision || revision.channel !== input.channel || revision.code !== input.market) throw new InvalidMappingError(['Revision not found for this marketplace'])
    if (!revision.snapshot || typeof revision.snapshot !== 'object' || Array.isArray(revision.snapshot)) throw new InvalidMappingError(['The saved revision has an invalid snapshot'])
    after = structuredClone(revision.snapshot) as unknown as MarketplaceSchemaMapping
    after.version = before.version
    // This publisher does not yet support activating variation ordering through mappings.
    if (JSON.stringify(after.presentationRules ?? []) !== JSON.stringify(before.presentationRules ?? [])) {
      throw new InvalidMappingError(['Restore presentation rules individually so their current themes, accounts and publisher support are checked'])
    }
    input.changes = changedFields(before, after)
    restoreRevision = { id: revision.id, version: revision.version }
  }
  if (input.expression) {
    after = expressionDraft(before, input.expression)
    input.changes = changedFields(before, after)
  }
  if (input.clone) {
    if (input.clone.channel !== input.channel || input.clone.market === input.market) throw new InvalidMappingError(['Clone into a different market of the same channel'])
    const source = await getMappingForMarketplace(input.clone.channel, input.clone.market)
    if (mappingToken(source) !== input.clone.token) throw new MappingConflict('The source mapping changed. Reload it before cloning.')
    const { getRulesFor, buildClonedRules } = await import('../schema-mapping.service.js')
    const schema = await prisma.channelSchema.findMany({ where: { channel: input.channel, OR: [{ marketplace: input.market }, { marketplace: null }] }, select: { fieldKey: true } })
    const cloned = buildClonedRules(getRulesFor(source, category), new Set(schema.map(f => f.fieldKey)), !!input.clone.addTranslate)
    if (!cloned.rules.length) throw new InvalidMappingError(['No source fields exist in the target schema'])
    // Named dependencies travel with a clone. Refuse an ambiguous same-name definition.
    const expressions = { ...before.expressions }
    const { exprDependenciesDeep } = await import('./expr.js')
    for (const { rule } of cloned.rules) for (const op of rule.transforms ?? []) {
      if (op.type !== 'expr') continue
      const deps = exprDependenciesDeep(op.expr ?? `rule(${JSON.stringify(op.ref)})`, source.expressions ?? {})
      for (const name of deps?.rules ?? []) {
        const body = source.expressions?.[name]
        if (!body) throw new InvalidMappingError([`Source business rule “${name}” is missing`])
        if (expressions[name] !== undefined && expressions[name] !== body) throw new InvalidMappingError([`Target business rule “${name}” has a different formula. Resolve the name conflict before cloning.`])
        expressions[name] = body
      }
    }
    after = { ...mergeRulesIntoMapping(before, cloned.rules, category), expressions }
    input.changes = cloned.rules
    cloneSource = { channel: input.clone.channel, market: input.clone.market, token: input.clone.token, cloned: cloned.rules.length,
      skippedFields: Object.keys(getRulesFor(source, category)).filter(key => !schema.some(field => field.fieldKey === key)).sort() }
  }
  if (input.categoryChange) {
    const change = input.categoryChange
    if (typeof change.categoryId !== 'string' || !change.categoryId.trim() || (change.channelCategoryId !== null && (typeof change.channelCategoryId !== 'string' || !change.channelCategoryId.trim()))) throw new InvalidMappingError(['Choose a shared category and a marketplace category, or explicitly remove its exact-market mapping'])
    const exists = await prisma.category.findUnique({ where: { id: change.categoryId }, select: { id: true } })
    if (!exists) throw new InvalidMappingError(['Shared category not found'])
    if (change.channelCategoryId !== null) {
      const { readTaxonomyRequirements } = await import('../../taxonomy/repository.js')
      const requirements = await readTaxonomyRequirements(input.channel, input.market, change.channelCategoryId.trim())
      if (!['ready', 'store'].includes(requirements.state)) throw new InvalidMappingError(['Refresh the category requirements before reviewing this assignment.'])
      if (change.expectedTaxonomySnapshotId && change.expectedTaxonomySnapshotId !== requirements.snapshotId) throw new MappingConflict('The taxonomy changed after this category was selected. Refresh the category and review again.')
      taxonomySnapshotId = requirements.snapshotId ?? undefined
      taxonomySchemaId = requirements.schema?.id
      change.channelCategoryPath = requirements.node.path
    }
    categoryBefore = await prisma.categoryChannelMapping.findMany({ where: { channel: input.channel, marketplace: { in: [input.market, '*'] } } })
    categoryAfter = categoryBefore.filter(r => r.categoryId !== change.categoryId || r.marketplace !== input.market)
    if (change.channelCategoryId !== null) categoryAfter.push({ categoryId: change.categoryId, marketplace: input.market, channelCategoryId: change.channelCategoryId.trim(), channelCategoryPath: change.channelCategoryPath ?? null, browseNodeId: change.browseNodeId ?? null, reviewedAt: new Date().toISOString() })
  }
  if (input.presentationChange) {
    if (input.channel !== 'EBAY') throw new InvalidMappingError(['Presentation rules currently support eBay only'])
    const { id, rule } = input.presentationChange
    if (typeof id !== 'string' || !id.trim() || (rule && id !== rule.id)) throw new InvalidMappingError(['Choose a stable presentation rule ID'])
    const previous = before.presentationRules?.find(r => r.id === id)
    if (rule) {
      const errors = validatePresentationRule(rule)
      if (errors.length) throw new InvalidMappingError(errors)
      if (rule.themeId && rule.themeId !== 'none') {
        const theme = await prisma.ebayDescriptionTheme.findFirst({ where: { id: rule.themeId, active: true }, select: { id: true } })
        if (!theme) throw new InvalidMappingError(['Choose an active description theme'])
      }
      if (rule.scope.accountId) {
        const { resolveChannelConnectionId } = await import('../../connection-resolver.service.js')
        await resolveChannelConnectionId('EBAY', rule.scope.accountId)
      }
      if (rule.scope.familyId && !await prisma.productFamily.findUnique({ where: { id: rule.scope.familyId }, select: { id: true } })) throw new InvalidMappingError(['Shared product family not found'])
      if (rule.scope.sharedCategoryId && !await prisma.category.findUnique({ where: { id: rule.scope.sharedCategoryId }, select: { id: true } })) throw new InvalidMappingError(['Shared category not found'])
    }
    after = { ...after, presentationRules: [...(before.presentationRules ?? []).filter(r => r.id !== id), ...(rule ? [{ ...rule, version: (previous?.version ?? 0) + 1 }] : [])] }
    input.changes = [{ fieldKey: 'descriptionThemeId', rule: null }]
  }
  validateReviewMapping(after)
  const shopifySchemaRevisions: Record<string, string> = {}
  if (input.channel === 'SHOPIFY') {
    const keys = [...new Set([...input.changes.filter(c => c.rule).map(c => c.fieldKey), ...(specialized ? Object.keys(after.fields) : [])])]
      .filter(key => key.startsWith('shopify_metafield:'))
    const { readShopifyMappingSchema } = await import('../channel-specs/shopify.js')
    const { shopifyProductSpec } = await import('../channel-specs/store.js')
    for (const accountId of new Set(keys.map(key => decodeURIComponent(key.split(':')[1] ?? '')))) {
      if (!accountId) throw new InvalidMappingError(['A Shopify metafield mapping requires its connected store.'])
      const schema = await readShopifyMappingSchema(accountId, true)
      const fields = new Set(shopifyProductSpec(schema, accountId).fields.map(f => f.key))
      if (keys.some(key => key.split(':')[1] === encodeURIComponent(accountId) && !fields.has(key))) throw new InvalidMappingError(['A Shopify metafield was removed or its type changed. Reload its store definitions.'])
      shopifySchemaRevisions[accountId] = schema.revision
    }
  }
  const cutoff = new Date().toISOString()
  const total = await prisma.product.count({ where: { deletedAt: null, createdAt: { lte: new Date(cutoff) } } })
  const payload: ImpactPayload = { kind: KIND, channel: input.channel, market: input.market, category, changes: input.changes, before, after, token, shopifySchemaRevisions, taxonomySnapshotId, taxonomySchemaId,
    cursor: null, cutoff, inputToken, inputModels, restoreRevision, expression: input.expression, categoryChange: input.categoryChange, categoryBefore, categoryAfter, cloneSource, presentationChange: input.presentationChange, allFields: specialized && !input.presentationChange, counts: { scanned: 0, matchedProducts: 0, affectedListings: 0, changed: 0, preservedOverrides: 0, invalid: 0, introducedInvalid: 0, excluded: 0 } }
  const job = await prisma.bulkOperation.create({ data: { userId: input.userId, productCount: total, changeCount: input.changes.length,
    status: 'MAPPING_SCANNING', changes: json(payload), total, processed: 0, expiresAt: new Date(Date.now() + LEASE) } })
  void runMappingImpact(job.id).catch(() => {})
  return { jobId: job.id, state: job.status, total, processed: 0 }
}

export async function runMappingImpact(jobId: string) {
  if (running.has(jobId)) return
  running.add(jobId)
  try {
    while (true) {
      const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } })
      const payload = payloadOf(job?.changes)
      if (!job || !payload || job.status !== 'MAPPING_SCANNING') return
      if (mappingToken(await getMappingForMarketplace(payload.channel, payload.market)) !== payload.token) {
        await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'MAPPING_SCANNING' }, data: { status: 'MAPPING_STALE' } }); return
      }
      const products = await prisma.product.findMany({ where: { deletedAt: null, createdAt: { lte: new Date(payload.cutoff) }, ...(payload.cursor ? { id: { gt: payload.cursor } } : {}) },
        orderBy: { id: 'asc' }, take: CHUNK, select: { id: true } })
      if (!products.length) {
        if (!payload.inputToken || await mappingInputToken(payload.channel, payload.market) !== payload.inputToken) {
          await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'MAPPING_SCANNING' }, data: { status: 'MAPPING_STALE' } }); return
        }
        await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'MAPPING_SCANNING', processed: job.processed },
          data: { status: 'MAPPING_REVIEW', completedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60_000) } }); return
      }
      const ids = products.map(p => p.id)
      const listings: Array<{ id: string; productId: string; channelConnectionId: string | null; aliasKey: string }> = []
      let listingCursor: string | undefined
      while (true) {
        const page = await prisma.channelListing.findMany({ where: { productId: { in: ids }, channel: payload.channel, marketplace: payload.market, ...(listingCursor ? { id: { gt: listingCursor } } : {}) },
          orderBy: { id: 'asc' }, take: 250, select: { id: true, productId: true, channelConnectionId: true, aliasKey: true } })
        listings.push(...page)
        if (page.length < 250) break
        listingCursor = page[page.length - 1].id
      }
      const destinations = new Map<string, { account?: string | null; alias: string; ids: Set<string>; listingIds: Map<string, string> }>()
      for (const listing of listings) {
        const key = JSON.stringify([listing.channelConnectionId, listing.aliasKey])
        const group = destinations.get(key) ?? { account: listing.channelConnectionId, alias: listing.aliasKey, ids: new Set(), listingIds: new Map() }
        group.ids.add(listing.productId); group.listingIds.set(listing.productId, listing.id); destinations.set(key, group)
      }
      const unlisted = ids.filter(id => !listings.some(l => l.productId === id))
      if (unlisted.length) destinations.set('unlisted', { account: null, alias: '', ids: new Set(unlisted), listingIds: new Map() })
      const rows: unknown[] = []
      const matched = new Set<string>()
      const counts = { ...payload.counts, matchedListings: payload.counts.matchedListings ?? 0, missing: payload.counts.missing ?? 0, conflicts: payload.counts.conflicts ?? 0, scanned: payload.counts.scanned + products.length }
      for (const destination of destinations.values()) {
        const args = { channel: payload.channel, marketplace: payload.market, productIds: [...destination.ids],
          categoryFilter: payload.category,
          channelConnectionId: destination.account, aliasKey: destination.alias, fieldKeys: payload.allFields ? undefined : payload.changes.map(c => c.fieldKey), includeCatalogue: false, includePresentation: !!payload.presentationChange }
        // Both answers run the existing resolver, schema validation, category rules and override logic.
        const before = await resolveBatch({ ...args, mappingSnapshot: payload.before, categoryMappingSnapshot: payload.categoryBefore })
        const after = await resolveBatch({ ...args, mappingSnapshot: payload.after, categoryMappingSnapshot: payload.categoryAfter })
        const byId = new Map(after.products.map(p => [p.productId, p]))
        for (const product of before.products) {
          if (payload.category && product.category.channelCategoryId !== payload.category) continue
          const next = byId.get(product.productId)
          let matchesDraft: boolean | undefined
          if (payload.presentationChange) {
            const oldScope = payload.before.presentationRules?.find(r => r.id === payload.presentationChange?.id)?.scope
            const newScope = payload.presentationChange.rule?.scope
            const matchedBefore = oldScope && product.presentationContext && matchesPresentationScope(oldScope, product.presentationContext)
            const matchedAfter = newScope && next?.presentationContext && matchesPresentationScope(newScope, next.presentationContext)
            matchesDraft = !!matchedAfter
            if (!matchedBefore && !matchedAfter) continue
          }
          matched.add(product.productId)
          if (destination.listingIds.has(product.productId)) counts.matchedListings++
          let listingChanged = false
          const fields = payload.allFields ? [...new Set([...Object.keys(product.cells), ...Object.keys(next?.cells ?? {})])] : payload.changes.map(c => c.fieldKey)
          if (payload.categoryChange) {
            fields.push('__category')
            product.cells.__category = { value: product.category.channelCategoryId, provenance: product.category.source === 'listing' ? 'override' : 'mapped', errors: product.category.conflicts ?? (product.category.channelCategoryId ? [] : ['No effective marketplace category']) } as never
            if (next) next.cells.__category = { value: next.category.channelCategoryId, provenance: next.category.source === 'listing' ? 'override' : 'mapped', errors: next.category.conflicts ?? (next.category.channelCategoryId ? [] : ['No effective marketplace category']) } as never
          }
          if (payload.presentationChange?.rule?.order || payload.before.presentationRules?.some(r => r.id === payload.presentationChange?.id && r.order)) {
            fields.push('__variationOrder')
            product.cells.__variationOrder = { value: product.presentationOrder?.value ?? null, provenance: product.presentationOrder?.explicitAxes || product.presentationOrder?.explicitValues.length ? 'override' : 'mapped', errors: product.presentationOrder?.conflicts ?? [] } as never
            if (next) next.cells.__variationOrder = { value: next.presentationOrder?.value ?? null, provenance: 'mapped', errors: next.presentationOrder?.conflicts ?? [] } as never
          }
          for (const fieldKey of fields) {
            const change = { fieldKey }
            const a = product.cells[change.fieldKey]; const b = next?.cells[change.fieldKey]
            if (!a && !b) continue
            const preserved = a?.provenance === 'override' || a?.provenance === 'locked'
            const changed = JSON.stringify(a?.value ?? null) !== JSON.stringify(b?.value ?? null)
            const errors = b?.errors ?? []
            if (preserved) counts.preservedOverrides++
            if (changed) { counts.changed++; listingChanged = true }
            if (errors.length) counts.invalid++
            if (!isPresent(b?.value)) counts.missing++
            if (errors.some(error => /conflict/i.test(error))) counts.conflicts++
            if (errors.length && JSON.stringify(errors) !== JSON.stringify(a?.errors ?? [])) counts.introducedInvalid++
            rows.push({ productId: product.productId, sku: product.sku, listingId: destination.listingIds.get(product.productId) ?? null,
              accountId: destination.account ?? null, aliasKey: destination.alias, category: product.category.channelCategoryId,
              market: payload.market, language: before.locale ?? await languageForMarketplace(payload.market, payload.channel), field: change.fieldKey, before: a?.value ?? null, after: b?.value ?? null, source: b?.provenance ?? 'missing',
              changed, preserved, errors, matchesDraft, supplyingRule: b?.supplyingRule ?? null })
          }
          if (listingChanged && destination.listingIds.has(product.productId)) counts.affectedListings++
        }
      }
      counts.matchedProducts += matched.size; counts.excluded += products.length - matched.size
      const chunkStart = Math.max(Date.now(), payload.chunkTimestamp ?? 0)
      const chunks = []
      for (let offset = 0; offset < rows.length; offset += 100) chunks.push({
        userId: job.userId, productCount: products.length, changeCount: Math.min(100, rows.length - offset),
        status: 'MAPPING_CHUNK', changes: json({ kind: 'mapping-impact-chunk-v1', jobId, offset: job.processed, rows: rows.slice(offset, offset + 100) }),
        completedAt: new Date(), createdAt: new Date(chunkStart + chunks.length),
      })
      const nextPayload = { ...payload, cursor: ids[ids.length - 1], counts, chunkTimestamp: chunkStart + chunks.length }
      await prisma.$transaction(async tx => {
        const checkpoint = await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'MAPPING_SCANNING', processed: job.processed },
          data: { changes: json(nextPayload), processed: counts.scanned, expiresAt: new Date(Date.now() + LEASE) } })
        if (!checkpoint.count) throw new MappingConflict()
        // One insert per checkpoint, not a remote round trip per 100 browser rows.
        // Explicit monotonic timestamps keep pagination stable after a resumed checkpoint.
        if (chunks.length) await tx.bulkOperation.createMany({ data: chunks })
      }, { timeout: 30_000 })
    }
  } catch (error) {
    // A durable checkpoint permits a safe retry after transient failures or process restart.
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } })
    const payload = payloadOf(job?.changes)
    if (job && payload) {
      const attempts = (payload.attempts ?? 0) + 1
      await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'MAPPING_SCANNING', processed: job.processed }, data: {
        changes: json({ ...payload, attempts }), status: attempts >= 3 ? 'MAPPING_FAILED' : 'MAPPING_SCANNING',
        errors: json([{ message: error instanceof Error ? error.message : String(error), attempts }]),
      } })
    }
  } finally { running.delete(jobId) }
}

export async function readMappingImpact(jobId: string, userId: string | null, page = 0) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } }); const payload = payloadOf(job?.changes)
  if (!job || !payload) return null
  const chunks = await prisma.bulkOperation.findMany({ where: { status: 'MAPPING_CHUNK', changes: { path: ['jobId'], equals: jobId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page, take: 1, select: { changes: true } })
  const chunkCount = await prisma.bulkOperation.count({ where: { status: 'MAPPING_CHUNK', changes: { path: ['jobId'], equals: jobId } } })
  return { jobId, state: job.status, total: job.total, processed: job.processed, counts: payload.counts,
    channel: payload.channel, market: payload.market, category: payload.category, version: payload.before.version, token: payload.token,
    futureProducts: true, operation: 'standing-rule', publication: 'separate', createdAt: payload.cutoff, expiresAt: job.expiresAt,
    inputPolicy: 'Any resolution-input change requires a new review; activation reads inputs in a serializable transaction. Future products resolve the active rule on read.', restoreRevision: payload.restoreRevision, expression: payload.expression, categoryChange: payload.categoryChange, cloneSource: payload.cloneSource, presentationChange: payload.presentationChange, changes: payload.changes, rows: (chunks[0]?.changes as { rows?: unknown[] } | undefined)?.rows ?? [], page, pages: chunkCount, errors: job.errors }
}

export async function activateMappingImpact(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } }); const payload = payloadOf(job?.changes)
  if (!job || !payload) return null
  if (job.status === 'MAPPING_APPLIED') return { applied: true }
  if (job.status !== 'MAPPING_REVIEW' || !job.expiresAt || job.expiresAt < new Date()) throw new MappingConflict()
  const current = await getMappingForMarketplace(payload.channel, payload.market)
  if (payload.presentationChange?.rule?.order || payload.before.presentationRules?.some(r => r.id === payload.presentationChange?.id && r.order)) throw new MappingConflict('Variation-order activation requires the coordinator’s publisher/domain integration patch. The review is saved; no rule or listing was changed.')
  if (payload.counts.introducedInvalid > 0) throw new MappingConflict('This rule introduces invalid outputs. Correct the draft and preview it again before activating.')
  for (const [accountId, revision] of Object.entries(payload.shopifySchemaRevisions ?? {})) {
    const { readShopifyMappingSchema } = await import('../channel-specs/shopify.js')
    if ((await readShopifyMappingSchema(accountId, true)).revision !== revision) throw new MappingConflict('The Shopify store schema changed after this review. Preview the metafield mappings again before activating.')
  }
  await persistMapping(payload.channel, payload.market, current, payload.after, payload.token, { userId, impactJobId: jobId,
    validateInputs: async tx => {
      if (payload.categoryChange) await (await import('../../category-lock.js')).lockCategoryTree(tx)
      if (payload.categoryChange?.channelCategoryId) {
        const { taxonomyWhere } = await import('../../taxonomy/repository.js')
        const source = await tx.marketplaceTaxonomy.findFirst({ where: taxonomyWhere(payload.channel, payload.market) })
        if (!payload.taxonomySnapshotId || source?.activeSnapshotId !== payload.taxonomySnapshotId) throw new MappingConflict('The marketplace taxonomy changed. Review this category assignment again.')
        if (payload.channel !== 'SHOPIFY') {
          const schema = payload.taxonomySchemaId ? await tx.categorySchema.findUnique({ where: { id: payload.taxonomySchemaId }, select: { isActive: true, expiresAt: true } }) : null
          if (!schema?.isActive || schema.expiresAt <= new Date()) throw new MappingConflict('Category requirements expired. Refresh them and start a new review.')
        }
      }
      const models: Record<string, string> = {}
      const inputToken = await mappingInputToken(payload.channel, payload.market, tx, (model, token) => { models[model] = token })
      if (!payload.inputToken || inputToken !== payload.inputToken) {
        const changed = payload.inputModels ? Object.keys(models).filter(model => payload.inputModels![model] !== models[model]) : []
        throw new MappingConflict(`Resolution inputs changed after this review${changed.length ? ` (${changed.join(', ')})` : ''}. Start a new preview before activating.`)
      }
      if (payload.cloneSource) {
        const source = await tx.marketplace.findUnique({ where: { channel_code: workspaceKey({ channel: payload.cloneSource.channel, code: payload.cloneSource.market }) }, select: { schemaMapping: true } })
        const { parseMapping } = await import('../schema-mapping.service.js')
        if (!source || mappingToken(parseMapping(source.schemaMapping)) !== payload.cloneSource.token) throw new MappingConflict('The clone source changed. Review it again.')
      }
    },
    applyRelated: async tx => {
      const change = payload.categoryChange
      if (!change) return
      const coordinate = { categoryId: change.categoryId, channel: payload.channel, marketplace: payload.market }
      if (change.channelCategoryId === null) { await tx.categoryChannelMapping.deleteMany({ where: coordinate }); return }
      const data = { channelCategoryId: change.channelCategoryId.trim(), channelCategoryPath: change.channelCategoryPath ?? null, browseNodeId: change.browseNodeId ?? null, reviewedAt: new Date(), reviewedBy: userId, confidence: 'MANUAL' }
      await tx.categoryChannelMapping.upsert({ where: { categoryId_channel_marketplace: workspaceKey(coordinate) }, create: { ...coordinate, ...data }, update: data })
    },
  })
  return { applied: true }
}

export async function recoverMappingImpacts() {
  const jobs = await prisma.bulkOperation.findMany({ where: { status: 'MAPPING_SCANNING', expiresAt: { lt: new Date() } }, take: 2, select: { id: true } })
  for (const job of jobs) {
    const claim = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: 'MAPPING_SCANNING', expiresAt: { lt: new Date() } }, data: { expiresAt: new Date(Date.now() + LEASE) } })
    if (claim.count) void runMappingImpact(job.id)
  }
}

/** Recent review metadata is always scoped to its operator and destination. */
export async function listMappingImpactReviews(channel: string, market: string, userId: string | null) {
  return await prisma.bulkOperation.findMany({ where: {
    userId: userId,
    AND: [{ changes: { path: ['kind'], equals: 'mapping-impact-v1' } },
      { changes: { path: ['channel'], equals: channel } }, { changes: { path: ['market'], equals: market } }],
  }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25,
  select: { id: true, status: true, createdAt: true, total: true, processed: true } })
}
