import { readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { emptyShopifyLinkedDraft, fieldAddress, linkedFamilyChanges, shopifyLinkedDraftSchema, validateShopifyField, shopifyReferenceError, shopifyDefinitionApplicability,
  type ShopifyFieldEdit, type ShopifyFieldSnapshot, type ShopifyStoreSchema, type ShopifyLinkedAutomation, type ShopifyLinkedDraft, type ShopifyLinkedPlan, type ShopifyLinkedWorkspace } from '@nexus/shared/shopify-linked-products'
import { contentDestination, object, PUBLISH_KEY, type ContentScope } from './content-workspace.service.js'
import { shopifyAdmin, assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { linkedDigest, readApplicableShopifyDefinitions, readLinkedFields, readLinkedOwner, readLinkedProducts, readLinkedStoreSchema, resolveLinkedReferences } from './linked-products-gateway.js'
import { WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'

import { resolveSharedContent } from './linked-shared-content.service.js'
import { readInformation, readInformationNativeOwners, verifyInformationPlan, applyNativeEdit, advanceMediaOrder } from './information-gateway.js'
import { informationRegistry, nativeValuesEqual, nativeEditVerified, nativeSchemaError, type NativeEdit, type MediaOrderEdit } from '@nexus/shared/shopify-information'
import { verifyTranslationEdits } from './information-translations.js'
import { readSheetGallerySources, reviewSheetGalleries, advanceSheetGallery, verifySheetGallery, SHEET_MEDIA_SYNC, type SheetGalleryProgress } from './channel-sheet-media.js'

export const AUTOMATION_KEY = '_nexusLinkedAutomation'
const pausedAutomation = (): ShopifyLinkedAutomation => ({ mode: 'PAUSED', status: 'IDLE', lastCheckedAt: null, lastVerifiedAt: null, message: null, changes: 0 })
export const LINKED_KEY = '_nexusLinkedProducts'
const OPERATION_KEY = '_nexusLinkedProductsOperation'
interface Operation { origin?: 'MANUAL' | 'AUTOMATIC'; sources?: ShopifyFieldSnapshot[]; id: string; status: 'RUNNING' | 'UNVERIFIED' | 'VERIFIED'; changes: ShopifyFieldEdit[]; verification: ShopifyFieldEdit[]; completed: number; error: string | null; schemaRevision: string; lease: string | null; leaseUntil: number
  actorUserId?: string | null
  nativeEdits?: NativeEdit[]; mediaEdits?: MediaOrderEdit[]; mediaJobs?: Record<string, { submitted: boolean; jobId?: string }>
  sheetGalleries?: ShopifyLinkedPlan['sheetGalleries']; galleryRevision?: string; sheetGalleryJobs?: Record<string, SheetGalleryProgress>
}
const operationTotal = (op: Operation) => op.changes.length + (op.nativeEdits?.length ?? 0) + (op.mediaEdits?.length ?? 0) + (op.sheetGalleries?.length ?? 0)
type Tx = Prisma.TransactionClient

async function auditLinkedChange(tx: Tx, destination: WorkspaceDestination, listingId: string, actorUserId: string | null, action: string, before: unknown, after: unknown, operationId?: string) {
  await tx.auditLog.create({ data: { userId: actorUserId, entityType: 'ChannelListing', entityId: listingId, action,
    before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue,
    metadata: { source: 'shopify-information', accountId: destination.accountId, familyId: destination.familyId, market: destination.marketplace, ...(operationId ? { operationId } : {}) },
  } })
}

export async function linkedState(tx: Tx, destination: WorkspaceDestination) {
  const family = await tx.product.findFirst({ where: { id: destination.familyId, deletedAt: null }, select: { id: true, name: true, children: { where: { deletedAt: null }, select: { id: true } } } })
  if (!family) throw new WorkspaceScopeError('The Nexus family is unavailable.', 404)
  const listings = await tx.channelListing.findMany({ where: { productId: { in: [family.id, ...family.children.map(c => c.id)] }, channel: 'SHOPIFY', channelConnectionId: destination.accountId, marketplace: destination.marketplace, aliasKey: destination.aliasKey ?? '' } })
  const listing = listings.find(l => l.productId === family.id) ?? null
  const pa = object(listing?.platformAttributes)
  const parsed = shopifyLinkedDraftSchema.safeParse(pa[LINKED_KEY] ?? emptyShopifyLinkedDraft())
  if (!parsed.success) throw new WorkspaceScopeError('The saved linked-product draft cannot be read. It has been preserved.', 422)
  const operation = (pa[OPERATION_KEY] ?? null) as Operation | null
  const revision = linkedDigest([destination.accountId, destination.familyId, listing?.id, listing?.version, parsed.data, operation])
  const suggestedProductIds = [...new Set(listings.map(l => l.externalListingId).filter((id): id is string => !!id && /^(gid:\/\/shopify\/Product\/)?\d+$/.test(id)).map(id => id.startsWith('gid:') ? id : `gid://shopify/Product/${id}`))]
  const workspace: ShopifyLinkedWorkspace = { productId: destination.productId, familyId: family.id, name: family.name,
    hasSheetMedia: listings.some(l => { const attrs = object(l.platformAttributes); return !!attrs._productMediaLocales || !!attrs[SHEET_MEDIA_SYNC] }),
    destination: { accountId: destination.accountId, listingId: listing?.id ?? null, market: destination.marketplace }, revision, draft: parsed.data, suggestedProductIds, automation: { ...pausedAutomation(), ...object(pa[AUTOMATION_KEY]) },
    operation: operation ? { id: operation.id, status: operation.status, completed: operation.completed, total: operationTotal(operation), error: operation.error, ...(operation.sheetGalleries?.length ? { includesSheetMedia: true } : {}) } : null }
  return { family, listing, pa, draft: parsed.data, operation, revision, workspace }
}

export async function writeLinkedState(tx: Tx, destination: WorkspaceDestination, current: Awaited<ReturnType<typeof linkedState>>, patch: Record<string, unknown>) {
  const platformAttributes = { ...current.pa, ...patch } as Prisma.InputJsonValue
  if (current.listing) {
    const saved = await tx.channelListing.updateMany({ where: { id: current.listing.id, version: current.listing.version }, data: { platformAttributes, version: { increment: 1 } } })
    if (saved.count !== 1) throw new WorkspaceScopeError('Another editor changed this family. Reload the saved draft.')
  } else await tx.channelListing.create({ data: { productId: current.family.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', marketplace: destination.marketplace, region: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', aliasId: destination.aliasKey, platformAttributes, isPublished: false } })
}
export async function linkedTransaction<T>(fn: (tx: Tx) => Promise<T>) {
  try { return await prisma.$transaction(fn, { isolationLevel: 'Serializable', timeout: 20000 }) }
  catch (error) { if (['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')) throw new WorkspaceScopeError('Another editor changed this family. Reload the saved draft.'); throw error }
}
export async function getLinkedWorkspace(productId: string, scope: ContentScope) {
  const destination = await contentDestination(productId, scope)
  return linkedTransaction(async tx => (await linkedState(tx, destination)).workspace)
}
export async function saveLinkedWorkspace(productId: string, scope: ContentScope, body: unknown, actorUserId: string | null = null) {
  const input = object(body), parsed = shopifyLinkedDraftSchema.safeParse(input.draft)
  if (!parsed.success || typeof input.expectedRevision !== 'string') throw new WorkspaceScopeError(parsed.success ? 'The observed revision is required.' : parsed.error.issues.map(i => i.message).join(' '), 400)
  const destination = await contentDestination(productId, scope)
  const schema = await readShopifyMappingSchema(destination.accountId, true)
  for (const edit of parsed.data.nativeEdits ?? []) {
    const error = nativeSchemaError(schema, edit)
    if (error) throw new WorkspaceScopeError(error, 422)
  }
  for (const edit of parsed.data.edits) {
    const definition = schema.definitions.find(d => d.ownerType === (edit.ownerId.includes('/Product/') ? 'PRODUCT' : 'PRODUCTVARIANT') && d.namespace === edit.namespace && d.key === edit.key)
    if (!definition || definition.type !== edit.type) throw new WorkspaceScopeError('The Shopify definition changed. Refresh the schema before saving this draft.', 422)
    const error = definition.readOnlyReason ?? validateShopifyField(definition, edit.nextValue)
    if (error) throw new WorkspaceScopeError(error, 422)
    if (definition.type === 'money' && edit.nextValue !== null && schema.currency && JSON.parse(edit.nextValue).currency_code !== schema.currency) throw new WorkspaceScopeError(`Use the store currency (${schema.currency}) for this money metafield.`, 422)
  }
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (parsed.data.informationOnly && !current.draft.informationOnly && current.draft.members.length) throw new WorkspaceScopeError('Existing Product family ownership cannot be changed by an Information edit.', 422)
    if (object(current.pa[PUBLISH_KEY]).status === 'PUBLISHING') throw new WorkspaceScopeError('A native Shopify publication is running. Reconcile it before setting up separate products.')
    if (current.revision !== input.expectedRevision) throw new WorkspaceScopeError('The saved family changed. Keep your edits and reload before retrying.')
    if (current.operation && current.operation.status !== 'VERIFIED') throw new WorkspaceScopeError('Resume the pending synchronization or review the latest Shopify values first.')
    // Cell pins are server-owned metadata; legacy family/recovery documents cannot erase them.
    parsed.data.sheetValues = current.draft.sheetValues
    await writeLinkedState(tx, destination, current, { [LINKED_KEY]: parsed.data, [OPERATION_KEY]: null, [AUTOMATION_KEY]: { ...current.workspace.automation, mode: 'PAUSED', status: 'IDLE', message: 'Draft changed. Review the saved rules before enabling automation.' } })
    const saved = await linkedState(tx, destination)
    await auditLinkedChange(tx, destination, saved.listing!.id, actorUserId, 'shopify.draft.saved', current.draft, parsed.data)
    return saved.workspace
  })
}

export async function importLinkedFamily(gql: ShopifyGraphql, sourceId: string, relationship: ShopifyLinkedDraft['relationship']) {
  const source = await readLinkedOwner(gql, sourceId)
  if (source.ownerType !== 'PRODUCT') throw new WorkspaceScopeError('Choose a product as the family source.', 400)
  const draft = emptyShopifyLinkedDraft(); draft.relationship = relationship
  let ids = [sourceId]
  if (relationship) {
    const schema = await readLinkedStoreSchema(gql)
    const definition = schema.definitions.find(d => d.ownerType === 'PRODUCT' && d.namespace === relationship.namespace && d.key === relationship.key)
    if (!definition || definition.type !== 'list.product_reference' || definition.readOnlyReason) throw new WorkspaceScopeError('Choose an editable product-reference list defined in this store.', 422)
    const field = source.fields.find(f => f.namespace === relationship.namespace && f.key === relationship.key)
    if (field?.value) {
      let values: unknown
      try { values = JSON.parse(field.value) } catch { throw new WorkspaceScopeError('The existing relationship cannot be read. It was preserved.', 422) }
      if (!Array.isArray(values) || values.some(id => typeof id !== 'string')) throw new WorkspaceScopeError('The existing relationship is not a product list.', 422)
      ids = [...new Set([...values, ...(values.includes(sourceId) ? [] : [sourceId])])]
      draft.relationship!.includeSelf = values.includes(sourceId)
    }
  }
  draft.members = await readLinkedProducts(gql, ids)
  if (relationship) draft.baselineLinks = (await readLinkedFields(gql, ids.map(ownerId => ({ ownerId, namespace: relationship.namespace, key: relationship.key })))).map(f => ({ ...f, type: f.type || 'list.product_reference' }))
  return draft
}

/** Category checks are batched by owner/category and refreshed immediately before writes. */
async function verifyFieldApplicability(gql: ShopifyGraphql, changes: ShopifyFieldEdit[], schema: ShopifyStoreSchema) {
  const constrained = changes.flatMap(change => {
    const definition = schema.definitions.find(d => d.ownerType === 'PRODUCT' && change.ownerId.includes('/Product/') && d.namespace === change.namespace && d.key === change.key)
    return change.nextValue !== null && definition?.constraints?.key ? [{ change, definition }] : []
  })
  if (!constrained.length) return
  const rows = await readInformationNativeOwners(gql, [...new Set(constrained.map(({ change }) => change.ownerId))])
  const applicable = new Map<string, Set<string>>()
  for (const { change, definition } of constrained) {
    const category = rows.find(row => row.id === change.ownerId)?.values.category
    if (!category || definition.constraints!.key !== 'category') throw new WorkspaceScopeError(`${change.ownerLabel}: ${shopifyDefinitionApplicability(definition, category)}`, 422)
    if (!applicable.has(category)) applicable.set(category, await readApplicableShopifyDefinitions(gql, category))
    if (!applicable.get(category)!.has(definition.id)) throw new WorkspaceScopeError(`${change.ownerLabel}: This category-specific definition does not apply to the product’s current Shopify category. Existing values and draft edits are preserved.`, 422)
  }
}

/** Build the complete reviewed change set; never pass a productSet replacement list. */
export async function buildLinkedPlan(gql: ShopifyGraphql, draft: ShopifyLinkedDraft): Promise<ShopifyLinkedPlan> {
  const schema = await readLinkedStoreSchema(gql)
  if (draft.mediaEdits?.some(e => e.membershipChanged || e.altEdits?.length) && !schema.native?.scopes.includes('write_files')) throw new WorkspaceScopeError('Changing gallery attachments or shared-file alt text requires Shopify write_files permission.', 403)
  for (const edit of draft.nativeEdits ?? []) {
    const error = nativeSchemaError(schema, edit)
    if (error) throw new WorkspaceScopeError(`${edit.ownerLabel}: ${error}`, 422)
    if (edit.translation && (draft.nativeEdits?.some(source => source.ownerId === edit.ownerId && source.field === edit.translation!.fieldId) || draft.edits.some(source => source.id === edit.translation!.resourceId))) throw new WorkspaceScopeError('Synchronize source content before reviewing its translations, so their source digests remain current.', 422)
  }
  await readLinkedProducts(gql, [...new Set([...draft.members.map(m => m.id), ...draft.baselineLinks.map(f => f.ownerId)])])
  const shared = await resolveSharedContent(gql, draft, schema)
  const changes = [...linkedFamilyChanges(draft), ...draft.edits.filter(e => e.value !== e.nextValue), ...shared.changes]
  // A sibling that needed no change when imported may have changed remotely.
  // Validate every observed relationship, including the already-compliant rows.
  const links = await readLinkedFields(gql, draft.baselineLinks)
  if (draft.baselineLinks.some((f, i) => f.value !== links[i].value || f.compareDigest !== links[i].compareDigest || (f.value !== null && f.type !== links[i].type))) throw new WorkspaceScopeError('A family relationship changed in Shopify. Refresh Shopify and review the complete family again.')
  const reviewedFamily = new Set([...draft.members.map(m => m.id), ...draft.baselineLinks.map(f => f.ownerId)])
  for (const member of draft.members) {
    const field = draft.baselineLinks.find(f => f.ownerId === member.id)
    const references: string[] = field?.value ? JSON.parse(field.value) : []
    if (references.some(id => !reviewedFamily.has(id))) throw new WorkspaceScopeError(`${member.title} links to products outside this reviewed family. Import its complete family or add those products before replacing the links.`, 422)
  }
  const addresses = changes.map(fieldAddress)
  if (new Set(addresses).size !== addresses.length) throw new WorkspaceScopeError('Two changes target the same field. Resolve the duplicate before synchronizing.', 422)
  const observed = await readLinkedFields(gql, changes), owners = new Map<string, string>()
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i], live = observed[i]
    if (live.value !== change.value || live.compareDigest !== change.compareDigest || (live.value !== null && live.type !== change.type)) throw new WorkspaceScopeError(`${change.ownerLabel}: ${change.namespace}.${change.key} changed in Shopify. Review the latest values before synchronizing.`)
    const product = change.ownerId.includes('/Product/')
    if (!product && !owners.has(change.ownerId)) owners.set(change.ownerId, (await readLinkedOwner(gql, change.ownerId)).productId)
    const productId = product ? change.ownerId : owners.get(change.ownerId)
    if (!draft.members.some(m => m.id === productId) && !draft.baselineLinks.some(f => f.ownerId === change.ownerId && f.namespace === change.namespace && f.key === change.key)) throw new WorkspaceScopeError('A field edit targets a product outside this reviewed family.', 422)
    const definition = schema.definitions.find(d => d.ownerType === (product ? 'PRODUCT' : 'PRODUCTVARIANT') && d.namespace === change.namespace && d.key === change.key)
    if (definition?.readOnlyReason) throw new WorkspaceScopeError(definition.readOnlyReason, 422)
    if (!definition || definition.type !== change.type) throw new WorkspaceScopeError('A field definition changed or is missing. Refresh the store schema.', 422)
    if (change.nextValue !== null && definition.constraints?.key) {
      if (draft.nativeEdits?.some(e => e.ownerId === change.ownerId && e.field === 'category')) throw new WorkspaceScopeError('Synchronize the category change before its category-specific fields. The field drafts are preserved.', 422)
    }
    if (!schema.types.some(t => t.name === change.type)) throw new WorkspaceScopeError('Shopify no longer supports this field type. Its value is preserved.', 422)
    const error = validateShopifyField(definition ?? { type: change.type, validations: [] }, change.nextValue)
    if (error) throw new WorkspaceScopeError(`${change.ownerLabel} / ${definition?.name ?? change.key}: ${error}`, 422)
    if (change.nextValue !== null && change.type.includes('_reference')) {
      const ids: string[] = change.type.startsWith('list.') ? JSON.parse(change.nextValue) : [change.nextValue]
      for (let offset = 0; offset < ids.length; offset += 100) {
        const refs = await resolveLinkedReferences(gql, ids.slice(offset, offset + 100))
        const referenceError = shopifyReferenceError(definition, refs, schema)
        if (referenceError) throw new WorkspaceScopeError(`${change.ownerLabel}: ${referenceError}`, 422)
      }
    }
  }
  await verifyFieldApplicability(gql, changes, schema)
  const warnings = changes.some(c => c.nextValue === null) ? ['Clearing removes the selected metafield value from Shopify. Its definition remains.'] : []
  if (changes.length > 25 || changes.some(c => c.nextValue === null)) warnings.push('Shopify applies this plan in multiple operations. Progress is saved and interrupted operations can be resumed.')
  const information = await verifyInformationPlan(gql, draft)
  for (const edit of information.mediaEdits) {
    if (edit.altEdits?.length) warnings.push(`${edit.ownerLabel}: alt text belongs to the shared Shopify file and changes everywhere that file is used.`)
    if (edit.affectedVariants?.length) warnings.push(`${edit.ownerLabel}: removing gallery files also removes their image associations from ${edit.affectedVariants.map(v => v.title).join(', ')}.`)
  }
  if (information.nativeEdits.length || information.mediaEdits.length) warnings.push('Product fields and gallery order use separate Shopify operations. Concurrent external edits are checked by readback; these APIs do not offer an atomic compare-and-set.')
  return { changes, ...information, verification: shared.verification, sources: shared.sources, schemaRevision: schema.revision, warnings, revision: linkedDigest([schema.revision, changes, shared.verification, shared.sources, information]) }
}

