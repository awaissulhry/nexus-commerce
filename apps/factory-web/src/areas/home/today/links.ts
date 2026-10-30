import { attentionAddress, hasRecordPage, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DECIDED_HERE, type HandledList, type HandledView, type PanelRow, type QueueItem, type TodayItem } from './model'
import type { PanelRecordRow } from './panels'

/**
 * Where Today's rows open (design 00 §2.3): the row's kind's own page when it has one (a privacy duty: Admin › Privacy &
 * notices), else its record at its own page when built, else its panels (lib/records/record-links.ts); a REVIEW row its
 * module decides itself (mail to sort) at that review. Addresses carry the company prefix (`/w/<code>`).
 */

export function queueItem(item: TodayItem, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): QueueItem {
  // W2a: an exception rule's alert (record type Alert) has no page of its own until Home › Alerts is built: its chip
  // opens the row here, whose review links the record the alert is about.
  if (item.kind === 'RULE_ALERT' && !hasRecordPage(item.record.type, built)) return { ...item, href: `${prefix}/home/today?open=${encodeURIComponent(item.key)}`, reviewHref: null }
  const href = `${prefix}${attentionAddress(item.kind, { type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId, siteId: item.siteId }, built)}`
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
    items: list.items.map((entry) => ({ ...entry, href: `${prefix}${attentionAddress(entry.kind, { type: entry.record.type, id: entry.record.id, label: entry.record.label, companyId: entry.companyId, siteId: null }, built)}` })),
  }
}
