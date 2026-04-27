'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'

interface Product {
  id: string
  name: string
  sku: string
  basePrice: any
  totalStock: number
  brand: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  createdAt: Date
  updatedAt: Date
  images: Array<{ url: string; type: string }>
  isParent: boolean
  masterProductId: string | null
  channelListings: Array<{ channel: string }>
}

interface CatalogClientProps {
  products: Product[]
}

export default function CatalogClient({ products }: CatalogClientProps) {
  const [showOrphansOnly, setShowOrphansOnly] = useState(false)

  // Filter orphaned products: isParent === false AND masterProductId === null AND has Amazon listing
  const orphanedProducts = useMemo(() => {
    return products.filter(
      (p) =>
        !p.isParent &&
        !p.masterProductId &&
        p.channelListings.some((cl) => cl.channel === 'AMAZON')
    )
  }, [products])

  const displayedProducts = showOrphansOnly ? orphanedProducts : products

  const formatCurrency = (amount: any) => {
    const num =
      typeof amount === 'string'
        ? parseFloat(amount)
        : typeof amount === 'number'
          ? amount
          : parseFloat(amount.toString())
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(num)
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Filter Bar */}
      <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between bg-gray-50">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">Filter:</span>
          <button
            onClick={() => setShowOrphansOnly(!showOrphansOnly)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              showOrphansOnly
                ? 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                : 'bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200'
            }`}
          >
            {showOrphansOnly ? (
              <>
                🏚️ Orphans Only ({orphanedProducts.length})
              </>
            ) : (
              <>
                🏚️ Show Orphans ({orphanedProducts.length})
              </>
            )}
          </button>
        </div>
        <div className="text-sm text-gray-600">
          Showing {displayedProducts.length} of {products.length} products
        </div>
      </div>

      {/* Table */}
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              Product
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              SKU
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              Price
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              Stock
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {displayedProducts.map((product) => {
            const mainImage = product.images?.[0]
            const isOrphan =
              !product.isParent &&
              !product.masterProductId &&
              product.channelListings.some((cl) => cl.channel === 'AMAZON')

            return (
              <tr
                key={product.id}
                className={`hover:bg-gray-50 transition-colors ${isOrphan ? 'bg-yellow-50' : ''}`}
              >
                <td className="px-6 py-4">
                  <Link
                    href={`/catalog/${product.id}`}
                    className="flex items-center gap-3 group"
                  >
                    <div className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                      {mainImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={mainImage.url}
                          alt={product.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-gray-400 text-xs">📷</span>
                      )}
                    </div>
                    <span className="text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors truncate max-w-xs">
                      {product.name}
                    </span>
                  </Link>
                </td>
                <td className="px-6 py-4 text-sm font-mono text-gray-600">
                  {product.sku}
                </td>
                <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                  {formatCurrency(product.basePrice)}
                </td>
                <td className="px-6 py-4 text-sm text-gray-900">
                  {product.totalStock}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        product.totalStock > 0
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {product.totalStock > 0 ? 'In Stock' : 'Out of Stock'}
                    </span>
                    {isOrphan && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        🏚️ Orphaned
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/catalog/${product.id}`}
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      View
                    </Link>
                    <span className="text-gray-300">|</span>
                    <Link
                      href={`/catalog/${product.id}/edit`}
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Edit
                    </Link>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {displayedProducts.length === 0 && (
        <div className="px-6 py-12 text-center">
          <p className="text-gray-500">
            {showOrphansOnly
              ? 'No orphaned products found. All your Amazon SKUs are properly linked!'
              : 'No products found.'}
          </p>
        </div>
      )}
    </div>
  )
}