export async function previewLinkedWorkspace(productId: string, scope: ContentScope) {
  const workspace = await getLinkedWorkspace(productId, scope), { graphql } = await shopifyAdmin(workspace.destination.accountId)
  const plan = await buildLinkedPlan(graphql, workspace.draft)
  if (workspace.hasSheetMedia) {
    const destination = await contentDestination(productId, scope), schema = await readShopifyMappingSchema(destination.accountId)
    const media = await readSheetGallerySources(prisma, destination, schema)
    plan.sheetGalleries = await reviewSheetGalleries(graphql, media.galleries, schema)
    if (plan.mediaEdits?.some(e => plan.sheetGalleries!.some(g => g.productId === e.productId))) throw new WorkspaceScopeError('An older native gallery draft overlaps this sheet gallery. Reconcile the recovered draft in Product family before reviewing media.', 422)
    plan.galleryRevision = media.revision; plan.warnings.push(...media.warnings)
    for (const gallery of plan.sheetGalleries) if (gallery.affectedVariants?.length) plan.warnings.push(`${gallery.ownerLabel}: replacing the gallery can remove image associations from ${gallery.affectedVariants.map(v => v.title).join(', ')}. These variants are included in this review.`)
    plan.revision = linkedDigest([plan.revision, plan.sheetGalleries, plan.galleryRevision])
  }
  return { workspace, plan }
}

