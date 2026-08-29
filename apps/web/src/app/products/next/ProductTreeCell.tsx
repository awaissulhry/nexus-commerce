'use client'

/**
 * The tree column's cell — AG's "custom group cell renderer" (`autoGroupColumnDef.cellRenderer`).
 *
 * Draws the product identity cell with its own expander wired to `node.setExpanded`, so AG renders
 * no chevron slot and no level step of its own. Under a row grouping the same cell draws the group
 * row (label + count) and indents leaf rows by level.
 */
import { useEffect, useState } from 'react'

import type { ProductRow } from '@/app/products/_types'
import { ExpandButton, GroupCell, type ICellRendererParams, type IRowNode } from '@/design-system/grid'

import { ProductCell, isGroupRow, type ProductGroupRow, groupRowLabel, type PageColumn } from './columns'

export interface ProductTreeCellParams {
  grouped: boolean
  columns: readonly PageColumn[]
  canExpand: (row: ProductRow) => boolean
}

function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(!!node.expanded)
  useEffect(() => {
    setExpanded(!!node.expanded)
    const onChange = () => setExpanded(!!node.expanded)
    node.addEventListener('expandedChanged', onChange)
    return () => node.removeEventListener('expandedChanged', onChange)
  }, [node])
  return expanded
}

export function ProductTreeCell(p: ICellRendererParams<ProductRow | ProductGroupRow> & ProductTreeCellParams) {
  const expanded = useExpanded(p.node)
  const data = p.data
  if (!data) return null

  if (isGroupRow(data)) {
    return (
      <div className="nds-cell-identity">
        <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand group', 'Collapse group']} />
        <GroupCell label={groupRowLabel(data, p.columns)} count={data.childCount} noun={['product', 'products']} />
      </div>
    )
  }

  const hasChildren = !p.grouped && p.canExpand(data)
  const level = p.grouped ? p.node.level : 0
  return (
    <div style={level > 0 ? { paddingLeft: level * 28, minWidth: 0, display: 'flex' } : undefined}>
      <ProductCell
        row={data}
        isChild={data.parentId !== null}
        hasChildren={hasChildren}
        isExpanded={expanded}
        onExpand={() => p.node.setExpanded(!expanded)}
      />
    </div>
  )
}
