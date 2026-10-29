import { hasRecordPage, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DECIDED_HERE, type HandledList, type HandledView, type PanelRow, type QueueItem, type TodayItem } from './model'
import type { PanelRecordRow } from './panels'

/**
 * Where Today's rows open (design 00 §2.3): a row's record at its own page when built, else its panels
 * (lib/records/record-links.ts); a REVIEW row its module decides itself (mail to sort) at that review. Addresses carry
 * the company prefix (`/w/<code>`).
 */

export function queueItem(item: TodayItem, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): QueueItem {
  const href = `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId, siteId: item.siteId }, built)}`
  const ownReview = item.decide === 'REVIEW' && !DECIDED_HERE.has(item.kind) && hasRecordPage(item.record.type, built)
  return { ...item, href, reviewHref: ownReview ? href : null }
}

export function panelRow(row: PanelRecordRow, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): PanelRow {
  return { id: row.id, label: row.label, sub: row.sub, word: row.word, date: row.date, href: `${prefix}${recordAddress(row.record, built)}` }
}

/** "Handled today": each row's record opens as a queue row's would. */
export function handledView(list: HandledList, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): HandledView {
  return {
    count: list.count,
    items: list.items.map((entry) => ({ ...entry, href: `${prefix}${recordAddress({ type: entry.record.type, id: entry.record.id, label: entry.record.label, companyId: entry.companyId, siteId: null }, built)}` })),
  }
}
