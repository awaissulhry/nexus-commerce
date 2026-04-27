'use client'

import { useState, useEffect } from 'react'
import { linkListingToProduct } from '@/app/actions/listings'
import PageHeader from '@/components/layout/PageHeader'

interface Listing {
  id: string
  productId: string | null
  channelId: string
  channelPrice: string
  channel: {
    name: string
    type: string
  }
  product: {
    sku: string
    name: string
  } | null
  createdAt: Date
}

interface Product {
  id: string
  sku: string
  name: string
}

export default function ListingsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedProducts, setSelectedProducts] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch listings
        const listingsRes = await fetch('/api/listings')
        const listingsData = await listingsRes.json()
        setListings(listingsData)

        // Fetch products
        const productsRes = await fetch('/api/products')
        const productsData = await productsRes.json()
        setProducts(productsData)
      } catch (error) {
        console.error('Error fetching data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const handleLinkListing = async (listingId: string) => {
    const productId = selectedProducts[listingId]
    if (!productId) {
      alert('Please select a product')
      return
    }

    setLinking((prev) => ({ ...prev, [listingId]: true }))

    try {
      await linkListingToProduct(listingId, productId)

      // Update local state
      setListings((prev) =>
        prev.map((listing) =>
          listing.id === listingId
            ? {
                ...listing,
                productId,
                product: products.find((p) => p.id === productId) || null,
              }
            : listing
        )
      )

      // Clear selection
      setSelectedProducts((prev) => {
        const newState = { ...prev }
        delete newState[listingId]
        return newState
      })
    } catch (error) {
      console.error('Error linking listing:', error)
      alert('Failed to link listing')
    } finally {
      setLinking((prev) => ({ ...prev, [listingId]: false }))
    }
  }

  const unlinkedListings = listings.filter((l) => !l.productId)
  const linkedListings = listings.filter((l) => l.productId)

  const formatCurrency = (amount: any) => {
    const num = typeof amount === 'string' ? parseFloat(amount) : typeof amount === 'number' ? amount : parseFloat(amount.toString())
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(num)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-600">Loading listings...</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Link Listings"
        subtitle={`${unlinkedListings.length} unlinked · ${linkedListings.length} linked`}
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Link Listings' },
        ]}
      />

      {/* Unlinked Listings Section */}
      {unlinkedListings.length > 0 && (
        <div className="mb-8">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-yellow-900 mb-2">⚠️ Unlinked Listings</h2>
            <p className="text-yellow-800">
              {unlinkedListings.length} listing{unlinkedListings.length !== 1 ? 's' : ''} need to be linked to products
            </p>
          </div>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Channel
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Channel Price
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Link to Product
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {unlinkedListings.map((listing) => (
                  <tr key={listing.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <div>
                        <p className="font-medium">{listing.channel.name}</p>
                        <p className="text-xs text-gray-500">{listing.channel.type}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(listing.channelPrice)}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <select
                        value={selectedProducts[listing.id] || ''}
                        onChange={(e) =>
                          setSelectedProducts((prev) => ({
                            ...prev,
                            [listing.id]: e.target.value,
                          }))
                        }
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
                      >
                        <option value="">Select a product...</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.sku} - {product.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <button
                        onClick={() => handleLinkListing(listing.id)}
                        disabled={linking[listing.id] || !selectedProducts[listing.id]}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium text-sm"
                      >
                        {linking[listing.id] ? 'Linking...' : 'Link'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Linked Listings Section */}
      {linkedListings.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Linked Listings ({linkedListings.length})
          </h2>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Channel
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Channel Price
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Linked Product
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {linkedListings.map((listing) => (
                  <tr key={listing.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <div>
                        <p className="font-medium">{listing.channel.name}</p>
                        <p className="text-xs text-gray-500">{listing.channel.type}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(listing.channelPrice)}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <div>
                        <p className="font-medium">{listing.product?.name}</p>
                        <p className="text-xs text-gray-500">{listing.product?.sku}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        ✓ Linked
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {listings.length === 0 && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-600 text-lg">No listings found</p>
        </div>
      )}
    </div>
  )
}
