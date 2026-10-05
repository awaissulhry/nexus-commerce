import { describe, expect, it, vi } from 'vitest'
import { readMediaCollection } from '@nexus/shared/product-media'
import { addLibraryPhotos, settleListingPhotos, settleListingsPhotos } from './listing-photos.service.js'

/** An in-memory stand-in for the few Prisma calls the photo settle makes. */
function store(seed: { listings: any[]; products: any[]; images: any[] }) {
  let n = 0
  const db = { listings: seed.listings.map(l => ({ version: 1, ...l })), products: seed.products.map(p => ({ version: 1, parentId: null, localizedContent: {}, deletedAt: null, ...p })),
    images: seed.images.map((image, i) => ({ sortOrder: i, mediaType: 'IMAGE', publicId: null, contentHash: null, createdAt: new Date(2026, 0, 1 + i), ...image })) }
  const pick = (row: any, select?: Record<string, boolean>) => select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key] ?? null])) : row
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
        const row = db.images.filter(i => i.mediaType === where.mediaType && i.url === where.url)
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

vi.mock('./media-plan-switch.js', () => ({ isOnMediaPlan: async (id: string) => id === 'plan-fam' }))

describe('settleListingPhotos', () => {
  const seed = () => store({
    products: [{ id: 'fam' }, { id: 'red', parentId: 'fam' }, { id: 'plan-fam' }],
    images: [
      { id: 'fam-main', productId: 'fam', url: cdn('v1/p/fam/main.jpg') },
      { id: 'fam-side', productId: 'fam', url: cdn('v1/p/fam/side.jpg') },
      { id: 'red-own', productId: 'red', url: 'https://cdn.example/red.jpg' },
    ],
    listings: [
      // Every address is a library photo: the side photo under another version marker, the row's own photo, the main one.
      { id: 'l-red', channel: 'EBAY', productId: 'red', platformAttributes: { conditionId: 'NEW', imageUrls: [cdn('v9/p/fam/side.jpg'), 'https://cdn.example/red.jpg', cdn('v1/p/fam/main.jpg')] } },
      { id: 'l-mixed', channel: 'EBAY', productId: 'red', platformAttributes: { imageUrls: ['https://i.ebayimg.com/images/g/x/s-l1600.jpg', cdn('v1/p/fam/main.jpg')] } },
      { id: 'l-sized', channel: 'EBAY', productId: 'red', platformAttributes: { imageUrls: [cdn('w_800/v1/p/fam/main.jpg')] } },
      { id: 'l-plan', channel: 'EBAY', productId: 'plan-fam', platformAttributes: { imageUrls: [] } },
      { id: 'l-amazon', channel: 'AMAZON', productId: 'red', platformAttributes: { imageUrls: ['https://cdn.example/red.jpg'] } },
      { id: 'l-done', channel: 'EBAY', productId: 'red', platformAttributes: { _productMediaLocales: {} } },
    ],
  })

  it('makes a list of library photos the listing\'s Product media, in the same order, and writes nothing else', async () => {
    const { db, tx } = seed()
    expect(await settleListingPhotos(tx, 'l-red')).toEqual({ settled: true, outside: 0, rootId: 'fam' })
    const listing = db.listings.find(l => l.id === 'l-red')
    expect(listing.platformAttributes.imageUrls).toBeUndefined()
    expect(listing.platformAttributes.conditionId).toBe('NEW')
    expect(ids(listing.platformAttributes._productMediaLocales)).toEqual(['fam-side', 'red-own', 'fam-main'])
    expect(db.images).toHaveLength(3)
    expect(db.products.every(p => p.version === 1)).toBe(true)
  })

  it('keeps the old list when any address is not a library photo — another site, or another rendering of a library photo', async () => {
    const { db, tx } = seed()
    expect(await settleListingPhotos(tx, 'l-mixed')).toEqual({ settled: false, outside: 1, rootId: null })
    expect(await settleListingPhotos(tx, 'l-sized')).toEqual({ settled: false, outside: 1, rootId: null })
    expect(db.listings.find(l => l.id === 'l-mixed').platformAttributes.imageUrls).toHaveLength(2)
    expect(db.images).toHaveLength(3)
  })

  it('does nothing for a family on the photo plan, a listing without an old list, or one that is not eBay', async () => {
    const { db, tx } = seed()
    expect(await settleListingPhotos(tx, 'l-plan')).toEqual({ settled: false, outside: 0, plan: true, rootId: null })
    expect((await settleListingPhotos(tx, 'l-amazon')).settled).toBe(false)
    expect((await settleListingPhotos(tx, 'l-done')).settled).toBe(false)
    expect((await settleListingPhotos(tx, 'missing')).settled).toBe(false)
    expect(db.listings.find(l => l.id === 'l-plan').platformAttributes.imageUrls).toEqual([])
  })

  it('settles many listings once each and names the families to refresh', async () => {
    const { tx } = seed()
    expect(await settleListingsPhotos(tx, ['l-red', 'l-red', 'l-mixed', 'l-amazon'])).toEqual({ settled: 1, kept: 1, rootIds: ['fam'] })
  })
})

describe('addLibraryPhotos (a save the person made in Product media)', () => {
  it('adds the photo to the row\'s own library, pinning the list it followed first', async () => {
    const { db, tx } = store({ listings: [], products: [{ id: 'fam' }, { id: 'row', parentId: 'fam' }],
      images: [{ id: 'fam-main', productId: 'fam', url: 'https://cdn.example/main.jpg' }, { id: 'elsewhere', productId: 'other', url: 'https://cdn.example/new.jpg', width: 1600, contentHash: 'h9' }] })
    const added = await addLibraryPhotos(tx, { productId: 'row', urls: ['https://cdn.example/new.jpg'] })
    const created = db.images.find(i => i.id === added.get('https://cdn.example/new.jpg')?.id)
    expect(created).toMatchObject({ productId: 'row', width: 1600, contentHash: 'h9' })
    expect(ids(db.products.find(p => p.id === 'row').localizedContent)).toEqual(['fam-main'])
    expect(db.products.find(p => p.id === 'fam').localizedContent).toEqual({})
  })

  it('reuses the row\'s photo with the same bytes instead of a second row', async () => {
    const { db, tx } = store({ listings: [], products: [{ id: 'row', localizedContent: { und: { _productMedia: { version: 1, items: [{ assetId: 'own' }] } } } }],
      images: [{ id: 'own', productId: 'row', url: 'https://cdn.example/own.jpg', contentHash: 'h1' }, { id: 'twin', productId: 'other', url: 'https://cdn.example/twin.jpg', contentHash: 'h1' }] })
    const added = await addLibraryPhotos(tx, { productId: 'row', urls: ['https://cdn.example/twin.jpg'] })
    expect(added.get('https://cdn.example/twin.jpg')?.id).toBe('own')
    expect(db.images).toHaveLength(2)
    expect(db.products[0].version).toBe(1)
  })

  it('pins nothing when the row and its family have no photos', async () => {
    const { db, tx } = store({ listings: [], products: [{ id: 'row' }], images: [] })
    await addLibraryPhotos(tx, { productId: 'row', urls: ['https://cdn.example/first.jpg'] })
    expect(db.products[0].localizedContent).toEqual({})
  })
})