/** Atomic set batches; ambiguous results are reconciled by exact value before retrying. */
export async function applyLinkedBatch(gql: ShopifyGraphql, changes: ShopifyFieldEdit[], schema?: ShopifyStoreSchema) {
  const live = await readLinkedFields(gql, changes)
  const pending: ShopifyFieldEdit[] = []
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i], current = live[i]
    if (current.value === change.nextValue && (current.value === null || current.type === change.type)) continue
    if (current.value !== change.value || current.compareDigest !== change.compareDigest || (current.value !== null && current.type !== change.type)) throw new WorkspaceScopeError(`${change.ownerLabel}: Shopify changed this field. Review the latest values before retrying.`)
    pending.push(change)
  }
  const sets = pending.filter(c => c.nextValue !== null), clears = pending.filter(c => c.nextValue === null)
  if (sets.length) await verifyFieldApplicability(gql, sets, schema ?? await readLinkedStoreSchema(gql))
  if (sets.length) assertShopifyResult((await gql(`mutation NexusLinkedSet($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { metafields { id } userErrors { field message } } }`, { metafields: sets.map(c => ({ ownerId: c.ownerId, namespace: c.namespace, key: c.key, type: c.type, value: c.nextValue, compareDigest: c.compareDigest })) })).metafieldsSet, 'Save Shopify fields')
  if (clears.length) assertShopifyResult((await gql(`mutation NexusLinkedClear($metafields:[MetafieldIdentifierInput!]!) { metafieldsDelete(metafields:$metafields) { userErrors { field message } } }`, { metafields: clears.map(c => ({ ownerId: c.ownerId, namespace: c.namespace, key: c.key })) })).metafieldsDelete, 'Clear Shopify fields')
  const verified = await readLinkedFields(gql, changes)
  if (changes.some((c, i) => verified[i].value !== c.nextValue || (c.nextValue !== null && verified[i].type !== c.type))) throw new WorkspaceScopeError('Shopify readback differs from the reviewed changes. Synchronization remains unverified.', 502)
}

