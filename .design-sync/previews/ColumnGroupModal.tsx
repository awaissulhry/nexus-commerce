// ColumnGroupModal — the flat-file editor's "Column groups" dialog: show, hide
// and reorder whole groups of columns at once.
// Composition ported from the eBay and Amazon flat-file clients
// (apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx), including
// the real group registry and its colour keys.
//
// `color` is a key into the modal's own dot map — slate, blue, purple, emerald,
// orange, teal, cyan, sky, amber, violet, red. Anything else falls back to slate.
//
// Rendered OPEN, which is the only state worth a card. The dialog portals to
// <body>, so two open stories in one grid paint over each other — this component
// needs cfg.overrides.ColumnGroupModal = {"cardMode":"single"}.
//
// Drag-to-reorder is a pointer gesture and is not statically renderable; the
// grip handle is present in every row and that is what the card can show.
import { useState } from 'react'
import { ColumnGroupModal, type ColumnGroup } from '@nexus/design-system'

const FLAT_FILE_GROUPS: ColumnGroup[] = [
  { id: 'identifiers', label: 'Identifiers', color: 'slate', columns: ['sku', 'row_action', 'parentage', 'parent_sku', 'ean', 'mpn'], visible: true },
  { id: 'listing', label: 'Listing', color: 'blue', columns: ['title', 'condition', 'category_id', 'variation_theme', 'subtitle', 'listing_format', 'listing_duration'], visible: true },
  { id: 'content', label: 'Content', color: 'purple', columns: ['description', 'description_theme'], visible: true },
  { id: 'pricing', label: 'Pricing', color: 'emerald', columns: ['price', 'best_offer_enabled', 'best_offer_floor', 'best_offer_ceiling', 'vat_rate'], visible: true },
  { id: 'inventory', label: 'Inventory', color: 'orange', columns: ['quantity', 'handling_time', 'quantity_limit_per_buyer'], visible: true },
  { id: 'shipping', label: 'Package & Shipping', color: 'cyan', columns: ['weight', 'length', 'width', 'height'], visible: false },
  { id: 'images', label: 'Images', color: 'teal', columns: ['image_1'], visible: true },
  { id: 'policies', label: 'Policies', color: 'sky', columns: ['payment_policy', 'return_policy', 'shipping_policy'], visible: false },
  { id: 'market-de', label: 'Germany (eBay.de)', color: 'violet', columns: ['de_title', 'de_price', 'de_quantity'], visible: true },
]

/** The whole registry: nine groups, two already hidden, each with its colour dot and column count. */
export const ManageGroups = () => {
  const [groups, setGroups] = useState<ColumnGroup[]>(FLAT_FILE_GROUPS)
  return <ColumnGroupModal open onClose={() => {}} groups={groups} onGroupsChange={setGroups} />
}

/** One group left visible: its toggle locks and the modal prints the reason under the list. */
export const LastVisibleGroup = () => {
  const [groups, setGroups] = useState<ColumnGroup[]>(
    FLAT_FILE_GROUPS.slice(0, 5).map((g) => ({ ...g, visible: g.id === 'identifiers' })),
  )
  return <ColumnGroupModal open onClose={() => {}} groups={groups} onGroupsChange={setGroups} />
}

/** A short registry — the Amazon flat file's four core groups, all showing. */
export const ShortRegistry = () => {
  const [groups, setGroups] = useState<ColumnGroup[]>([
    { id: 'identifiers', label: 'Identifiers', color: 'slate', columns: ['sku', 'asin', 'ean'], visible: true },
    { id: 'listing', label: 'Listing', color: 'blue', columns: ['item_name', 'product_type', 'brand'], visible: true },
    { id: 'pricing', label: 'Pricing', color: 'emerald', columns: ['standard_price', 'sale_price', 'vat_rate'], visible: true },
    { id: 'inventory', label: 'Inventory', color: 'orange', columns: ['quantity', 'fulfilment_latency'], visible: true },
  ])
  return <ColumnGroupModal open onClose={() => {}} groups={groups} onGroupsChange={setGroups} />
}
