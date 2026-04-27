'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'

// Simple toast notification
const showToast = (message: string, type: 'success' | 'error') => {
  const notification = document.createElement('div')
  notification.className = `fixed top-4 right-4 px-4 py-3 rounded-lg text-white font-medium z-50 animate-in fade-in slide-in-from-top-2 ${
    type === 'success' ? 'bg-green-600' : 'bg-red-600'
  }`
  notification.textContent = message
  document.body.appendChild(notification)

  setTimeout(() => {
    notification.remove()
  }, 3000)
}

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

interface ChannelResolverClientProps {
  initialListings: UnmatchedListing[]
  connectionId: string
  products: Product[]
}

export default function ChannelResolverClient({
  initialListings,
  connectionId,
  products,
}: ChannelResolverClientProps) {
  const router = useRouter()
  const [listings, setListings] = useState<UnmatchedListing[]>(initialListings)
  const [selectedProducts, setSelectedProducts] = useState<Record<string, string>>({})
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({})
  const [loadingListingId, setLoadingListingId] = useState<string | null>(null)

  // Filter products based on search term for each listing
  const filteredProducts = useMemo(() => {
    const result: Record<string, Product[]> = {}

    for (const listing of listings) {
      const searchTerm = searchTerms[listing.id]?.toLowerCase() || ''

      if (!searchTerm) {
        result[listing.id] = products
      } else {
        result[listing.id] = products.filter(
          (p) =>
            p.name.toLowerCase().includes(searchTerm) ||
            p.sku.toLowerCase().includes(searchTerm)
        )
      }
    }

    return result
  }, [listings, searchTerms, products])

  const handleProductSelect = (listingId: string, productId: string) => {
    setSelectedProducts((prev) => ({
      ...prev,
      [listingId]: productId,
    }))
  }

  const handleSearchChange = (listingId: string, value: string) => {
    setSearchTerms((prev) => ({
      ...prev,
      [listingId]: value,
    }))
  }

  const handleLinkListing = async (listingId: string) => {
    const variantId = selectedProducts[listingId]

    if (!variantId) {
      showToast('Please select a product to link', 'error')
      return
    }

    setLoadingListingId(listingId)

    try {
      const response = await fetch(
        `/api/sync/ebay/listings/${listingId}/link`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ variantId }),
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to link listing')
      }

      // Remove the linked listing from the list
      setListings((prev) => prev.filter((l) => l.id !== listingId))

      // Clear selection
      setSelectedProducts((prev) => {
        const newSelected = { ...prev }
        delete newSelected[listingId]
        return newSelected
      })

      showToast('Listing linked successfully!', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      showToast(`Failed to link listing: ${message}`, 'error')
    } finally {
      setLoadingListingId(null)
    }
  }

  if (!connectionId) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-yellow-900">No eBay Connection</h3>
        <p className="text-sm text-yellow-800 mt-2">
          Please connect your eBay account first before resolving listings.
        </p>
      </div>
    )
  }

  if (listings.length === 0) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
        <div className="flex items-center gap-3">
          <div className="text-2xl">✓</div>
          <div>
            <h3 className="text-sm font-semibold text-green-900">All Listings Resolved</h3>
            <p className="text-sm text-green-800 mt-1">
              All eBay listings have been successfully linked to your products.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Calculate progress
  const totalListings = initialListings.length
  const resolvedListings = totalListings - listings.length
  const progressPercent = Math.round((resolvedListings / totalListings) * 100)

  return (
    <div className="space-y-6">
      {/* Progress Bar */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-900">Resolution Progress</h3>
          <span className="text-sm font-medium text-slate-600">
            {resolvedListings} of {totalListings} resolved
          </span>
        </div>
        <div className="w-full bg-slate-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <p className="text-xs text-slate-500 mt-2">{progressPercent}% complete</p>
      </div>

      {/* Listings Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  eBay Item ID
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  SKU
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  Price
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  Qty
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  Link to Product
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-900">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <tr
                  key={listing.id}
                  className="border-b border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  {/* eBay Item ID */}
                  <td className="px-4 py-3">
                    {listing.listingUrl ? (
                      <a
                        href={listing.listingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {listing.externalListingId}
                      </a>
                    ) : (
                      <span className="text-slate-600">{listing.externalListingId}</span>
                    )}
                  </td>

                  {/* SKU */}
                  <td className="px-4 py-3 text-slate-600">
                    {listing.externalSku || '—'}
                  </td>

                  {/* Price */}
                  <td className="px-4 py-3 text-slate-600">
                    {listing.currentPrice
                      ? `$${listing.currentPrice.toFixed(2)}`
                      : '—'}
                  </td>

                  {/* Quantity */}
                  <td className="px-4 py-3 text-slate-600">
                    {listing.quantity || 0}
                  </td>

                  {/* Product Dropdown */}
                  <td className="px-4 py-3">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Search products..."
                        value={searchTerms[listing.id] || ''}
                        onChange={(e) =>
                          handleSearchChange(listing.id, e.target.value)
                        }
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />

                      {/* Dropdown Menu */}
                      {searchTerms[listing.id] && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                          {filteredProducts[listing.id]?.length > 0 ? (
                            filteredProducts[listing.id].map((product) => (
                              <button
                                key={product.id}
                                onClick={() => {
                                  handleProductSelect(listing.id, product.id)
                                  handleSearchChange(listing.id, product.name)
                                }}
                                className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-slate-100 last:border-0 transition-colors"
                              >
                                <div className="font-medium text-slate-900">
                                  {product.name}
                                </div>
                                <div className="text-xs text-slate-500">
                                  SKU: {product.sku}
                                </div>
                              </button>
                            ))
                          ) : (
                            <div className="px-3 py-2 text-sm text-slate-500">
                              No products found
                            </div>
                          )}
                        </div>
                      )}

                      {/* Selected Product Display */}
                      {selectedProducts[listing.id] && !searchTerms[listing.id] && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-blue-50 border border-blue-300 rounded-lg p-2 z-10">
                          <div className="text-sm font-medium text-blue-900">
                            {
                              products.find((p) => p.id === selectedProducts[listing.id])
                                ?.name
                            }
                          </div>
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Link Button */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleLinkListing(listing.id)}
                      disabled={
                        !selectedProducts[listing.id] ||
                        loadingListingId === listing.id
                      }
                      className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                    >
                      {loadingListingId === listing.id ? (
                        <span className="flex items-center gap-2">
                          <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          Linking...
                        </span>
                      ) : (
                        'Link'
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-blue-900 mb-2">How to resolve listings:</h4>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>Search for the product by name or SKU in the search box</li>
          <li>Select the matching product from the dropdown</li>
          <li>Click the "Link" button to connect the eBay listing</li>
          <li>The listing will be removed from this queue once linked</li>
        </ol>
      </div>
    </div>
  )
}