export async function beginLinkedSync(productId: string, scope: ContentScope, body: unknown, origin: 'MANUAL' | 'AUTOMATIC' = 'MANUAL', actorUserId: string | null = null) {
  const input = object(body), destination = await contentDestination(productId, scope)
  const { workspace, plan } = await previewLinkedWorkspace(productId, scope)
  if (input.expectedRevision !== workspace.revision || input.planRevision !== plan.revision) throw new WorkspaceScopeError('The draft or Shopify changed after review. Refresh the review.')
  if (!plan.changes.length && !plan.nativeEdits?.length && !plan.mediaEdits?.length && !plan.sheetGalleries?.length) return workspace
  if (origin === 'AUTOMATIC' && (plan.nativeEdits?.length || plan.mediaEdits?.length || plan.sheetGalleries?.length)) throw new WorkspaceScopeError('Synchronize Information changes manually before enabling family automation.', 422)
  const gallerySchema = plan.galleryRevision ? await readShopifyMappingSchema(destination.accountId) : null
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (current.revision !== input.expectedRevision) throw new WorkspaceScopeError('The draft changed after review.')
    if (origin === 'AUTOMATIC' && current.workspace.automation?.mode !== 'AUTOMATIC') throw new WorkspaceScopeError('Automation is paused. Review its settings before continuing.')
    if (current.listing?.syncPaused || current.listing?.syncLocked) throw new WorkspaceScopeError('Synchronization is paused for this listing.', 422)
    if (current.operation && current.operation.status !== 'VERIFIED') throw new WorkspaceScopeError('Resume or reconcile the previous operation first.')
    if (gallerySchema && (await readSheetGallerySources(tx, destination, gallerySchema)).revision !== plan.galleryRevision) throw new WorkspaceScopeError('A gallery changed after review. Refresh the review before synchronizing.')
    const verification = new Map<string, ShopifyFieldEdit>(current.draft.baselineLinks.map(f => [fieldAddress(f), { ...f, nextValue: f.value, ownerLabel: 'Family member' }]))
    for (const change of [...(plan.verification ?? []), ...plan.changes]) verification.set(fieldAddress(change), change)
    const operation: Operation = { actorUserId, origin, sources: plan.sources, id: randomUUID(), status: 'RUNNING', changes: plan.changes, nativeEdits: plan.nativeEdits, mediaEdits: plan.mediaEdits, sheetGalleries: plan.sheetGalleries, galleryRevision: plan.galleryRevision, verification: [...verification.values()], completed: 0, error: null, schemaRevision: plan.schemaRevision, lease: null, leaseUntil: 0 }
    await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: operation })
    const saved = await linkedState(tx, destination)
    await auditLinkedChange(tx, destination, saved.listing!.id, actorUserId, 'shopify.sync.started', { status: 'REVIEWED' }, { changes: plan.changes, nativeEdits: plan.nativeEdits ?? [], mediaEdits: plan.mediaEdits ?? [], sheetGalleries: plan.sheetGalleries ?? [], origin }, operation.id)
    return (await linkedState(tx, destination)).workspace
  })
}

