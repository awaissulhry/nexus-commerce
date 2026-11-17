import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { FINAL, workOrder } from '../../../_shared/fixtures'
import { designScreen } from '../fixtures'
import { customerFactOf } from '../overview/model'
import { scrapPageHref, shareAddress, shareHeld } from './model'

/**
 * F-PR-06 — the work order's Quality tab and Labour & cost (06-tree A.4 Tabs 5 and 6; O-WO-qa, O-WO-qa-scrap, O-WO-lab): Quality is
 * the one scrap home (its door to Scrap & rework for the replacements), "Share with the customer" on a final inspection's report,
 * held on a work order of several customers before anything else (WALL-G02, WALL-G07, TH-16), and Labour & cost without the second
 * scrap card. Wall PW-05 (web side): the share opens only this work order's own inspections' reports; a mixed work order holds
 * every customer share.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const ONE = customerFactOf({ customer: { id: 'p1', code: 'ALPHA', name: 'Brand Alpha' }, mixedCustomers: false })
const MIXED = customerFactOf({ customer: null, mixedCustomers: true })
const NONE = customerFactOf({ customer: null, mixedCustomers: false })
const PASSED = { status: 'PASSED' as const }

describe('F-PR-06 — Share with the customer, held on a mixed work order (PW-05 web side)', () => {
  it('a mixed work order holds the share before anything else — even with the right and a decided result', () => {
    expect(shareHeld(MIXED, PASSED, true)).toEqual({ key: 'quality.share.mixed' })
    expect(shareHeld(MIXED, { status: 'OPEN' }, false)).toEqual({ key: 'quality.share.mixed' })
  })

  it('a work order for stock has no customer; an open or cancelled inspection has no report yet; the right last', () => {
    expect(shareHeld(NONE, PASSED, true)).toEqual({ key: 'quality.share.noCustomer' })
    expect(shareHeld(ONE, { status: 'OPEN' }, true)).toEqual({ key: 'quality.share.noResult' })
    expect(shareHeld(ONE, { status: 'CANCELLED' }, true)).toEqual({ key: 'quality.share.noResult' })
    expect(shareHeld(ONE, PASSED, false)).toEqual({ key: 'quality.share.noRight' })
    expect(shareHeld(ONE, PASSED, true)).toBeNull()
    expect(shareHeld(ONE, { status: 'FAILED' }, true)).toBeNull()
  })

  it('the share opens the inspection’s report window on its share part; the scrap home’s door finds this work order', () => {
    expect(shareAddress('/w/DEMO', 'i 1')).toBe('/w/DEMO/quality/inspections/report?id=i%201&share=1')
    expect(scrapPageHref('/w/DEMO', 'WO-00009')).toBe('/w/DEMO/production/scrap?q=WO-00009')
  })

  it('on screen: one customer — Share opens for the decided inspection only; the links name this work order’s inspections only', () => {
    const html = draw('quality-share')
    const links = [...html.matchAll(/report\?id=([^&"]+)&amp;share=1/g)].map((match) => decodeURIComponent(match[1]!))
    expect(links).toEqual([FINAL.inspections[0]!.id])
    for (const id of links) expect(FINAL.inspections.map((inspection) => inspection.id)).toContain(id)
    // A held button says why (the DS draws the reason with the button).
    expect(html).toContain('Shared once the inspection has a result')
  })

  it('on screen: a mixed work order — every share held with “Mixed work order: not for a customer”, no report link', () => {
    const html = draw('quality-share-mixed')
    expect(html).toContain('Mixed work order: not for a customer')
    expect(html).not.toMatch(/share=1/)
    expect(draw('quality-share-mixed', 'it')).toContain('Ordine misto: non per un cliente')
  })

  it('without quality.documents.share the share is held in words', () => {
    expect(draw('quality-share-no-right')).toContain('Your role cannot share quality reports')
  })
})

describe('F-PR-06 — Quality is the one scrap home; Labour & cost keeps one scrap value line', () => {
  it('Quality: scrap, rework and holds with the door to Scrap & rework (replacements) for those who read it', () => {
    const html = draw('quality-share')
    expect(html).toContain(`/production/scrap?q=${workOrder('IN_PROGRESS').number}`)
  })

  it('Labour & cost: no scrap and rework card per reason; at most one Scrap value line, its door to Quality', () => {
    const text = textOf(draw('w2a-labour'))
    expect(text).not.toContain('Scrap and rework cost')
    expect((text.match(/Scrap value/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it('the cases draw in it and en with no key left', () => {
    for (const id of ['quality-share', 'quality-share-mixed', 'quality-share-no-right', 'quality', 'w2a-quality-scrap', 'w2a-labour']) {
      for (const locale of LOCALES) expect(leftKeys(draw(id, locale), ['quality', 'scrapValue', 'scrap', 'tab']), `${id} (${locale})`).toEqual([])
    }
  })
})
