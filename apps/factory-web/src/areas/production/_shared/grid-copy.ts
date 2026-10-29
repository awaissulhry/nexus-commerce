import type { SizeGridCopy } from '@nexus/ui/grid'
import type { Translate } from '../../../lib/i18n/messages'

/** The DS size grid's words in the page's language (`production` catalogue, `size.copy.*`). */
export function sizeGridCopy(t: Translate): Partial<SizeGridCopy> {
  return {
    caption: t('size.copy.caption'),
    colourHeader: t('size.copy.colour'),
    totalHeader: t('size.copy.total'),
    cellName: (colour, size) => t('size.copy.cellName', { colour, size }),
    notOffered: t('size.copy.notOffered'),
    empty: t('size.copy.empty'),
    totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('size.copy.totals', { colour, rowTotal, size, columnTotal, grand }),
    notWhole: (cell, max) => t('size.copy.notWhole', { cell, max }),
    cutToMax: (cell, max) => t('size.copy.cutToMax', { cell, max }),
    pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('size.copy.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
    issuesHeading: t('size.copy.issues'),
  }
}
