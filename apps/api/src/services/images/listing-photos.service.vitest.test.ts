import { describe, expect, it } from 'vitest'
import { readMediaCollection } from '@nexus/shared/product-media'
import { addLibraryPhotos, settleListingPhotos, settleListingsPhotos } from './listing-photos.service.js'

/** An in-memory stand-in for the few Prisma calls the photo settle makes. */
function store(seed: { listings: any[]; products: any[]; images: any[] }) {
  let n = 0
  const db = { listings: seed.listings.map(l => ({ version: 1, ...l })), products: seed.products.map(p => ({ version: 1, parentId: null, localizedContent: {}, deletedAt: null, ...p })),
    images: seed.images.map((image, i) => ({ sortOrder: i, mediaType: 'IMAGE', publicId: null, contentHash: null, createdAt: new Date(2026, 0, 1 + i), ...image })) }
  const pick = (row: any, select?: Record<string, boolean>) => select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key] ?? null])) : row
  const urlMatches = (url: string, where: any) => typeof where === 'string' ? url === where : where?.contains ? url.includes(where.contains) : false
  const tx: any = {
    channelListing: {
      findFirst: async ({ where, select }: any) => { const row = db.listings.find(l => l.id === where.id); return row ? pick(row, select) : null },
      updateMany: async ({ where, data }: any) => {
        const row = db.listings.find(l => l.id === where.id && l.version === where.version)
        if (!row) return { count: 0 }
        Object.assign(row, { platformAttributes: data.platformAttributes, version: row.version + 1 })
        return { count: 1 }
      },
    },
    product: {
      findFirst: async ({ where, select }: any) => { const row = db.products.find(p => p.id === where.id && !p.deletedAt); return row ? pick(row, select) : null },
      updateMany: async ({ where, data }: any) => {
        const row = db.products.find(p => p.id === where.id && p.version === where.version)
        if (!row) return { count: 0 }
        Object.assign(row, { localizedContent: data.localizedContent, version: row.version + 1 })
        return { count: 1 }
      },
    },
    productImage: {
      findMany: async ({ where, select }: any) => db.images.filter(i => where.productId.in.includes(i.productId))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).map(i => pick(i, select)),
      findFirst: async ({ where, select }: any) => {
        const row = db.images.filter(i => i.mediaType === where.mediaType && where.OR.some((or: any) => urlMatches(i.url, or.url)))
          .sort((a, b) => a.createdAt - b.createdAt)[0]
        return row ? pick(row, select) : null
      },
      create: async ({ data, select }: any) => { const row = { id: `new-${++n}`, createdAt: new Date(), ...data }; db.images.push(row); return pick(row, select) },
    },
  }
  return { db, tx }
}

const cdn = (path: string) => `https://res.cloudinary.com/demo-cloud/image/upload/${path}`
const ids = (content: unknown, locale = 'und') => readMediaCollection(content, locale)?.items.map(item => item.assetId)

describe('settleListingPhotos', () => {
  const seed = () => store({
    products: [{ id: 'fam' }, { id: 'red', parentId: 'fam' }, { id: 'other-fam' }],
    images: [
      { id: 'fam-main', productId: 'fam', url: cdn('v1/p/fam/main.jpg') },
      { id: 'fam-side', productId: 'fam', url: cdn('v1/p/fam/side.jpg') },
      // Another product of the business holds this photo: its size and hash are lent to the new row.
      { id: 'elsewhere', productId: 'other-fam', url: 'https://cdn.example/shared.jpg', width: 1600, height: 1200, contentHash: 'h-shared' },
    ],
    listings: [
      { id: 'l-red', channel: 'EBAY', productId: 'red', platformAttributes: { conditionId: 'NEW',
        imageUrls: ['https://i.ebayimg.com/images/g/x/s-l1600.jpg', cdn('w_800/v1/p/fam/side.jpg'), 'https://cdn.example/shared.jpg'] } },
      { id: 'l-amazon', channel: 'AMAZON', productId: 'red', platformAttributes: { imageUrls: ['https://cdn.example/a.jpg'] } },
      { id: 'l-done', channel: 'EBAY', productId: 'red', platformAttributes: { _productMediaLocales: {} } },
    ],
  })

  it('moves the old list into Product media in the same order: library photos used, the others added to the family library', async () => {
    const { db, tx } = seed()
    const result = await settleListingPhotos(tx, 'l-red')
    expect(result).toEqual({ settled: true, fromLibrary: 1, added: 2, rootId: 'fam' })
    const listing = db.listings.find(l => l.id === 'l-red')
    expect(listing.platformAttributes.imageUrls).toBeUndefined()
    expect(listing.platformAttributes.conditionId).toBe('NEW')
    const added = db.images.filter(i => i.productId === 'fam' && i.id.startsWith('new-'))
    expect(added.map(i => i.url)).toEqual(['https://i.ebayimg.com/images/g/x/s-l1600.jpg', 'https://cdn.example/shared.jpg'])
    expect(added[1]).toMatchObject({ width: 1600, height: 1200, contentHash: 'h-shared' })
    expect(ids(listing.platformAttributes._productMediaLocales)).toEqual([added[0].id, 'fam-side', added[1].id])
  })

  it('pins the family\'s list before its library grows, so other channels keep their photos', async () => {
    const { db, tx } = seed()
    await settleListingPhotos(tx, 'l-red')
    expect(ids(db.products.find(p => p.id === 'fam').localizedContent)).toEqual(['fam-main', 'fam-side'])
    expect(db.products.find(p => p.id === 'red').localizedContent).toEqual({})
  })

  it('does nothing for a listing without an old list, or one that is not eBay', async () => {
    const { db, tx } = seed()
    expect((await settleListingPhotos(tx, 'l-amazon')).settled).toBe(false)
    expect((await settleListingPhotos(tx, 'l-done')).settled).toBe(false)
    expect((await settleListingPhotos(tx, 'missing')).settled).toBe(false)
    expect(db.images).toHaveLength(3)
  })

  it('settles many listings once each and names the families to refresh', async () => {
    const { tx } = seed()
    expect(await settleListingsPhotos(tx, ['l-red', 'l-red', 'l-amazon'])).toEqual({ settled: 1, added: 2, rootIds: ['fam'] })
  })
})

describe('addLibraryPhotos', () => {
  it('reuses the family\'s photo with the same bytes instead of a second row', async () => {
    const { db, tx } = store({ listings: [], products: [{ id: 'fam', localizedContent: { und: { _productMedia: { version: 1, items: [{ assetId: 'own' }] } } } }, { id: 'row', parentId: 'fam' }],
      images: [{ id: 'own', productId: 'fam', url: 'https://cdn.example/own.jpg', contentHash: 'h1' }, { id: 'twin', productId: 'other', url: 'https://cdn.example/twin.jpg', contentHash: 'h1' }] })
    const added = await addLibraryPhotos(tx, { productId: 'row', urls: ['https://cdn.example/twin.jpg'] })
    expect(added.get('https://cdn.example/twin.jpg')?.id).toBe('own')
    expect(db.images).toHaveLength(2)
    // The family already had its own list: it is not rewritten.
    expect(db.products[0].version).toBe(1)
  })

  it('pins nothing on an empty library', async () => {
    const { db, tx } = store({ listings: [], products: [{ id: 'fam' }], images: [] })
    await addLibraryPhotos(tx, { productId: 'fam', urls: ['https://cdn.example/first.jpg'] })
    expect(db.products[0].localizedContent).toEqual({})
    expect(db.images.map(i => i.productId)).toEqual(['fam'])
  })
})
