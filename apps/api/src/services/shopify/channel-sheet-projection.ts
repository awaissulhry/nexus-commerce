import { completenessFor } from '../pim/sheet-rows.service.js'
import { shopifyValuesEqual, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { informationRestriction, informationSharingRule, informationSharedValue, informationSharingFacts, sharedInformationSource } from '@nexus/shared/shopify-information-editing'
import { createHash } from 'node:crypto'
import { informationRegistry, informationSheetValue, informationPendingValue, informationStoredValue, nativeFieldValueError, nativeValuesEqual, shopifyWeightGrams, shopifyWeightSymbol, type InformationField, type InformationSnapshot } from '@nexus/shared/shopify-information'
import type { ShopifyLinkedDraft, ShopifyLinkedWorkspace, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { StudioSheet, StudioRow } from '../pim/studio-sheet.service.js'
import { shopifyInventoryHeldReason } from '../pim/shopify-inventory-hold.js'
import { SHOPIFY_STATUS_FROM_STATUS_COLUMN } from '@nexus/shared/listing-actions'
import { listingShopifyProductId, shopifyProductOwners } from './product-owner-row.js'
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const linkedDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type ListingIdentity = { id: string; productId: string; externalListingId: string | null; platformAttributes: unknown }
const gid = (type: string, value: unknown) => typeof value === 'string' && new RegExp(`^(gid://shopify/${type}/)?\\d+$`).test(value) ? value.startsWith('gid:') ? value : `gid://shopify/${type}/${value}` : null
export const active = (workspace: ShopifyLinkedWorkspace) => !!workspace.operation && workspace.operation.status !== 'VERIFIED'

/**
 * S1 item 5 (f), Owner decision 11 — the native fields whose Shared value a synchronisation of a Nexus-created product
 * DOES send (`productSet` / the price sync): title, description, vendor, product type, price, SKU. Every other native or
 * metafield value of a product already on Shopify changes only through an edit here, so a Shared value that differs
 * from Shopify's is marked on the cell (`liveSharedDivergence`).
 */
const SENT_FROM_SHARED = new Set(['title', 'descriptionHtml', 'vendor', 'productType', 'price', 'sku'])
/**
 * Wave 2 D3 — native fields whose default rule speaks only when Nexus CREATES the product (the theme template's "nexus"):
 * a product already on Shopify shows and keeps Shopify's own value, with no mark (nothing would send the default).
 */
const CREATE_ONLY_DEFAULTS = new Set(['templateSuffix'])

/**
 * Wave 2 D4 (Owner decision 9) — a row NOT on Shopify yet (no persisted Shopify product or variant): its "Shopify status"
 * cell is read-only and shows what Publish creates — the Status column's choice (`shopifyCreateStatus`): ACTIVE, DRAFT,
 * or nothing ("Not set") when the Status column says Not listed. A row already on Shopify keeps its own editable cell.
 * `create` null = the family's main product is on Shopify here (nothing to create): the rows are left as they are. Pure.
 */
export function withShopifyCreateStatus(rows: StudioRow[], columns: Array<{ key: string; shopifyField?: { id: string } }>, aliasId: string | null,
  create: { status: 'ACTIVE' | 'DRAFT' | null } | null): StudioRow[] {
  const keys = columns.filter(column => column.shopifyField?.id === 'status').map(column => column.key)
  if (!create || !keys.length) return rows
  return rows.map(row => {
    if (row.aliasId !== aliasId || row.shopify) return row
    const values = { ...row.values }
    for (const key of keys) {
      const base = values[key]
      if (!base) continue
      values[key] = { ...base, value: create.status, source: 'channelExplicit', layer: 'channel', pinned: false, inherited: false, follows: null,
        nexusDraft: false, unsentDraft: undefined, channelOnly: true, mapped: null, divergence: undefined, resettable: false, shopifyWrite: undefined,
        editable: false, writable: false, writeBlockedReason: SHOPIFY_STATUS_FROM_STATUS_COLUMN }
    }
    const readiness = row.readiness ? { ...row.readiness, issues: row.readiness.issues.filter(issue => !keys.includes(issue.key)) } : row.readiness
    return { ...row, values, readiness }
  })
}
/** Shopify's value as a person reads it: a weight as "1.2 kg", a list as its items, a description as its text, nothing as "no value". */
function shopifyValueWords(field: InformationField, value: string | null): string {
  if (value == null || value === '') return 'no value'
  try {
    const parsed = JSON.parse(value)
    if (!field.definition && field.id === 'weight' && parsed && typeof parsed === 'object') return `${parsed.value} ${shopifyWeightSymbol(parsed.unit)}`
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed.length ? parsed.join(', ') : 'no value'
  } catch { /* plain text */ }
  const text = !field.definition && field.id === 'descriptionHtml' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || 'no value' : value
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}
const valueText = (value: unknown) => value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
/** A Nexus value and Shopify's are the same value: a weight in grams (1.2 kg equals 1200 g), a JSON value in any key order. */
function sameShopifyValue(field: InformationField, text: string | null, shopify: string | null): boolean {
  const grams = !field.definition && field.id === 'weight' ? shopifyWeightGrams(text) : null
  // A JSON value in another key order, spacing or number spelling is the same value (`shopifyValuesEqual`): no mark.
  return grams !== null ? grams === shopifyWeightGrams(shopify) : (text ?? '') === (shopify ?? '') || nativeValuesEqual(field.id, text, shopify)
    || field.type === 'json' && shopifyValuesEqual(field.type, text, shopify)
}
/**
 * A live cell that follows Shared while Shopify keeps another value: the value Shopify has and why it stays. A weight is
 * compared in grams (1.2 kg equals 1200 g). Null when they agree, or for a field a synchronisation sends from Shared.
 */
export function liveSharedDivergence(field: InformationField, shared: unknown, shopify: string | null): { publishesAs: string | null; note: string } | null {
  if (!field.definition && SENT_FROM_SHARED.has(field.id)) return null
  if (sameShopifyValue(field, valueText(shared), shopify)) return null
  return { publishesAs: shopify, note: `Shopify keeps ${shopifyValueWords(field, shopify)}. Shared changes are not sent to a product already on Shopify; enter the value here to send it.` }
}

/**
 * An adopted colour product (`colour-products/confirm.service.ts`): Nexus links the store's product and holds nothing
 * of it. Its title and description and its price, vendor and product type cells show the STORE's value, read live,
 * while Nexus holds no value of its own for that listing (a pin, a saved draft, an edit waiting). Showing it sends
 * nothing and makes nothing sendable.
 */
const COLOUR_STORE_FIELDS = new Set(['title', 'descriptionHtml', 'vendor', 'productType', 'price'])
/** Nexus holds a content pin for this listing (the content resolver's `pin` tier, not a following snapshot). */
const contentPinned = (cell: { tier?: string; follows?: boolean | null } | undefined) => cell?.tier === 'pin' && cell.follows === false
/**
 * The note on such a cell when the Nexus value differs from the store's: what Shopify keeps and what Nexus holds.
 * `nexusValue` is the Nexus value, so the cell's pop-up can name both. Null when they agree.
 */
export function colourStoreDivergence(field: InformationField, nexus: unknown, shopify: string | null): { publishesAs: string | null; note: string; nexusValue: unknown } | null {
  const text = valueText(nexus)
  if (sameShopifyValue(field, text, shopify)) return null
  // A text in quotes (a title ends with its own full stop); a price and "no value" as they are.
  const say = (value: string | null) => { const words = shopifyValueWords(field, value); return words === 'no value' || field.id === 'price' ? words : `“${words}”` }
  return { publishesAs: shopify, nexusValue: nexus ?? null, note: `Shopify keeps ${say(shopify)}. Nexus holds ${say(text)}; this colour product shows the store’s value.` }
}

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
    const productId = listingShopifyProductId(listing) ?? variant?.productId
    // An adopted colour product (`colour-products/confirm.service.ts`): this size listing is linked to its colour.
    return [row.id, { product: productId ? owners.get(productId) : undefined, variant, colour: typeof pa.shopifyColourProductId === 'string' && !!pa.shopifyColourProductId }]
  }))
  // One canonical Nexus row owns product-level fields when several Nexus variants share a product — the rule the Shopify
  // product CSV import records them by (`product-owner-row.ts`).
  const productRows = new Map([...shopifyProductOwners(baseRows, row => identities.get(row.id)?.product?.id, row => !!row.parentId)].map(([product, row]) => [product, row.id]))
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
      const mapped = !rule && field.id !== 'inventory' && !CREATE_ONLY_DEFAULTS.has(field.id) && base?.mapped?.status === 'mapped' && base.mapped.sourceOwner?.kind !== 'listing'
      // D2 = A (Amazon sheet gaps): while Nexus sends this listing's quantity, Shopify's own inventory field is held and
      // points to Qty — the read set it (`studio-sheet`); this projection rebuilds the cell, so it applies the same rule.
      const stockHeld = field.id === 'inventory' && !row.isParent ? shopifyInventoryHeldReason(row) : null
      const reason = stockHeld ?? (pin && pin.type !== field.type ? 'This definition changed type. The saved override is preserved; review and migrate it before editing.' : informationRestriction(remote, field, workspace.draft, active(workspace)))
      // An adopted colour product shows the store's value of these fields while Nexus holds none of its own here.
      const colourStore = identity.colour && !field.definition && COLOUR_STORE_FIELDS.has(field.id)
      // The common content writer owns these values, source facts and save tokens. A provider read must not
      // replace a confirmed Nexus pin (including a blank). Keep older pending Shopify drafts visible for review.
      if (!rule && base?.contentAcknowledgement && pending === undefined && !pin) {
        // A colour product's title or description with no Nexus pin for this listing: the store's text, with a note when
        // Nexus's text differs. The content writer stays the cell's writer (an edit saves a pin, which this cell then shows).
        const store = colourStore && !contentPinned(base) ? { value: baseline, divergence: colourStoreDivergence(field, base.value, baseline) ?? base.divergence } : null
        if (store) refreshed.add(column.key)
        row.values[column.key] = { ...base, ...store, shopifyWrite: undefined, editable: !reason, writable: !reason, writeBlockedReason: reason }
        continue
      }
      const ownValue = !sharedValue && (pending !== undefined || !!pin || !mapped)
      // Remaining fields are provider-owned facts. Only the content resolver above assigns language readiness.
      const pinned = excluded || !!pin || pending !== undefined && !saved?.inherited || !rule && !saved && !!base?.pinned
      // A colour product's Shared value with no Nexus value of the listing's own: the cell shows the store's value instead.
      const storeShown = colourStore && mapped && !pinned && pending === undefined && !pin && !sharedValue
      const value = pending !== undefined ? pending : pin ? pin.value : sharedValue ? sharedValue.value : mapped && !storeShown ? informationSheetValue(field, base.value) : baseline
      // S1 item 5 (f) — this cell shows the Shared value of a product Shopify already holds; Shopify keeps its own value.
      // A pending edit or a pin is the operator's own value, so it carries no mark. A colour product's cell shows the
      // store's value and names the Shared value Nexus holds when it differs.
      const keeps = storeShown ? colourStoreDivergence(field, informationSheetValue(field, base.value), baseline)
        : mapped && !pinned && pending === undefined && !pin && !sharedValue ? liveSharedDivergence(field, value, baseline) : null
      row.values[column.key] = { ...base,
        ...(rule ? { contentAddress: undefined, contentAcknowledgement: undefined, contentVersion: undefined, contentAcknowledged: undefined,
          tier: undefined, language: undefined, requested: undefined, provenance: undefined, translation: undefined } : {}),
        divergence: sharedConflict ? { publishesAs: sharedConflict.value, note: conflictMessage } : rule ? undefined : keeps ?? base?.divergence,
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
