import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { MERGED_TABS, previewPdf, RECORD_TABS, tabOf } from '../model'
import { designScreen } from './fixtures'

/**
 * B-TH-263 — the purchase order on RecordFrame (O-PUR-PO; the rule of picture 38, the tabs of 08-tabs): the band in the area row,
 * ONE thread docked beside the five tabs, Activity's tools in the thread's "⋯" (R-ACT), Documents gone without losing its work (the
 * frozen PDFs are the order's files, the draft's preview is the band's ⋯ "Preview PDF"), the old addresses (R-8), the wall.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => {
  const found = designScreen.cases.find((item) => item.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return renderView(view, found.model, locale)
}
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the purchase order on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity or Documents tab and no record panels', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(html).not.toContain('?tab=activity')
    expect(html).not.toContain('?tab=documents')
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['draft', 'thread-docked', 'receipts', 'answer-confirmed', 'w2b-347-sample-order']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the tabs 7 → 5: Lines · Delivery schedule · Supplier’s answer · Receipts · Invoices', () => {
    expect(RECORD_TABS).toEqual(['lines', 'schedule', 'answer', 'receipts', 'invoices'])
    expect(textOf(draw('thread-docked', 'it'))).toContain('Risposta del fornitore')
    const text = textOf(draw('thread-docked'))
    expect(text).toContain('Supplier’s answer')
    expect(text).not.toMatch(/\bActivity\b/)
  })

  it('every old ?tab= keeps working (R-8): Documents and Activity land on Lines (the frame opens the thread), unknown → Lines', () => {
    expect(MERGED_TABS).toEqual({ documents: 'lines', activity: 'lines' })
    expect(tabOf('documents')).toBe('lines')
    expect(tabOf('activity')).toBe('lines')
    expect(tabOf('receipts')).toBe('receipts')
    expect(tabOf('schedule')).toBe('schedule')
    expect(tabOf('constructor')).toBe('lines')
    expect(tabOf(null)).toBe('lines')
  })

  it('"Preview PDF" moved to the band’s ⋯, next to What the supplier sees: a draft’s, with the cost grain, else held with why', () => {
    expect(previewPdf('DRAFT', '/api/purchasing/orders/x/preview')).toEqual({ href: '/api/purchasing/orders/x/preview' })
    expect(previewPdf('DRAFT', null)).toEqual({ held: 'po.send.previewNeedsCost' })
    expect(previewPdf('SENT', '/api/purchasing/orders/x/preview')).toBeNull()
    const view = source('./view/OrderRecordView.tsx')
    expect(view).toMatch(/id: 'supplierView'[^\n]*\n\s*\.\.\.\(preview \? \[\{ id: 'preview'/)
    expect(view).toContain("target: '_blank' as const")
    expect(view).not.toContain('DocumentsTab')
  })

  it('the page mounts the office thread docked with the order’s own supplier; no dock hook, no Documents read', () => {
    const container = source('./OrderRecord.tsx')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain('party={{ id: value.partyId, name: value.supplier.name }} partyRole="supplier"')
    expect(container).not.toContain('useThreadDock')
    expect(container).not.toContain('getDocuments')
    expect(source('./view/OrderRecordView.tsx')).not.toContain('RecordPanelsView')
  })

  it('the wall (W08, W25, W36): the docked thread speaks of this order’s supplier only, never a customer’s name', () => {
    const html = draw('thread-docked')
    const dock = textOf(html.slice(html.indexOf('class="fw-rcf-dock"')))
    expect(dock).toContain('Conceria Demo S.r.l.')
    expect(dock).not.toMatch(/Brand Alpha|Brand Beta/)
  })
})
