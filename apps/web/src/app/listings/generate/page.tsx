'use client'

import { useState, useEffect } from 'react'
import PageHeader from '@/components/layout/PageHeader'
import { Loader, AlertCircle, CheckCircle, Zap } from 'lucide-react'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface Product {
  id: string
  sku: string
  name: string
  basePrice: number
  totalStock: number
  images: Array<{ url: string }>
}

interface DraftListing {
  draftListingId: string
  productId: string
  productName: string
  productSku: string
  ebayTitle: string
  categoryId: string
  itemSpecifics: Record<string, string>
  htmlDescription: string
  status: string
  createdAt: string
}

interface GenerationState {
  [productId: string]: {
    loading: boolean
    error?: string
    draft?: DraftListing
    publishing?: boolean
    publishError?: string
  }
}

export default function GeneratorPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [generationState, setGenerationState] = useState<GenerationState>({})
  const [selectedDraft, setSelectedDraft] = useState<DraftListing | null>(null)
  const [showPreviewModal, setShowPreviewModal] = useState(false)
  const [notification, setNotification] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Fetch products on mount
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const response = await fetch('/api/products')
        const data = await response.json()
        setProducts(data || [])
      } catch (error) {
        console.error('Error fetching products:', error)
        showNotification('error', 'Failed to load products')
      } finally {
        setLoading(false)
      }
    }

    fetchProducts()
  }, [])

  // Auto-hide notifications after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [notification])

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message })
  }

  const handleGenerateListing = async (productId: string) => {
    setGenerationState((prev) => ({
      ...prev,
      [productId]: { loading: true },
    }))

    try {
      const response = await fetch('/api/listings/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, regenerate: false }),
      })

      const result = await response.json()

      if (!response.ok) {
        const errorMessage =
          result.error?.message || 'Failed to generate listing'
        throw new Error(errorMessage)
      }

      const draft = result.data as DraftListing
      setGenerationState((prev) => ({
        ...prev,
        [productId]: { loading: false, draft },
      }))

      setSelectedDraft(draft)
      setShowPreviewModal(true)
      showNotification('success', 'Listing generated successfully!')
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      setGenerationState((prev) => ({
        ...prev,
        [productId]: { loading: false, error: errorMessage },
      }))
      showNotification('error', errorMessage)
    }
  }

  const handleRegenerateListing = async (productId: string) => {
    setGenerationState((prev) => ({
      ...prev,
      [productId]: { loading: true },
    }))

    try {
      const response = await fetch('/api/listings/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, regenerate: true }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error?.message || 'Failed to regenerate listing')
      }

      const draft = result.data as DraftListing
      setGenerationState((prev) => ({
        ...prev,
        [productId]: { loading: false, draft },
      }))

      setSelectedDraft(draft)
      setShowPreviewModal(true)
      showNotification('success', 'Listing regenerated successfully!')
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      setGenerationState((prev) => ({
        ...prev,
        [productId]: { loading: false, error: errorMessage },
      }))
      showNotification('error', errorMessage)
    }
  }
 
  const handlePublishDraft = async (draftId: string) => {
    if (!selectedDraft) return
 
    setGenerationState((prev) => ({
      ...prev,
      [selectedDraft.productId]: {
        ...prev[selectedDraft.productId],
        publishing: true,
      },
    }))
 
    try {
      const response = await fetch(`/api/listings/${draftId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
 
      const result = await response.json()
 
      if (!response.ok) {
        throw new Error(result.error?.message || 'Failed to publish listing')
      }
 
      // Success
      showNotification('success', 'Listing published to eBay successfully!')

      // Snappy local refresh — same-tab CustomEvent + cross-tab
      // BroadcastChannel. The backend ALSO emits `listing.created`
      // via SSE inside EbayPublishService.publishDraft, so this is
      // belt-and-braces: this fires immediately (~0ms) while the
      // SSE roundtrip lands a moment later. Listeners debounce
      // refetches, so duplicates are harmless.
      emitInvalidation({
        type: 'listing.created',
        id: result?.data?.variantChannelListingId ?? result?.data?.listingId,
        meta: {
          source: 'generator',
          draftId,
          productId: selectedDraft.productId,
          channel: 'EBAY',
        },
      })

      // Update state to remove from queue
      setGenerationState((prev) => {
        const newState = { ...prev }
        delete newState[selectedDraft.productId]
        return newState
      })

      // Close modal
      setShowPreviewModal(false)
      setSelectedDraft(null)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
 
      showNotification('error', errorMessage)
 
      setGenerationState((prev) => ({
        ...prev,
        [selectedDraft.productId]: {
          ...prev[selectedDraft.productId],
          publishing: false,
          publishError: errorMessage,
        },
      }))
    }
  }
 
  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.sku.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const productsWithDrafts = filteredProducts.filter(
    (p) => generationState[p.id]?.draft
  )
  const productsWithoutDrafts = filteredProducts.filter(
    (p) => !generationState[p.id]?.draft
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading products...</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="AI Listing Generator"
        subtitle="Generate eBay-optimized listings from your products"
        breadcrumbs={[
          { label: 'Products', href: '/products' },
          { label: 'Generate Listings' },
        ]}
      />

      {/* Notification Toast */}
      {notification && (
        <div
          className={`fixed top-4 right-4 p-4 rounded-lg shadow-lg flex items-center gap-3 z-50 ${
            notification.type === 'success'
              ? 'bg-green-50 border border-green-200'
              : 'bg-red-50 border border-red-200'
          }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600" />
          )}
          <span
            className={
              notification.type === 'success'
                ? 'text-green-800'
                : 'text-red-800'
            }
          >
            {notification.message}
          </span>
        </div>
      )}

      {/* Search Bar */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by product name or SKU..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        />
      </div>

      {/* Products with Drafts Section */}
      {productsWithDrafts.length > 0 && (
        <div className="mb-8">
          <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-green-900 mb-2 flex items-center gap-2">
              <CheckCircle className="w-5 h-5" />
              Generated Listings ({productsWithDrafts.length})
            </h2>
            <p className="text-green-800">
              These products have AI-generated draft listings ready for review
            </p>
          </div>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Product
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Price
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Stock
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    eBay Title
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {productsWithDrafts.map((product) => {
                  const draft = generationState[product.id]?.draft
                  return (
                    <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 text-sm">
                        <div className="flex items-center gap-3">
                          {product.images.length > 0 && (
                            <img
                              src={product.images[0].url}
                              alt={product.name}
                              className="w-10 h-10 rounded object-cover"
                            />
                          )}
                          <div>
                            <p className="font-medium text-gray-900">
                              {product.name}
                            </p>
                            <p className="text-xs text-gray-500">{product.sku}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                        ${product.basePrice.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {product.totalStock}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          {draft?.ebayTitle.substring(0, 40)}...
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm space-x-2">
                        <button
                          onClick={() => {
                            setSelectedDraft(draft!)
                            setShowPreviewModal(true)
                          }}
                          className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-xs font-medium"
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => handleRegenerateListing(product.id)}
                          disabled={generationState[product.id]?.loading}
                          className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:bg-gray-400 transition-colors text-xs font-medium"
                        >
                          {generationState[product.id]?.loading
                            ? 'Regenerating...'
                            : 'Regenerate'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Products without Drafts Section */}
      {productsWithoutDrafts.length > 0 && (
        <div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-blue-900 mb-2 flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Ready to Generate ({productsWithoutDrafts.length})
            </h2>
            <p className="text-blue-800">
              Click "Generate" to create AI-optimized eBay listings for these
              products
            </p>
          </div>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Product
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Price
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Stock
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {productsWithoutDrafts.map((product) => {
                  const state = generationState[product.id]
                  return (
                    <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 text-sm">
                        <div className="flex items-center gap-3">
                          {product.images && product.images.length > 0 && (
                            <img
                              src={product.images[0].url}
                              alt={product.name}
                              className="w-10 h-10 rounded object-cover"
                            />
                          )}
                          <div>
                            <p className="font-medium text-gray-900">
                              {product.name}
                            </p>
                            <p className="text-xs text-gray-500">{product.sku}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                        ${product.basePrice.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {product.totalStock}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {state?.error ? (
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            ✗ Error
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            Ready
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <button
                          onClick={() => handleGenerateListing(product.id)}
                          disabled={state?.loading}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium text-sm flex items-center gap-2"
                        >
                          {state?.loading ? (
                            <>
                              <Loader className="w-4 h-4 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Zap className="w-4 h-4" />
                              Generate
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filteredProducts.length === 0 && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-600 text-lg">
            {searchTerm
              ? 'No products found matching your search'
              : 'No products available'}
          </p>
        </div>
      )}

      {/* Preview Modal */}
      {showPreviewModal && selectedDraft && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="sticky top-0 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6 flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold">Listing Preview</h2>
                <p className="text-blue-100 text-sm mt-1">
                  {selectedDraft.productName} ({selectedDraft.productSku})
                </p>
              </div>
              <button
                onClick={() => setShowPreviewModal(false)}
                className="text-white hover:bg-blue-800 p-2 rounded transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-6">
              {/* eBay Title */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  eBay Title (80 chars max)
                </h3>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <p className="text-lg font-semibold text-gray-900">
                    {selectedDraft.ebayTitle}
                  </p>
                  <p className="text-xs text-gray-500 mt-2">
                    {selectedDraft.ebayTitle.length} / 80 characters
                  </p>
                </div>
              </div>

              {/* Category ID */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  eBay Category ID
                </h3>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <p className="text-gray-900 font-mono">
                    {selectedDraft.categoryId}
                  </p>
                </div>
              </div>

              {/* Item Specifics */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  Item Specifics
                </h3>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="grid grid-cols-2 gap-4">
                    {Object.entries(selectedDraft.itemSpecifics).map(
                      ([key, value]) => (
                        <div key={key}>
                          <p className="text-xs font-semibold text-gray-600 uppercase">
                            {key}
                          </p>
                          <p className="text-sm text-gray-900">{value}</p>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>

              {/* HTML Description Preview */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  Description Preview
                </h3>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 max-h-96 overflow-y-auto">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: selectedDraft.htmlDescription,
                    }}
                  />
                </div>
              </div>

              {/* Raw HTML (for debugging) */}
              <details className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                <summary className="text-sm font-semibold text-gray-700 cursor-pointer">
                  View Raw HTML
                </summary>
                <pre className="mt-4 text-xs bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto">
                  {selectedDraft.htmlDescription}
                </pre>
              </details>
            </div>

            {/* Modal Footer */}
            <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 p-6 flex justify-end gap-3">
              <button
                onClick={() => setShowPreviewModal(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors font-medium"
              >
                Close
              </button>
              <button
                onClick={() => handlePublishDraft(selectedDraft!.draftListingId)}
                disabled={generationState[selectedDraft!.productId]?.publishing}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium flex items-center gap-2"
              >
                {generationState[selectedDraft!.productId]?.publishing ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Publishing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Publish to eBay
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
