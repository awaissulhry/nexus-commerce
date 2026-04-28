'use client'

import { useState, useEffect } from 'react'
import { getCategorySchema } from '@/lib/taxonomy/schemas'

interface DynamicAttributeFormProps {
  category: string
  initialData?: Record<string, any>
  onChange: (data: Record<string, any>) => void
  disabled?: boolean
}

export default function DynamicAttributeForm({
  category,
  initialData = {},
  onChange,
  disabled = false,
}: DynamicAttributeFormProps) {
  const [formData, setFormData] = useState<Record<string, any>>(initialData)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const schema = getCategorySchema(category)

  // Update parent when form data changes
  useEffect(() => {
    onChange(formData)
  }, [formData, onChange])

  // Reset form when category changes
  useEffect(() => {
    setFormData(initialData)
    setErrors({})
  }, [category, initialData])

  const handleFieldChange = (fieldId: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [fieldId]: value,
    }))

    // Clear error for this field when user starts typing
    if (errors[fieldId]) {
      setErrors((prev) => {
        const newErrors = { ...prev }
        delete newErrors[fieldId]
        return newErrors
      })
    }
  }

  if (schema.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center text-sm text-gray-600">
        No category-specific attributes available for {category}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">
          {category} Attributes
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {schema.map((field) => (
            <div key={field.id} className="flex flex-col">
              <label
                htmlFor={field.id}
                className="mb-1 text-sm font-medium text-gray-700"
              >
                {field.label}
                {field.required && <span className="ml-1 text-red-600">*</span>}
              </label>

              {field.type === 'select' ? (
                <select
                  id={field.id}
                  value={formData[field.id] || ''}
                  onChange={(e) => handleFieldChange(field.id, e.target.value)}
                  disabled={disabled}
                  className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                    errors[field.id]
                      ? 'border-red-500 bg-red-50 focus:border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500'
                  } disabled:bg-gray-100 disabled:text-gray-500`}
                >
                  <option value="">Select {field.label}</option>
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === 'textarea' ? (
                <textarea
                  id={field.id}
                  value={formData[field.id] || ''}
                  onChange={(e) => handleFieldChange(field.id, e.target.value)}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  disabled={disabled}
                  rows={3}
                  className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                    errors[field.id]
                      ? 'border-red-500 bg-red-50 focus:border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500'
                  } disabled:bg-gray-100 disabled:text-gray-500`}
                />
              ) : field.type === 'checkbox' ? (
                <label className="flex items-center gap-2">
                  <input
                    id={field.id}
                    type="checkbox"
                    checked={formData[field.id] || false}
                    onChange={(e) => handleFieldChange(field.id, e.target.checked)}
                    disabled={disabled}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                  <span className="text-sm text-gray-700">{field.label}</span>
                </label>
              ) : (
                <input
                  id={field.id}
                  type={field.type}
                  value={formData[field.id] || ''}
                  onChange={(e) => handleFieldChange(field.id, e.target.value)}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  disabled={disabled}
                  className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                    errors[field.id]
                      ? 'border-red-500 bg-red-50 focus:border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500'
                  } disabled:bg-gray-100 disabled:text-gray-500`}
                />
              )}

              {/* Help text */}
              {field.helpText && !errors[field.id] && (
                <p className="mt-1 text-xs text-gray-500">{field.helpText}</p>
              )}

              {/* Error message */}
              {errors[field.id] && (
                <p className="mt-1 text-xs text-red-600">{errors[field.id]}</p>
              )}

              {/* Character count for textarea */}
              {field.type === 'textarea' && field.maxLength && (
                <p className="mt-1 text-xs text-gray-400">
                  {(formData[field.id] || '').length} / {field.maxLength}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Info box */}
      <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800 border border-blue-200">
        <p className="font-medium mb-1">💡 Category-Specific Fields</p>
        <p>
          These fields are specific to {category} products and help ensure accurate
          listings across all marketplaces.
        </p>
      </div>
    </div>
  )
}