export async function advanceLinkedSync(productId: string, scope: ContentScope, operationId: string, automated = false, actorUserId: string | null = null) {
  const destination = await contentDestination(productId, scope), lease = randomUUID()
  let initialDraft: ShopifyLinkedDraft | null = null
  const operation = await linkedTransaction(async tx => {
    const current = await linkedState(tx, destination), op = current.operation
    initialDraft = current.draft
    if (!op || op.id !== operationId) throw new WorkspaceScopeError('This synchronization is unavailable. Reload its status.')
    if (op.status === 'VERIFIED') return op
    if (automated && (op.origin !== 'AUTOMATIC' || current.workspace.automation?.mode !== 'AUTOMATIC')) throw new WorkspaceScopeError('Automation is paused. Review or resume it before continuing.')
    if (op.lease && op.leaseUntil > Date.now()) throw new WorkspaceScopeError('This synchronization is already running. Reload its progress before retrying.')
    if (current.listing?.syncPaused || current.listing?.syncLocked) throw new WorkspaceScopeError('Synchronization is paused for this listing.', 422)
    const next = { ...op, lease, leaseUntil: Date.now() + 5 * 60_000, status: 'RUNNING' as const, error: null }
    await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: next }); return next
  })
  if (operation.status === 'VERIFIED') return getLinkedWorkspace(productId, scope)
  try {
    const { graphql } = await shopifyAdmin(destination.accountId)
    const schema = await readLinkedStoreSchema(graphql)
    if (schema.revision !== operation.schemaRevision) throw new WorkspaceScopeError('Shopify definitions changed during synchronization. Review the latest schema.')
    if (operation.galleryRevision && (await readSheetGallerySources(prisma, destination, schema)).revision !== operation.galleryRevision) throw new WorkspaceScopeError('The saved gallery changed during synchronization. Its newer draft and completed progress are retained.')
    await linkedTransaction(async tx => {
      const current = await linkedState(tx, destination)
      if (current.operation?.lease !== lease || current.operation.leaseUntil < Date.now()) throw new WorkspaceScopeError('This synchronization lease expired. Reload and resume its saved progress.')
      await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: { ...current.operation, leaseUntil: Date.now() + 5 * 60_000 } })
    })
    const sourceValues = await readLinkedFields(graphql, operation.sources ?? [])
    if (sourceValues.some((f, i) => { const before = operation.sources![i]; const edit = operation.changes.find(c => fieldAddress(c) === fieldAddress(f)); return !(f.value === before.value && f.compareDigest === before.compareDigest) && !(edit && f.value === edit.nextValue && f.type === edit.type) })) throw new WorkspaceScopeError('Shared source content changed during synchronization. Refresh and review its latest value.')
    let advanced = 0
    if (operation.completed < operation.changes.length) {
      const batch = operation.changes.slice(operation.completed, operation.completed + 25)
      await applyLinkedBatch(graphql, batch, schema); advanced = batch.length
    } else {
      const nativeIndex = operation.completed - operation.changes.length
      const native = operation.nativeEdits?.[nativeIndex]
      if (native) { await applyNativeEdit(graphql, native, operation.id); advanced = 1 }
      else {
        const media = operation.mediaEdits?.[nativeIndex - (operation.nativeEdits?.length ?? 0)]
        if (media) {
          const done = await advanceMediaOrder(graphql, media, operation.mediaJobs?.[media.productId], async state => {
            await linkedTransaction(async tx => {
              const current = await linkedState(tx, destination)
              if (current.operation?.lease !== lease || current.operation.leaseUntil < Date.now()) throw new WorkspaceScopeError('Synchronization ownership changed. Reload its progress.')
              operation.mediaJobs = { ...current.operation.mediaJobs, [media.productId]: state }
              await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: { ...current.operation, mediaJobs: operation.mediaJobs } })
            })
          })
          advanced = done ? 1 : 0
        }
        else {
          const index = nativeIndex - (operation.nativeEdits?.length ?? 0) - (operation.mediaEdits?.length ?? 0), gallery = operation.sheetGalleries?.[index]
          if (gallery) {
            const previous = operation.sheetGalleries!.slice(0, index).filter(g => g.productId === gallery.productId).at(-1)
            const value = previous ? operation.sheetGalleryJobs?.[previous.listingId]?.edit?.nextValue ?? gallery.value : gallery.value
            const done = await advanceSheetGallery(graphql, { ...gallery, value }, operation.sheetGalleryJobs?.[gallery.listingId], async state => {
              await linkedTransaction(async tx => {
                const current = await linkedState(tx, destination)
                if (current.operation?.lease !== lease || current.operation.leaseUntil < Date.now()) throw new WorkspaceScopeError('Synchronization ownership changed. Reload its progress.')
                operation.sheetGalleryJobs = { ...current.operation.sheetGalleryJobs, [gallery.listingId]: state }
                await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: { ...current.operation, sheetGalleryJobs: operation.sheetGalleryJobs } })
              })
            })
            advanced = done ? 1 : 0
          }
        }
      }
    }
    const completed = operation.completed + advanced, finished = completed === operationTotal(operation)
    const verified = new Map<string, ShopifyFieldSnapshot>()
    // Verify the whole plan before claiming family-wide completion, including earlier batches.
    if (finished) {
      const expected = operation.verification ?? operation.changes
      const all = await readLinkedFields(graphql, expected)
      if (expected.some((c, i) => all[i].value !== c.nextValue || (c.nextValue !== null && all[i].type !== c.type))) throw new WorkspaceScopeError('A family field changed before final verification. Review Shopify again.')
      for (const field of all) verified.set(fieldAddress(field), field)
      if (operation.nativeEdits?.length || operation.mediaEdits?.length) {
        const info = await readInformation(graphql, [...new Set([...(operation.nativeEdits ?? []), ...(operation.mediaEdits ?? [])].map(e => e.productId))], schema)
        if (operation.nativeEdits?.some(e => e.field !== 'translation' && !nativeEditVerified(e, info.rows.find(r => r.id === e.ownerId)?.values[e.field]))
          || operation.mediaEdits?.some(e => JSON.stringify(info.rows.find(r => r.id === e.productId)?.media.map(m => m.id)) !== JSON.stringify(e.nextValue) || e.altEdits?.some(a => info.rows.find(r => r.id === e.productId)?.media.find(m => m.id === a.id)?.alt !== a.nextValue))) throw new WorkspaceScopeError('Product information changed before final verification. Review Shopify again.')
        await verifyTranslationEdits(graphql, (operation.nativeEdits ?? []).filter(e => e.field === 'translation'), schema, 'result')
      }
      for (const gallery of operation.sheetGalleries ?? []) {
        const state = operation.sheetGalleryJobs?.[gallery.listingId]
        if (!state) throw new WorkspaceScopeError('Gallery progress is unavailable. Synchronization remains unverified.', 502)
        const last = operation.sheetGalleries!.filter(g => g.productId === gallery.productId).at(-1)!
        const finalEdit = operation.sheetGalleryJobs?.[last.listingId]?.edit
        await verifySheetGallery(graphql, gallery, { ...state, edit: finalEdit })
      }
    }
    const draftBefore = initialDraft as ShopifyLinkedDraft | null
    // Persist exactly the observations we verified. A later read must not silently
    // adopt a concurrent Shopify edit as the baseline of an automatic rule.
    const baselineLinks = finished && draftBefore?.relationship ? draftBefore.members.map(m => {
      const field = verified.get(fieldAddress({ ownerId: m.id, ...draftBefore.relationship! }))!
      return { ...field, type: field.type || 'list.product_reference' }
    }) : null
    const sharedBaselines = finished ? draftBefore?.sharedFields?.map(rule => ({ ...rule, baseline: rule.baseline.map(f => verified.get(fieldAddress(f)) ?? f) })) : null
    return linkedTransaction(async tx => {
      const current = await linkedState(tx, destination)
      if (current.operation?.lease !== lease || current.operation.id !== operationId) throw new WorkspaceScopeError('Synchronization ownership changed. Reload its progress.')
      const draft = structuredClone(current.draft)
      if (finished) {
        if (operation.galleryRevision && (await readSheetGallerySources(tx, destination, schema)).revision !== operation.galleryRevision) throw new WorkspaceScopeError('A gallery draft changed before verification could be saved. The newer input is retained.')
        const registry = informationRegistry(schema)
        for (const edit of [...draft.edits.map(e => ({ ownerId: e.ownerId, fieldId: `metafield:${e.ownerId.includes('/ProductVariant/') ? 'PRODUCTVARIANT' : 'PRODUCT'}:${e.namespace}.${e.key}`, locale: '', value: e.nextValue })), ...(draft.nativeEdits ?? []).map(e => ({ ownerId: e.ownerId, fieldId: e.translation?.fieldId ?? e.field, locale: e.translation?.locale ?? '', value: e.nextValue }))]) {
          if (edit.fieldId === 'inventory') continue
          const field = registry.find(f => f.id === edit.fieldId)
          if (!field) throw new WorkspaceScopeError('A verified field definition became unavailable before its listing override could be saved.')
          const saved = draft.sheetValues?.find(v => v.ownerId === edit.ownerId && v.fieldId === edit.fieldId && v.locale === edit.locale)
          draft.sheetValues = [...(draft.sheetValues ?? []).filter(v => v !== saved), { ...saved, ...edit, type: field.type }]
        }
        draft.edits = []
        if (draft.nativeEdits) draft.nativeEdits = []
        if (draft.mediaEdits) draft.mediaEdits = []
        draft.baselineLinks = baselineLinks ?? []
        if (draft.sharedFields) draft.sharedFields = sharedBaselines ?? []
        for (const gallery of operation.sheetGalleries ?? []) {
          const listing = await tx.channelListing.findFirst({ where: { id: gallery.listingId, productId: gallery.nexusProductId, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', channel: 'SHOPIFY', marketplace: destination.marketplace } })
          if (!listing) throw new WorkspaceScopeError('A gallery destination changed. Verification could not be saved.')
          const patch = { [SHEET_MEDIA_SYNC]: { signature: gallery.signature, verifiedAt: new Date().toISOString() } }
          if (listing.id === current.listing?.id) current.pa = { ...current.pa, ...patch }
          else {
            const result = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { platformAttributes: { ...object(listing.platformAttributes), ...patch }, version: { increment: 1 } } })
            if (result.count !== 1) throw new WorkspaceScopeError('The gallery draft changed before verification could be saved.')
          }
        }
      }
      await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: { ...operation, completed, status: finished ? 'VERIFIED' : 'RUNNING', error: null, lease: null, leaseUntil: 0 }, [LINKED_KEY]: draft })
      if (advanced || finished) await auditLinkedChange(tx, destination, current.listing!.id, actorUserId ?? operation.actorUserId ?? null, finished ? 'shopify.sync.verified' : 'shopify.sync.progress', { completed: operation.completed }, { completed, total: operationTotal(operation), status: finished ? 'VERIFIED' : 'RUNNING' }, operationId)
      return (await linkedState(tx, destination)).workspace
    })
  } catch (error) {
    await linkedTransaction(async tx => {
      const current = await linkedState(tx, destination)
      if (current.operation?.lease === lease) {
        const message = error instanceof Error ? error.message : 'The result could not be verified.'
        await writeLinkedState(tx, destination, current, { [OPERATION_KEY]: { ...current.operation, status: 'UNVERIFIED', error: message, lease: null, leaseUntil: 0 } })
        await auditLinkedChange(tx, destination, current.listing!.id, actorUserId ?? operation.actorUserId ?? null, 'shopify.sync.unverified', { completed: current.operation.completed }, { error: message, status: 'UNVERIFIED' }, operationId)
      }
    }).catch(() => {})
    throw error
  }
}

