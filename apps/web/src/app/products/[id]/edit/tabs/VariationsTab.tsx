'use client'

import { Plus, Edit2, Trash2 } from 'lucide-react'

interface Props {
  parent: any
  childrenList: any[]
  onChange: () => void
}

export default function VariationsTab({ parent, childrenList }: Props) {
  // Resolve axes: prefer the explicit array, fall back to the slash/" / "
  // separated variationTheme string.
  const variationAxes: string[] =
    Array.isArray(parent.variationAxes) && parent.variationAxes.length > 0
      ? parent.variationAxes
      : typeof parent.variationTheme === 'string' && parent.variationTheme.length > 0
      ? parent.variationTheme.split(/\s*\/\s*/)
      : []

  const getAttr = (child: any, axis: string): string | null => {
    const fromVariant = child.variantAttributes?.[axis]
    if (fromVariant) return String(fromVariant)
    const fromCategory = child.categoryAttributes?.variations?.[axis]
    if (fromCategory) return String(fromCategory)
    const fromVariations = child.variations?.[axis]
    if (fromVariations) return String(fromVariations)
    return null
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold mb-1">Variation Configuration</h2>
            <p className="text-xs text-slate-500">
              {childrenList.length} variation{childrenList.length === 1 ? '' : 's'}
              {variationAxes.length > 0
                ? ` across ${variationAxes.length} ${variationAxes.length === 1 ? 'axis' : 'axes'}`
                : ''}
            </p>
          </div>
          <button className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
            <Plus className="w-3.5 h-3.5 inline mr-1" /> Add Variation
          </button>
        </div>

        {variationAxes.length > 0 ? (
          <div className="flex gap-2 flex-wrap">
            {variationAxes.map((axis) => (
              <span
                key={axis}
                className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs"
              >
                {axis}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 italic">
            No variation axes defined yet. Set them via PIM auto-detect or manually.
          </p>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-700">SKU</th>
                {variationAxes.map((axis) => (
                  <th
                    key={axis}
                    className="px-4 py-2.5 text-left text-xs font-medium text-slate-700"
                  >
                    {axis}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-700">
                  Price
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-700">
                  Stock
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-700">
                  ASIN
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-700">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {childrenList.length === 0 && (
                <tr>
                  <td
                    colSpan={5 + variationAxes.length}
                    className="px-4 py-6 text-center text-xs text-slate-400"
                  >
                    No variations linked to this product.
                  </td>
                </tr>
              )}
              {childrenList.map((child) => (
                <tr key={child.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs">{child.sku}</td>
                  {variationAxes.map((axis) => {
                    const value = getAttr(child, axis)
                    return (
                      <td key={axis} className="px-4 py-2.5 text-xs">
                        {value ?? <span className="text-slate-400">—</span>}
                      </td>
                    )
                  })}
                  <td className="px-4 py-2.5 tabular-nums">€{Number(child.basePrice ?? child.price ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        Number(child.totalStock ?? child.stock ?? 0) > 0
                          ? 'text-slate-900 tabular-nums'
                          : 'text-red-600 tabular-nums'
                      }
                    >
                      {child.totalStock ?? child.stock ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {child.amazonAsin ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button className="p-1 hover:bg-slate-100 rounded text-slate-600" title="Edit">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="p-1 hover:bg-slate-100 rounded text-red-600 ml-1"
                      title="Unlink from master"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
