import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ImageGallery from '@/app/products/[id]/ImageGallery'
import BuyBox from '@/app/products/[id]/BuyBox'
import VariationSelector from '@/app/products/[id]/VariationSelector'
import PageHeader from '@/components/layout/PageHeader'

interface PageProps {
  params: Promise<{ id: string }>
}

function RatingStars({ rating }: { rating: number }) {
  const full = Math.floor(rating)
  const half = rating % 1 >= 0.5 ? 1 : 0
  const empty = 5 - full - half
  return (
    <span className="text-yellow-400 text-lg">
      {'★'.repeat(full)}
      {half ? '⯪' : ''}
      {'☆'.repeat(empty)}
    </span>
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

  if (!product) notFound()

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
      <PageHeader
        title={product.name}
        subtitle={`SKU: ${product.sku}`}
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: product.name },
        ]}
        actions={
          <div className="flex items-center gap-2 text-sm text-gray-500">
            {product.amazonAsin && (
              <span className="inline-flex items-center px-2 py-1 rounded bg-orange-50 text-orange-700 text-xs font-medium">
                ASIN: <span className="font-mono ml-1">{product.amazonAsin}</span>
              </span>
            )}
            {product.ebayItemId && (
              <span className="inline-flex items-center px-2 py-1 rounded bg-blue-50 text-blue-700 text-xs font-medium">
                eBay: <span className="font-mono ml-1">{product.ebayItemId}</span>
              </span>
            )}
            <Link
              href={`/catalog/${id}/edit`}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              ✏️ Edit
            </Link>
          </div>
        }
      />

      {/* ── Main grid ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Images */}
        <div className="lg:col-span-5">
          <ImageGallery images={images} productName={product.name} />
        </div>

        {/* Center: Details */}
        <div className="lg:col-span-4 space-y-6">
          {product.brand && (
            <Link href="#" className="text-sm text-blue-600 hover:underline">
              Visit the {product.brand} Store
            </Link>
          )}

          <h1 className="text-xl font-semibold text-gray-900 leading-tight">
            {product.name}
          </h1>

          <div className="flex items-center gap-2">
            <RatingStars rating={4.2} />
            <span className="text-sm text-blue-600 hover:underline cursor-pointer">
              42 ratings
            </span>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <p className="text-3xl font-bold text-gray-900">
              €{Number(product.basePrice).toFixed(2)}
            </p>
          </div>

          {/* Bullet Points */}
          {bulletPoints.length > 0 && (
            <div className="border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">About this item</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {bulletPoints.map((point, idx) => (
                  <li key={idx}>{point}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Identifiers */}
          <div className="text-xs text-gray-500 space-y-0.5">
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
            price={Number(product.basePrice)}
            stock={product.totalStock}
            fulfillmentMethod={product.fulfillmentMethod}
            brand={product.brand}
          />
          {variations.length > 0 && (
            <div className="mt-4">
              <VariationSelector variations={variations} />
            </div>
          )}
        </div>
      </div>

      {/* ── Product Details Table ──────────────────────────────── */}
      <div className="mt-8 bg-white rounded-lg border border-gray-200 overflow-hidden">
        <h3 className="px-6 py-3 text-sm font-semibold text-gray-900 bg-gray-50 border-b border-gray-200">
          Product Details
        </h3>
        <table className="w-full">
          <tbody className="divide-y divide-gray-100">
            {product.brand && (
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">Brand</td>
                <td className="px-6 py-3 text-sm text-gray-900">{product.brand}</td>
              </tr>
            )}
            {product.manufacturer && (
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">Manufacturer</td>
                <td className="px-6 py-3 text-sm text-gray-900">{product.manufacturer}</td>
              </tr>
            )}
            {product.weightValue && (
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">Weight</td>
                <td className="px-6 py-3 text-sm text-gray-900">
                  {Number(product.weightValue)} {product.weightUnit || ''}
                </td>
              </tr>
            )}
            {product.dimLength && product.dimWidth && product.dimHeight && (
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">Dimensions</td>
                <td className="px-6 py-3 text-sm text-gray-900">
                  {Number(product.dimLength)} × {Number(product.dimWidth)} × {Number(product.dimHeight)} {product.dimUnit || ''}
                </td>
              </tr>
            )}
            <tr>
              <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">SKU</td>
              <td className="px-6 py-3 text-sm text-gray-900 font-mono">{product.sku}</td>
            </tr>
            {product.amazonAsin && (
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-600 w-48">ASIN</td>
                <td className="px-6 py-3 text-sm text-gray-900 font-mono">{product.amazonAsin}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── A+ Content ─────────────────────────────────────────── */}
      {aPlusContent && (
        <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">A+ Content</h3>
          <div className="prose prose-sm max-w-none text-gray-700">
            {aPlusContent}
          </div>
        </div>
      )}
    </div>
  )
}
