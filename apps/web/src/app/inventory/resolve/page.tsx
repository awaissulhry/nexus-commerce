import { PrismaClient } from '@prisma/client'
import PageHeader from '@/components/layout/PageHeader'
import ChannelResolverClient from '@/components/inventory/ChannelResolverClient'

export const dynamic = 'force-dynamic'

interface UnmatchedListing {
  id: string
  externalListingId: string
  externalSku: string
  listingUrl: string
  listingStatus: string
  currentPrice: number | null
  quantity: number | null
}

interface Product {
  id: string
  sku: string
  name: string
}

async function getUnmatchedListings(): Promise<{
  connectionId: string
  listings: UnmatchedListing[]
}> {
  try {
    const prisma = new PrismaClient()

    // Get the first active eBay connection
    const connection = await (prisma as any).channelConnection.findFirst({
      where: {
        channel: 'EBAY',
        isActive: true,
      },
    })

    if (!connection) {
      await prisma.$disconnect()
      return {
        connectionId: '',
        listings: [],
      }
    }

    // Get all unmatched listings for this connection
    const listings = await (prisma as any).variantChannelListing.findMany({
      where: {
        channelConnectionId: connection.id,
        variantId: null, // Unmatched listings have no variant
      },
    })

    await prisma.$disconnect()

    return {
      connectionId: connection.id,
      listings: listings.map((listing: any) => ({
        id: listing.id,
        externalListingId: listing.externalListingId || '',
        externalSku: listing.externalSku || '',
        listingUrl: listing.listingUrl || '',
        listingStatus: listing.listingStatus || 'PENDING',
        currentPrice: listing.currentPrice ? Number(listing.currentPrice) : null,
        quantity: listing.quantity || 0,
      })),
    }
  } catch (error) {
    console.error('Error fetching unmatched listings:', error)
    return {
      connectionId: '',
      listings: [],
    }
  }
}

async function getAllProducts(): Promise<Product[]> {
  try {
    const prisma = new PrismaClient()

    // Fetch all products with their variations
    const products = await prisma.product.findMany({
      select: {
        id: true,
        sku: true,
        name: true,
        variations: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    })

    await prisma.$disconnect()

    // Flatten to include both parent products and variations
    const allProducts: Product[] = []

    for (const product of products) {
      // Add parent product
      allProducts.push({
        id: product.id,
        sku: product.sku || '',
        name: product.name,
      })

      // Add variations
      for (const variation of product.variations) {
        allProducts.push({
          id: variation.id,
          sku: variation.sku || '',
          name: `${product.name} - ${variation.name || ''}`.trim(),
        })
      }
    }

    return allProducts
  } catch (error) {
    console.error('Error fetching products:', error)
    return []
  }
}

export default async function ChannelResolverPage() {
  const [unmatchedData, products] = await Promise.all([
    getUnmatchedListings(),
    getAllProducts(),
  ])

  return (
    <div>
      <PageHeader
        title="Resolve Unmatched Listings"
        subtitle="Link eBay listings to your Nexus products"
        breadcrumbs={[
          { label: 'Products', href: '/products' },
          { label: 'Resolve Listings' },
        ]}
      />

      <div className="mt-6">
        <ChannelResolverClient
          initialListings={unmatchedData.listings}
          connectionId={unmatchedData.connectionId}
          products={products}
        />
      </div>
    </div>
  )
}
