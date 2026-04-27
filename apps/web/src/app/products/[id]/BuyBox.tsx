'use client'

import { useState } from 'react'

interface BuyBoxProps {
  price: number
  salePrice?: number | null
  stock: number
  fulfillmentMethod?: string | null
  brand?: string | null
}

export default function BuyBox({ price, salePrice, stock, fulfillmentMethod, brand }: BuyBoxProps) {
  const [quantity, setQuantity] = useState(1)
  const [addedToCart, setAddedToCart] = useState(false)

  const displayPrice = salePrice && salePrice < price ? salePrice : price
  const hasDiscount = salePrice && salePrice < price
  const discountPercent = hasDiscount ? Math.round(((price - salePrice!) / price) * 100) : 0

  const handleAddToCart = () => {
    setAddedToCart(true)
    setTimeout(() => setAddedToCart(false), 2000)
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 sticky top-8">
      {/* Price */}
      <div className="mb-4">
        {hasDiscount && (
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-red-100 text-red-800 text-xs font-semibold">
              -{discountPercent}%
            </span>
          </div>
        )}
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-gray-900">{formatCurrency(displayPrice)}</span>
          {hasDiscount && (
            <span className="text-lg text-gray-500 line-through">{formatCurrency(price)}</span>
          )}
        </div>
      </div>

      {/* Stock status */}
      <div className="mb-4">
        {stock > 0 ? (
          <p className="text-green-600 font-semibold text-sm">
            ✓ In Stock {stock <= 10 && <span className="text-orange-600">— Only {stock} left!</span>}
          </p>
        ) : (
          <p className="text-red-600 font-semibold text-sm">✗ Out of Stock</p>
        )}
      </div>

      {/* Ships from / Sold by */}
      <div className="mb-4 text-sm text-gray-600 space-y-1">
        <div className="flex justify-between">
          <span className="text-gray-500">Ships from</span>
          <span className="font-medium">
            {fulfillmentMethod === 'FBA' ? 'Amazon.com' : 'Seller'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Sold by</span>
          <span className="font-medium">{brand || 'Nexus Commerce'}</span>
        </div>
        {fulfillmentMethod && (
          <div className="flex justify-between">
            <span className="text-gray-500">Fulfillment</span>
            <span
              className={`font-medium ${
                fulfillmentMethod === 'FBA' ? 'text-orange-600' : 'text-blue-600'
              }`}
            >
              {fulfillmentMethod === 'FBA' ? '📦 FBA' : '🏠 FBM'}
            </span>
          </div>
        )}
      </div>

      <hr className="my-4 border-gray-200" />

      {/* Quantity selector */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">Quantity</label>
        <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden w-fit">
          <button
            type="button"
            onClick={() => setQuantity(Math.max(1, quantity - 1))}
            className="px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-gray-600 font-bold"
            disabled={quantity <= 1}
          >
            −
          </button>
          <span className="px-4 py-2 text-center min-w-[3rem] font-medium">{quantity}</span>
          <button
            type="button"
            onClick={() => setQuantity(Math.min(stock, quantity + 1))}
            className="px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-gray-600 font-bold"
            disabled={quantity >= stock}
          >
            +
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={handleAddToCart}
          disabled={stock === 0}
          className={`w-full py-3 rounded-full font-semibold text-sm transition-all ${
            addedToCart
              ? 'bg-green-500 text-white'
              : stock > 0
                ? 'bg-yellow-400 hover:bg-yellow-500 text-gray-900'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {addedToCart ? '✓ Added to Cart!' : '🛒 Add to Cart'}
        </button>
        <button
          type="button"
          disabled={stock === 0}
          className={`w-full py-3 rounded-full font-semibold text-sm transition-all ${
            stock > 0
              ? 'bg-orange-500 hover:bg-orange-600 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          ⚡ Buy Now
        </button>
      </div>

      {/* Secure transaction */}
      <div className="mt-4 flex items-center gap-2 text-xs text-gray-500">
        <span>🔒</span>
        <span>Secure transaction</span>
      </div>
    </div>
  )
}
