'use client'

import { useMemo } from 'react'
import {
  generateAmazonPayload,
  generateShopifyPayload,
  generateEbayPayload,
  formatPayloadForDisplay,
  type Product,
  type ChannelOverrides,
  type ChannelType,
} from '@/lib/taxonomy/channel-mapper'

interface PayloadPreviewProps {
  product: Product
  channel: ChannelType
  overrides?: ChannelOverrides
}

const channelGenerators = {
  AMAZON: generateAmazonPayload,
  SHOPIFY: generateShopifyPayload,
  EBAY: generateEbayPayload,
}

const channelLabels: Record<ChannelType, string> = {
  AMAZON: '🔶 Amazon Selling Partner API',
  SHOPIFY: '🟢 Shopify REST API',
  EBAY: '🔴 eBay Trading API',
}

export default function PayloadPreview({
  product,
  channel,
  overrides,
}: PayloadPreviewProps) {
  // Generate payload reactively based on product and overrides
  const payload = useMemo(() => {
    const generator = channelGenerators[channel]
    if (!generator) return {}
    return generator(product, overrides)
  }, [product, channel, overrides])

  const payloadJson = useMemo(() => {
    return formatPayloadForDisplay(payload)
  }, [payload])

  const fieldCount = Object.keys(payload).length

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">
            {channelLabels[channel]}
          </h4>
          <p className="text-xs text-gray-500 mt-1">
            Real-time API payload preview ({fieldCount} fields)
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-mono text-gray-600 bg-gray-100 px-2 py-1 rounded">
            SKU: {product.sku}
          </p>
        </div>
      </div>

      {/* JSON Preview Container */}
      <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-slate-900">
        {/* Copy Button */}
        <button
          onClick={() => {
            navigator.clipboard.writeText(payloadJson)
          }}
          className="absolute top-3 right-3 z-10 px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-medium rounded transition-colors"
          title="Copy to clipboard"
        >
          📋 Copy
        </button>

        {/* Code Block */}
        <pre className="p-4 overflow-x-auto text-sm font-mono text-green-400 leading-relaxed">
          <code>{payloadJson}</code>
        </pre>
      </div>

      {/* Info Box */}
      <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
        <p className="text-xs text-blue-800">
          <span className="font-semibold">💡 Live Preview:</span> This JSON updates
          instantly as you modify product attributes or channel overrides. Use this to
          verify your data before publishing to {channel}.
        </p>
      </div>

      {/* Field Mapping Info */}
      {Object.keys(payload).length > 0 && (
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-semibold text-gray-700 mb-2">📊 Mapped Fields:</p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(payload).map(([key, value]) => (
              <div key={key} className="text-xs">
                <span className="font-mono text-gray-600">{key}:</span>
                <span className="text-gray-500 ml-1">
                  {typeof value === 'string' || typeof value === 'number'
                    ? String(value).substring(0, 30)
                    : Array.isArray(value)
                      ? `[${value.length} items]`
                      : '[object]'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
