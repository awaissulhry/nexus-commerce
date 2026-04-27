'use client'

import { useFormContext, useFieldArray } from 'react-hook-form'
import type { ProductEditorFormData } from '../schema'

const IMAGE_SLOTS = [
  { type: 'MAIN' as const, label: 'Main Image', icon: '🖼️' },
  { type: 'ALT' as const, label: 'Alt Image 1', icon: '📷' },
  { type: 'ALT' as const, label: 'Alt Image 2', icon: '📷' },
  { type: 'ALT' as const, label: 'Alt Image 3', icon: '📷' },
  { type: 'LIFESTYLE' as const, label: 'Lifestyle 1', icon: '🏡' },
  { type: 'LIFESTYLE' as const, label: 'Lifestyle 2', icon: '🏡' },
]

export default function ImagesTab() {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<ProductEditorFormData>()

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'images',
  })

  const addImageSlot = (type: 'MAIN' | 'ALT' | 'LIFESTYLE') => {
    append({ url: '', alt: '', type })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Product Images</h3>
        <p className="text-sm text-gray-500">{fields.length} image(s) added</p>
      </div>

      {/* Quick-add slots */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {IMAGE_SLOTS.map((slot, idx) => {
          return (
            <button
              key={idx}
              type="button"
              onClick={() => addImageSlot(slot.type)}
              className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors"
            >
              <span className="text-3xl mb-2">{slot.icon}</span>
              <span className="text-sm font-medium text-gray-600">{slot.label}</span>
              <span className="text-xs text-gray-400 mt-1">Click to add</span>
            </button>
          )
        })}
      </div>

      {/* Image entries */}
      {fields.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-gray-700">Added Images</h4>
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg border border-gray-200"
            >
              {/* Preview */}
              <div className="w-20 h-20 bg-gray-200 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                {field.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={field.url}
                    alt={field.alt || 'Preview'}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <span className="text-2xl text-gray-400">📷</span>
                )}
              </div>

              {/* Fields */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                      field.type === 'MAIN'
                        ? 'bg-blue-100 text-blue-800'
                        : field.type === 'LIFESTYLE'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {field.type}
                  </span>
                </div>
                <input
                  {...register(`images.${index}.url`)}
                  type="url"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="https://example.com/image.jpg"
                />
                {errors.images?.[index]?.url && (
                  <p className="text-xs text-red-600">
                    {errors.images[index]?.url?.message}
                  </p>
                )}
                <input
                  {...register(`images.${index}.alt`)}
                  type="text"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="Alt text (optional)"
                />
              </div>

              {/* Remove */}
              <button
                type="button"
                onClick={() => remove(index)}
                className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="Remove image"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {fields.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p className="text-lg mb-1">No images added yet</p>
          <p className="text-sm">Click the slots above to add product images</p>
        </div>
      )}
    </div>
  )
}
