'use client'

import { useFormContext } from 'react-hook-form'
import type { ProductEditorFormData } from '../schema'

export default function OfferTab() {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<ProductEditorFormData>()

  const fulfillmentMethod = watch('fulfillmentMethod')
  const basePrice = watch('basePrice')
  const salePrice = watch('salePrice')

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900">Offer & Pricing</h3>

      {/* Pricing */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            List Price <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-gray-500">$</span>
            <input
              {...register('basePrice')}
              type="number"
              step="0.01"
              min="0"
              className={`w-full pl-8 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
                errors.basePrice ? 'border-red-300 bg-red-50' : 'border-gray-300'
              }`}
              placeholder="0.00"
            />
          </div>
          {errors.basePrice && (
            <p className="text-sm text-red-600 mt-1">{errors.basePrice.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Sale Price</label>
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-gray-500">$</span>
            <input
              {...register('salePrice')}
              type="number"
              step="0.01"
              min="0"
              className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="0.00"
            />
          </div>
          {salePrice && basePrice && salePrice < basePrice && (
            <p className="text-sm text-green-600 mt-1">
              💰 {Math.round(((basePrice - salePrice) / basePrice) * 100)}% discount
            </p>
          )}
        </div>
      </div>

      {/* Stock */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Stock Quantity <span className="text-red-500">*</span>
        </label>
        <input
          {...register('totalStock')}
          type="number"
          min="0"
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
            errors.totalStock ? 'border-red-300 bg-red-50' : 'border-gray-300'
          }`}
          placeholder="0"
        />
        {errors.totalStock && (
          <p className="text-sm text-red-600 mt-1">{errors.totalStock.message}</p>
        )}
      </div>

      {/* Fulfillment Method Toggle */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          Fulfillment Method
        </label>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setValue('fulfillmentMethod', 'FBA', { shouldDirty: true })}
            className={`flex-1 px-6 py-4 rounded-lg border-2 transition-all text-center ${
              fulfillmentMethod === 'FBA'
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <div className="text-2xl mb-1">📦</div>
            <div className="font-semibold">FBA</div>
            <div className="text-xs mt-1">Fulfillment by Amazon</div>
          </button>
          <button
            type="button"
            onClick={() => setValue('fulfillmentMethod', 'FBM', { shouldDirty: true })}
            className={`flex-1 px-6 py-4 rounded-lg border-2 transition-all text-center ${
              fulfillmentMethod === 'FBM'
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <div className="text-2xl mb-1">🏠</div>
            <div className="font-semibold">FBM</div>
            <div className="text-xs mt-1">Fulfillment by Merchant</div>
          </button>
        </div>
      </div>

      {/* Physical Attributes */}
      <div className="border-t border-gray-200 pt-6">
        <h4 className="text-sm font-semibold text-gray-700 mb-4">Physical Attributes</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Weight</label>
            <input
              {...register('weightValue')}
              type="number"
              step="0.001"
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="0.0"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Unit</label>
            <select
              {...register('weightUnit')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            >
              <option value="">Select</option>
              <option value="lb">lb</option>
              <option value="kg">kg</option>
              <option value="oz">oz</option>
              <option value="g">g</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Dimension Unit</label>
            <select
              {...register('dimUnit')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            >
              <option value="">Select</option>
              <option value="in">inches</option>
              <option value="cm">cm</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 mt-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Length</label>
            <input
              {...register('dimLength')}
              type="number"
              step="0.01"
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="0.0"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Width</label>
            <input
              {...register('dimWidth')}
              type="number"
              step="0.01"
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="0.0"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Height</label>
            <input
              {...register('dimHeight')}
              type="number"
              step="0.01"
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="0.0"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
