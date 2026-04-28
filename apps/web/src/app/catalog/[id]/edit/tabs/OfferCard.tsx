'use client'

import { useState, useCallback, useRef, memo } from 'react'
import { logger } from '@/lib/logger'

interface Offer {
  id: string
  channelListingId: string
  fulfillmentMethod: 'FBA' | 'FBM'
  sku: string
  price: number
  quantity: number
  leadTime: number
  minPrice?: number
  maxPrice?: number
  costPrice?: number
  isActive?: boolean
}

interface OfferCardProps {
  offer: Offer
  onUpdate: (updatedOffer: Offer) => void
  onDelete: () => void
}

function OfferCardComponent({ offer, onUpdate, onDelete }: OfferCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [formData, setFormData] = useState(offer)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]:
        name === 'fulfillmentMethod'
          ? value
          : ['price', 'minPrice', 'maxPrice', 'costPrice'].includes(name)
            ? parseFloat(value) || 0
            : ['quantity', 'leadTime'].includes(name)
              ? parseInt(value) || 0
              : value,
    }))

    // Debounce updates to parent (300ms)
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      onUpdate(formData)
    }, 300)
  }, [formData, onUpdate])

  const handleSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    onUpdate(formData)
    setIsExpanded(false)
    logger.info('Offer updated', { offerId: offer.id, fulfillmentMethod: formData.fulfillmentMethod })
  }, [formData, offer.id, onUpdate])

  const handleCancel = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    setFormData(offer)
    setIsExpanded(false)
  }, [offer])

  const handleDelete = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    onDelete()
    logger.info('Offer deleted', { offerId: offer.id })
  }, [offer.id, onDelete])

  const handleToggleActive = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      isActive: !prev.isActive,
    }))
    // Debounce update to parent
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      onUpdate({
        ...formData,
        isActive: !formData.isActive,
      })
    }, 300)
  }, [formData, onUpdate])

  const isFBA = formData.fulfillmentMethod === 'FBA'
  const margin = formData.costPrice ? ((formData.price - formData.costPrice) / formData.price * 100).toFixed(1) : 'N/A'

  return (
    <div className={`border rounded-lg transition-all ${isExpanded ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
      {/* Collapsed View */}
      {!isExpanded && (
        <div
          onClick={() => setIsExpanded(true)}
          className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-white ${isFBA ? 'bg-orange-500' : 'bg-blue-500'}`}>
                {isFBA ? 'FBA' : 'FBM'}
              </div>
              <div>
                <h4 className="font-semibold text-gray-900">{isFBA ? 'Fulfilled by Amazon' : 'Fulfilled by Merchant'}</h4>
                <p className="text-sm text-gray-600">SKU: {formData.sku}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold text-gray-900">${formData.price.toFixed(2)}</p>
              <p className="text-sm text-gray-600">{formData.quantity} in stock</p>
            </div>
          </div>
        </div>
      )}

      {/* Expanded View */}
      {isExpanded && (
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 pb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              {isFBA ? '📦 FBA Offer' : '🏪 FBM Offer'}
            </h3>
            <button
              onClick={handleCancel}
              className="text-gray-400 hover:text-gray-600 text-2xl"
            >
              ✕
            </button>
          </div>

          {/* PHASE 15: Active Offer Toggle */}
          <div className={`rounded-lg p-4 border-2 transition-all ${
            formData.isActive
              ? 'bg-green-50 border-green-300'
              : 'bg-gray-50 border-gray-300'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-semibold text-gray-900">Active Offer</h4>
                <p className="text-sm text-gray-600 mt-1">
                  {formData.isActive
                    ? '✓ This offer will be synced to the platform'
                    : '✗ This offer will NOT be synced to the platform'}
                </p>
              </div>
              <button
                onClick={handleToggleActive}
                className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                  formData.isActive
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-400 text-white hover:bg-gray-500'
                }`}
              >
                {formData.isActive ? '✓ Active' : '✗ Inactive'}
              </button>
            </div>
          </div>

          {/* Fulfillment Method Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Fulfillment Method</label>
            <div className="grid grid-cols-2 gap-3">
              {(['FBA', 'FBM'] as const).map((method) => (
                <button
                  key={method}
                  onClick={() => setFormData((prev) => ({ ...prev, fulfillmentMethod: method }))}
                  className={`p-3 rounded-lg border-2 font-medium transition-all ${
                    formData.fulfillmentMethod === method
                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {method === 'FBA' ? '📦 FBA' : '🏪 FBM'}
                  <div className="text-xs text-gray-600 mt-1">
                    {method === 'FBA' ? 'Amazon Fulfillment' : 'Your Fulfillment'}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {isFBA
                ? 'Amazon handles storage, shipping, and returns'
                : 'You handle storage, shipping, and returns'}
            </p>
          </div>

          {/* SKU */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">SKU</label>
            <input
              type="text"
              name="sku"
              value={formData.sku}
              onChange={handleInputChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., SKU-FBA-001"
            />
            <p className="text-xs text-gray-500 mt-1">Unique SKU for this fulfillment method</p>
          </div>

          {/* Pricing Grid */}
          <div className="grid grid-cols-2 gap-4">
            {/* Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Selling Price</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                <input
                  type="number"
                  name="price"
                  value={formData.price}
                  onChange={handleInputChange}
                  step="0.01"
                  min="0"
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Cost Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Cost Price</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                <input
                  type="number"
                  name="costPrice"
                  value={formData.costPrice || 0}
                  onChange={handleInputChange}
                  step="0.01"
                  min="0"
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Min Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Min Price</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                <input
                  type="number"
                  name="minPrice"
                  value={formData.minPrice || 0}
                  onChange={handleInputChange}
                  step="0.01"
                  min="0"
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Max Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Max Price</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                <input
                  type="number"
                  name="maxPrice"
                  value={formData.maxPrice || 0}
                  onChange={handleInputChange}
                  step="0.01"
                  min="0"
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Margin Display */}
          {formData.costPrice && formData.costPrice > 0 && (
            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Profit Margin</span>
                <span className={`text-lg font-bold ${parseFloat(margin as string) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {margin}%
                </span>
              </div>
            </div>
          )}

          {/* Inventory */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Quantity</label>
              <input
                type="number"
                name="quantity"
                value={formData.quantity}
                onChange={handleInputChange}
                min="0"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Lead Time (days)</label>
              <input
                type="number"
                name="leadTime"
                value={formData.leadTime}
                onChange={handleInputChange}
                min="0"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* FBA-Specific Info */}
          {isFBA && (
            <div className="bg-orange-50 rounded-lg p-4 border border-orange-200">
              <h4 className="font-semibold text-gray-900 mb-2">FBA Details</h4>
              <ul className="text-sm text-gray-700 space-y-1">
                <li>✓ Amazon handles fulfillment and returns</li>
                <li>✓ Eligible for Prime shipping</li>
                <li>✓ Amazon charges fulfillment fees</li>
                <li>✓ Inventory stored in Amazon warehouses</li>
              </ul>
            </div>
          )}

          {/* FBM-Specific Info */}
          {!isFBA && (
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <h4 className="font-semibold text-gray-900 mb-2">FBM Details</h4>
              <ul className="text-sm text-gray-700 space-y-1">
                <li>✓ You handle all fulfillment</li>
                <li>✓ Lower fees than FBA</li>
                <li>✓ More control over shipping</li>
                <li>✓ Inventory stored at your location</li>
              </ul>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 border-t border-gray-200 pt-6">
            <button
              onClick={handleSave}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              ✓ Save Offer
            </button>
            <button
              onClick={handleCancel}
              className="flex-1 px-4 py-2.5 bg-gray-200 text-gray-900 rounded-lg hover:bg-gray-300 transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              className="px-4 py-2.5 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors font-medium"
            >
              🗑️
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(OfferCardComponent)
