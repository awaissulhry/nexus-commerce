'use client'

import { useState, useCallback, useMemo } from 'react'
import { ChevronDown, Plus, Trash2, Eye } from 'lucide-react'
import {
  generateVariationMatrix,
  calculateVariationCount,
  type OptionType,
  type GeneratedVariation,
} from '@/lib/sku-generator'

interface VariationGeneratorProps {
  parentSku: string
  onGenerate: (variations: GeneratedVariation[], globalPrice: number, globalStock: number) => Promise<void>
  isLoading?: boolean
}

export default function VariationGenerator({
  parentSku,
  onGenerate,
  isLoading = false,
}: VariationGeneratorProps) {
  const [optionTypes, setOptionTypes] = useState<OptionType[]>([])
  const [globalPrice, setGlobalPrice] = useState<number>(0)
  const [globalStock, setGlobalStock] = useState<number>(0)
  const [showPreview, setShowPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Generate variations based on current option types
  const generatedVariations = useMemo(() => {
    return generateVariationMatrix(parentSku, optionTypes)
  }, [parentSku, optionTypes])

  const variationCount = useMemo(() => {
    return calculateVariationCount(optionTypes)
  }, [optionTypes])

  // Add new option type
  const handleAddOptionType = useCallback(() => {
    const newId = `option_${Date.now()}`
    setOptionTypes((prev) => [
      ...prev,
      {
        id: newId,
        name: '',
        values: [],
      },
    ])
  }, [])

  // Update option type name
  const handleUpdateOptionName = useCallback((id: string, name: string) => {
    setOptionTypes((prev) =>
      prev.map((opt) => (opt.id === id ? { ...opt, name } : opt))
    )
  }, [])

  // Add value to option type
  const handleAddValue = useCallback((optionId: string) => {
    setOptionTypes((prev) =>
      prev.map((opt) =>
        opt.id === optionId
          ? { ...opt, values: [...opt.values, ''] }
          : opt
      )
    )
  }, [])

  // Update value in option type
  const handleUpdateValue = useCallback(
    (optionId: string, valueIndex: number, value: string) => {
      setOptionTypes((prev) =>
        prev.map((opt) =>
          opt.id === optionId
            ? {
                ...opt,
                values: opt.values.map((v, i) =>
                  i === valueIndex ? value : v
                ),
              }
            : opt
        )
      )
    },
    []
  )

  // Remove value from option type
  const handleRemoveValue = useCallback(
    (optionId: string, valueIndex: number) => {
      setOptionTypes((prev) =>
        prev.map((opt) =>
          opt.id === optionId
            ? {
                ...opt,
                values: opt.values.filter((_, i) => i !== valueIndex),
              }
            : opt
        )
      )
    },
    []
  )

  // Remove option type
  const handleRemoveOptionType = useCallback((id: string) => {
    setOptionTypes((prev) => prev.filter((opt) => opt.id !== id))
  }, [])

  // Handle generate
  const handleGenerate = useCallback(async () => {
    try {
      setError(null)

      // Validate
      if (optionTypes.length === 0) {
        setError('Please add at least one option type')
        return
      }

      const emptyOptions = optionTypes.filter(
        (opt) => !opt.name || opt.values.length === 0
      )
      if (emptyOptions.length > 0) {
        setError('All option types must have a name and at least one value')
        return
      }

      if (globalPrice <= 0) {
        setError('Global price must be greater than 0')
        return
      }

      if (globalStock < 0) {
        setError('Global stock cannot be negative')
        return
      }

      // Generate and send
      await onGenerate(generatedVariations, globalPrice, globalStock)
    } catch (err: any) {
      setError(err.message || 'Failed to generate variations')
    }
  }, [optionTypes, generatedVariations, globalPrice, globalStock, onGenerate])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold text-gray-900">Matrix Variation Builder</h3>
          <span className="text-3xl">🔲</span>
        </div>
        <p className="text-sm text-gray-600">
          Define option types (Color, Size, etc.) and their values to generate all possible SKU combinations
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Option Types Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-gray-900">Option Types</h4>
          <button
            onClick={handleAddOptionType}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            Add Option
          </button>
        </div>

        {optionTypes.length === 0 ? (
          <div className="p-6 bg-gray-50 rounded-lg border border-gray-200 text-center">
            <p className="text-gray-600 text-sm">
              No option types yet. Click "Add Option" to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {optionTypes.map((option) => (
              <div
                key={option.id}
                className="bg-white rounded-lg border border-gray-200 p-4 space-y-3"
              >
                {/* Option Name */}
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Option Type Name
                    </label>
                    <input
                      type="text"
                      value={option.name}
                      onChange={(e) =>
                        handleUpdateOptionName(option.id, e.target.value)
                      }
                      placeholder="e.g., Color, Size, Material"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <button
                    onClick={() => handleRemoveOptionType(option.id)}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Remove option type"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>

                {/* Values */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Values ({option.values.length})
                  </label>
                  <div className="space-y-2">
                    {option.values.map((value, valueIndex) => (
                      <div key={valueIndex} className="flex gap-2">
                        <input
                          type="text"
                          value={value}
                          onChange={(e) =>
                            handleUpdateValue(
                              option.id,
                              valueIndex,
                              e.target.value
                            )
                          }
                          placeholder={`Value ${valueIndex + 1}`}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        />
                        <button
                          onClick={() =>
                            handleRemoveValue(option.id, valueIndex)
                          }
                          className="px-2 py-2 text-gray-400 hover:text-red-600 transition-colors"
                          title="Remove value"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => handleAddValue(option.id)}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium mt-2"
                  >
                    + Add Value
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Global Settings */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <h4 className="font-semibold text-gray-900">Global Settings</h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Price (USD) *
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={globalPrice}
              onChange={(e) => setGlobalPrice(parseFloat(e.target.value) || 0)}
              placeholder="0.00"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">Applied to all variants</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Stock Quantity *
            </label>
            <input
              type="number"
              min="0"
              value={globalStock}
              onChange={(e) => setGlobalStock(parseInt(e.target.value) || 0)}
              placeholder="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">Applied to all variants</p>
          </div>
        </div>
      </div>

      {/* Preview Section */}
      {generatedVariations.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors border-b border-gray-200"
          >
            <div className="flex items-center gap-2">
              <Eye size={18} className="text-gray-600" />
              <span className="font-medium text-gray-900">
                Preview ({variationCount} variations)
              </span>
            </div>
            <ChevronDown
              size={20}
              className={`text-gray-600 transition-transform ${
                showPreview ? 'rotate-180' : ''
              }`}
            />
          </button>

          {showPreview && (
            <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
              {generatedVariations.map((variation, index) => (
                <div
                  key={index}
                  className="p-3 bg-gray-50 rounded border border-gray-200 text-sm"
                >
                  <div className="font-mono font-semibold text-gray-900">
                    {variation.sku}
                  </div>
                  <div className="text-gray-600 text-xs mt-1">
                    {variation.name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {generatedVariations.length > 0 && (
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="text-sm text-gray-700">
            <span className="font-semibold">{variationCount} variations</span> will be created with:
          </p>
          <ul className="text-sm text-gray-600 mt-2 space-y-1">
            <li>• Price: ${globalPrice.toFixed(2)} each</li>
            <li>• Stock: {globalStock} units each</li>
            <li>• Parent SKU: {parentSku}</li>
          </ul>
        </div>
      )}

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isLoading || generatedVariations.length === 0}
        className="w-full px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? '⟳ Generating...' : `✓ Generate ${variationCount} Variations`}
      </button>
    </div>
  )
}
