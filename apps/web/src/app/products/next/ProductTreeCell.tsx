'use client'

/**
 * The tree column's cell — AG's "custom group cell renderer".
 *
 * `autoGroupColumnDef.cellRenderer` replaces AG's group cell renderer outright, which is AG's own
 * way to draw a group cell that does not look like AG's: no chevron slot, no per-level indent
 * step, no `.ag-cell-wrapper` — and therefore nothing to override in a stylesheet. This cell
 * draws the DS expander (the same 20px button the live page has) and wires it to
 * `node.setExpanded`, which is all AG needs to fetch the family's variations.
 *
 * TWO SHAPES, ONE CELL
 *   tree (families): a parent row expands; its variations sit directly under it, unindented —
 *                    a variation's price belongs under the same Price header as its parent's.
 *   grouping:        a group row expands; the products inside it step in one level, so the
 *                    group reads as a container. Families do not expand here — the auto column
 *                    is either the tree or the group column, never both.
 */
import { useEffect, useState } from 'react'
import type { IRowNode } from '@/design-system/patterns/workspace-grid/engine/NexusGrid'

import type { ProductRow } from '@/app/products/_types'
import type { ICellRendererParams } from '@/design-system/patterns/workspace-grid/engine/NexusGrid'

import { ExpandToggle } from '@/design-system/primitives'

import styles from './styles.module.css'
import { GroupCell, ProductCell, isGroupRow, type ProductGroupRow, groupRowLabel, type PageColumn } from './columns'

export interface ProductTreeCellParams {
  /** The auto column is the GROUP column (true) or the family TREE (false). */
  grouped: boolean
  columns: readonly PageColumn[]
  /**
   * Can this product row expand? The SAME predicate the page hands AG as `isServerSideGroup`,
   * so the chevron and the grid can never disagree about which rows have variations. Read from
   * the row's data: the node's own `group` flag is not yet set when SSRM first renders the cell.
   */
  canExpand: (row: ProductRow) => boolean
}

/** AG mutates `node.expanded` in place; the cell listens so the chevron follows. */
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
      <div className={styles.productCell}>
        <ExpandToggle
          expanded={expanded}
          label={expanded ? 'Collapse group' : 'Expand group'}
          onClick={(e) => { e.stopPropagation(); p.node.setExpanded(!expanded) }}
        />
        <GroupCell label={groupRowLabel(data, p.columns)} count={data.childCount} />
      </div>
    )
  }

  // Under a grouping the tree is off: a family row is just a product with its roll-up, and the
  // products inside a group step in one level under it.
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
