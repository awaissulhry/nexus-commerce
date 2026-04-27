'use client'

import { useState } from 'react'
import { Product, ChannelListing } from '@prisma/client'
import ChannelOverrideToggle from '@/components/catalog/ChannelOverrideToggle'
import TabValidationIcon from '@/components/catalog/TabValidationIcon'
import PayloadPreview from '@/components/catalog/PayloadPreview'
import type { ChannelType } from '@/lib/taxonomy/channel-mapper'

interface ChannelOverridesTabProps {
  product: any // Product with Decimal basePrice
  channelListings?: ChannelListing[]
}

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

const CHANNELS: { id: Channel; label: string; icon: string }[] = [
  { id: 'AMAZON', label: 'Amazon', icon: '🔶' },
  { id: 'EBAY', label: 'eBay', icon: '🔴' },
  { id: 'SHOPIFY', label: 'Shopify', icon: '🟢' },
]

export default function ChannelOverridesTab({ product, channelListings = [] }: ChannelOverridesTabProps) {
  const [activeChannel, setActiveChannel] = useState<Channel>('AMAZON')
  const [overrides, setOverrides] = useState<Record<Channel, Record<string, any>>>({
    AMAZON: {},
    EBAY: {},
    SHOPIFY: {},
  })

  // Calculate target price based on pricing rule
  const calculateTargetPrice = (): number => {
    const masterPrice = typeof product.basePrice === 'number' ? product.basePrice : parseFloat(String(product.basePrice || 0))
    const costPrice = typeof product.costPrice === 'number' ? product.costPrice : parseFloat(String(product.costPrice || 0))
    const minMargin = typeof product.minMargin === 'number' ? product.minMargin : parseFloat(String(product.minMargin || 10))
    const pricingRule = overrides[activeChannel].pricingRule || 'FIXED'
    const adjustmentPercent = parseFloat(String(overrides[activeChannel].priceAdjustmentPercent || 0))

    let calculatedPrice = masterPrice

    if (pricingRule === 'PERCENT_OF_MASTER') {
      calculatedPrice = masterPrice * (1 + adjustmentPercent / 100)
    }

    // Apply margin guard
    const floorPrice = costPrice > 0 ? costPrice * (1 + minMargin / 100) : 0
    if (floorPrice > 0 && calculatedPrice < floorPrice) {
      return floorPrice
    }

    return Math.round(calculatedPrice * 100) / 100
  }

  const isMarginGuarded = (): boolean => {
    const masterPrice = typeof product.basePrice === 'number' ? product.basePrice : parseFloat(String(product.basePrice || 0))
    const costPrice = typeof product.costPrice === 'number' ? product.costPrice : parseFloat(String(product.costPrice || 0))
    const minMargin = typeof product.minMargin === 'number' ? product.minMargin : parseFloat(String(product.minMargin || 10))
    const pricingRule = overrides[activeChannel].pricingRule || 'FIXED'
    const adjustmentPercent = parseFloat(String(overrides[activeChannel].priceAdjustmentPercent || 0))

    let calculatedPrice = masterPrice
    if (pricingRule === 'PERCENT_OF_MASTER') {
      calculatedPrice = masterPrice * (1 + adjustmentPercent / 100)
    }

    const floorPrice = costPrice > 0 ? costPrice * (1 + minMargin / 100) : 0
    return floorPrice > 0 && calculatedPrice < floorPrice
  }

  // Get the channel listing for the active channel
  const currentListing = channelListings.find(
    (cl) => cl.channel === activeChannel
  )

  // Handle toggle for following master
  const handleToggle = (field: string, isFollowing: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [activeChannel]: {
        ...prev[activeChannel],
        [`${field}Following`]: isFollowing,
      },
    }))
  }

  // Handle override value change
  const handleOverrideChange = (field: string, value: any) => {
    setOverrides((prev) => ({
      ...prev,
      [activeChannel]: {
        ...prev[activeChannel],
        [field]: value,
      },
    }))
  }

  // Get current override state for a field
  const getFieldState = (field: string) => {
    const isFollowing = overrides[activeChannel][`${field}Following`] ?? true
    const value = overrides[activeChannel][field]
    return { isFollowing, value }
  }

  return (
    <div className="space-y-6">
      {/* Channel Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-2">
          {CHANNELS.map((channel) => {
            const isActive = activeChannel === channel.id
            return (
              <button
                key={channel.id}
                onClick={() => setActiveChannel(channel.id)}
                className={`flex items-center gap-2 px-4 py-3 font-medium transition-colors ${
                  isActive
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <span>{channel.icon}</span>
                <span>{channel.label}</span>
                <TabValidationIcon status="VALID" />
              </button>
            )
          })}
        </div>
      </div>

      {/* Override Controls Grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Price Override */}
        <ChannelOverrideToggle
          label="Price"
          masterValue={typeof product.basePrice === 'number' ? product.basePrice : parseFloat(String(product.basePrice || 0))}
          overrideValue={getFieldState('price').value}
          isFollowingMaster={getFieldState('price').isFollowing}
          onToggle={(isFollowing) => handleToggle('price', isFollowing)}
          onChange={(value) => handleOverrideChange('price', value)}
          syncStatus="IDLE"
          lastSyncAt={null}
          inputType="number"
          placeholder="Enter custom price"
        />

        {/* Pricing Strategy Section */}
        <div className="md:col-span-2 border-t pt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">💰 Pricing Strategy</h3>
          
          <div className="space-y-4">
            {/* Strategy Dropdown */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Pricing Rule
              </label>
              <select
                value={overrides[activeChannel].pricingRule || 'FIXED'}
                onChange={(e) => handleOverrideChange('pricingRule', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="FIXED">Fixed Price (Use Master Price)</option>
                <option value="PERCENT_OF_MASTER">Percent of Master (Adjust by %)</option>
                <option value="MATCH_AMAZON">Match Amazon Price</option>
              </select>
            </div>

            {/* Adjustment Percentage (Only for PERCENT_OF_MASTER) */}
            {(overrides[activeChannel].pricingRule === 'PERCENT_OF_MASTER') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Price Adjustment (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={overrides[activeChannel].priceAdjustmentPercent || 0}
                    onChange={(e) => handleOverrideChange('priceAdjustmentPercent', parseFloat(e.target.value))}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., 10 for +10%, -5 for -5%"
                  />
                  <span className="text-sm text-gray-600">%</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Positive values increase price, negative values decrease it
                </p>
              </div>
            )}

            {/* Calculated Price Preview */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Calculated Price</p>
                  <p className="text-2xl font-bold text-blue-600">
                    ${calculateTargetPrice().toFixed(2)}
                  </p>
                  {isMarginGuarded() && (
                    <p className="text-xs text-orange-600 mt-1 flex items-center gap-1">
                      🛡️ Margin Protected (Floor: ${((typeof product.costPrice === 'number' ? product.costPrice : parseFloat(String(product.costPrice || 0))) * (1 + (typeof product.minMargin === 'number' ? product.minMargin : parseFloat(String(product.minMargin || 10))) / 100)).toFixed(2)})
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-600">Master Price</p>
                  <p className="text-lg font-semibold text-gray-900">
                    ${(typeof product.basePrice === 'number' ? product.basePrice : parseFloat(String(product.basePrice || 0))).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Title Override */}
        <ChannelOverrideToggle
          label="Title"
          masterValue={product.name}
          overrideValue={getFieldState('title').value}
          isFollowingMaster={getFieldState('title').isFollowing}
          onToggle={(isFollowing) => handleToggle('title', isFollowing)}
          onChange={(value) => handleOverrideChange('title', value)}
          syncStatus="IDLE"
          lastSyncAt={null}
          inputType="text"
          placeholder="Enter custom title"
        />

        {/* Description Override (Full Width) */}
        <div className="md:col-span-2">
          <ChannelOverrideToggle
            label="Description"
            masterValue={typeof product.aPlusContent === 'string' ? product.aPlusContent : 'No description'}
            overrideValue={getFieldState('description').value}
            isFollowingMaster={getFieldState('description').isFollowing}
            onToggle={(isFollowing) => handleToggle('description', isFollowing)}
            onChange={(value) => handleOverrideChange('description', value)}
            syncStatus="IDLE"
            lastSyncAt={null}
            inputType="text"
            placeholder="Enter custom description"
          />
        </div>
      </div>

      {/* API Payload Preview Section */}
      <div className="border-t pt-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">📋 API Payload Preview</h3>
        <PayloadPreview
          product={{
            id: product.id,
            sku: product.sku,
            name: product.name,
            basePrice: typeof product.basePrice === 'number' ? product.basePrice : parseFloat(String(product.basePrice || 0)),
            brand: product.brand,
            manufacturer: product.manufacturer,
            upc: product.upc,
            ean: product.ean,
            bulletPoints: product.bulletPoints || [],
            categoryAttributes: product.categoryAttributes || {},
            productType: product.productType,
          }}
          channel={activeChannel as ChannelType}
          overrides={{
            priceOverride: !getFieldState('price').isFollowing ? getFieldState('price').value : undefined,
            titleOverride: !getFieldState('title').isFollowing ? getFieldState('title').value : undefined,
            descriptionOverride: !getFieldState('description').isFollowing ? getFieldState('description').value : undefined,
          }}
        />
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 border-t border-gray-200 pt-6">
        <button
          onClick={() => {
            // TODO: Implement force sync
            console.log('Force sync for', activeChannel, overrides[activeChannel])
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          🔄 Force Sync {activeChannel}
        </button>
        <button
          onClick={async () => {
            try {
              // Save overrides including pricing rule
              const payload = {
                ...overrides[activeChannel],
                channel: activeChannel,
              }
              
              console.log('Saving overrides for', activeChannel, payload)
              
              // TODO: Send to API endpoint
              // await fetch(`/api/catalog/products/${product.id}/channel-listing`, {
              //   method: 'PATCH',
              //   headers: { 'Content-Type': 'application/json' },
              //   body: JSON.stringify(payload),
              // })
            } catch (error) {
              console.error('Failed to save overrides:', error)
            }
          }}
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors"
        >
          ✓ Save Overrides
        </button>
      </div>

      {/* Info Section */}
      <div className="rounded-lg bg-blue-50 p-4 border border-blue-200">
        <h3 className="font-semibold text-blue-900 mb-2">💡 SSOT Architecture</h3>
        <p className="text-sm text-blue-800">
          Each channel can independently follow the master product data or use custom overrides. 
          When "Follow Master" is enabled, changes to the master product automatically sync to this channel. 
          Custom overrides allow channel-specific customization while maintaining data integrity.
        </p>
      </div>
    </div>
  )
}
