import { definitionAddress, type ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'

/** Only the reviewed Shopify workspace may write its intent, authority and checkpoints. */
export const isManagedShopifyAttribute = (key: string) => ['_nexusLinkedProducts', '_nexusLinkedProductsOperation', '_nexusLinkedAutomation', '_nexusSheetMediaSync'].includes(key)

export function shopifyInformationPublicationIssue(attributes: unknown): string | null {
  const pa = attributes && typeof attributes === 'object' ? attributes as Record<string, any> : {}
  const draft = pa._nexusLinkedProducts
  if (draft?.version !== 1) return null
  if (!draft.informationOnly || draft.relationship) return 'This family uses separate Shopify products. Manage its links in Product family and its fields in Information.'
  if (draft.edits?.length || draft.nativeEdits?.length || draft.mediaEdits?.length || draft.sharedFields?.length || (pa._nexusLinkedProductsOperation && pa._nexusLinkedProductsOperation.status !== 'VERIFIED')) return 'Information has pending changes or shared rules. Synchronize those changes and pause shared rules before reviewing a full product publication.'
  return null
}

type Address = { namespace: string; key: string }
/**
 * Colour products (PR 4) own the two grouping fields (`grouping`, from `colourGrouping`): of the family they manage, and
 * of every confirmed colour product of the store. No Product family link, edit, shared rule or change may write them
 * there. Null: allowed.
 */
export function colourGroupingIssue(grouping: { fields: readonly Address[]; family: boolean; products: readonly string[] } | null,
  draft: Pick<ShopifyLinkedDraft, 'relationship' | 'members' | 'edits' | 'sharedFields'>, changes: ReadonlyArray<Address & { ownerId: string }> = []): string | null {
  if (!grouping) return null
  const owned = new Set(grouping.fields.map(definitionAddress)), colourProduct = new Set(grouping.products)
  if (grouping.family && draft.relationship) return 'Colour products link this family on Shopify. Remove its links in Product family first.'
  if (draft.relationship && owned.has(definitionAddress(draft.relationship)) && draft.members.some(m => colourProduct.has(m.id)))
    return 'Some of these products are colour products of another family, and colour products write their colour list. Remove them from this Product family.'
  const written = (a: Address & { ownerId: string }) => owned.has(definitionAddress(a)) && (grouping.family || colourProduct.has(a.ownerId))
  if ([...changes, ...draft.edits].some(written) || (grouping.family && (draft.sharedFields ?? []).some(f => owned.has(definitionAddress(f)))))
    return `Colour products write ${grouping.fields.map(definitionAddress).join(' and ')} on these products. Remove those edits here; Nexus keeps both fields correct.`
  return null
}
