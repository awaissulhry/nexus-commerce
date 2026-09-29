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

type FieldAddress = { namespace: string; key: string }
/**
 * Colour products (PR 4) own the two grouping fields of the family they manage (`fields`, from `colourManagedFields`):
 * no Product family link, and no edit, shared rule or change on either field, may write them there. Null: allowed.
 */
export function colourGroupingIssue(fields: readonly FieldAddress[] | null, draft: { relationship?: unknown; edits?: readonly FieldAddress[]; sharedFields?: readonly FieldAddress[] } | null | undefined, changes: readonly FieldAddress[] = []): string | null {
  if (!fields) return null
  if (draft?.relationship) return 'Colour products link this family on Shopify. Remove its links in Product family first.'
  const owned = (a: FieldAddress) => fields.some(f => f.namespace === a.namespace && f.key === a.key)
  if ([...changes, ...(draft?.edits ?? []), ...(draft?.sharedFields ?? [])].some(owned))
    return `Colour products write ${fields.map(f => `${f.namespace}.${f.key}`).join(' and ')} for this family. Remove those edits here; Nexus keeps both fields correct.`
  return null
}
