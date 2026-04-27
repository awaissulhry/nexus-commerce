'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import MasterCatalogTab from './tabs/MasterCatalogTab'
import PlatformTab from './tabs/PlatformTab'
import { logger } from '@/lib/logger'

interface MatrixData {
  product: any
  channelListings: any[]
  masterImages: any[]
  error?: string
}

interface DirtyState {
  product: boolean
  listings: Set<string> // Track which listing IDs are dirty
}

const PLATFORMS = [
  { id: 'master', label: '📋 Master Catalog', icon: '📋' },
  { id: 'amazon', label: '🛒 Amazon', icon: '🛒' },
  { id: 'ebay', label: '🏪 eBay', icon: '🏪' },
  { id: 'shopify', label: '🛍️ Shopify', icon: '🛍️' },
  { id: 'woocommerce', label: '🌐 WooCommerce', icon: '🌐' },
]

interface MatrixEditorProps {
  isParent?: boolean
  childrenCount?: number
  initialProduct?: any
}

export default function MatrixEditor({ isParent = false, childrenCount = 0, initialProduct }: MatrixEditorProps) {
  const params = useParams()
  const productId = params.id as string

  const [matrixData, setMatrixData] = useState<MatrixData | null>(null)
  const [originalData, setOriginalData] = useState<MatrixData | null>(null)
  const [activeTab, setActiveTab] = useState('master')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ success: boolean; message: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dirtyState, setDirtyState] = useState<DirtyState>({ product: false, listings: new Set() })
  const originalDataRef = useRef<MatrixData | null>(null)

  // Fetch matrix data on mount
  useEffect(() => {
    const fetchMatrixData = async () => {
      try {
        setIsLoading(true)
        setError(null)

        // If initialProduct is provided from server, use it directly
        if (initialProduct) {
          const data = {
            product: initialProduct,
            channelListings: [],
            masterImages: initialProduct.images || [],
          }
          setMatrixData(data)
          setOriginalData(JSON.parse(JSON.stringify(data)))
          originalDataRef.current = JSON.parse(JSON.stringify(data))
          logger.info('Matrix data loaded from server', { productId, childrenCount: initialProduct.children?.length || 0 })
          return
        }

        const response = await fetch(`/api/products/${productId}/matrix`)
        if (!response.ok) {
          throw new Error(`Failed to fetch product matrix: ${response.statusText}`)
        }

        const data = await response.json()
        setMatrixData(data)
        setOriginalData(JSON.parse(JSON.stringify(data))) // Deep copy for comparison
        originalDataRef.current = JSON.parse(JSON.stringify(data))
        logger.info('Matrix data loaded', { productId, channelListings: data.channelListings.length })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to load product matrix'
        setError(errorMsg)
        logger.error('Error loading matrix data', { productId, error: errorMsg })
      } finally {
        setIsLoading(false)
      }
    }

    if (productId) {
      fetchMatrixData()
    }
  }, [productId, initialProduct])

  // Track dirty state when matrixData changes
  useEffect(() => {
    if (!matrixData || !originalDataRef.current) return

    const newDirtyState: DirtyState = { product: false, listings: new Set() }

    // Check if product is dirty
    if (JSON.stringify(matrixData.product) !== JSON.stringify(originalDataRef.current.product)) {
      newDirtyState.product = true
    }

    // Check which listings are dirty
    matrixData.channelListings.forEach((listing) => {
      const originalListing = originalDataRef.current?.channelListings.find((l) => l.id === listing.id)
      if (!originalListing || JSON.stringify(listing) !== JSON.stringify(originalListing)) {
        newDirtyState.listings.add(listing.id)
      }
    })

    setDirtyState(newDirtyState)
  }, [matrixData])

  const handleSaveChanges = useCallback(async () => {
    if (!matrixData || !originalDataRef.current) return

    setIsSaving(true)
    try {
      // Only save product if it's dirty
      if (dirtyState.product) {
        const response = await fetch(`http://localhost:3001/api/catalog/products/${productId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(matrixData.product),
        })
        if (!response.ok) throw new Error('Failed to save product')
        logger.info('Product saved', { productId })
      }

      // Only save dirty listings and their offers
      for (const listing of matrixData.channelListings) {
        if (!dirtyState.listings.has(listing.id)) continue

        const response = await fetch(
          `/api/products/${productId}/matrix?endpoint=channel-listing&resourceId=${listing.id}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(listing),
          }
        )
        if (!response.ok) throw new Error(`Failed to save listing ${listing.id}`)

        // Save offers for this listing
        if (listing.offers && Array.isArray(listing.offers)) {
          for (const offer of listing.offers) {
            const offerResponse = await fetch(
              `/api/products/${productId}/matrix?endpoint=offer&resourceId=${offer.id}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(offer),
              }
            )
            if (!offerResponse.ok) throw new Error(`Failed to save offer ${offer.id}`)
          }
        }
        logger.info('Listing saved', { listingId: listing.id })
      }

      // Update original data reference after successful save
      originalDataRef.current = JSON.parse(JSON.stringify(matrixData))
      setDirtyState({ product: false, listings: new Set() })

      setSaveStatus({ success: true, message: '✓ All changes saved successfully' })
      setTimeout(() => setSaveStatus(null), 3000)
      logger.info('Matrix changes saved', { productId })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to save changes'
      setSaveStatus({ success: false, message: `✗ ${errorMsg}` })
      logger.error('Error saving matrix changes', { productId, error: errorMsg })
    } finally {
      setIsSaving(false)
    }
  }, [matrixData, dirtyState, productId])

  const handleProductUpdate = useCallback((updatedProduct: any) => {
    setMatrixData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        product: { ...prev.product, ...updatedProduct },
      }
    })
  }, [])

  const handleImagesUpdate = useCallback((updatedImages: any) => {
    setMatrixData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        masterImages: updatedImages,
      }
    })
  }, [])

  const handleListingsUpdate = useCallback((updatedListings: any) => {
    setMatrixData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        channelListings: prev.channelListings.map((cl: any) => {
          const updated = updatedListings.find((ul: any) => ul.id === cl.id)
          return updated || cl
        }),
      }
    })
  }, [])

  const hasDirtyChanges = dirtyState.product || dirtyState.listings.size > 0

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading product matrix...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-red-900 mb-2">Error Loading Product</h3>
        <p className="text-red-700">{error}</p>
      </div>
    )
  }

  if (!matrixData) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
        <p className="text-yellow-800">Product not found</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header with Save Button */}
      <div className="flex items-center justify-between bg-white rounded-lg shadow p-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{matrixData.product.name}</h1>
          <p className="text-sm text-gray-600 mt-1">SKU: {matrixData.product.sku}</p>
          {hasDirtyChanges && (
            <p className="text-sm text-yellow-600 font-medium mt-2">● {dirtyState.listings.size + (dirtyState.product ? 1 : 0)} unsaved changes</p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {saveStatus && (
            <div
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                saveStatus.success
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {saveStatus.message}
            </div>
          )}
          <button
            onClick={handleSaveChanges}
            disabled={isSaving || !hasDirtyChanges}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {isSaving ? 'Saving…' : '💾 Save All Changes'}
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {PLATFORMS.map((platform) => (
            <button
              key={platform.id}
              onClick={() => setActiveTab(platform.id)}
              className={`px-6 py-4 font-medium whitespace-nowrap transition-colors relative ${
                activeTab === platform.id
                  ? 'border-b-2 border-blue-600 text-blue-600 bg-blue-50'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              {platform.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'master' && (
            <MasterCatalogTab
              product={matrixData.product}
              masterImages={matrixData.masterImages}
              onUpdate={handleProductUpdate}
              onImagesUpdate={handleImagesUpdate}
              isParent={isParent}
              childrenCount={childrenCount}
            />
          )}

          {activeTab !== 'master' && (
            <PlatformTab
              platform={activeTab}
              product={matrixData.product}
              channelListings={matrixData.channelListings.filter(
                (cl: any) => cl.channel.toLowerCase() === activeTab.toUpperCase()
              )}
              onUpdate={handleListingsUpdate}
            />
          )}
        </div>
      </div>
    </div>
  )
}
