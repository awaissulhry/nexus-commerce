import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { render } from '../../../lib/record-thread/parts/testing'
import { portalArrivalCleaned, portalArrivalOf } from '../../shell/record/model'
import { shipmentsRead } from './design-data'
import { recordHref, tabOf } from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * pp-t — the order page's old addresses keep landing (lane pp-, round 1; plan § 7 "old links in mails keep working"; 10-design § 2:
 * Overview · Lines · Shipments · Files). pp-w1 pinned the tab map (`tabOf`: status → overview, documents → files, messages → overview),
 * `?tab=messages` showing the docked conversation focused (record-frame.vitest.test.ts), My production's links on Overview
 * (production.vitest.test.ts, approve-ask.vitest.test.ts) and `recordHref(…, 'shipments')`. Pinned here what was left: an old
 * `?tab=status` / `?tab=documents` opens no conversation and keeps its address (only `tab=messages` is an arrival term the frame
 * takes away), the clean address after `?tab=messages` is Overview's, and a shipment's address — `?tab=shipments#shipment-<id>` (the
 * orders list's old "On the way" door, pg- lane; pg-w2's list opens Shipments by `recordHref(…, 'shipments')`) — lands on Shipments
 * with no conversation opened, the page bringing the shipment's card into view once the shipments are read.
 * Made-up data only.
 */

describe('old addresses: a mail before round 1, a list\'s door', () => {
  it('?tab=status and ?tab=documents land on Overview and Files; no conversation opens; the address keeps its tab', () => {
    for (const [search, tab] of [
      ['?tab=status', 'overview'],
      ['?tab=documents', 'files'],
    ] as const) {
      expect(portalArrivalOf(search), search).toEqual({ openThread: false, focus: false })
      expect(portalArrivalCleaned(search, false), search).toBe(search)
      expect(tabOf(new URLSearchParams(search).get('tab')), search).toBe(tab)
    }
  })

  it('?tab=messages is taken once: the conversation shows, focused, and the clean address is Overview\'s', () => {
    expect(portalArrivalOf('?tab=messages')).toEqual({ openThread: true, focus: true })
    const clean = portalArrivalCleaned('?tab=messages', false)
    expect(clean).toBe('')
    expect(tabOf(new URLSearchParams(clean).get('tab'))).toBe('overview')
  })

  it('a shipment\'s address lands: Shipments, no conversation, the shipment\'s card under #shipment-<id> brought into view', () => {
    const shipments = shipmentsRead().shipments
    expect(shipments.length).toBeGreaterThan(0)
    const url = new URL(`${recordHref('/p/X', 'o1', 'shipments')}#shipment-${shipments[0]!.id}`, 'https://portal.example')
    expect(url.pathname + url.search).toBe('/p/X/orders/o1?tab=shipments')
    expect(tabOf(url.searchParams.get('tab'))).toBe('shipments')
    // A shipment's anchor is no arrival of the conversation (only #messages is).
    expect(portalArrivalOf(url.search, url.hash)).toEqual({ openThread: false, focus: false })
    // The Shipments tab draws each shipment's card with that id (the DS Card passes it to the DOM).
    const entry = recordScreen.cases.find((item) => item.id === 'shipments')
    expect(entry, 'the order screen\'s Shipments case').toBeDefined()
    for (const locale of LOCALES) {
      const html = render(createElement(recordScreen.view, { model: entry!.model }), locale)
      for (const shipment of shipments) expect(html, `${locale} ${shipment.id}`).toContain(`id="shipment-${shipment.id}"`)
    }
    // The page brings that card into view once the shipments are read (the browser's own jump comes before the card exists): pp-w2.
    const page = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/if \(tab !== 'shipments' \|\| !shipmentsReady \|\| !window\.location\.hash\.startsWith\('#shipment-'\)\) return/)
    expect(page).toContain('document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView(')
  })
})
