import type { NativeEdit } from '@nexus/shared/shopify-information'
import { collectShopifyPages } from './linked-products-gateway.js'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

export interface PublicationValue { publicationId: string; publishDate: string | null }
export async function readInformationPublications(gql: ShopifyGraphql, productId: string): Promise<PublicationValue[]> {
  const rows = await collectShopifyPages<any>(async after => {
    const { product } = await gql(`query NexusInformationPublications($id:ID!,$after:String) { product(id:$id) {
      resourcePublicationsV2(first:100,after:$after,onlyPublished:false) { nodes { isPublished publishDate publication { id } } pageInfo { hasNextPage endCursor } }
    } }`, { id: productId, after })
    if (!product) throw new WorkspaceScopeError('The Shopify product is unavailable.', 404)
    return product.resourcePublicationsV2
  })
  return rows.filter(r => r.isPublished || r.publishDate && Date.parse(r.publishDate) > Date.now()).map(r => ({ publicationId: r.publication.id,
    publishDate: !r.isPublished && r.publishDate ? new Date(r.publishDate).toISOString() : null })).sort((a, b) => a.publicationId.localeCompare(b.publicationId))
}
const same = (a: PublicationValue | undefined, b: PublicationValue | undefined) => a?.publicationId === b?.publicationId && a?.publishDate === b?.publishDate
/** Each publication is reconciled independently after interruption; unrelated memberships stay intact. */
export async function applyInformationPublications(gql: ShopifyGraphql, edit: NativeEdit) {
  const before: PublicationValue[] = JSON.parse(edit.value ?? '[]'), after: PublicationValue[] = JSON.parse(edit.nextValue ?? '[]')
  const current = await readInformationPublications(gql, edit.productId)
  const ids = new Set([...before, ...after, ...current].map(p => p.publicationId))
  const remove: { publicationId: string }[] = [], publish: PublicationValue[] = []
  for (const id of ids) {
    const old = before.find(p => p.publicationId === id), next = after.find(p => p.publicationId === id), live = current.find(p => p.publicationId === id)
    if (same(live, next)) continue
    if (!same(live, old)) throw new WorkspaceScopeError('A publication changed in Shopify. Review its current visibility and schedule.', 409)
    if (next) publish.push(next); else remove.push({ publicationId: id })
  }
  if (remove.length) assertShopifyResult((await gql('mutation NexusInformationUnpublish($id:ID!,$input:[PublicationInput!]!) { publishableUnpublish(id:$id,input:$input) { userErrors { field message } } }', { id: edit.productId, input: remove })).publishableUnpublish, 'Remove product publications')
  if (publish.length) assertShopifyResult((await gql('mutation NexusInformationPublish($id:ID!,$input:[PublicationInput!]!) { publishablePublish(id:$id,input:$input) { userErrors { field message } } }', { id: edit.productId, input: publish.map(p => ({ publicationId: p.publicationId, ...(p.publishDate ? { publishDate: p.publishDate } : {}) })) })).publishablePublish, 'Set product publications')
  const verified = await readInformationPublications(gql, edit.productId)
  if (verified.length !== after.length || verified.some(v => !same(v, after.find(a => a.publicationId === v.publicationId)))) throw new WorkspaceScopeError('Shopify has not confirmed every publication. The saved intent is retained.', 502)
}
