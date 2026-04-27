'use client'

import { useFormContext } from 'react-hook-form'
import DynamicAttributeForm from '@/components/catalog/DynamicAttributeForm'
import type { ProductEditorFormData } from '../schema'

interface VitalInfoTabProps {
  isParent?: boolean
  childrenCount?: number
  productType?: string
}

export default function VitalInfoTab({ isParent = false, childrenCount = 0, productType = 'OUTERWEAR' }: VitalInfoTabProps) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<ProductEditorFormData>()

  const handleCategoryAttributesChange = (data: Record<string, any>) => {
    setValue('categoryAttributes', data)
  }

  const titleValue = watch('name') || ''
  const titleLength = titleValue.length
  const titleOverLimit = titleLength > 200
  const isLocked = isParent && childrenCount > 0

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900">Vital Information</h3>

      {/* Parent Product Status */}
      {isParent && (
        <div className={`p-4 rounded-lg border-2 ${
          isLocked
            ? 'bg-blue-50 border-blue-300'
            : 'bg-amber-50 border-amber-300'
        }`}>
          <div className="flex items-center gap-3">
            <span className="text-2xl">{isLocked ? '🔒' : '👨‍👧‍👦'}</span>
            <div>
              <p className="font-semibold text-gray-900">
                {isLocked ? 'Parent Product (Locked)' : 'Parent Product'}
              </p>
              <p className="text-sm text-gray-600">
                {isLocked
                  ? `This product has ${childrenCount} variation${childrenCount !== 1 ? 's' : ''}. Parent status cannot be changed.`
                  : 'This product is configured as a parent for variations.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Product Title <span className="text-red-500">*</span>
        </label>
        <input
          {...register('name')}
          type="text"
          maxLength={200}
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
            errors.name ? 'border-red-300 bg-red-50' : 'border-gray-300'
          }`}
          placeholder="Enter product title..."
        />
        <div className="flex justify-between mt-1">
          {errors.name && (
            <p className="text-sm text-red-600">{errors.name.message}</p>
          )}
          <p
            className={`text-sm ml-auto ${
              titleOverLimit ? 'text-red-600 font-semibold' : 'text-gray-500'
            }`}
          >
            {titleLength}/200
          </p>
        </div>
      </div>

      {/* Brand & Manufacturer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Brand</label>
          <input
            {...register('brand')}
            type="text"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            placeholder="e.g., Nike, Apple"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Manufacturer</label>
          <input
            {...register('manufacturer')}
            type="text"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            placeholder="e.g., Nike Inc."
          />
        </div>
      </div>

      {/* UPC & EAN */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">UPC</label>
          <input
            {...register('upc')}
            type="text"
            className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
              errors.upc ? 'border-red-300 bg-red-50' : 'border-gray-300'
            }`}
            placeholder="12-digit UPC code"
          />
          {errors.upc && (
            <p className="text-sm text-red-600 mt-1">{errors.upc.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">EAN</label>
          <input
            {...register('ean')}
            type="text"
            className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
              errors.ean ? 'border-red-300 bg-red-50' : 'border-gray-300'
            }`}
            placeholder="13-digit EAN code"
          />
          {errors.ean && (
            <p className="text-sm text-red-600 mt-1">{errors.ean.message}</p>
          )}
        </div>
      </div>

      {/* Category Breadcrumbs */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Category Breadcrumbs
        </label>
        <input
          {...register('categoryBreadcrumbs')}
          type="text"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          placeholder="e.g., Electronics > Computers > Laptops"
        />
        <p className="text-xs text-gray-500 mt-1">
          Separate categories with &gt; for breadcrumb navigation
        </p>
      </div>

      {/* Dynamic Category-Specific Attributes */}
      <div className="border-t pt-6">
        <DynamicAttributeForm
          category={productType}
          initialData={watch('categoryAttributes') || {}}
          onChange={handleCategoryAttributesChange}
        />
      </div>
    </div>
  )
}
