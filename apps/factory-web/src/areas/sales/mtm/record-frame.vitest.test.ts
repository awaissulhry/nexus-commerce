import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { RECORD, ROLE_PERMISSIONS } from './demo/fixtures'
import { MTM_PERMISSIONS, RECORD_TABS, threadRecordOf } from './model'
import { designScreen } from './record/fixtures'
import { designScreen as threadScreen } from './thread/fixtures'

/**
 * B-TH-258 — the rider profile on RecordFrame (O-SAL-MTM; the rule of picture 38, the tabs of 08-tabs.tsv): the band in the area row,
 * ONE thread docked beside the five tabs, Activity's tools in the thread's "⋯" (R-ACT), the thread only for a reader of measurements
 * who reads threads (body data), on the chain's FIRST revision, with the rider's own customer only (the brand wall).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en', screen = designScreen) => renderView(screen.view as ComponentType<{ model: unknown }>, screen.cases.find((item) => item.id === id)!.model, locale)

describe('the rider profile on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity tab and no record panels', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(textOf(html)).not.toMatch(/\bActivity\b/)
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['measurements', 'photos', 'fittings', 'proofs', 'orders']) expect(draw(id), id).toContain('aria-label="Thread tools"')
    for (const id of ['thread', 'thread-photos', 'thread-fittings']) expect(draw(id, 'en', threadScreen), id).toContain('aria-label="Thread tools"')
  })

  it('the tabs 6 → 5: Measurements · Photos · Fittings · Proofs · Orders', () => {
    expect(RECORD_TABS).toEqual(['measurements', 'photos', 'fittings', 'proofs', 'orders'])
    const text = textOf(draw('thread-docked'))
    for (const tab of ['Measurements', 'Photos', 'Fittings', 'Proofs', 'Orders']) expect(text).toContain(tab)
  })

  it('no thread without sales.measurements.view or without threads.read (body data): no dock, no Thread button', () => {
    expect(threadRecordOf(RECORD, [MTM_PERMISSIONS.view, 'threads.read'])).toBe(RECORD.revisions.at(-1)!.id)
    expect(threadRecordOf(RECORD, ['threads.read'])).toBeNull()
    expect(threadRecordOf(RECORD, [MTM_PERMISSIONS.view])).toBeNull()
    expect(threadRecordOf({ revisions: [] }, [MTM_PERMISSIONS.view, 'threads.read'])).toBeNull()
    // The roles without measurements never get the rider's thread, whatever threads they read.
    for (const role of ['reader', 'warehouse'] as const) expect(threadRecordOf(RECORD, ROLE_PERMISSIONS[role]), role).toBeNull()
    for (const id of ['no-thread']) {
      const html = draw(id)
      expect(html, id).not.toContain('class="fw-rcf-dock"')
      expect(html, id).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
    }
    expect(draw('no-threads', 'en', threadScreen)).not.toContain('class="fw-rcf-dock"')
  })

  it('the thread lives on the chain’s FIRST revision (one per rider and garment type), the newest is never asked', () => {
    expect(RECORD.revisions.length).toBeGreaterThan(1)
    const first = RECORD.revisions.at(-1)!.id
    expect(threadRecordOf(RECORD, [MTM_PERMISSIONS.view, 'threads.read'])).toBe(first)
    expect(threadRecordOf(RECORD, [MTM_PERMISSIONS.view, 'threads.read'])).not.toBe(RECORD.latestId)
  })

  it('the page mounts the office thread docked on the first revision, with the rider’s own customer, and no rider name in its label', () => {
    const container = readFileSync(new URL('./record/ProfileRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain("record={{ type: 'MeasurementProfile', id: firstId, companyId: null, siteId: null }}")
    expect(container).toContain('threadRecordOf(record, session.permissions)')
    expect(container).toContain("party={{ id: record.partyId, name: record.customer.name }}")
    expect(container).toContain("recordLabel={words('record.threadLabel', { garment: record.garmentType })}")
    expect(container).not.toContain("tab === 'activity'")
    const view = readFileSync(new URL('./record/view/ProfileRecordView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('ActivityTab')
    expect(view).toContain('<RecordFrame')
  })

  it('every old ?tab=activity keeps working: the body lands on Measurements (tabOf), the frame opens the thread on arrival', () => {
    const container = readFileSync(new URL('./record/ProfileRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("const tab = tabOf(params?.get('tab'))")
    expect(container).not.toContain('useRecordTab')
    // The design case of an old address draws Measurements with the thread docked beside it.
    const html = renderView(view, designScreen.cases.find((item) => item.id === 'measurements')!.model, 'en')
    expect(html).toContain('class="fw-rcf-dock"')
    expect(html).toContain('id="mtm-measures"')
  })

  it('the band holds ONE pill (the review state) and the notices stay in the body column, never above the thread', () => {
    const html = draw('stale')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)
    expect(body).toContain('fw-rcf-notices')
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('brand wall: Brand Beta’s words never reach the rider’s design thread (its own customer only)', () => {
    const text = textOf(draw('thread-docked'))
    expect(text).toContain(RECORD.customer.name)
    expect(text).not.toContain('Brand Beta')
  })
})
