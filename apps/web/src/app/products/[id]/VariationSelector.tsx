'use client'

import { useState, useMemo } from 'react'

interface Variation {
  id: string
  sku: string
  name: string
  value: string
  price: number
  stock: number
  // NEW: Multi-axis variation attributes (Rithum pattern)
  variationAttributes?: Record<string, string>
  isActive?: boolean
}

interface VariationSelectorProps {
  variations: Variation[]
  onSelect?: (variation: Variation) => void
}

// Color name → Tailwind bg class mapping
const COLOR_MAP: Record<string, string> = {
  red: 'bg-red-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  black: 'bg-gray-900',
  white: 'bg-white border-2 border-gray-300',
  yellow: 'bg-yellow-400',
  orange: 'bg-orange-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-400',
  gray: 'bg-gray-400',
  grey: 'bg-gray-400',
  navy: 'bg-blue-900',
  brown: 'bg-amber-700',
  beige: 'bg-amber-100',
}

export default function VariationSelector({ variations, onSelect }: VariationSelectorProps) {
  const [selectedValues, setSelectedValues] = useState<Record<string, string>>({})

  // ── Build axis → unique values map from variationAttributes (Rithum) ──
  // Falls back to legacy name/value grouping for backward compat
  const { axes, axisValues } = useMemo(() => {
    const axisSet = new Map<string, Set<string>>()

    for (const v of variations) {
      if (v.isActive === false) continue

      if (v.variationAttributes && Object.keys(v.variationAttributes).length > 0) {
        // Rithum pattern: multi-axis from variationAttributes JSON
        for (const [axis, val] of Object.entries(v.variationAttributes)) {
          if (!axisSet.has(axis)) axisSet.set(axis, new Set())
          axisSet.get(axis)!.add(val)
        }
      } else if (v.name && v.value) {
        // Legacy pattern: single name/value
        if (!axisSet.has(v.name)) axisSet.set(v.name, new Set())
        axisSet.get(v.name)!.add(v.value)
      }
    }

    const axesArr = Array.from(axisSet.keys())
    const axisVals: Record<string, string[]> = {}
    for (const [axis, vals] of axisSet) {
      axisVals[axis] = Array.from(vals)
    }

    return { axes: axesArr, axisValues: axisVals }
  }, [variations])

  // ── Find matching variation for current selection ──────────────────
  const selectedVariation = useMemo(() => {
    if (axes.length === 0) return null
    // All axes must be selected
    if (axes.some((a) => !selectedValues[a])) return null

    return variations.find((v) => {
      if (v.variationAttributes && Object.keys(v.variationAttributes).length > 0) {
        return axes.every((axis) => v.variationAttributes![axis] === selectedValues[axis])
      }
      // Legacy fallback
      if (axes.length === 1 && v.name === axes[0]) {
        return v.value === selectedValues[axes[0]]
      }
      return false
    }) ?? null
  }, [variations, axes, selectedValues])

  // ── Get stock for a specific axis value (considering other selections) ──
  const getStockForValue = (axis: string, value: string): number => {
    const matchingVariations = variations.filter((v) => {
      if (v.isActive === false) return false

      const attrs = v.variationAttributes && Object.keys(v.variationAttributes).length > 0
        ? v.variationAttributes
        : v.name ? { [v.name]: v.value } : {}

      if (attrs[axis] !== value) return false

      // Check other selected axes
      for (const [otherAxis, otherVal] of Object.entries(selectedValues)) {
        if (otherAxis === axis) continue
        if (attrs[otherAxis] !== otherVal) return false
      }

      return true
    })

    return matchingVariations.reduce((sum, v) => sum + v.stock, 0)
  }

  const handleSelect = (axis: string, value: string) => {
    const newSelected = { ...selectedValues, [axis]: value }
    setSelectedValues(newSelected)

    // If all axes are selected, find and emit the matching variation
    if (axes.every((a) => newSelected[a])) {
      const match = variations.find((v) => {
        if (v.variationAttributes && Object.keys(v.variationAttributes).length > 0) {
          return axes.every((a) => v.variationAttributes![a] === newSelected[a])
        }
        if (axes.length === 1 && v.name === axes[0]) {
          return v.value === newSelected[axes[0]]
        }
        return false
      })
      if (match) onSelect?.(match)
    }
  }

  if (variations.length === 0) return null

  return (
    <div className="space-y-4">
      {axes.map((axis) => {
        const isColor = axis.toLowerCase() === 'color'
        const selectedValue = selectedValues[axis]
        const values = axisValues[axis] ?? []

        return (
          <div key={axis}>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {axis}
              {selectedValue && (
                <span className="text-gray-500 font-normal">: {selectedValue}</span>
              )}
            </label>

            {isColor ? (
              /* Color swatches */
              <div className="flex flex-wrap gap-2">
                {values.map((val) => {
                  const colorClass =
                    COLOR_MAP[val.toLowerCase()] || 'bg-gray-300'
                  const isSelected = selectedValue === val
                  const stock = getStockForValue(axis, val)
                  const isOutOfStock = stock === 0

                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => handleSelect(axis, val)}
                      disabled={isOutOfStock}
                      title={`${val}${isOutOfStock ? ' (Out of Stock)' : ''}`}
                      className={`relative w-10 h-10 rounded-full transition-all ${colorClass} ${
                        isSelected
                          ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                          : 'hover:scale-105'
                      } ${isOutOfStock ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      {isOutOfStock && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="w-8 h-0.5 bg-red-500 rotate-45 absolute" />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              /* Button group for Size and other attributes */
              <div className="flex flex-wrap gap-2">
                {values.map((val) => {
                  const isSelected = selectedValue === val
                  const stock = getStockForValue(axis, val)
                  const isOutOfStock = stock === 0

                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => handleSelect(axis, val)}
                      disabled={isOutOfStock}
                      className={`px-4 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : isOutOfStock
                            ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed line-through'
                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {val}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {/* Show selected variant details */}
      {selectedVariation && (
        <div className="mt-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">
              SKU: <span className="font-mono text-gray-700">{selectedVariation.sku}</span>
            </span>
            <span className={`font-medium ${selectedVariation.stock > 0 ? 'text-green-600' : 'text-red-600'}`}>
              {selectedVariation.stock > 0 ? `${selectedVariation.stock} in stock` : 'Out of stock'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
