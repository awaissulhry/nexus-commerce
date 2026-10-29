import type { SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import type { Translate } from '../../../../../lib/i18n/messages'

/** The size grid's words in the page's language (`sales` catalogue, `grid.*`); the curve and made-to-measure words are W2b. */
export function sizeGridWords(t: Translate): Partial<SizeGridCopy> {
  return {
    caption: t('grid.caption'),
    colourHeader: t('grid.colour'),
    totalHeader: t('grid.total'),
    cellName: (colour, size) => t('grid.cell', { colour, size }),
    notOffered: t('grid.notOffered'),
    empty: t('grid.empty'),
    totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('grid.totals', { colour, rowTotal, size, columnTotal, grand }),
    notWhole: (cell, max) => t('grid.notWhole', { cell, max }),
    cutToMax: (cell, max) => t('grid.cutToMax', { cell, max }),
    pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('grid.pasted', { applied, skipped: notOffered + outside + invalid, clamped }),
    issuesHeading: t('grid.issues'),
  }
}
