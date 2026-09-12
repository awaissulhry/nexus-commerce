import { completenessFor } from '../pim/sheet-rows.service.js'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { informationRestriction } from '@nexus/shared/shopify-information-editing'
import { createHash } from 'node:crypto'
import { informationRegistry, informationSheetValue, informationPendingValue, informationStoredValue, nativeFieldValueError, type InformationField, type InformationSnapshot } from '@nexus/shared/shopify-information'
import type { ShopifyLinkedDraft, ShopifyLinkedWorkspace, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { StudioSheet, StudioRow } from '../pim/studio-sheet.service.js'
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const linkedDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type ListingIdentity = { id: string; productId: string; externalListingId: string | null; platformAttributes: unknown }
const gid = (type: string, value: unknown) => typeof value === 'string' && new RegExp(`^(gid://shopify/${type}/)?\\d+$`).test(value) ? value.startsWith('gid:') ? value : `gid://shopify/${type}/${value}` : null
export const active = (workspace: ShopifyLinkedWorkspace) => !!workspace.operation && workspace.operation.status !== 'VERIFIED'

function pendingRecord(draft: ShopifyLinkedDraft, ownerId: string, field: InformationField, locale?: string) {
  if (locale) return draft.nativeEdits?.find(e => e.ownerId === ownerId && e.translation?.locale === locale && e.translation.fieldId === field.id) ?? null
  if (field.id === 'media') return draft.mediaEdits?.find(e => e.productId === ownerId) ?? null
  return field.definition ? draft.edits.find(e => e.ownerId === ownerId && e.namespace === field.definition!.namespace && e.key === field.definition!.key) ?? null
    : draft.nativeEdits?.find(e => e.ownerId === ownerId && e.field === field.id) ?? null
}
const fieldSignatures = new WeakMap<InformationField, string>()
export function shopifyCellToken(workspace: ShopifyLinkedWorkspace, ownerId: string, field: InformationField, locale?: string) {
  let signature = fieldSignatures.get(field)
  if (!signature) { signature = linkedDigest(field); fieldSignatures.set(field, signature) }
  return linkedDigest([workspace.destination.accountId, workspace.destination.listingId, workspace.familyId, ownerId, locale ?? '', signature, pendingRecord(workspace.draft, ownerId, field, locale), workspace.draft.sheetValues?.find(v => v.ownerId === ownerId && v.fieldId === field.id && v.locale === (locale ?? '')) ?? null])
}

/** Keep the common sheet's Nexus identities and hierarchy. Shopify owners are cell addresses,
 * resolved only from persisted listing IDs; a remote owner never creates another grid row. */
export function projectShopifyChannelSheet(page: StudioSheet, workspace: ShopifyLinkedWorkspace, snapshot: InformationSnapshot, schema: ShopifyStoreSchema, listings: ListingIdentity[], aliasId: string | null): StudioRow[] {
  const baseRows = page.rows.filter(r => r.aliasId === aliasId)
  // Imported families can have attributed child listings before the family draft row exists.
  // Any exact listing in this alias can anchor the family workspace; never create one on read.
  const listingId = workspace.destination.listingId ?? listings[0]?.id
  if (!listingId) return baseRows
  const fields = new Map(informationRegistry(schema).map(field => [field.id, field]))
  const owners = new Map(snapshot.rows.map(owner => [owner.id, owner]))
  const rootListing = listings.find(listing => listing.productId === workspace.familyId)
  const published = object(object(rootListing?.platformAttributes)._nexusContentPublish)
  const variantIds = object(published.variantIds)
  const identities = new Map(baseRows.map(row => {
    const listing = listings.find(listing => listing.productId === row.id), pa = object(listing?.platformAttributes)
    const variantId = gid('ProductVariant', pa.variantId) ?? gid('ProductVariant', variantIds[row.id])
    const variant = variantId ? owners.get(variantId) : undefined
    const productId = gid('Product', listing?.externalListingId) ?? gid('Product', pa.shopifyProductId) ?? variant?.productId
    return [row.id, { product: productId ? owners.get(productId) : undefined, variant }]
  }))
  // One canonical Nexus row owns product-level fields when several Nexus variants share a product.
  const productRows = new Map<string, string>()
  for (const row of [...baseRows].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId))) {
    const product = identities.get(row.id)?.product
    if (product && !productRows.has(product.id)) productRows.set(product.id, row.id)
  }
  return baseRows.map(shared => {
    const identity = identities.get(shared.id)!
    if (!identity.product && !identity.variant) return shared
    const row: StudioRow = { ...shared, values: { ...shared.values },
      shopify: { productId: workspace.productId, listingId },
    }
    // A persisted Shopify ID proves linkage, not publication. A provider draft
    // or archived product must never acquire a Live label from that ID alone.
    const providerStatus = identity.product?.values.status
    if (row.listing && (providerStatus === 'DRAFT' || providerStatus === 'ARCHIVED')) row.listing = { ...row.listing, isPublished: false, listingStatus: providerStatus }
    const inapplicable = new Set<string>()
    const refreshed = new Set<string>()
    const fieldIssues: StudioRow['readiness']['issues'] = []
    for (const column of page.columns) {
      const field = column.shopifyField ? fields.get(column.shopifyField.id) : undefined
      const base = shared.values[column.key]
      // Media uses the same library, collection editor, CAS and reviewed publication adapter as
      // every other channel. Legacy native-gallery intent remains in the linked review document.
      if (!field || field.id === 'media') continue
      const remote = field.owner === 'PRODUCT' && identity.product && productRows.get(identity.product.id) === row.id
        ? identity.product : field.owner === 'PRODUCTVARIANT' ? identity.variant : undefined
      if (!remote) {
        inapplicable.add(column.key)
        row.values[column.key] = { ...base, writable: false, editable: false, writeBlockedReason: field.owner === 'PRODUCT'
          ? 'Edit this field on the product row that owns this Shopify listing.'
          : 'This Nexus row has no persisted Shopify variant identity. Link or publish the variant before editing its Shopify value.' }
        continue
      }
      const pending = informationPendingValue(remote, field, workspace.draft), baseline = informationStoredValue(remote, field)
      const saved = workspace.draft.sheetValues?.find(v => v.ownerId === remote.id && v.fieldId === field.id && v.locale === (remote.locale ?? ''))
      const pin = saved && !saved.inherited ? saved : undefined
      const mapped = field.id !== 'inventory' && base?.mapped?.status === 'mapped' && base.mapped.sourceOwner?.kind !== 'listing'
      const reason = pin && pin.type !== field.type ? 'This definition changed type. The saved override is preserved; review and migrate it before editing.' : informationRestriction(remote, field, workspace.draft, active(workspace))
      const value = pending !== undefined ? pending : pin ? pin.value : mapped ? informationSheetValue(field, base.value) : baseline
      const ownValue = pending !== undefined || !!pin || !mapped
      const localized = column.storage === 'localizedContent' || !!remote.translations?.[field.id]
      const translation = remote.translations?.[field.id]
      const translationState = pending !== undefined || !!pin ? 'draft' : translation?.outdated ? 'outdated' : translation && translation.value === null ? 'missing' : 'current'
      const pinned = !!pin || pending !== undefined && !saved?.inherited || !saved && !!base?.pinned
      row.values[column.key] = { ...base, value, nexusDraft: pending !== undefined || !!pin, source: pinned || !mapped ? 'channelExplicit' : base.source,
        layer: pinned || !mapped ? 'channel' : base.layer, pinned,
        inherited: !pinned && mapped, inheritedFrom: mapped ? base.inheritedFrom : null, follows: pinned ? false : mapped ? true : null,
        resettable: !!pin || pending !== undefined || mapped, linkGroupId: null, mapped: ownValue ? null : base.mapped, affectsAllChannels: false,
        ...(ownValue ? { needsTranslation: localized && ['outdated', 'missing'].includes(translationState), requestedLocale: localized ? page.scope.locale ?? undefined : undefined, effectiveLocale: localized ? remote.locale ?? schema.locales.find(l => l.primary)?.locale : undefined, translationState: localized ? translationState : undefined } : {}),
        writeField: column.writeField, writeTarget: 'channelListing', writeVerb: 'channel', editable: !reason, writable: !reason, writeBlockedReason: reason,
        shopifyWrite: { ownerId: remote.id, fieldId: field.id, token: shopifyCellToken(workspace, remote.id, field, remote.locale), baseline },
      }
      if (ownValue) {
        refreshed.add(column.key)
        const error = value == null && pending === undefined && !pin ? null : field.definition ? validateShopifyField(field.definition, value == null ? null : String(value))
          : field.id !== 'media' && !field.reason ? nativeFieldValueError(field.id as any, value == null ? null : String(value), baseline) : null
        if (error) fieldIssues.push({ key: column.key, label: column.label, message: error, severity: 'error' })
        if (pin && pin.type !== field.type) fieldIssues.push({ key: column.key, label: column.label, message: reason!, severity: 'error' })
      }
    }
    if (row.completeness && row.readiness) {
      row.completeness = completenessFor(page.columns.filter(c => !inapplicable.has(c.key)), row, row.values)
      const issues = [...row.readiness.issues.filter(i => !inapplicable.has(i.key) && !refreshed.has(i.key)), ...fieldIssues]
      for (const missing of row.completeness.required.missing) if (!issues.some(i => i.key === missing.key && i.severity === 'error')) issues.push({ key: missing.key, label: missing.label, message: 'Required Information value is missing for this owner and language.', severity: 'error' })
      row.readiness = { ...row.readiness, issues, state: issues.some(i => i.severity === 'error') ? 'errors' : issues.length ? 'missing' : row.listing?.isPublished ? 'live' : 'ready' }
    }
    return row
  })
}
