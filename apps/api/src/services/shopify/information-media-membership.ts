import type { MediaOrderEdit } from '@nexus/shared/shopify-information'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { readInformationMedia } from './information-gateway.js'
import { collectShopifyPages } from './linked-products-gateway.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

export async function mediaRemovalVariants(gql: ShopifyGraphql, edit: MediaOrderEdit) {
  const removed = edit.value.filter(id => !edit.nextValue.includes(id))
  if (!removed.length) return []
  const variants = await collectShopifyPages<any>(async after => (await gql(`query NexusInformationMediaVariants($id:ID!,$after:String) { product(id:$id) {
    variants(first:100,after:$after) { nodes { id title media(first:250) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage endCursor } }
  } }`, { id: edit.productId, after })).product?.variants, 10000)
  if (variants.some(v => v.media.pageInfo.hasNextPage)) throw new WorkspaceScopeError('Variant media could not be read completely. Refresh before removing gallery items.', 502)
  return variants.flatMap(v => { const mediaIds = v.media.nodes.map((m: any) => m.id).filter((id: string) => removed.includes(id)); return mediaIds.length ? [{ id: v.id, title: v.title, mediaIds }] : [] })
}
export async function verifyMediaMembership(gql: ShopifyGraphql, edit: MediaOrderEdit) {
  if (edit.added?.length) {
    const ids = edit.added.map(m => m.id)
    const { nodes } = await gql(`query NexusInformationAddedFiles($ids:[ID!]!) { nodes(ids:$ids) { ... on File { id fileStatus __typename } } }`, { ids })
    if (nodes.length !== ids.length || nodes.some((n: any, i: number) => n?.id !== ids[i] || n.fileStatus !== 'READY' || !['MediaImage', 'Video', 'Model3d'].includes(n.__typename))) throw new WorkspaceScopeError('A selected gallery file is unavailable, incompatible or still processing in this store.', 422)
  }
  const current = await readInformationMedia(gql, edit.productId)
  if (edit.altEdits?.some(a => current.find(m => m.id === a.id)?.alt !== a.value && edit.added?.find(m => m.id === a.id)?.alt !== a.value)) throw new WorkspaceScopeError('Shared-file alt text changed. Review its current value before synchronization.', 409)
  return { ...edit, affectedVariants: await mediaRemovalVariants(gql, edit) }
}
/** Exact product associations only. File deletion is never used. External videos are
 * product-specific embeds and use the pinned, deprecated product media operation. */
export async function applyMediaMembership(gql: ShopifyGraphql, edit: MediaOrderEdit) {
  const current = await readInformationMedia(gql, edit.productId), ids = current.map(m => m.id)
  const keep = edit.value.filter(id => edit.nextValue.includes(id))
  if (ids.some(id => !edit.value.includes(id) && !edit.nextValue.includes(id)) || keep.some(id => !ids.includes(id))) throw new WorkspaceScopeError('Gallery membership changed outside the reviewed plan.', 409)
  const affected = await mediaRemovalVariants(gql, { ...edit, value: ids })
  if (affected.some(v => !edit.affectedVariants?.some(old => old.id === v.id && v.mediaIds.every(id => old.mediaIds.includes(id))))) throw new WorkspaceScopeError('A removed file now supplies another variant image. Review the gallery again before removing it.', 409)
  const fileUpdates = [
    ...edit.nextValue.filter(id => !ids.includes(id)).map(id => ({ id, referencesToAdd: [edit.productId] })),
    ...ids.filter(id => !edit.nextValue.includes(id) && !id.includes('/ExternalVideo/')).map(id => ({ id, referencesToRemove: [edit.productId] })),
  ]
  for (let offset = 0; offset < fileUpdates.length; offset += 250) assertShopifyResult((await gql(`mutation NexusInformationFileReferences($files:[FileUpdateInput!]!) {
    fileUpdate(files:$files) { files { id } userErrors { field message } }
  }`, { files: fileUpdates.slice(offset, offset + 250) })).fileUpdate, 'Update product media associations')
  const embeds = ids.filter(id => !edit.nextValue.includes(id) && id.includes('/ExternalVideo/'))
  if (embeds.length) {
    const { productDeleteMedia } = await gql(`mutation NexusInformationRemoveEmbeds($id:ID!,$ids:[ID!]!) { productDeleteMedia(productId:$id,mediaIds:$ids) { deletedMediaIds mediaUserErrors { field message } } }`, { id: edit.productId, ids: embeds })
    if (!productDeleteMedia || productDeleteMedia.mediaUserErrors?.length) throw new WorkspaceScopeError(productDeleteMedia?.mediaUserErrors?.map((e: any) => e.message).join('; ') || 'The embed removal is unverified.', 502)
  }
  const altSnapshot = edit.altEdits?.length ? await readInformationMedia(gql, edit.productId) : []
  const fileAlts: { id: string; alt: string }[] = [], embedAlts: { id: string; alt: string }[] = []
  for (const change of edit.altEdits ?? []) {
    const live = altSnapshot.find(m => m.id === change.id)
    if (live?.alt === change.nextValue) continue
    if (!live || live.alt !== change.value) throw new WorkspaceScopeError('The shared-file alt text changed. Your intended text is retained.', 409)
    ;(change.id.includes('/ExternalVideo/') ? embedAlts : fileAlts).push({ id: change.id, alt: change.nextValue })
  }
  for (let offset = 0; offset < fileAlts.length; offset += 250) assertShopifyResult((await gql(`mutation NexusInformationFileAlt($files:[FileUpdateInput!]!) { fileUpdate(files:$files) { files { id } userErrors { field message } } }`, { files: fileAlts.slice(offset, offset + 250) })).fileUpdate, 'Update shared-file alt text')
  if (embedAlts.length) {
    const { productUpdateMedia } = await gql(`mutation NexusInformationEmbedAlt($id:ID!,$media:[UpdateMediaInput!]!) { productUpdateMedia(productId:$id,media:$media) { media { id } mediaUserErrors { field message } } }`, { id: edit.productId, media: embedAlts })
    if (!productUpdateMedia || productUpdateMedia.mediaUserErrors?.length) throw new WorkspaceScopeError('Shopify could not confirm the embed alt text.', 502)
  }
  const verified = await readInformationMedia(gql, edit.productId)
  if (verified.length !== edit.nextValue.length || verified.some(m => !edit.nextValue.includes(m.id)) || edit.altEdits?.some(a => verified.find(m => m.id === a.id)?.alt !== a.nextValue)) throw new WorkspaceScopeError('Shopify has not confirmed the gallery associations and metadata. Resume the saved operation to reconcile them.', 502)
  return verified
}
