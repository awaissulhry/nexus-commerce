import { resolveMediaCollection } from '@nexus/shared/product-media'
import type { PublicationFacts } from './studio-publication-plan.js'
import { object } from './studio-publication-plan.js'

/** Same saved collection, locale inheritance and order as the studio Images cell. */
export function publicationImages(facts: PublicationFacts, product: PublicationFacts['products'][number]) {
  const listing = facts.listings.find(l => l.productId === product.id)
  const parent = product.id === facts.parent.id ? undefined : facts.parent
  const files = [...product.images, ...(parent?.images ?? [])]
  const { collection } = resolveMediaCollection({ locale: facts.languages[0], own: object(listing?.platformAttributes)._productMediaLocales,
    shared: product.localizedContent, parent: parent?.localizedContent, ownIds: product.images.map(i => i.id), parentIds: parent?.images.map(i => i.id) ?? [] })
  return collection.items.map(item => {
    const file = files.find(f => f.id === item.assetId)
    if (!file) throw new Error(`${product.sku}: a saved gallery file is missing. Review Images before publishing.`)
    if (file.mediaType && file.mediaType !== 'IMAGE') throw new Error(`${product.sku}: the saved gallery includes a video that requires the channel's media workflow.`)
    if (!/^https:\/\//i.test(file.url)) throw new Error(`${product.sku}: product images need publicly accessible HTTPS URLs.`)
    return file.url
  })
}
