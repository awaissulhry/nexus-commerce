'use client'

import { useState } from 'react'
import { Trash2, Edit2, Check, X, Lock, Unlock } from 'lucide-react'
import AttributeLockToggle from '@/components/catalog/AttributeLockToggle'

interface Child {
  id: string
  sku: string
  name: string
  basePrice: number
  totalStock: number
  categoryAttributes?: Record<string, any>
  lockedAttributes?: Record<string, boolean>
}

interface VariationMatrixTableProps {
  children: Child[]
  parentAttributes?: Record<string, any>
  onUpdate: (childId: string, updates: { sku?: string; basePrice?: number; totalStock?: number }) => Promise<void>
  onDelete: (childId: string) => Promise<void>
  onToggleLock?: (childId: string, attributeName: string, locked: boolean) => Promise<void>
  isLoading?: boolean
}

export default function VariationMatrixTable({
  children,
  parentAttributes = {},
  onUpdate,
  onDelete,
  onToggleLock,
  isLoading = false,
}: VariationMatrixTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, any>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLockToggles, setShowLockToggles] = useState(false)

  const handleStartEdit = (child: Child) => {
    setEditingId(child.id)
    setEditValues({
      sku: child.sku,
      basePrice: child.basePrice,
      totalStock: child.totalStock,
    })
    setError(null)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditValues({})
    setError(null)
  }

  const handleSaveEdit = async (childId: string) => {
    try {
      setError(null)
      setSavingId(childId)

      // Validation
      if (!editValues.sku || editValues.sku.trim() === '') {
        setError('SKU is required')
        setSavingId(null)
        return
      }

      if (editValues.basePrice <= 0) {
        setError('Price must be greater than 0')
        setSavingId(null)
        return
      }

      if (editValues.totalStock < 0) {
        setError('Stock cannot be negative')
        setSavingId(null)
        return
      }

      await onUpdate(childId, {
        sku: editValues.sku,
        basePrice: editValues.basePrice,
        totalStock: editValues.totalStock,
      })

      setEditingId(null)
      setEditValues({})
    } catch (err: any) {
      setError(err.message || 'Failed to update variation')
    } finally {
      setSavingId(null)
    }
  }

  const handleDelete = async (childId: string) => {
    if (!confirm('Are you sure you want to delete this variation?')) {
      return
    }

    try {
      setError(null)
      setDeletingId(childId)
      await onDelete(childId)
    } catch (err: any) {
      setError(err.message || 'Failed to delete variation')
    } finally {
      setDeletingId(null)
    }
  }

  if (children.length === 0) {
    return (
      <div className="bg-gray-50 rounded-lg p-8 text-center">
        <p className="text-gray-600">No variations found for this product.</p>
      </div>
    )
  }

  // Extract variation attributes from first child to determine columns
  const variationKeys = children.length > 0 
    ? Object.keys(children[0].categoryAttributes || {})
    : []

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">
          Variation Management ({children.length} variations)
        </h3>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowLockToggles(!showLockToggles)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showLockToggles
                ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {showLockToggles ? '🔒 Hide Locks' : '🔓 Show Locks'}
          </button>
          <span className="text-sm text-gray-600">Click any field to edit</span>
        </div>
      </div>

      {/* Legend */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
        <p className="font-medium mb-1">🔵 Inherited Fields (Blue Tint)</p>
        <p className="text-xs">These attributes are inherited from the parent product. Click the lock icon to prevent inheritance.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Amazon-Style High-Density Grid */}
      <div className="overflow-x-auto border border-gray-300 rounded-lg bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b border-gray-300 sticky top-0">
            <tr>
              {/* Variation Attributes */}
              {variationKeys.map((key) => (
                <th
                  key={key}
                  className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap border-r border-gray-200"
                >
                  {key}
                </th>
              ))}
              {/* Core Fields */}
              <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap border-r border-gray-200">
                SKU
              </th>
              <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap border-r border-gray-200">
                Price
              </th>
              <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap border-r border-gray-200">
                Quantity
              </th>
              <th className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {children.map((child, idx) => (
              <tr key={child.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                {/* Variation Attributes */}
                {variationKeys.map((key) => {
                  const isLocked = child.lockedAttributes?.[key] === true
                  const isInherited = parentAttributes[key] !== undefined && !isLocked
                  
                  return (
                    <td
                      key={`${child.id}-${key}`}
                      className={`px-3 py-2 border-r border-gray-200 font-medium relative group ${
                        isInherited ? 'bg-blue-50 text-blue-900' : 'text-gray-900'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>{child.categoryAttributes?.[key] || '-'}</span>
                        {showLockToggles && onToggleLock && (
                          <AttributeLockToggle
                            childVariationId={child.id}
                            attributeName={key}
                            isLocked={isLocked}
                            onToggle={onToggleLock}
                            disabled={isLoading}
                          />
                        )}
                      </div>
                      {isInherited && (
                        <div className="absolute top-0 right-0 w-1 h-full bg-blue-400 rounded-r"></div>
                      )}
                    </td>
                  )
                })}

                {editingId === child.id ? (
                  <>
                    {/* SKU Input */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <input
                        type="text"
                        value={editValues.sku}
                        onChange={(e) => setEditValues({ ...editValues, sku: e.target.value })}
                        className="w-full px-2 py-1 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                        placeholder="SKU"
                        autoFocus
                      />
                    </td>

                    {/* Price Input */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <input
                        type="number"
                        value={editValues.basePrice}
                        onChange={(e) => setEditValues({ ...editValues, basePrice: parseFloat(e.target.value) || 0 })}
                        className="w-full px-2 py-1 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                        placeholder="Price"
                        step="0.01"
                        min="0"
                      />
                    </td>

                    {/* Stock Input */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <input
                        type="number"
                        value={editValues.totalStock}
                        onChange={(e) => setEditValues({ ...editValues, totalStock: parseInt(e.target.value) || 0 })}
                        className="w-full px-2 py-1 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                        placeholder="Qty"
                        min="0"
                      />
                    </td>

                    {/* Save/Cancel Buttons */}
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleSaveEdit(child.id)}
                          disabled={savingId === child.id}
                          className="p-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Save"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={savingId === child.id}
                          className="p-1 text-gray-600 hover:bg-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Cancel"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    {/* SKU Display */}
                    <td className="px-3 py-2 text-gray-900 border-r border-gray-200 font-mono text-xs cursor-pointer hover:bg-blue-50"
                        onClick={() => handleStartEdit(child)}>
                      {child.sku}
                    </td>

                    {/* Price Display */}
                    <td className="px-3 py-2 text-gray-900 border-r border-gray-200 cursor-pointer hover:bg-blue-50"
                        onClick={() => handleStartEdit(child)}>
                      ${Number(child.basePrice || 0).toFixed(2)}
                    </td>

                    {/* Stock Display */}
                    <td className="px-3 py-2 text-gray-900 border-r border-gray-200 cursor-pointer hover:bg-blue-50"
                        onClick={() => handleStartEdit(child)}>
                      {child.totalStock}
                    </td>

                    {/* Edit/Delete Buttons */}
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleStartEdit(child)}
                          disabled={isLoading || deletingId !== null}
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => handleDelete(child.id)}
                          disabled={isLoading || deletingId === child.id}
                          className="p-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Helper Text */}
      <p className="text-xs text-gray-600 mt-2">
        💡 Click any SKU, Price, or Quantity field to edit. Changes are saved instantly to the database.
      </p>
    </div>
  )
}
