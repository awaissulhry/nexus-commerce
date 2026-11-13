import type { SizeGridCopy } from '@nexus/ui/grid'
import type { Translate } from '../../../../lib/i18n/messages'

/** The DS size grid's words in the page's language (`planning-promise` catalogue, `sizegrid.*`). */
export function sizeGridCopy(t: Translate, caption: string): Partial<SizeGridCopy> {
  return {
    caption,
    colourHeader: t('sizegrid.colour'),
    totalHeader: t('sizegrid.total'),
    cellName: (colour, size) => t('sizegrid.cellName', { colour, size }),
    notOffered: t('sizegrid.notOffered'),
    empty: t('sizegrid.empty'),
    totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('sizegrid.totals', { colour, rowTotal, size, columnTotal, grand }),
    notWhole: (cell, max) => t('sizegrid.notWhole', { cell, max }),
    cutToMax: (cell, max) => t('sizegrid.cutToMax', { cell, max }),
    pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('sizegrid.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
    issuesHeading: t('sizegrid.issues'),
  }
}
