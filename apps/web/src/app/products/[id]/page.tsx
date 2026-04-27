import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ImageGallery from './ImageGallery'
import BuyBox from './BuyBox'
import VariationSelector from './VariationSelector'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

// Mock rating data (would come from a reviews system in production)
const MOCK_RATING = { average: 4.3, count: 1247 }

function RatingStars({ rating }: { rating: number }) {
  const fullStars = Math.floor(rating)
  const hasHalf = rating - fullStars >= 0.3
  const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0)

  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: fullStars }).map((_, i) => (
        <span key={`full-${i}`} className="text-yellow-400 text-lg">★</span>
      ))}
      {hasHalf && <span className="text-yellow-400 text-lg">★</span>}
      {Array.from({ length: emptyStars }).map((_, i) => (
        <span key={`empty-${i}`} className="text-gray-300 text-lg">★</span>
      ))}
    </div>
  )
}

export default async function ProductDetailPage({ params }: PageProps) {
  const { id } = await params

  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      sku: true,
      basePrice: true,
      totalStock: true,
      brand: true,
      manufacturer: true,
      upc: true,
      ean: true,
      amazonAsin: true,
      ebayItemId: true,
      fulfillmentMethod: true,
      bulletPoints: true,
      aPlusContent: true,
      weightValue: true,
      weightUnit: true,
      dimLength: true,
      dimWidth: true,
      dimHeight: true,
      dimUnit: true,
      createdAt: true,
      updatedAt: true,
      images: { orderBy: { type: 'asc' } },
      variations: true,
    },
  })

  if (!product) {
    notFound()
  }

  const price = Number(product.basePrice)
  const images = (product.images || []).map((img: any) => ({
    url: img.url,
    alt: img.alt || product.name,
    type: img.type,
  }))
  const variations = (product.variations || []).map((v: any) => ({
    id: v.id,
    sku: v.sku,
    name: v.name,
    value: v.value,
    price: Number(v.price),
    stock: v.stock,
  }))
  const bulletPoints: string[] = product.bulletPoints || []
  const aPlusContent: string | null = product.aPlusContent
    ? typeof product.aPlusContent === 'string'
      ? product.aPlusContent
      : JSON.stringify(product.aPlusContent)
    : null

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
        <span>›</span>
        <Link href="/catalog" className="hover:text-blue-600 transition-colors">Catalog</Link>
        <span>›</span>
        <span className="text-gray-900 font-medium truncate max-w-xs">{product.name}</span>
      </nav>

      {/* Main layout: Gallery + Info + BuyBox */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Image Gallery */}
        <div className="lg:col-span-5">
          <ImageGallery images={images} productName={product.name} />
        </div>

        {/* Center: Product Info */}
        <div className="lg:col-span-4">
          {/* Title */}
          <h1 className="text-2xl font-bold text-gray-900 leading-tight mb-2">
            {product.name}
          </h1>

          {/* Brand */}
          {product.brand && (
            <p className="text-sm mb-3">
              <span className="text-gray-500">Brand: </span>
              <span className="text-blue-600 hover:text-blue-700 cursor-pointer hover:underline">
                {product.brand}
              </span>
            </p>
          )}

          {/* Rating */}
          <div className="flex items-center gap-2 mb-4">
            <RatingStars rating={MOCK_RATING.average} />
            <span className="text-sm text-blue-600 hover:text-blue-700 cursor-pointer hover:underline">
              {MOCK_RATING.average} ({MOCK_RATING.count.toLocaleString()} ratings)
            </span>
          </div>

          <hr className="my-4 border-gray-200" />

          {/* Price display (mobile — hidden on desktop where BuyBox shows it) */}
          <div className="lg:hidden mb-4">
            <span className="text-2xl font-bold text-gray-900">
              {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price)}
            </span>
          </div>

          {/* Variations */}
          {variations.length > 0 && (
            <div className="mb-6">
              <VariationSelector variations={variations} />
            </div>
          )}

          <hr className="my-4 border-gray-200" />

          {/* Bullet Points / Key Features */}
          {bulletPoints.length > 0 && (
            <div className="mb-6">
              <h2 className="text-base font-semibold text-gray-900 mb-3">About this item</h2>
              <ul className="space-y-2">
                {bulletPoints.map((point, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-gray-400 mt-0.5 flex-shrink-0">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Product identifiers */}
          <div className="text-xs text-gray-500 space-y-1 mt-6">
            <p>SKU: <span className="font-mono">{product.sku}</span></p>
            {product.amazonAsin && (
              <p>ASIN: <span className="font-mono">{product.amazonAsin}</span></p>
            )}
            {product.upc && (
              <p>UPC: <span className="font-mono">{product.upc}</span></p>
            )}
            {product.ean && (
              <p>EAN: <span className="font-mono">{product.ean}</span></p>
            )}
          </div>
        </div>

        {/* Right: Buy Box */}
        <div className="lg:col-span-3">
          <BuyBox
            price={price}
            stock={product.totalStock}
            fulfillmentMethod={product.fulfillmentMethod}
            brand={product.brand}
          />
        </div>
      </div>

      {/* Product Description (A+ Content) */}
      {aPlusContent && (
        <div className="mt-12 border-t border-gray-200 pt-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Product Description</h2>
          <div
            className="prose prose-sm max-w-none text-gray-700"
            dangerouslySetInnerHTML={{ __html: aPlusContent }}
          />
        </div>
      )}

      {/* Product details table */}
      <div className="mt-12 border-t border-gray-200 pt-8">
        <h2 className="text-xl font-bold text-gray-900 mb-6">Product Details</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <tbody className="divide-y divide-gray-100">
              {product.brand && (
                <tr>
                  <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50 w-1/3">Brand</td>
                  <td className="px-6 py-3 text-sm text-gray-900">{product.brand}</td>
                </tr>
              )}
              {product.manufacturer && (
                <tr>
                  <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50">Manufacturer</td>
                  <td className="px-6 py-3 text-sm text-gray-900">{product.manufacturer}</td>
                </tr>
              )}
              {product.weightValue && (
                <tr>
                  <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50">Weight</td>
                  <td className="px-6 py-3 text-sm text-gray-900">
                    {Number(product.weightValue)} {product.weightUnit || ''}
                  </td>
                </tr>
              )}
              {product.dimLength && product.dimWidth && product.dimHeight && (
                <tr>
                  <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50">Dimensions</td>
                  <td className="px-6 py-3 text-sm text-gray-900">
                    {Number(product.dimLength)} × {Number(product.dimWidth)} × {Number(product.dimHeight)} {product.dimUnit || ''}
                  </td>
                </tr>
              )}
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50">SKU</td>
                <td className="px-6 py-3 text-sm font-mono text-gray-900">{product.sku}</td>
              </tr>
              {product.amazonAsin && (
                <tr>
                  <td className="px-6 py-3 text-sm font-medium text-gray-500 bg-gray-50">ASIN</td>
                  <td className="px-6 py-3 text-sm font-mono text-gray-900">{product.amazonAsin}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
