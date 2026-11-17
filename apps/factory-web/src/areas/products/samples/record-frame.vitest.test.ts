import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { MERGED_TABS, RECORD_TABS, recordTabOf } from './model'
import { designScreen } from './record/fixtures'

/**
 * B-TH-262 — the sample round on RecordFrame (O-PRD-SMP; the rule of picture 38, the tabs of picture 39 / 08-tabs.tsv): the band in
 * the area row, ONE thread docked beside the five tabs, Activity's tools in the thread's "⋯" (R-ACT), "Ask the customer" opening the
 * thread's Ask a partner to approve, one notice, the old addresses (R-8).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const ask = (tab: string | null) => recordTabOf({ get: (name: string) => (name === 'tab' ? tab : null) })

describe('the sample round on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity tab and no record panels', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(textOf(html)).not.toMatch(/\bActivity\b/)
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['request', 'sample', 'fit', 'approval', 'shipments', 'thread-internal']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the tabs 6 → 5: Request · Sample · Fit & comments · Approval · Shipments, in that order', () => {
    expect(RECORD_TABS).toEqual(['request', 'sample', 'fit', 'approval', 'shipments'])
    const text = textOf(draw('thread-docked'))
    let at = -1
    for (const tab of ['Request', 'Sample', 'Fit & comments', 'Approval', 'Shipments']) {
      const next = text.indexOf(tab, at + 1)
      expect(next, tab).toBeGreaterThan(at)
      at = next
    }
  })

  it('every old ?tab= keeps working (R-8): Activity → the Request (the frame opens the thread), unknown → the Request', () => {
    expect(MERGED_TABS).toEqual({ activity: 'request' })
    expect(ask('activity')).toBe('request')
    for (const tab of RECORD_TABS) expect(ask(tab)).toBe(tab)
    expect(ask('nope')).toBe('request')
    expect(ask('constructor')).toBe('request')
    expect(ask(null)).toBe('request')
  })

  it('the band sits in the frame: ONE pill (the stage), the round’s details beside it, the Thread button', () => {
    const html = draw('request')
    expect(html).toContain('fw-rcf-hdr')
    const band = html.slice(html.indexOf('fw-rcf-hdr'), html.indexOf('class="fw-rcf has-thread'))
    expect(band.match(/class="nds-pill /g)?.length).toBe(1)
    expect(textOf(band)).toContain('Made from revision')
    expect(textOf(band)).toContain('Thread')
  })

  it('one notice: the most serious shows, the rest wait behind "N more notices" (never above the thread)', () => {
    const html = draw('notices')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)
    expect(body).toContain('fw-rcf-notices-list')
    expect((body.match(/class="nds-banner /g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('the brand wall: an internal round’s thread holds notes only (no customer, no mail); a customer round names only its own customer', () => {
    const dock = (id: string) => {
      const html = draw(id)
      return textOf(html.slice(html.indexOf('class="fw-rcf-dock"')))
    }
    const internal = dock('thread-internal')
    expect(internal).not.toContain('Demo Moto Brand')
    expect(internal).not.toContain(BRAND_ALPHA.contact.email)
    expect(internal).not.toContain(BRAND_ALPHA.contact.name)
    const own = dock('thread-docked')
    expect(own).toContain('Demo Moto Brand')
    expect(own).not.toContain('Demo Rider Shop')
  })

  it('the page mounts the office thread docked; no record panels in a tab, no panel address of its own', () => {
    const container = readFileSync(new URL('./record/SampleRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).not.toMatch(/tab === 'activity'/)
    expect(container).not.toContain('panelOf')
    const view = readFileSync(new URL('./record/view/SampleRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<RecordFrame')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).not.toContain('DetailHeader')
  })

  it('"Ask the customer" opens the docked thread’s Ask a partner to approve (openDoor), never the gone Activity tab', () => {
    const source = readFileSync(new URL('./record/view/ApprovalTab.tsx', import.meta.url), 'utf8')
    expect(source).toContain("openDoor?.('approve')")
    expect(source).not.toContain("'activity'")
    const html = draw('thread-docked')
    expect(textOf(html)).toContain('Ask the customer')
    expect(html).not.toContain('tab=activity')
  })
})
