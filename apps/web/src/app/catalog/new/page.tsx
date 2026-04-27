import Link from 'next/link'
import { createProduct } from '@/app/actions/product'

export default function NewProductPage() {
  return (
    <div>
      <div className="mb-8">
        <Link
          href="/catalog"
          className="text-blue-600 hover:text-blue-700 font-medium mb-4 inline-block"
        >
          ← Back to Catalog
        </Link>
        <h1 className="text-4xl font-bold text-gray-900">Add New Product</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-8 max-w-2xl">
        <form action={createProduct} className="space-y-6">
          {/* SKU Field */}
          <div>
            <label htmlFor="sku" className="block text-sm font-medium text-gray-700 mb-2">
              SKU <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="sku"
              name="sku"
              placeholder="e.g., PROD-001"
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-xs text-gray-500 mt-1">Unique product identifier</p>
          </div>

          {/* Product Name Field */}
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
              Product Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              placeholder="e.g., Premium Wireless Headphones"
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-xs text-gray-500 mt-1">Display name for the product</p>
          </div>

          {/* Base Price Field */}
          <div>
            <label htmlFor="basePrice" className="block text-sm font-medium text-gray-700 mb-2">
              Base Price (USD) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="basePrice"
              name="basePrice"
              placeholder="0.00"
              step="0.01"
              min="0"
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-xs text-gray-500 mt-1">Base price for this product</p>
          </div>

          {/* Initial Stock Field */}
          <div>
            <label htmlFor="totalStock" className="block text-sm font-medium text-gray-700 mb-2">
              Initial Stock <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="totalStock"
              name="totalStock"
              placeholder="0"
              min="0"
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-xs text-gray-500 mt-1">Number of units in stock</p>
          </div>

          {/* Form Actions */}
          <div className="flex gap-4 pt-6 border-t border-gray-200">
            <button
              type="submit"
              className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Create Product
            </button>
            <Link
              href="/catalog"
              className="flex-1 px-6 py-3 bg-gray-200 text-gray-900 rounded-lg hover:bg-gray-300 transition-colors font-medium text-center"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>

      {/* Info Box */}
      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">ℹ️ Product Information</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• SKU must be unique across all products</li>
          <li>• Base price is the cost before any channel-specific adjustments</li>
          <li>• Stock quantity can be updated later through inventory management</li>
        </ul>
      </div>
    </div>
  )
}
