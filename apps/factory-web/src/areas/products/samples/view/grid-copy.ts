'use client'

import { useMemo } from 'react'
import type { SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { NS } from '../model'

/** The DS size grid's words in the page's language (`products-samples` `grid.*`, the stacked phone form's from `ds-words`). */
export function useGridCopy(): Partial<SizeGridCopy> {
  const t = useT(NS)
  const ds = useDsWords()
  return useMemo(
    () => ({
      ...ds.sizeGridStacked,
      caption: t('grid.caption'),
      colourHeader: t('grid.colour'),
      totalHeader: t('grid.total'),
      cellName: (colour: string, size: string) => t('grid.cellName', { colour, size }),
      notOffered: t('grid.notOffered'),
      empty: t('grid.empty'),
      totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }: { colour: string; rowTotal: string; size: string; columnTotal: string; grand: string }) => t('grid.totals', { colour, rowTotal, size, columnTotal, grand }),
      notWhole: (cell: string, max: string) => t('grid.notWhole', { cell, max }),
      cutToMax: (cell: string, max: string) => t('grid.cutToMax', { cell, max }),
      pasteResult: ({ applied, notOffered, outside, invalid, clamped }: { applied: number; notOffered: number; outside: number; invalid: number; clamped: number }) => t('grid.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
      issuesHeading: t('grid.issues'),
    }),
    [t, ds.sizeGridStacked],
  )
}