/** Explicit operator reconciliation keeps intended edits while adopting current remote baselines. */
export async function rebaseLinkedWorkspace(productId: string, scope: ContentScope, expectedRevision: string) {
  const destination = await contentDestination(productId, scope), initial = await linkedTransaction(tx => linkedState(tx, destination))
  if (initial.revision !== expectedRevision) throw new WorkspaceScopeError('The draft changed. Reload its saved state.')
  if (initial.operation?.lease && initial.operation.leaseUntil > Date.now()) throw new WorkspaceScopeError('Wait for the running synchronization before refreshing Shopify.')
  const { graphql } = await shopifyAdmin(destination.accountId), draft = structuredClone(initial.draft)
  const mediaJobs = [...Object.values(initial.operation?.mediaJobs ?? {}), ...Object.values(initial.operation?.sheetGalleryJobs ?? {}).flatMap(state => state.order ? [state.order] : [])]
  for (const state of mediaJobs) {
    if (state.submitted && !state.jobId) throw new WorkspaceScopeError('A submitted gallery reorder has no confirmed job ID. Reconcile its saved operation before replacing the review baseline.')
    if (state.jobId) {
      const { job } = await graphql('query NexusInformationMediaJob($id:ID!) { job(id:$id) { id done } }', { id: state.jobId })
      if (job?.id !== state.jobId || !job.done) throw new WorkspaceScopeError('Wait for the submitted Shopify media job to finish before refreshing the review baseline.')
    }
  }
  draft.members = await readLinkedProducts(graphql, draft.members.map(m => m.id))
  if (draft.relationship) {
    const ids = [...new Set([...draft.members.map(m => m.id), ...draft.baselineLinks.map(f => f.ownerId)])]
    draft.baselineLinks = (await readLinkedFields(graphql, ids.map(ownerId => ({ ownerId, namespace: draft.relationship!.namespace, key: draft.relationship!.key })))).map(f => ({ ...f, type: f.type || 'list.product_reference' }))
  }
  for (const rule of draft.sharedFields ?? []) rule.baseline = (await readLinkedFields(graphql, draft.members.map(m => ({ ownerId: m.id, namespace: rule.namespace, key: rule.key })))).map(f => ({ ...f, type: f.type || rule.baseline[0]?.type || 'single_line_text_field' }))
  const fields = await readLinkedFields(graphql, draft.edits)
  draft.edits = draft.edits.map((e, i) => ({ ...e, value: fields[i].value, compareDigest: fields[i].compareDigest })).filter(e => e.value !== e.nextValue)
  if (draft.nativeEdits?.length || draft.mediaEdits?.length) {
    const schema = await readLinkedStoreSchema(graphql), productIds = [...new Set([...(draft.nativeEdits ?? []), ...(draft.mediaEdits ?? [])].map(e => e.productId))]
    const info = await readInformation(graphql, productIds, schema)
    const localized = new Map<string, Awaited<ReturnType<typeof readInformation>>>()
    for (const locale of new Set((draft.nativeEdits ?? []).flatMap(e => e.translation ? [e.translation.locale] : []))) localized.set(locale, await readInformation(graphql, productIds, schema, locale))
    draft.nativeEdits = draft.nativeEdits?.map(e => {
      if (e.translation) {
        const source = localized.get(e.translation.locale)?.rows.find(r => r.id === e.ownerId)?.translations?.[e.translation.fieldId]
        if (!source || source.resourceId !== e.translation.resourceId) throw new WorkspaceScopeError('A translated source was removed or replaced. Its pending text is retained for review.')
        return { ...e, value: source.value, translation: { ...e.translation, digest: source.digest } }
      }
      const row = info.rows.find(r => r.id === e.ownerId)
      if (!row || !(e.field in row.values)) throw new WorkspaceScopeError('A changed field owner is unavailable. Its draft is preserved.')
      if (e.field === 'inventory') {
        const before = JSON.parse(e.value!), next = JSON.parse(e.nextValue!), live = JSON.parse(row.values.inventory!)
        for (const location of next.locations) {
          const old = before.locations.find((l: any) => l.locationId === location.locationId), current = live.locations.find((l: any) => l.locationId === location.locationId)
          if (!old || !current) throw new WorkspaceScopeError('A stocking location changed. Resolve the inventory intent before refreshing.')
          for (const key of ['available', 'onHand']) if (old[key] === location[key]) location[key] = current[key]
        }
        return { ...e, value: row.values.inventory, nextValue: JSON.stringify({ ...live, locations: next.locations }) }
      }
      return { ...e, value: row.values[e.field] }
    }).filter(e => !nativeValuesEqual(e.field, e.value, e.nextValue))
    draft.mediaEdits = draft.mediaEdits?.map(e => {
      const row = info.rows.find(r => r.id === e.productId), ids = row?.media.map(m => m.id)
      if (!ids || ids.some(id => !e.value.includes(id) && !e.nextValue.includes(id)) || e.nextValue.some(id => !ids.includes(id) && !e.added?.some(m => m.id === id))) throw new WorkspaceScopeError('Gallery membership changed outside the draft. Resolve the new or missing attachments before refreshing; your intent is preserved.')
      const added = e.added?.filter(m => !ids.includes(m.id))
      const altEdits = e.altEdits?.map(a => ({ ...a, value: row!.media.find(m => m.id === a.id)?.alt ?? added?.find(m => m.id === a.id)?.alt ?? a.value })).filter(a => a.value !== a.nextValue)
      return { ...e, value: ids, added, altEdits, affectedVariants: undefined }
    }).filter(e => JSON.stringify(e.value) !== JSON.stringify(e.nextValue) || !!e.altEdits?.length)
  }
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (current.revision !== expectedRevision) throw new WorkspaceScopeError('The draft changed while refreshing Shopify. Reload its saved state.')
    await writeLinkedState(tx, destination, current, { [LINKED_KEY]: draft, [OPERATION_KEY]: null, [AUTOMATION_KEY]: { ...current.workspace.automation, mode: 'PAUSED', status: 'IDLE', message: 'Shopify values refreshed. Review before resuming automation.' } })
    return (await linkedState(tx, destination)).workspace
  })
}
