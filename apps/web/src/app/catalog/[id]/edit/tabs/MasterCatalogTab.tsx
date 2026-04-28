'use client'

import { useState, useCallback, memo } from 'react'
import { logger } from '@/lib/logger'
import ChannelListingImageUploader from '@/components/catalog/ChannelListingImageUploader'
import VariationMatrixTable from './VariationMatrixTable'
import VariationGenerator from '@/components/catalog/VariationGenerator'
import { ChevronDown } from 'lucide-react'
import type { GeneratedVariation } from '@/lib/sku-generator'

interface MasterCatalogTabProps {
  product: any
  masterImages: any[]
  onUpdate: (updatedProduct: any) => void
  onImagesUpdate?: (images: any[]) => void
  isParent?: boolean
  childrenCount?: number
}

function MasterCatalogTabComponent({
  product,
  masterImages,
  onUpdate,
  onImagesUpdate,
  isParent = false,
  childrenCount: _childrenCount = 0,
}: MasterCatalogTabProps) {
  // Use the incoming isParent prop directly, not from product
  const actualIsParent = isParent || product?.isParent || false
  
  const [formData, setFormData] = useState({
    sku: product?.sku || '',
    name: product?.name || '',
    basePrice: product?.basePrice || 0,
    description: product?.description || '',
    attributes: product?.attributes || {},
    isParent: actualIsParent,
  })

  const [images, setImages] = useState<any[]>(masterImages || [])
  const [childProducts, setChildProducts] = useState<any[]>(product?.children || [])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showOrphansOnly, setShowOrphansOnly] = useState(false)
  const [isOrphansExpanded, setIsOrphansExpanded] = useState(false)
  
  // New variant creation form
  const [showCreateVariantForm, setShowCreateVariantForm] = useState(false)
  const [newVariantForm, setNewVariantForm] = useState({
    sku: '',
    name: '',
    basePrice: 0,
    totalStock: 0,
  })
  const [isCreatingVariant, setIsCreatingVariant] = useState(false)
  const [variantError, setVariantError] = useState<string | null>(null)

  // Matrix variation generator
  const [showMatrixGenerator, setShowMatrixGenerator] = useState(false)
  const [isGeneratingBulk, setIsGeneratingBulk] = useState(false)
  const [bulkGeneratorError, setBulkGeneratorError] = useState<string | null>(null)

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'basePrice' ? parseFloat(value) || 0 : value,
    }))
  }, [])

  const handleAttributeChange = useCallback((key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      attributes: {
        ...prev.attributes,
        [key]: value,
      },
    }))
  }, [])

  const handleAddAttribute = useCallback(() => {
    const newKey = `attr_${Date.now()}`
    setFormData((prev) => ({
      ...prev,
      attributes: {
        ...prev.attributes,
        [newKey]: '',
      },
    }))
  }, [])

  const handleRemoveAttribute = useCallback((key: string) => {
    setFormData((prev) => {
      const newAttributes = { ...prev.attributes }
      delete newAttributes[key]
      return {
        ...prev,
        attributes: newAttributes,
      }
    })
  }, [])

  const handleImagesChange = useCallback((updatedImages: any[]) => {
    setImages(updatedImages)
    if (onImagesUpdate) {
      onImagesUpdate(updatedImages)
    }
    logger.info('Master images updated', { count: updatedImages.length })
  }, [onImagesUpdate])

  const handleParentToggle = useCallback(() => {
    // Prevent toggling if product has children (locked state)
    if (childProducts.length > 0) {
      logger.warn('Cannot toggle parent status: product has children', { childCount: childProducts.length })
      return
    }
    setFormData((prev) => ({
      ...prev,
      isParent: !prev.isParent,
    }))
    logger.info('Parent toggle changed', { isParent: !formData.isParent })
  }, [formData.isParent, childProducts.length])

  const handleSearchChildren = useCallback(async (query: string) => {
    setSearchQuery(query)
    if (query.length < 2) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    try {
      const response = await fetch(`/api/products?search=${encodeURIComponent(query)}&limit=10`)
      if (response.ok) {
        const data = await response.json()
        // Filter out current product and already linked children
        const linkedIds = new Set([product.id, ...childProducts.map((c) => c.id)])
        let filtered = (data.products || []).filter((p: any) => !linkedIds.has(p.id))
        
        // Filter orphans if toggle is enabled
        if (showOrphansOnly) {
          filtered = filtered.filter((p: any) =>
            !p.isParent &&
            !p.masterProductId &&
            p.channelListings?.some((cl: any) => cl.channel === 'AMAZON')
          )
        }
        
        setSearchResults(filtered)
      }
    } catch (error) {
      logger.error('Error searching products', { error })
    } finally {
      setIsSearching(false)
    }
  }, [product.id, childProducts, showOrphansOnly])

  const handleAddChild = useCallback((childProduct: any) => {
    if (!childProducts.find((c) => c.id === childProduct.id)) {
      setChildProducts((prev) => [...prev, childProduct])
      setSearchQuery('')
      setSearchResults([])
      logger.info('Child product added', { childId: childProduct.id, childSku: childProduct.sku })
    }
  }, [childProducts])

  const handleCreateVariant = useCallback(async () => {
    try {
      setVariantError(null)
      setIsCreatingVariant(true)

      // Validate form
      if (!newVariantForm.sku || !newVariantForm.name) {
        setVariantError('SKU and name are required')
        setIsCreatingVariant(false)
        return
      }

      // Call the API to create the variant
      const response = await fetch(
        `http://localhost:3001/api/catalog/products/${product.id}/children`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: newVariantForm.sku,
            name: newVariantForm.name,
            basePrice: parseFloat(String(newVariantForm.basePrice)) || 0,
            totalStock: parseInt(String(newVariantForm.totalStock), 10) || 0,
          }),
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || 'Failed to create variant')
      }

      const result = await response.json()
      
      // Add the new variant to the list
      setChildProducts((prev) => [...prev, result.data])
      
      // Reset the form
      setNewVariantForm({ sku: '', name: '', basePrice: 0, totalStock: 0 })
      setShowCreateVariantForm(false)
      
      logger.info('Variant created successfully', {
        variantId: result.data.id,
        sku: result.data.sku
      })
    } catch (error: any) {
      logger.error('Failed to create variant', { error: error.message })
      setVariantError(error.message || 'Failed to create variant')
    } finally {
      setIsCreatingVariant(false)
    }
  }, [product.id, newVariantForm])

  const handleBulkGenerateVariants = useCallback(
    async (variations: GeneratedVariation[], globalPrice: number, globalStock: number) => {
      try {
        setIsGeneratingBulk(true)
        setBulkGeneratorError(null)

        logger.info('Starting bulk variant generation', {
          count: variations.length,
          price: globalPrice,
          stock: globalStock,
        })

        // Call the bulk-variants API
        const response = await fetch(
          `http://localhost:3001/api/catalog/products/${product.id}/bulk-variants`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              variations,
              globalPrice,
              globalStock,
            }),
          }
        )

        if (!response.ok) {
          const error = await response.json()
          throw new Error(error.error?.message || 'Failed to generate variants')
        }

        const result = await response.json()

        // Add all new variants to the list
        setChildProducts((prev) => [...prev, ...result.data.variations])

        // Close the generator
        setShowMatrixGenerator(false)

        logger.info('Bulk variants created successfully', {
          count: result.data.createdCount,
        })
      } catch (error: any) {
        logger.error('Failed to generate bulk variants', { error: error.message })
        setBulkGeneratorError(error.message || 'Failed to generate variants')
      } finally {
        setIsGeneratingBulk(false)
      }
    },
    [product.id]
  )

  const handleSave = useCallback(() => {
    onUpdate({
      ...formData,
      children: childProducts,
    })
    logger.info('Master catalog changes saved', { sku: formData.sku, childCount: childProducts.length })
  }, [formData, childProducts, onUpdate])

  // Nuclear debug logging
  console.log("🔥 DEBUG MATRIX:", { isParent, childProducts: childProducts?.length || 0, actualIsParent })

  return (
    <div className="space-y-8">
      {/* NUCLEAR DEBUG BANNER */}
      <div className="bg-red-600 text-white p-4 font-bold text-xl mb-4 rounded">
        DEBUG: MASTER CATALOG TAB IS RENDERED! Children count: {childProducts?.length || 0} | isParent Prop: {String(isParent)}
      </div>

      {/* Variations (Parent/Child) Section */}
      <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg p-6 border border-purple-200">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Variation Management</h2>
            <p className="text-sm text-gray-600 mt-1">
              Manage parent-child relationships and link orphaned SKUs
            </p>
          </div>
          <div className="text-3xl">🔗</div>
        </div>

        {/* Parent Toggle */}
        <div className="bg-white rounded-lg p-4 border border-purple-200 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Is this a Parent Product?</h3>
              <p className="text-sm text-gray-600 mt-1">
                {formData.isParent
                  ? '✓ This product is a parent with child variations'
                  : '✗ This is a standalone product (no variations)'}
              </p>
            </div>
            <button
              onClick={handleParentToggle}
              disabled={childProducts.length > 0}
              className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                childProducts.length > 0
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed opacity-60'
                  : formData.isParent
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
              }`}
              title={childProducts.length > 0 ? 'Cannot change parent status: product has variations' : ''}
            >
              {formData.isParent ? '✓ Parent' : 'Standalone'}
            </button>
          </div>
        </div>

        {/* Child Products Section - Show if parent OR if children exist */}
        {(actualIsParent || childProducts.length > 0) && (
          <div className="space-y-4">
            {/* SECTION 1: Active Variations (Amazon-Style Matrix) */}
            {childProducts.length > 0 && (
              <div className="bg-white rounded-lg border border-green-200 overflow-hidden">
                <div className="px-4 py-3 bg-green-50 border-b border-green-200">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <span className="text-lg">✓</span>
                    Active Variations ({childProducts.length})
                  </h3>
                  <p className="text-xs text-gray-600 mt-1">Edit SKU, price, and stock directly. Changes are saved instantly.</p>
                </div>
                <div className="p-4">
                  <VariationMatrixTable
                    children={childProducts}
                    onUpdate={async (childId, updates) => {
                      // Parse numeric values to ensure proper types
                      const parsedUpdates = {
                        sku: updates.sku,
                        basePrice: updates.basePrice !== undefined ? Number(updates.basePrice) : undefined,
                        totalStock: updates.totalStock !== undefined ? Number(updates.totalStock) : undefined,
                      }

                      // Update local state optimistically
                      setChildProducts((prev) =>
                        prev.map((c) =>
                          c.id === childId
                            ? {
                                ...c,
                                sku: parsedUpdates.sku || c.sku,
                                basePrice: parsedUpdates.basePrice || c.basePrice,
                                totalStock: parsedUpdates.totalStock !== undefined ? parsedUpdates.totalStock : c.totalStock,
                              }
                            : c
                        )
                      )
                      // Call API to update in database
                      try {
                        const response = await fetch(`http://localhost:3001/api/catalog/products/${product.id}/children/${childId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(parsedUpdates),
                        })
                        if (!response.ok) {
                          const errorText = await response.text()
                          console.error('🔴 PATCH failed:', {
                            status: response.status,
                            statusText: response.statusText,
                            body: errorText,
                            url: `http://localhost:3001/api/catalog/products/${product.id}/children/${childId}`,
                            payload: parsedUpdates,
                          })
                          throw new Error(`Failed to update child product: ${response.status} ${errorText}`)
                        }
                      } catch (error) {
                        logger.error('Failed to update child product', { error })
                        throw error
                      }
                    }}
                    onDelete={async (childId) => {
                      // Remove from local state optimistically
                      setChildProducts((prev) => prev.filter((c) => c.id !== childId))
                      // Call API to delete from database
                      try {
                        const response = await fetch(`http://localhost:3001/api/catalog/products/${product.id}/children/${childId}`, {
                          method: 'DELETE',
                        })
                        if (!response.ok) {
                          const errorText = await response.text()
                          console.error('🔴 DELETE failed:', {
                            status: response.status,
                            statusText: response.statusText,
                            body: errorText,
                            url: `http://localhost:3001/api/catalog/products/${product.id}/children/${childId}`,
                          })
                          throw new Error(`Failed to delete child product: ${response.status} ${errorText}`)
                        }
                      } catch (error) {
                        logger.error('Failed to delete child product', { error })
                        throw error
                      }
                    }}
                  />
                </div>
              </div>
            )}

            {/* SECTION 1.4: Matrix Variation Generator */}
            {(actualIsParent || childProducts.length > 0) && (
              <div className="bg-white rounded-lg border border-indigo-200 overflow-hidden">
                <button
                  onClick={() => setShowMatrixGenerator(!showMatrixGenerator)}
                  className="w-full px-4 py-4 flex items-center justify-between hover:bg-indigo-50 transition-colors border-b border-indigo-200"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">🔲</span>
                    <div className="text-left">
                      <h3 className="font-semibold text-gray-900">Bulk Variation Generator</h3>
                      <p className="text-xs text-gray-600 mt-0.5">Create multiple variants at once using a matrix builder</p>
                    </div>
                  </div>
                  <ChevronDown
                    size={20}
                    className={`text-gray-600 transition-transform ${showMatrixGenerator ? 'rotate-180' : ''}`}
                  />
                </button>

                {showMatrixGenerator && (
                  <div className="px-4 py-4 border-t border-indigo-200">
                    {bulkGeneratorError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 mb-4">
                        {bulkGeneratorError}
                      </div>
                    )}
                    <VariationGenerator
                      parentSku={formData.sku}
                      onGenerate={handleBulkGenerateVariants}
                      isLoading={isGeneratingBulk}
                    />
                  </div>
                )}
              </div>
            )}

            {/* SECTION 1.5: Create New Variant */}
            {(actualIsParent || childProducts.length > 0) && (
              <div className="bg-white rounded-lg border border-blue-200 overflow-hidden">
                <button
                  onClick={() => setShowCreateVariantForm(!showCreateVariantForm)}
                  className="w-full px-4 py-4 flex items-center justify-between hover:bg-blue-50 transition-colors border-b border-blue-200"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">➕</span>
                    <div className="text-left">
                      <h3 className="font-semibold text-gray-900">Create New Variant</h3>
                      <p className="text-xs text-gray-600 mt-0.5">Add a new child product to this parent</p>
                    </div>
                  </div>
                  <ChevronDown
                    size={20}
                    className={`text-gray-600 transition-transform ${showCreateVariantForm ? 'rotate-180' : ''}`}
                  />
                </button>

                {showCreateVariantForm && (
                  <div className="px-4 py-4 border-t border-blue-200 space-y-4">
                    {variantError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                        {variantError}
                      </div>
                    )}
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">SKU *</label>
                        <input
                          type="text"
                          value={newVariantForm.sku}
                          onChange={(e) => setNewVariantForm({ ...newVariantForm, sku: e.target.value })}
                          placeholder="e.g., JACKET-BLACK-M"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                        <input
                          type="text"
                          value={newVariantForm.name}
                          onChange={(e) => setNewVariantForm({ ...newVariantForm, name: e.target.value })}
                          placeholder="e.g., Black Jacket - Medium"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Base Price</label>
                        <input
                          type="number"
                          step="0.01"
                          value={newVariantForm.basePrice}
                          onChange={(e) => setNewVariantForm({ ...newVariantForm, basePrice: parseFloat(e.target.value) || 0 })}
                          placeholder="0.00"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Total Stock</label>
                        <input
                          type="number"
                          value={newVariantForm.totalStock}
                          onChange={(e) => setNewVariantForm({ ...newVariantForm, totalStock: parseInt(e.target.value) || 0 })}
                          placeholder="0"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={handleCreateVariant}
                        disabled={isCreatingVariant}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                      >
                        {isCreatingVariant ? 'Creating...' : '✓ Create Variant'}
                      </button>
                      <button
                        onClick={() => {
                          setShowCreateVariantForm(false)
                          setVariantError(null)
                        }}
                        className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 2: Adopt Orphaned SKUs (Collapsible Accordion) */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <button
                onClick={() => setIsOrphansExpanded(!isOrphansExpanded)}
                className="w-full px-4 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors border-b border-gray-200"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">🏚️</span>
                  <div className="text-left">
                    <h3 className="font-semibold text-gray-900">Adopt Orphaned SKUs</h3>
                    <p className="text-xs text-gray-600 mt-0.5">Optional: Link existing unlinked products to this parent</p>
                  </div>
                </div>
                <ChevronDown
                  size={20}
                  className={`text-gray-600 transition-transform ${isOrphansExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isOrphansExpanded && (
                <div className="px-4 py-4 border-t border-gray-200 space-y-4">
                  {/* Search Input */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Search Products</label>
                    <div className="relative">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => handleSearchChildren(e.target.value)}
                        placeholder="Search by SKU or name..."
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                      {isSearching && (
                        <div className="absolute right-3 top-2.5">
                          <div className="animate-spin h-5 w-5 text-purple-600">⟳</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Orphans Filter Toggle */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowOrphansOnly(!showOrphansOnly)}
                      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        showOrphansOnly
                          ? 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                          : 'bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200'
                      }`}
                    >
                      {showOrphansOnly ? '🏚️ Orphans Only' : '🏚️ Show All'}
                    </button>
                    <p className="text-xs text-gray-600">Filter to show only unlinked products</p>
                  </div>

                  {/* Search Results */}
                  {searchResults.length > 0 && (
                    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg">
                      {searchResults.map((result) => (
                        <div
                          key={result.id}
                          className="flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50"
                        >
                          <div>
                            <p className="font-medium text-gray-900">{result.sku}</p>
                            <p className="text-sm text-gray-600">{result.name}</p>
                          </div>
                          <button
                            onClick={() => handleAddChild(result)}
                            className="px-3 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-sm font-medium"
                          >
                            + Link
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {searchQuery && searchResults.length === 0 && !isSearching && (
                    <p className="text-sm text-gray-500 italic">No products found matching your search</p>
                  )}

                  {!searchQuery && (
                    <p className="text-sm text-gray-500 italic">Start typing to search for orphaned SKUs to link</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Master Product Information */}
      <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">Master Product Information</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Internal SKU */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Internal SKU</label>
            <input
              type="text"
              name="sku"
              value={formData.sku}
              onChange={handleInputChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., PROD-001"
            />
            <p className="text-xs text-gray-500 mt-1">Unique identifier for this master product</p>
          </div>

          {/* Master Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Master Product Name</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleInputChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., Premium Wireless Headphones"
            />
            <p className="text-xs text-gray-500 mt-1">Base name inherited by all channel listings</p>
          </div>

          {/* Base Price */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Base Price (USD)</label>
            <input
              type="number"
              name="basePrice"
              value={formData.basePrice}
              onChange={handleInputChange}
              step="0.01"
              min="0"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="0.00"
            />
            <p className="text-xs text-gray-500 mt-1">Default price for channel listings</p>
          </div>
        </div>

        {/* Description */}
        <div className="mt-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">Master Description</label>
          <textarea
            name="description"
            value={formData.description}
            onChange={handleInputChange}
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Detailed product description..."
          />
          <p className="text-xs text-gray-500 mt-1">Base description for all channels</p>
        </div>
      </div>

      {/* Master Attributes */}
      <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-900">Master Attributes</h2>
          <button
            onClick={handleAddAttribute}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            + Add Attribute
          </button>
        </div>

        <div className="space-y-4">
          {Object.entries(formData.attributes).map(([key, value]) => (
            <div key={key} className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Attribute Name</label>
                <input
                  type="text"
                  value={key.replace('attr_', '')}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
                <input
                  type="text"
                  value={value as string}
                  onChange={(e) => handleAttributeChange(key, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Attribute value"
                />
              </div>
              <button
                onClick={() => handleRemoveAttribute(key)}
                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {Object.keys(formData.attributes).length === 0 && (
          <p className="text-gray-500 text-sm italic">
            No attributes yet. Click "Add Attribute" to get started.
          </p>
        )}
      </div>

      {/* Master Images */}
      <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">Master Images</h2>
        <p className="text-sm text-gray-600 mb-6">
          📌 Master images are used as defaults across all platforms. Regional images can override
          these for specific markets.
        </p>
        <ChannelListingImageUploader
          images={images}
          onImagesChange={handleImagesChange}
          context="master"
          maxImages={10}
        />
      </div>

      {/* Save Button */}
      <div className="flex justify-end gap-3">
        <button
          onClick={handleSave}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
        >
          💾 Save Master Catalog
        </button>
      </div>
    </div>
  )
}

export default memo(MasterCatalogTabComponent)
