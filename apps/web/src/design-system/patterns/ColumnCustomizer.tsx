'use client'

import type { ReactNode } from 'react'
import { PreferencesModal } from './PreferencesModal'

export interface CustomizableColumn {
  key: string
  label: ReactNode
  visible: boolean
  /** Fixed columns cannot be hidden or moved. */
  locked?: boolean
}

export interface ColumnCustomizerProps {
  open: boolean
  onClose: () => void
  columns: CustomizableColumn[]
  onApply: (columns: CustomizableColumn[]) => void
  className?: string
}

/** Compatibility entry point for the canonical Nexus column modal. New grids use PreferencesModal. */
export function ColumnCustomizer({ open, onClose, columns, onApply, className }: ColumnCustomizerProps) {
  return <PreferencesModal
    open={open}
    onClose={onClose}
    className={className}
    title="Customise columns"
    attributeGroups
    groupToggles
    inViewCount
    pageSizeChoices={[]}
    sortFieldOptions={[]}
    showSticky={false}
    allColumns={columns.map((c) => ({ key: c.key, label: typeof c.label === 'string' ? c.label : c.key, locked: c.locked }))}
    defaultVisible={columns.filter((c) => c.visible).map((c) => c.key)}
    value={{ visibleColumns: columns.filter((c) => c.visible).map((c) => c.key), columnOrder: columns.map((c) => c.key), stickyFirstColumn: true, stickyLastColumn: true, pageSize: 100, sortBy: '', sortDir: 'asc' }}
    onConfirm={(next) => {
      const byKey = new Map(columns.map((c) => [c.key, c]))
      const ordered = [...new Set([...next.visibleColumns, ...(next.columnOrder ?? []), ...byKey.keys()])]
        .flatMap((key) => { const column = byKey.get(key); return column && !column.locked ? [column] : [] })
      let index = 0
      onApply(columns.map((c) => c.locked ? c : { ...ordered[index++], visible: next.visibleColumns.includes(ordered[index - 1].key) }))
    }}
  />
}
