'use client'

import { Plus, Edit2, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

interface Props {
  parent: any
  childrenList: any[]
  onChange: () => void
}

export default function VariationsTab({ parent, childrenList }: Props) {
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
    <div className="space-y-4">
      <Card
        title="Variation Configuration"
        description={`${childrenList.length} variation${
          childrenList.length === 1 ? '' : 's'
        }${
          variationAxes.length > 0
            ? ` across ${variationAxes.length} ${
                variationAxes.length === 1 ? 'axis' : 'axes'
              }`
            : ''
        }`}
        action={
          <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />}>
            Add Variation
          </Button>
        }
      >
        {variationAxes.length > 0 ? (
          <div className="flex gap-1.5 flex-wrap">
            {variationAxes.map((axis) => (
              <Badge key={axis} variant="info">
                {axis}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-slate-400 italic">
            No variation axes defined. Set them via PIM auto-detect or manually.
          </p>
        )}
      </Card>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                  SKU
                </th>
                {variationAxes.map((axis) => (
                  <th
                    key={axis}
                    className="px-4 py-2 text-left text-[11px] font-semibold text-slate-700 uppercase tracking-wide"
                  >
                    {axis}
                  </th>
                ))}
                <th className="px-4 py-2 text-right text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                  Price
                </th>
                <th className="px-4 py-2 text-right text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                  Stock
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                  ASIN
                </th>
                <th className="px-4 py-2 text-right text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {childrenList.length === 0 && (
                <tr>
                  <td
                    colSpan={5 + variationAxes.length}
                    className="px-4 py-6 text-center text-[12px] text-slate-400"
                  >
                    No variations linked to this product.
                  </td>
                </tr>
              )}
              {childrenList.map((child) => (
                <tr key={child.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-900">
                    {child.sku}
                  </td>
                  {variationAxes.map((axis) => {
                    const value = getAttr(child, axis)
                    return (
                      <td key={axis} className="px-4 py-2 text-[12px] text-slate-700">
                        {value ?? <span className="text-slate-400">—</span>}
                      </td>
                    )
                  })}
                  <td className="px-4 py-2 text-right tabular-nums text-slate-900">
                    €{Number(child.basePrice ?? child.price ?? 0).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span
                      className={
                        Number(child.totalStock ?? child.stock ?? 0) > 0
                          ? 'text-slate-900'
                          : 'text-red-600'
                      }
                    >
                      {child.totalStock ?? child.stock ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-700">
                    {child.amazonAsin ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      className="p-1 rounded hover:bg-slate-200 text-slate-600 transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-slate-200 text-red-600 ml-1 transition-colors"
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
      </Card>
    </div>
  )
}
