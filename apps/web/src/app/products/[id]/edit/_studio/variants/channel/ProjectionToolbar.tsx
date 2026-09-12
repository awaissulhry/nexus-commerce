'use client'

/** Variants uses the Information SheetToolbar with its own row counts and domain chips.
 * Saved views are absent for the fixed column set; Import uses the shared CSV workflow.
 */
import { memo } from 'react'

import type { MenuItemDef } from '@/design-system/components'

import { SheetToolbar, type AbsentControl } from '../../sheet/SheetToolbar'
import { useViewChips } from '../../contracts'
import { includedDescriptor } from './copy'
import type { ProjectionCounts } from './rows'
import type { ProjectionPage } from './types'

/** §1.5, verbatim. */
const VIEWS_REASON = 'This page has a fixed column set: product, axes and channel projections.'

const ABSENT: readonly AbsentControl[] = [{ control: 'views', reason: VIEWS_REASON }]

export interface ProjectionToolbarProps {
  visible: number
  selected: number
  page: ProjectionPage | null
  counts: ProjectionCounts | null
  loading: boolean
  search: string
  onSearch(v: string): void
  activeChipId: string | null
  onChipToggle(id: string | null): void
  onReload(): void
  onCustomise(): void
  onImport(): void
  onExport(): void
  exportDisabled: boolean
  overflow: MenuItemDef[]
}

export const ProjectionToolbar = memo(function ProjectionToolbar(p: ProjectionToolbarProps) {
  const { chips } = useViewChips()
  /* The parent row is a row on this sheet — §4.2's count reads `21 rows · 19 included`, which is
     20 variants plus the listing itself. Counting only variants here would contradict the grid. */
  const total = p.counts ? p.counts.total + 1 : 0
  return (
    <SheetToolbar
      visible={p.visible}
      total={total}
      selected={p.selected}
      descriptor={p.counts ? includedDescriptor(p.counts.included) : undefined}
      search={p.search}
      onSearch={p.onSearch}
      chips={chips}
      activeChipId={p.activeChipId}
      onChipToggle={p.onChipToggle}
      onCustomise={p.onCustomise}
      onExport={p.onExport}
      onImport={p.onImport}
      exportPurpose="editing"
      exportDisabled={p.exportDisabled}
      onReload={p.onReload}
      loading={p.loading}
      unavailable={!p.page && !p.loading}
      overflow={p.overflow}
      absent={ABSENT}
    />
  )
})
