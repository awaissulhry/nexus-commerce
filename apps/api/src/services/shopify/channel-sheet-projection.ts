import { completenessFor } from '../pim/sheet-rows.service.js'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { informationRestriction, informationSharingRule, informationSharedValue, informationSharingFacts, sharedInformationSource } from '@nexus/shared/shopify-information-editing'
import { createHash } from 'node:crypto'
import { informationRegistry, informationSheetValue, informationPendingValue, informationStoredValue, nativeFieldValueError, type InformationField, type InformationSnapshot } from '@nexus/shared/shopify-information'
import type { ShopifyLinkedDraft, ShopifyLinkedWorkspace, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { StudioSheet, StudioRow } from '../pim/studio-sheet.service.js'
import { shopifyInventoryHeldReason } from '../pim/shopify-inventory-hold.js'
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
/**
 * A cell's draft token: everything a save must find unchanged. The family root is its PHYSICAL listing id; an absent root
 * is named by its exact normalized alias key ('' for the primary listing), so two absent aliases with equal cells never
 * share a token. The same alias value is used by the projection, the save check, the continuation and the returned token.
 */
export function shopifyCellToken(workspace: ShopifyLinkedWorkspace, ownerId: string, field: InformationField, locale?: string, aliasKey = '') {
  let signature = fieldSignatures.get(field)
  if (!signature) { signature = linkedDigest(field); fieldSignatures.set(field, signature) }
  const rule = !locale && field.owner === 'PRODUCT' && field.definition ? workspace.draft.sharedFields?.find(r => r.namespace === field.definition!.namespace && r.key === field.definition!.key) : undefined
  const follows = rule && rule.sourceProductId !== ownerId && !rule.excludedProductIds.includes(ownerId)
  const shared = rule ? [rule.sourceProductId, rule.excludedProductIds.includes(ownerId), rule.baseline.find(v => v.ownerId === ownerId) ?? null,
    follows ? pendingRecord(workspace.draft, rule.sourceProductId, field) : null] : null
  const root = workspace.destination.listingId ?? ['absent-root', aliasKey]
  return linkedDigest([shared, workspace.destination.accountId, root, workspace.familyId, ownerId, locale ?? '', signature, pendingRecord(workspace.draft, ownerId, field, locale), workspace.draft.sheetValues?.find(v => v.ownerId === ownerId && v.fieldId === field.id && v.locale === (locale ?? '')) ?? null])
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
    if (row.listing && ['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(String(providerStatus))) row.listing = { ...row.listing, isPublished: providerStatus === 'ACTIVE', listingStatus: providerStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE', channelFactDetail: { ...row.listing.channelFactDetail, shopifyStatus: String(providerStatus) }, offerActiveHonoured: false }
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
      /**
       * 🔴 LX.6 — step 6's content-cell shortcut is REMOVED, not renamed.
       *
       * It read `base.requestedLocale && base.effectiveLocale` and set `needsTranslation`. LX.12
       * removed all four of those from `StudioCellValue` (`studio-sheet.service.ts:133` Omits
       * `requestedLocale` / `effectiveLocale` / `translationState` / `needsTranslation`), so:
       *   • it never COMPILED — `apps/api` tsc reported 5 errors on these two lines, invisible to
       *     steps 6 and 7 because both typechecked only their own files plus transitive imports and
       *     neither scope imports this projection;
       *   • it never RAN — `base` comes from `getStudioSheet` through `enrichShopifyChannelSheet`,
       *     and the step-6 (d) gate measured `Object.hasOwn(cell,'requestedLocale') === false` on
       *     that wire (`step6/screen-gate.mjs:188`, exit 1 for an unrelated reason at 01:31Z).
       * Its only unique effect would have been a second `needsTranslation` boolean; the write/CAS
       * address it installed is installed by the path below for every field anyway (`shopifyWrite`,
       * a few lines down). Deleting dead code that never compiled restores the build and changes no
       * behaviour — the 8 pre-existing `services/shopify` test failures are byte-identical before
       * and after (they are about "Shopify content requires hydrated pro…", a separate defect).
       */
      const pending = informationPendingValue(remote, field, workspace.draft), baseline = informationStoredValue(remote, field)
      const saved = workspace.draft.sheetValues?.find(v => v.ownerId === remote.id && v.fieldId === field.id && v.locale === (remote.locale ?? ''))
      const pin = saved && !saved.inherited ? saved : undefined
      const rule = informationSharingRule(remote, field, workspace.draft)
      const sharedValue = informationSharedValue(remote, field, workspace.draft, snapshot.rows)
      const excluded = !remote.locale && rule?.excludedProductIds.includes(remote.id) === true
      const sharedConflict = rule && rule.sourceProductId !== remote.id && !excluded && pin ? sharedInformationSource(rule, field, workspace.draft, snapshot.rows) : undefined
      const conflictMessage = 'The saved draft conflicts with the sharing rule. Shopify will use the shared source. Edit or reset this field to resolve it.'
      const mapped = !rule && field.id !== 'inventory' && base?.mapped?.status === 'mapped' && base.mapped.sourceOwner?.kind !== 'listing'
      // D2 = A (Amazon sheet gaps): while Nexus sends this listing's quantity, Shopify's own inventory field is held and
      // points to Qty — the read set it (`studio-sheet`); this projection rebuilds the cell, so it applies the same rule.
      const stockHeld = field.id === 'inventory' && !row.isParent ? shopifyInventoryHeldReason(row) : null
      const reason = stockHeld ?? (pin && pin.type !== field.type ? 'This definition changed type. The saved override is preserved; review and migrate it before editing.' : informationRestriction(remote, field, workspace.draft, active(workspace)))
      // The common content writer owns these values, source facts and save tokens. A provider read must not
      // replace a confirmed Nexus pin (including a blank). Keep older pending Shopify drafts visible for review.
      if (!rule && base?.contentAcknowledgement && pending === undefined && !pin) {
        row.values[column.key] = { ...base, shopifyWrite: undefined, editable: !reason, writable: !reason, writeBlockedReason: reason }
        continue
      }
      const value = pending !== undefined ? pending : pin ? pin.value : sharedValue ? sharedValue.value : mapped ? informationSheetValue(field, base.value) : baseline
      const ownValue = !sharedValue && (pending !== undefined || !!pin || !mapped)
      // Remaining fields are provider-owned facts. Only the content resolver above assigns language readiness.
      const pinned = excluded || !!pin || pending !== undefined && !saved?.inherited || !rule && !saved && !!base?.pinned
      row.values[column.key] = { ...base,
        ...(rule ? { contentAddress: undefined, contentAcknowledgement: undefined, contentVersion: undefined, contentAcknowledged: undefined,
          tier: undefined, language: undefined, requested: undefined, provenance: undefined, translation: undefined } : {}),
        divergence: sharedConflict ? { publishesAs: sharedConflict.value, note: conflictMessage } : rule ? undefined : base?.divergence,
        // `unsentDraft`: an edit saved in Nexus that Shopify does not have yet (a finished synchronization clears the
        // draft's edits and keeps the value as a saved pin). Additive, set only when true.
        value, nexusDraft: pending !== undefined || !!pin, ...(pending !== undefined ? { unsentDraft: true } : {}),
        // `channelOnly`: the Shared product supplies no value for this field here — no Shared mapping reaches it (`mapped`
        // above is false: no rule, a listing-owned source, inventory, or a Shopify sharing rule decides it). The value is
        // Shopify's own, or Nexus's pin or edit of it, and a reset returns Shopify's value, never the Shared product's.
        // `mapped` below is null for every value Nexus holds, so it cannot say this. Additive, set only when true.
        ...(!mapped ? { channelOnly: true } : {}),
        source: pinned || !mapped ? 'channelExplicit' : base.source,
        layer: sharedValue ? 'linked' : pinned || !mapped ? 'channel' : base.layer, pinned,
        inherited: !!sharedValue || !pinned && mapped, inheritedFrom: sharedValue ? productRows.get(sharedValue.sourceProductId) ?? null : mapped ? base.inheritedFrom : null, follows: sharedValue ? true : pinned ? false : mapped ? true : null,
        resettable: pinned || pending !== undefined || mapped, linkGroupId: null, mapped: rule || ownValue ? null : base.mapped, affectsAllChannels: false,
        ...(ownValue ? { needsTranslation: false, requestedLocale: undefined, effectiveLocale: undefined, translationState: undefined } : {}),
        writeField: column.writeField, writeTarget: 'channelListing', writeVerb: 'channel', editable: !reason, writable: !reason, writeBlockedReason: reason,
        shopifyWrite: { ownerId: remote.id, fieldId: field.id, token: shopifyCellToken(workspace, remote.id, field, remote.locale, aliasId ?? ''), baseline, sharing: informationSharingFacts(remote, field, workspace.draft) },
      }
      if (sharedConflict) fieldIssues.push({ key: column.key, label: column.label, message: conflictMessage, severity: 'warn' })
      if (ownValue || sharedValue) {
        refreshed.add(column.key)
        const error = value == null && pending === undefined && !pin && !sharedValue ? null : field.definition ? validateShopifyField(field.definition, value == null ? null : String(value))
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
