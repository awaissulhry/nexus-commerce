'use client'

import { useState, useCallback, memo } from 'react'
import { logger } from '@/lib/logger'
import OfferCard from './OfferCard'
import ChannelListingImageUploader from '@/components/catalog/ChannelListingImageUploader'

interface ChannelListing {
  id: string
  channel: string
  region: string
  externalListingId?: string
  platformProductId?: string
  title: string
  description: string
  price: number
  quantity: number
  syncFromMaster: boolean
  syncLocked: boolean
  isPublished: boolean
  useCustomImages?: boolean
  variationTheme?: string
  variationMapping?: Record<string, any>
  offers: any[]
  images: any[]
}

interface PlatformTabProps {
  platform: string
  product: any
  channelListings: ChannelListing[]
  onUpdate: (updatedListings: ChannelListing[]) => void
}

const REGIONS_BY_PLATFORM: Record<string, string[]> = {
  amazon: ['US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU', 'IN'],
  ebay: ['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'AU', 'CA'],
  // ── PHASE 12a: Shopify Simplification ─────────────────────────
  // Shopify handles global markets from a single storefront (no regional variants)
  shopify: ['GLOBAL'],
  woocommerce: ['US', 'CA', 'UK', 'AU', 'DE', 'FR'],
}

function PlatformTabComponent({
  platform,
  product,
  channelListings,
  onUpdate,
}: PlatformTabProps) {
  const [activeRegion, setActiveRegion] = useState<string>(
    channelListings.length > 0 ? channelListings[0].region : REGIONS_BY_PLATFORM[platform]?.[0] || 'US'
  )

  const regions = REGIONS_BY_PLATFORM[platform] || ['US']
  const listingsForRegion = channelListings.filter((cl) => cl.region === activeRegion)
  const activeListing = listingsForRegion.length > 0 ? listingsForRegion[0] : null

  const handleListingUpdate = useCallback((updatedListing: ChannelListing) => {
    const updated = channelListings.map((cl) => (cl.id === updatedListing.id ? updatedListing : cl))
    onUpdate(updated)
    logger.info('Listing updated', { listingId: updatedListing.id, region: activeRegion })
  }, [channelListings, activeRegion, onUpdate])

  const handleAddListing = useCallback(() => {
    const newListing: ChannelListing = {
      id: `listing_${Date.now()}`,
      channel: platform.toUpperCase(),
      region: activeRegion,
      title: product.name,
      description: product.description || '',
      price: product.basePrice || 0,
      quantity: product.totalStock || 0,
      syncFromMaster: true,
      syncLocked: false,
      isPublished: false,
      offers: [],
      images: [],
    }
    onUpdate([...channelListings, newListing])
    logger.info('New listing created', { region: activeRegion })
  }, [channelListings, activeRegion, product, onUpdate])

  const handleDeleteListing = useCallback((listingId: string) => {
    const updated = channelListings.filter((cl) => cl.id !== listingId)
    onUpdate(updated)
    logger.info('Listing deleted', { listingId })
  }, [channelListings, onUpdate])

  const handleSyncFromMaster = useCallback(() => {
    if (!activeListing) return

    const updated = {
      ...activeListing,
      title: product.name,
      description: product.description || '',
      price: product.basePrice || 0,
      quantity: product.totalStock || 0,
      syncFromMaster: true,
    }
    handleListingUpdate(updated)
    logger.info('Synced from master', { listingId: activeListing.id })
  }, [activeListing, product, handleListingUpdate])

  const handleTitleChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      title: value,
      syncFromMaster: false,
    })
  }, [activeListing, handleListingUpdate])

  const handlePriceChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      price: parseFloat(value) || 0,
      syncFromMaster: false,
    })
  }, [activeListing, handleListingUpdate])

  const handleQuantityChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      quantity: parseInt(value) || 0,
      syncFromMaster: false,
    })
  }, [activeListing, handleListingUpdate])

  const handleExternalIdChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      externalListingId: value,
    })
  }, [activeListing, handleListingUpdate])

  const handlePlatformProductIdChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      platformProductId: value,
    })
  }, [activeListing, handleListingUpdate])

  const handleTogglePublished = useCallback(() => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      isPublished: !activeListing.isPublished,
    })
  }, [activeListing, handleListingUpdate])

  const handleDescriptionChange = useCallback((value: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      description: value,
      syncFromMaster: false,
    })
  }, [activeListing, handleListingUpdate])

  const handleToggleCustomImages = useCallback(() => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      useCustomImages: !activeListing.useCustomImages,
    })
  }, [activeListing, handleListingUpdate])

  const handleImagesChange = useCallback((updatedImages: any[]) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      images: updatedImages,
    })
  }, [activeListing, handleListingUpdate])

  const handleVariationThemeChange = useCallback((theme: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      variationTheme: theme,
    })
  }, [activeListing, handleListingUpdate])

  const handleVariationMappingChange = useCallback((masterAttr: string, mappedValue: string) => {
    if (!activeListing) return
    const currentMapping = activeListing.variationMapping || {}
    handleListingUpdate({
      ...activeListing,
      variationMapping: {
        ...currentMapping,
        [masterAttr]: mappedValue,
      },
    })
  }, [activeListing, handleListingUpdate])

  const handleAddOffer = useCallback(() => {
    if (!activeListing) return
    const newOffer = {
      id: `offer_${Date.now()}`,
      channelListingId: activeListing.id,
      fulfillmentMethod: 'FBA',
      sku: `${activeListing.id}-FBA`,
      price: activeListing.price,
      quantity: activeListing.quantity,
      leadTime: 1,
    }
    handleListingUpdate({
      ...activeListing,
      offers: [...activeListing.offers, newOffer],
    })
  }, [activeListing, handleListingUpdate])

  const handleOfferUpdate = useCallback((updatedOffer: any) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      offers: activeListing.offers.map((o) =>
        o.id === updatedOffer.id ? updatedOffer : o
      ),
    })
  }, [activeListing, handleListingUpdate])

  const handleOfferDelete = useCallback((offerId: string) => {
    if (!activeListing) return
    handleListingUpdate({
      ...activeListing,
      offers: activeListing.offers.filter((o) => o.id !== offerId),
    })
  }, [activeListing, handleListingUpdate])

  return (
    <div className="space-y-6">
      {/* Platform Header */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 capitalize">{platform} Listings</h2>
            <p className="text-sm text-gray-600 mt-1">
              Manage platform-specific listings and offers for {product.name}
            </p>
          </div>
          <div className="text-4xl">{getPlatformEmoji(platform)}</div>
        </div>
      </div>

      {/* Regional Market Tabs */}
      {/* ── PHASE 12a: Shopify Simplification ─────────────────────────
           Shopify uses GLOBAL region (no regional sub-tabs) */}
      {platform.toLowerCase() !== 'shopify' ? (
        <div className="bg-white rounded-lg shadow border border-gray-200">
          <div className="flex border-b border-gray-200 overflow-x-auto">
            {regions.map((region) => {
              const regionListings = channelListings.filter((cl) => cl.region === region)
              return (
                <button
                  key={region}
                  onClick={() => setActiveRegion(region)}
                  className={`px-6 py-4 font-medium whitespace-nowrap transition-colors relative ${
                    activeRegion === region
                      ? 'border-b-2 border-blue-600 text-blue-600 bg-blue-50'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {region}
                  {regionListings.length > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">
                      {regionListings.length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="p-6">
            {activeListing ? (
              <div className="space-y-6">
                {/* PHASE 15: Master Publishing Toggle */}
                <div className={`rounded-lg p-4 border-2 transition-all ${
                  activeListing.isPublished
                    ? 'bg-green-50 border-green-300'
                    : 'bg-red-50 border-red-300'
                }`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-gray-900">
                        Publish to {platform.charAt(0).toUpperCase() + platform.slice(1)}
                      </h4>
                      <p className="text-sm text-gray-600 mt-1">
                        {activeListing.isPublished
                          ? '✓ This listing will be synced to the platform'
                          : '✗ This listing will NOT be synced to the platform'}
                      </p>
                    </div>
                    <button
                      onClick={handleTogglePublished}
                      className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                        activeListing.isPublished
                          ? 'bg-green-600 text-white hover:bg-green-700'
                          : 'bg-red-600 text-white hover:bg-red-700'
                      }`}
                    >
                      {activeListing.isPublished ? '✓ Published' : '✗ Unpublished'}
                    </button>
                  </div>
                </div>

                {/* Listing Header */}
                <div className={`flex items-center justify-between bg-gray-50 rounded-lg p-4 border border-gray-200 transition-opacity ${
                  !activeListing.isPublished ? 'opacity-60' : ''
                }`}>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{activeListing.title}</h3>
                    <p className="text-sm text-gray-600 mt-1">
                      Region: <span className="font-medium">{activeListing.region}</span>
                      {activeListing.externalListingId && (
                        <>
                          {' '}
                          | ID: <span className="font-mono text-xs">{activeListing.externalListingId}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteListing(activeListing.id)}
                    className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors font-medium"
                  >
                    🗑️ Delete
                  </button>
                </div>

                {/* Sync Control */}
                <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-gray-900">Sync from Master</h4>
                      <p className="text-sm text-gray-600 mt-1">
                        {activeListing.syncFromMaster
                          ? '✓ This listing is synced with master catalog'
                          : '✗ This listing has custom data'}
                      </p>
                    </div>
                    <button
                      onClick={handleSyncFromMaster}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                    >
                      🔄 Sync Now
                    </button>
                  </div>
                </div>

                {/* Listing Details */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Listing Title</label>
                    <input
                      type="text"
                      value={activeListing.title}
                      onChange={(e) => handleTitleChange(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* Price */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Price ({platform})</label>
                    <input
                      type="number"
                      value={activeListing.price}
                      onChange={(e) => handlePriceChange(e.target.value)}
                      step="0.01"
                      min="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* Quantity */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Quantity Available</label>
                    <input
                      type="number"
                      value={activeListing.quantity}
                      onChange={(e) => handleQuantityChange(e.target.value)}
                      min="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* External Listing ID */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {platform.charAt(0).toUpperCase() + platform.slice(1)} Listing ID
                    </label>
                    <input
                      type="text"
                      value={activeListing.externalListingId || ''}
                      onChange={(e) => handleExternalIdChange(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., ASIN, Item ID, etc."
                    />
                  </div>

                  {/* PHASE 15: Platform Product ID (Analytics Grouping Key) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {platform.toLowerCase() === 'amazon'
                        ? 'ASIN (For Analytics Grouping)'
                        : platform.toLowerCase() === 'ebay'
                        ? 'eBay Item ID'
                        : 'Product ID'}
                    </label>
                    <input
                      type="text"
                      value={activeListing.platformProductId || ''}
                      onChange={(e) => handlePlatformProductIdChange(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder={platform.toLowerCase() === 'amazon' ? 'e.g., B0123456789' : 'e.g., 123456789012'}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {platform.toLowerCase() === 'amazon'
                        ? 'Groups FBA/FBM offers under a single ASIN for analytics'
                        : 'Groups variations under a single listing for analytics'}
                    </p>
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Listing Description</label>
                  <textarea
                    value={activeListing.description}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                    rows={4}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* Variation Mapping Section - Amazon Only */}
                {platform.toLowerCase() === 'amazon' && (
                  <div className="border-t border-gray-200 pt-6">
                    <div className="mb-6">
                      <h3 className="text-lg font-semibold text-gray-900 mb-4">🔗 Variation Mapping</h3>
                      <p className="text-sm text-gray-600 mb-4">
                        Tell Amazon how your product variations are organized (e.g., by size, color, or both)
                      </p>

                      {/* Variation Theme Dropdown */}
                      <div className="mb-6">
                        <label className="block text-sm font-medium text-gray-700 mb-2">How do your variations differ?</label>
                        <select
                          value={activeListing.variationTheme || ''}
                          onChange={(e) => handleVariationThemeChange(e.target.value)}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="">-- Select how your products vary --</option>
                          <option value="Size">By Size (S, M, L, XL, etc.)</option>
                          <option value="Color">By Color (Red, Blue, Green, etc.)</option>
                          <option value="SizeColor">By Size AND Color</option>
                          <option value="Style">By Style (Classic, Modern, etc.)</option>
                          <option value="Material">By Material (Cotton, Polyester, etc.)</option>
                          <option value="SizeMaterial">By Size AND Material</option>
                        </select>
                        <p className="text-xs text-gray-500 mt-1">
                          Choose the option that best describes how your child products differ from each other
                        </p>
                      </div>

                      {/* Attribute Mapping Inputs */}
                      {activeListing.variationTheme && (
                        <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                          <h4 className="font-semibold text-gray-900 mb-4">Map Your Internal Attributes to Amazon</h4>
                          <p className="text-sm text-gray-600 mb-4">
                            Tell Amazon what you call each attribute in your system. For example, if you use "Size" internally, enter "Size". If you use "Apparel_Size", enter that instead.
                          </p>

                          <div className="space-y-4">
                            {/* Size Mapping */}
                            {(activeListing.variationTheme === 'Size' ||
                              activeListing.variationTheme === 'SizeColor' ||
                              activeListing.variationTheme === 'SizeMaterial') && (
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  What do you call your size attribute internally?
                                </label>
                                <input
                                  type="text"
                                  value={activeListing.variationMapping?.Size || ''}
                                  onChange={(e) => handleVariationMappingChange('Size', e.target.value)}
                                  placeholder="e.g., Size, Apparel_Size, Shoe_Size"
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                                <p className="text-xs text-gray-500 mt-1">
                                  Enter the exact name you use in your system (e.g., "Size", "Apparel_Size", "Shoe_Size")
                                </p>
                              </div>
                            )}

                            {/* Color Mapping */}
                            {(activeListing.variationTheme === 'Color' ||
                              activeListing.variationTheme === 'SizeColor') && (
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  What do you call your color attribute internally?
                                </label>
                                <input
                                  type="text"
                                  value={activeListing.variationMapping?.Color || ''}
                                  onChange={(e) => handleVariationMappingChange('Color', e.target.value)}
                                  placeholder="e.g., Color, ColorMap, ProductColor"
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                                <p className="text-xs text-gray-500 mt-1">
                                  Enter the exact name you use in your system (e.g., "Color", "ColorMap", "ProductColor")
                                </p>
                              </div>
                            )}

                            {/* Style Mapping */}
                            {activeListing.variationTheme === 'Style' && (
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  What do you call your style attribute internally?
                                </label>
                                <input
                                  type="text"
                                  value={activeListing.variationMapping?.Style || ''}
                                  onChange={(e) => handleVariationMappingChange('Style', e.target.value)}
                                  placeholder="e.g., Style, StyleType, ProductStyle"
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                                <p className="text-xs text-gray-500 mt-1">
                                  Enter the exact name you use in your system
                                </p>
                              </div>
                            )}

                            {/* Material Mapping */}
                            {(activeListing.variationTheme === 'Material' ||
                              activeListing.variationTheme === 'SizeMaterial') && (
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  What do you call your material attribute internally?
                                </label>
                                <input
                                  type="text"
                                  value={activeListing.variationMapping?.Material || ''}
                                  onChange={(e) => handleVariationMappingChange('Material', e.target.value)}
                                  placeholder="e.g., Material, MaterialType, Fabric"
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                                <p className="text-xs text-gray-500 mt-1">
                                  Enter the exact name you use in your system
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Linked Children Preview */}
                          {product?.children && product.children.length > 0 && (
                            <div className="mt-6 pt-6 border-t border-blue-200">
                              <h4 className="font-semibold text-gray-900 mb-3">Linked Child Products</h4>
                              <div className="space-y-2">
                                {product.children.map((child: any) => (
                                  <div key={child.id} className="flex items-center justify-between bg-white p-3 rounded border border-gray-200">
                                    <div>
                                      <p className="font-medium text-gray-900">{child.sku}</p>
                                      <p className="text-sm text-gray-600">{child.name}</p>
                                    </div>
                                    {child.variationAttributes && (
                                      <div className="flex flex-wrap gap-1">
                                        {Object.entries(child.variationAttributes as Record<string, any>).map(
                                          ([key, value]) => (
                                            <span
                                              key={key}
                                              className="inline-block px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-medium"
                                            >
                                              {key}: {String(value)}
                                            </span>
                                          )
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Image Management Section */}
                <div className="border-t border-gray-200 pt-6">
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Regional Images</h3>
                    
                    {/* Image Source Toggle */}
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 mb-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-gray-900">Image Source</h4>
                          <p className="text-sm text-gray-600 mt-1">
                            {activeListing.useCustomImages
                              ? '🎨 Using custom regional images for this market'
                              : '📌 Using master images (default for all platforms)'}
                          </p>
                        </div>
                        <button
                          onClick={handleToggleCustomImages}
                          className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                            activeListing.useCustomImages
                              ? 'bg-green-600 text-white hover:bg-green-700'
                              : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                          }`}
                        >
                          {activeListing.useCustomImages ? '✓ Custom Images' : 'Use Master Images'}
                        </button>
                      </div>
                    </div>

                    {/* Image Uploader - Only show if custom images are enabled */}
                    {activeListing.useCustomImages && (
                      <ChannelListingImageUploader
                        images={activeListing.images || []}
                        onImagesChange={handleImagesChange}
                        context="channel"
                        maxImages={10}
                      />
                    )}

                    {/* Master Images Preview - Show if using master images */}
                    {!activeListing.useCustomImages && (
                      <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
                        <p className="text-sm text-blue-900 mb-4">
                          📌 Master images will be used for this listing. To use region-specific images, toggle "Custom Images" above.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Offers Section */}
                <div className="border-t border-gray-200 pt-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold text-gray-900">Fulfillment Offers</h3>
                    <button
                      onClick={handleAddOffer}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                    >
                      + Add Offer
                    </button>
                  </div>

                  {activeListing.offers && activeListing.offers.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activeListing.offers.map((offer) => (
                        <OfferCard
                          key={offer.id}
                          offer={offer}
                          onUpdate={handleOfferUpdate}
                          onDelete={() => handleOfferDelete(offer.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="bg-gray-50 rounded-lg p-6 text-center border border-gray-200">
                      <p className="text-gray-600">No offers yet. Click "Add Offer" to create one.</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <p className="text-gray-600 mb-4">No listings for {activeRegion} yet</p>
                <button
                  onClick={handleAddListing}
                  className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  + Create Listing for {activeRegion}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200 bg-blue-50">
            <h3 className="font-medium text-gray-900">Global Storefront</h3>
            <p className="text-sm text-gray-600 mt-1">Shopify handles all markets from a single global storefront</p>
          </div>

          <div className="p-6">
            {activeListing ? (
              <div className="space-y-6">
                {/* Listing Header */}
                <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{activeListing.title}</h3>
                    <p className="text-sm text-gray-600 mt-1">
                      Global Storefront
                      {activeListing.externalListingId && (
                        <>
                          {' '}
                          | ID: <span className="font-mono text-xs">{activeListing.externalListingId}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteListing(activeListing.id)}
                    className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors font-medium"
                  >
                    🗑️ Delete
                  </button>
                </div>

                {/* Sync Control */}
                <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-gray-900">Sync from Master</h4>
                      <p className="text-sm text-gray-600 mt-1">
                        {activeListing.syncFromMaster
                          ? '✓ This listing is synced with master catalog'
                          : '✗ This listing has custom data'}
                      </p>
                    </div>
                    <button
                      onClick={handleSyncFromMaster}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                    >
                      🔄 Sync Now
                    </button>
                  </div>
                </div>

                {/* Listing Details */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Listing Title</label>
                    <input
                      type="text"
                      value={activeListing.title}
                      onChange={(e) => handleTitleChange(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* Price */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Price (Shopify)</label>
                    <input
                      type="number"
                      value={activeListing.price}
                      onChange={(e) => handlePriceChange(e.target.value)}
                      step="0.01"
                      min="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* Quantity */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Quantity Available</label>
                    <input
                      type="number"
                      value={activeListing.quantity}
                      onChange={(e) => handleQuantityChange(e.target.value)}
                      min="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* External Listing ID */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Shopify Product ID</label>
                    <input
                      type="text"
                      value={activeListing.externalListingId || ''}
                      onChange={(e) => handleExternalIdChange(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., gid://shopify/Product/123456"
                    />
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Listing Description</label>
                  <textarea
                    value={activeListing.description}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                    rows={4}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* Image Management Section */}
                <div className="border-t border-gray-200 pt-6">
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Product Images</h3>
                    
                    {/* Image Source Toggle */}
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 mb-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-gray-900">Image Source</h4>
                          <p className="text-sm text-gray-600 mt-1">
                            {activeListing.useCustomImages
                              ? '🎨 Using custom Shopify images'
                              : '📌 Using master images (default)'}
                          </p>
                        </div>
                        <button
                          onClick={handleToggleCustomImages}
                          className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                            activeListing.useCustomImages
                              ? 'bg-green-600 text-white hover:bg-green-700'
                              : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                          }`}
                        >
                          {activeListing.useCustomImages ? '✓ Custom Images' : 'Use Master Images'}
                        </button>
                      </div>
                    </div>

                    {/* Image Uploader - Only show if custom images are enabled */}
                    {activeListing.useCustomImages && (
                      <ChannelListingImageUploader
                        images={activeListing.images || []}
                        onImagesChange={handleImagesChange}
                        context="channel"
                        maxImages={10}
                      />
                    )}

                    {/* Master Images Preview - Show if using master images */}
                    {!activeListing.useCustomImages && (
                      <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
                        <p className="text-sm text-blue-900 mb-4">
                          📌 Master images will be used for this listing. To use custom Shopify images, toggle "Custom Images" above.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Offers Section */}
                <div className="border-t border-gray-200 pt-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold text-gray-900">Fulfillment Offers</h3>
                    <button
                      onClick={handleAddOffer}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                    >
                      + Add Offer
                    </button>
                  </div>

                  {activeListing.offers && activeListing.offers.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activeListing.offers.map((offer) => (
                        <OfferCard
                          key={offer.id}
                          offer={offer}
                          onUpdate={handleOfferUpdate}
                          onDelete={() => handleOfferDelete(offer.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="bg-gray-50 rounded-lg p-6 text-center border border-gray-200">
                      <p className="text-gray-600">No offers yet. Click "Add Offer" to create one.</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <p className="text-gray-600 mb-4">No global storefront listing yet</p>
                <button
                  onClick={handleAddListing}
                  className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  + Create Global Listing
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(PlatformTabComponent)

function getPlatformEmoji(platform: string): string {
  const emojis: Record<string, string> = {
    amazon: '🛒',
    ebay: '🏪',
    shopify: '🛍️',
    woocommerce: '🌐',
  }
  return emojis[platform] || '📦'
}
