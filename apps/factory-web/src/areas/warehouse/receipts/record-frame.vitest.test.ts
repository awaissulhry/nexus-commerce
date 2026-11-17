import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { arrivalOf } from '../../_shared/record-frame/model'
import { SUPPLIERS } from '../../_shared/buying/fixtures'
import { receipt } from './demo/fixtures'
import { designScreen as receiptsScreen } from './list/fixtures'
import { designScreen as lotsScreen } from './record/fixtures'
import { isWideReceiptTab, MERGED_TABS, RECEIPT_TABS, receiptTabOf } from './model'

/**
 * B-TH-264 — the goods receipt on RecordFrame (threads plan O-WH-REC; the rule of picture 38, the tabs of picture 39): the band in the
 * area row, ONE thread docked beside the four tabs (Lines · Lots & hides · Documents check · Discrepancies), Activity's tools in the
 * thread's "⋯" (R-ACT), one notice, every old address (R-8), the brand wall (the receipt's own supplier only).
 */

const drawIn = (screen: { view: unknown; cases: readonly { id: string; model: unknown }[] }, id: string, locale: 'it' | 'en' = 'en') => renderView(screen.view as ComponentType<{ model: unknown }>, screen.cases.find((item) => item.id === id)!.model, locale)
const draw = (id: string, locale: 'it' | 'en' = 'en') => drawIn(receiptsScreen, id, locale)

describe('B-TH-264: the receipt on RecordFrame', () => {
  it('the tabs 5 → 4: Lines · Lots & hides · Documents check · Discrepancies (Activity gone)', () => {
    expect(RECEIPT_TABS).toEqual(['lines', 'lots', 'documents', 'discrepancies'])
    const text = textOf(draw('record-thread'))
    for (const tab of ['Lines', 'Lots & hides', 'Documents check', 'Discrepancies']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
    // Italian: "Attività" also names the thread Head's tasks, so the tab list is checked by its ids instead.
    expect(draw('record-thread', 'it')).not.toContain('tab=activity')
  })

  it('every old ?tab= keeps working (R-8): activity → Lines with the thread opened; the four stay; anything else → Lines', () => {
    expect(MERGED_TABS).toEqual({ activity: 'lines' })
    expect(receiptTabOf('activity')).toBe('lines')
    for (const tab of RECEIPT_TABS) expect(receiptTabOf(tab)).toBe(tab)
    expect(receiptTabOf('constructor')).toBe('lines')
    expect(receiptTabOf(undefined)).toBe('lines')
    expect(arrivalOf('?tab=activity')).toEqual({ openThread: true, door: null })
    expect(isWideReceiptTab('lines')).toBe(true)
    expect(isWideReceiptTab('lots')).toBe(true)
    expect(isWideReceiptTab('documents')).toBe(false)
  })

  it('ONE thread on the page, docked; its "⋯" (Activity’s tools, R-ACT) on every tab; no record panels', () => {
    for (const id of ['record-thread', 'record-thread-lines', 'w2a-lots-return', 'w2a-changed', 'reversed']) {
      const html = draw(id)
      expect(html.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(html.match(/class="fw-rt-column[ "]/g)?.length, id).toBe(1)
      expect(html, id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
    }
    // SCR-062's cases (Lots & hides) draw the same frame.
    expect(drawIn(lotsScreen, 'lots')).toContain('aria-label="Thread tools"')
    // Loading / not found / no permission: the band, no thread.
    for (const id of ['record-loading', 'record-not-found', 'record-no-permission']) expect(draw(id), id).not.toContain('class="fw-rcf-dock"')
  })

  it('one notice in the body column, the rest behind "N more notices" (never above the thread)', () => {
    const html = draw('reversed')
    expect(html).toContain('class="fw-rcf-notices"')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)).toContain('fw-rcf-notices-list')
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('Request from supplier still goes through its own narrow route and says its mail is in the thread beside the page', () => {
    for (const locale of ['en', 'it'] as const) {
      const sent = textOf(draw('w2a-request-sent', locale))
      expect(sent).toContain(locale === 'en' ? 'in the receipt’s thread beside this page' : 'nella conversazione del ricevimento accanto alla pagina')
      expect(sent).not.toContain(locale === 'en' ? '(Activity)' : '(Attività)')
    }
  })

  it('the page mounts the office thread docked with its own supplier only (brand wall: no customer on a supplier’s record)', () => {
    const container = readFileSync(new URL('./record/ReceiptRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain('party={{ id: value.supplier.id, name: value.supplier.name }}')
    expect(container).toContain('partyRole="supplier"')
    expect(container).not.toContain('useThreadDock')
    expect(container).not.toContain("tab === 'activity'")
    const view = readFileSync(new URL('./record/view/ReceiptRecordView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).not.toContain('onDock')
    expect(view).toContain('<RecordNotices>')
    const own = receipt().supplier
    const text = textOf(draw('record-thread'))
    expect(text).toContain(own.name)
    for (const other of Object.values(SUPPLIERS).filter((supplier) => supplier.id !== own.id)) expect(text, other.legalName).not.toContain(other.legalName)
  })
})
