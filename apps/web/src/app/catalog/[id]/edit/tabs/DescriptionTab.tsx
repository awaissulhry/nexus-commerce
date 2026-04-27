'use client'

import { useFormContext, useFieldArray } from 'react-hook-form'
import type { ProductEditorFormData } from '../schema'

export default function DescriptionTab() {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<ProductEditorFormData>()

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'bulletPoints' as any,
  })

  // Ensure we always show up to 5 bullet point inputs
  const bulletCount = fields.length

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900">Description & Content</h3>

      {/* Bullet Points */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium text-gray-700">
            Bullet Points ({bulletCount}/5)
          </label>
          {bulletCount < 5 && (
            <button
              type="button"
              onClick={() => append('')}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              + Add Bullet Point
            </button>
          )}
        </div>

        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2">
              <span className="flex-shrink-0 w-8 h-10 flex items-center justify-center text-sm font-semibold text-gray-400">
                {index + 1}.
              </span>
              <div className="flex-1">
                <input
                  {...register(`bulletPoints.${index}`)}
                  type="text"
                  maxLength={500}
                  className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
                    errors.bulletPoints?.[index]
                      ? 'border-red-300 bg-red-50'
                      : 'border-gray-300'
                  }`}
                  placeholder={`Bullet point ${index + 1}...`}
                />
                {errors.bulletPoints?.[index] && (
                  <p className="text-xs text-red-600 mt-1">
                    {(errors.bulletPoints[index] as any)?.message}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(index)}
                className="flex-shrink-0 p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="Remove bullet point"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {bulletCount === 0 && (
          <div className="text-center py-6 border-2 border-dashed border-gray-300 rounded-lg">
            <p className="text-gray-500 mb-2">No bullet points added</p>
            <button
              type="button"
              onClick={() => append('')}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              + Add First Bullet Point
            </button>
          </div>
        )}

        <p className="text-xs text-gray-500 mt-2">
          💡 Tip: Use bullet points to highlight key features. Amazon allows up to 5 bullet
          points, each up to 500 characters.
        </p>
      </div>

      {/* A+ Content / Rich Text */}
      <div className="border-t border-gray-200 pt-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          A+ Content / Rich Description
        </label>
        <p className="text-xs text-gray-500 mb-3">
          Enter HTML content for enhanced product descriptions. This will be used for A+ Content
          on Amazon and rich descriptions on eBay.
        </p>
        <textarea
          {...register('aPlusContent')}
          rows={12}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-mono text-sm"
          placeholder={`<h2>Product Features</h2>
<p>Describe your product in detail...</p>
<ul>
  <li>Feature 1</li>
  <li>Feature 2</li>
</ul>`}
        />
        <div className="flex items-center gap-4 mt-2">
          <span className="text-xs text-gray-400">Supports HTML tags: h2, h3, p, ul, ol, li, strong, em</span>
        </div>
      </div>
    </div>
  )
}
