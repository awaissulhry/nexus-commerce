'use client'

import { useFormContext, useFieldArray } from 'react-hook-form'
import { useState, useCallback } from 'react'
import type { ProductEditorFormData } from '../schema'
import { VARIATION_THEMES, getAxesForTheme } from '../schema'

export default function VariationsTab() {
  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<ProductEditorFormData>()

  const { fields, append, remove, replace } = useFieldArray({
    control,
    name: 'variations',
  })

  const variationTheme = watch('variationTheme')
  const parentName = watch('name')
  const basePrice = watch('basePrice')

  // Local state for axis value inputs (used during matrix generation)
  const [axisValues, setAxisValues] = useState<Record<string, string[]>>({})
  const [newAxisValue, setNewAxisValue] = useState<Record<string, string>>({})

  const axes = variationTheme ? getAxesForTheme(variationTheme) : []

  // ── Theme selection ─────────────────────────────────────────────────
  const handleThemeChange = (theme: string | null) => {
    setValue('variationTheme', theme, { shouldDirty: true })
    // Reset axis values when theme changes
    if (theme) {
      const newAxes = getAxesForTheme(theme)
      const newAxisVals: Record<string, string[]> = {}
      for (const axis of newAxes) {
        newAxisVals[axis] = axisValues[axis] ?? []
      }
      setAxisValues(newAxisVals)
    } else {
      setAxisValues({})
    }
  }

  // ── Axis value management ───────────────────────────────────────────
  const addAxisValue = (axis: string) => {
    const val = (newAxisValue[axis] ?? '').trim()
    if (!val) return
    if (axisValues[axis]?.includes(val)) return
    setAxisValues((prev) => ({
      ...prev,
      [axis]: [...(prev[axis] ?? []), val],
    }))
    setNewAxisValue((prev) => ({ ...prev, [axis]: '' }))
  }

  const removeAxisValue = (axis: string, val: string) => {
    setAxisValues((prev) => ({
      ...prev,
      [axis]: (prev[axis] ?? []).filter((v) => v !== val),
    }))
  }

  // ── Matrix generation ───────────────────────────────────────────────
  const generateMatrix = useCallback(() => {
    if (axes.length === 0) return

    // Build cartesian product of all axis values
    const axisArrays = axes.map((axis) => axisValues[axis] ?? [])
    if (axisArrays.some((arr) => arr.length === 0)) return

    const cartesian = axisArrays.reduce<Record<string, string>[]>(
      (acc, values, idx) => {
        const axisName = axes[idx]
        if (acc.length === 0) {
          return values.map((v) => ({ [axisName]: v }))
        }
        const result: Record<string, string>[] = []
        for (const existing of acc) {
          for (const v of values) {
            result.push({ ...existing, [axisName]: v })
          }
        }
        return result
      },
      []
    )

    // Generate SKU prefix from parent name
    const skuPrefix = parentName
      ? parentName.substring(0, 10).toUpperCase().replace(/[^A-Z0-9]/g, '')
      : 'VAR'

    // Create variation entries
    const newVariations = cartesian.map((attrs) => {
      // Build SKU suffix from attribute values
      const suffix = Object.values(attrs)
        .map((v) => v.substring(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .join('-')

      return {
        sku: `${skuPrefix}-${suffix}`,
        variationAttributes: attrs,
        name: axes.length === 1 ? axes[0] : undefined,
        value: axes.length === 1 ? Object.values(attrs)[0] : undefined,
        price: basePrice || 0,
        stock: 0,
        isActive: true,
      }
    })

    replace(newVariations as any)
  }, [axes, axisValues, parentName, basePrice, replace])

  // ── Manual add (for standalone or custom) ───────────────────────────
  const addVariation = (attributeName?: string) => {
    const skuPrefix = parentName
      ? parentName.substring(0, 10).toUpperCase().replace(/[^A-Z0-9]/g, '')
      : 'VAR'

    append({
      sku: `${skuPrefix}-${(fields.length + 1).toString().padStart(2, '0')}`,
      variationAttributes: attributeName ? { [attributeName]: '' } : {},
      name: attributeName || '',
      value: '',
      price: basePrice || 0,
      stock: 0,
      isActive: true,
    } as any)
  }

  // ── Bulk actions ────────────────────────────────────────────────────
  const setAllPrices = () => {
    if (!basePrice) return
    fields.forEach((_, idx) => {
      setValue(`variations.${idx}.price`, basePrice, { shouldDirty: true })
    })
  }

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Variations</h3>
          <p className="text-sm text-gray-500 mt-1">
            Define variation theme, axis values, and generate the variant matrix
          </p>
        </div>
        <span className="text-sm text-gray-500">{fields.length} variant(s)</span>
      </div>

      {/* ── Step 1: Variation Theme Selector ────────────────────────── */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Variation Theme
        </label>
        <p className="text-xs text-gray-500 mb-3">
          Select how this product varies. Choose &quot;None&quot; for standalone products.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleThemeChange(null)}
            className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
              !variationTheme
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
            }`}
          >
            None (Standalone)
          </button>
          {VARIATION_THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => handleThemeChange(theme.value)}
              className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                variationTheme === theme.value
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-blue-50 hover:border-blue-300'
              }`}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Step 2: Define Axis Values ──────────────────────────────── */}
      {variationTheme && axes.length > 0 && (
        <div className="bg-blue-50 rounded-lg border border-blue-200 p-4 space-y-4">
          <div>
            <h4 className="text-sm font-medium text-blue-900">Define Axis Values</h4>
            <p className="text-xs text-blue-700 mt-1">
              Add values for each variation axis, then generate the matrix.
            </p>
          </div>

          {axes.map((axis) => (
            <div key={axis}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {axis}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(axisValues[axis] ?? []).map((val) => (
                  <span
                    key={val}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-blue-200 rounded-full text-sm text-blue-800"
                  >
                    {val}
                    <button
                      type="button"
                      onClick={() => removeAxisValue(axis, val)}
                      className="text-blue-400 hover:text-red-500 ml-0.5"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newAxisValue[axis] ?? ''}
                  onChange={(e) =>
                    setNewAxisValue((prev) => ({ ...prev, [axis]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addAxisValue(axis)
                    }
                  }}
                  placeholder={`Add ${axis.toLowerCase()} value…`}
                  className="flex-1 px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
                <button
                  type="button"
                  onClick={() => addAxisValue(axis)}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                >
                  + Add
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={generateMatrix}
            disabled={axes.some((axis) => !(axisValues[axis]?.length))}
            className="w-full mt-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            🔄 Generate Variation Matrix ({axes.map((a) => axisValues[a]?.length ?? 0).reduce((a, b) => a * b, 1)} variants)
          </button>
        </div>
      )}

      {/* ── Step 3: Variation Matrix Table ──────────────────────────── */}
      {fields.length > 0 && (
        <>
          {/* Bulk actions */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={setAllPrices}
              className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
            >
              Set All Prices to ${basePrice || 0}
            </button>
            <button
              type="button"
              onClick={() => addVariation()}
              className="px-3 py-1.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
            >
              + Add Row
            </button>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    Active
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    SKU
                  </th>
                  {/* Dynamic axis columns */}
                  {axes.map((axis) => (
                    <th
                      key={axis}
                      className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase"
                    >
                      {axis}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    Price
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    Stock
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    UPC
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase">
                    ASIN
                  </th>
                  <th className="px-3 py-2.5 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {fields.map((field, index) => {
                  const attrs = watch(`variations.${index}.variationAttributes`) ?? {}
                  return (
                    <tr key={field.id} className="hover:bg-gray-50">
                      {/* Active toggle */}
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          {...register(`variations.${index}.isActive`)}
                          className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        />
                      </td>

                      {/* SKU */}
                      <td className="px-3 py-2">
                        <input
                          {...register(`variations.${index}.sku`)}
                          type="text"
                          className={`w-28 px-2 py-1.5 border rounded text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
                            errors.variations?.[index]?.sku
                              ? 'border-red-300 bg-red-50'
                              : 'border-gray-300'
                          }`}
                          placeholder="SKU"
                        />
                      </td>

                      {/* Dynamic axis value columns (read-only from matrix, editable for manual) */}
                      {axes.map((axis) => (
                        <td key={axis} className="px-3 py-2">
                          <span className="text-sm text-gray-700 font-medium">
                            {attrs[axis] ?? '—'}
                          </span>
                        </td>
                      ))}

                      {/* Price */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <span className="absolute left-2 top-1.5 text-gray-400 text-sm">$</span>
                          <input
                            {...register(`variations.${index}.price`)}
                            type="number"
                            step="0.01"
                            min="0"
                            className={`w-24 pl-5 pr-2 py-1.5 border rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
                              errors.variations?.[index]?.price
                                ? 'border-red-300 bg-red-50'
                                : 'border-gray-300'
                            }`}
                            placeholder="0.00"
                          />
                        </div>
                      </td>

                      {/* Stock */}
                      <td className="px-3 py-2">
                        <input
                          {...register(`variations.${index}.stock`)}
                          type="number"
                          min="0"
                          className={`w-20 px-2 py-1.5 border rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
                            errors.variations?.[index]?.stock
                              ? 'border-red-300 bg-red-50'
                              : 'border-gray-300'
                          }`}
                          placeholder="0"
                        />
                      </td>

                      {/* UPC */}
                      <td className="px-3 py-2">
                        <input
                          {...register(`variations.${index}.upc`)}
                          type="text"
                          className="w-28 px-2 py-1.5 border border-gray-300 rounded text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                          placeholder="UPC"
                        />
                      </td>

                      {/* ASIN (read-only, populated by sync) */}
                      <td className="px-3 py-2">
                        <span className="text-xs text-gray-400 font-mono">
                          {watch(`variations.${index}.amazonAsin`) || '—'}
                        </span>
                      </td>

                      {/* Remove */}
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => remove(index)}
                          className="p-1 text-red-500 hover:bg-red-50 rounded transition-colors"
                          title="Remove variation"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Empty state ────────────────────────────────────────────── */}
      {fields.length === 0 && !variationTheme && (
        <div className="text-center py-12 border-2 border-dashed border-gray-300 rounded-lg">
          <p className="text-3xl mb-3">🎨</p>
          <p className="text-gray-600 font-medium mb-1">No variations</p>
          <p className="text-sm text-gray-500 mb-4">
            Select a variation theme above to create a variant matrix, or add variants manually.
          </p>
          <button
            type="button"
            onClick={() => addVariation()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            + Add Variant Manually
          </button>
        </div>
      )}

      {fields.length === 0 && variationTheme && (
        <div className="text-center py-8 border-2 border-dashed border-blue-300 rounded-lg bg-blue-50">
          <p className="text-3xl mb-3">📊</p>
          <p className="text-blue-700 font-medium mb-1">
            Theme selected: {VARIATION_THEMES.find((t) => t.value === variationTheme)?.label ?? variationTheme}
          </p>
          <p className="text-sm text-blue-600">
            Add values for each axis above, then click &quot;Generate Variation Matrix&quot;.
          </p>
        </div>
      )}

      {errors.variations && typeof errors.variations === 'object' && 'message' in errors.variations && (
        <p className="text-sm text-red-600">{errors.variations.message as string}</p>
      )}
    </div>
  )
}
