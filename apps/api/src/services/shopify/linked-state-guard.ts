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
