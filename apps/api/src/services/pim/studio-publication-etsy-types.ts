/** E1 — the Etsy studio publication contract (types only + one constant). B1 owns it; B2 and B3 import it. */
import type { StudioPublishChange, StudioPublishFieldWrite, StudioPublishIssue, StudioPublishRemoval } from '@nexus/shared/studio-publication'
import type { EtsyInventoryWrite, EtsyWriteOffering } from '../etsy/inventory.js'

export type ProductIdentity = { productId: string; sku: string }
/** How a NEW Etsy listing starts (Owner D1 = A): the main row's Inactive = Etsy draft; Active is refused in E1–E3. */
export type EtsyCreateState = 'draft' | 'active'

/** One property value as updateListingProperty and the inventory PUT take it (R1 §3–4). Diff by `values` text, never by `value_ids`. */
export interface EtsyPropertyValue { property_id: number; property_name: string; value_ids: number[]; values: string[]; scale_id: number | null }

/** Listing-level change fields: one change each, on the owner (main) row. */
export const ETSY_LISTING_FIELDS = ['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shop_section_id',
  'shipping_profile_id', 'return_policy_id', 'item_weight', 'item_dimensions', 'is_taxable', 'should_auto_renew', 'production_partner_ids', 'styles'] as const
export type EtsyListingField = typeof ETSY_LISTING_FIELDS[number]

/**
 * Listing values in ONE shape for Nexus (B1 builder) and Etsy (B2 normaliser). Rules both sides keep: strings trimmed,
 * '' → null; ids and measures as numbers; lists in the source's order (B1 compares tags/materials/styles as
 * case-insensitive sets); `production_partner_ids` sorted ascending; a unit is null when its value(s) are null.
 */
export interface EtsyListingValues {
  title: string | null; description: string | null; tags: string[]; materials: string[]; taxonomy_id: number | null
  /** Etsy takes these three together (R1 §1): one change. */
  classification: { who_made: string | null; when_made: string | null; is_supply: boolean | null }
  type: string | null; shop_section_id: number | null; shipping_profile_id: number | null; return_policy_id: number | null
  item_weight: { value: number | null; unit: string | null }
  item_dimensions: { length: number | null; width: number | null; height: number | null; unit: string | null }
  is_taxable: boolean | null; should_auto_renew: boolean | null; production_partner_ids: number[]; styles: string[]
}

/** The variation structure the `inventory` change compares (no price, quantity or ids: those are not compared). */
export interface EtsyInventoryStructure {
  /** Variation properties in order (0–2 in E1). */
  properties: Array<{ property_id: number; property_name: string; scale_id: number | null }>
  /** One per Etsy product, sorted by sku; `values` in `properties` order. */
  products: Array<{ sku: string; values: Array<{ property_id: number; values: string[] }>; readiness_state_id: number | null }>
}

export interface EtsyTranslation { language: string; title: string | null; description: string | null; tags: string[] }

/** B2's normalised live read. Deterministic: two reads of the same Etsy state give equal JSON (no timestamps, counters, raw). */
export interface EtsyLiveListing {
  listingId: string
  state: string | null
  language: string | null
  values: EtsyListingValues
  /** Fields Etsy's read does not report, with why (e.g. production_partner_ids). Their channel side is unknown. */
  unread: Partial<Record<EtsyListingField, string>>
  /** getListingProperties, sorted by property_id (includes properties used as variations; B1 filters). */
  properties: EtsyPropertyValue[]
  inventory: EtsyInventoryStructure
  /** Each live product's first live offering by SKU, as the PUT takes it (price = moneyToNumber). */
  offerings: Record<string, EtsyWriteOffering>
  /** Live products with no SKU (Nexus cannot match them; a full replace would delete them). */
  unnamedProducts: number
  /** null = Etsy's translations could not be read. */
  translations: EtsyTranslation[] | null
  shop: { languages: string[]; currencyCode: string | null }
  /** Distinct `currency_code`s of the live offering prices. */
  priceCurrencies: string[]
  /** publicationDigest of { state, values, properties, inventory, translations } (offerings left out: stock moves often). */
  revision: string
}
export interface EtsyLiveReadInput { accountId: string; listingId: string }
export type EtsyLiveReader = (input: EtsyLiveReadInput) => Promise<EtsyLiveListing>

/** createDraftListing / updateListing form fields, exactly as sent (R1 §1–2). */
export type EtsyFormKey = 'quantity' | 'title' | 'description' | 'price' | 'who_made' | 'when_made' | 'taxonomy_id' | 'is_supply' | 'type' | 'tags'
  | 'materials' | 'styles' | 'shop_section_id' | 'shipping_profile_id' | 'return_policy_id' | 'readiness_state_id' | 'item_weight' | 'item_weight_unit'
  | 'item_length' | 'item_width' | 'item_height' | 'item_dimensions_unit' | 'is_taxable' | 'should_auto_renew' | 'production_partner_ids'
export type EtsyListingForm = Partial<Record<EtsyFormKey, string | number | boolean | Array<string | number>>>

export interface EtsyPublication {
  kind: 'etsy'
  marketplace: string
  /** This business's Etsy listing id (externalListingId); null for a new listing. Never a shop id (that is read at send). */
  listingId: string | null
  /** Every included product with the exact SKU sent, the main row included: baseline and journal identity (S:309–313). */
  products: ProductIdentity[]
  /** The Etsy inventory products: a family's children, or the single product. */
  inventoryProducts: ProductIdentity[]
  ownerProductId: string
  values: EtsyListingValues
  /** The full createDraftListing body (new listing); built for an existing one too (the change values come from `values`). */
  form: EtsyListingForm
  /** The full inventory PUT body from Nexus (offerings from Nexus). */
  inventory: EtsyInventoryWrite
  structure: EtsyInventoryStructure
  /** Non-variation listing properties (updateListingProperty). */
  properties: EtsyPropertyValue[]
  /** Languages after the listing's own (Shop.languages[1..]). */
  translations: EtsyTranslation[]
  /** New listing: how it starts and the POST's own price/quantity (Etsy refuses quantity 0, D2). */
  create: { state: EtsyCreateState; price: number; quantity: number } | null
  live: EtsyLiveListing | null
  liveRevision: string | null
  liveReadError?: string
  /** Why Etsy was not read for an existing listing (sending is not live): every change of that listing is refused with it. */
  liveSkipped?: string
  notices?: string[]
  fieldWrites?: Record<string, StudioPublishFieldWrite[]>
}

export interface EtsyChangePlan {
  kind: 'etsy-changes'
  changes: StudioPublishChange[]
  /** live revision; 'new' for a create; 'unavailable' when the read failed. */
  remoteRevision: string
  publication: EtsyPublication
  products: ProductIdentity[]
  ownerProductId: string
  createWrites: Record<string, StudioPublishFieldWrite[]>
  removals?: StudioPublishRemoval[]
  fullIssues?: StudioPublishIssue[]
}

export interface EtsyCall { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; encoding: 'form' | 'json' | 'none'; body: Record<string, unknown> | null; note?: string }
/** The calls a send would make, in order. Paths use the literal `{shop_id}` (and `{listing_id}` for a new listing). */
export interface EtsyWireRequest { operation: 'createDraftListing' | 'updateListing'; listingId: string | null; calls: EtsyCall[] }
export type EtsyCompiled = EtsyPublication & { products: ProductIdentity[]; fieldWrites: Record<string, StudioPublishFieldWrite[]>; request: EtsyWireRequest | null }
