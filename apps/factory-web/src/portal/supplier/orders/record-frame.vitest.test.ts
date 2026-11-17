import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { everyCase, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { designScreen as announceScreen } from '../deliveries/announce/fixtures'
import { noticeBandOf } from '../deliveries/band'
import { noticePage } from '../deliveries/design-data'
import { designScreen as noticeScreen } from '../deliveries/notice/fixtures'
import { replyHref } from '../home/model'
import { jobBandOf } from '../jobs/band'
import { jobOf } from '../jobs/design-data'
import { RECORD_TABS as JOB_TABS } from '../jobs/model'
import { designScreen as jobScreen } from '../jobs/record/fixtures'
import { orderBandOf } from './band'
import { confirmedPage, orderPage } from './design-data'
import { MERGED_TABS, NS, RECORD_TABS, recordHref, replyToOrderHref, tabOf } from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * B-TH-277 (threads plan TH-6; P-SUP-PO, P-SUP-DEL, P-SUB-JOB; picture 22; wall W02, W08, W09, W36): the supplier's purchase order
 * 5 → 3 tabs, the delivery notice with the order's conversation docked beside it, the workshop's job 5 → 3 — every page on the
 * portal record frame (the conversation docked, no Messages tab, no Ask modal), every old address still working (R-8), nothing of
 * the Documents tab lost, and never a brand's or a customer's name on a supplier or workshop page (WALL-G18, W36).
 */

const t = createTranslator('en', CATALOGUE.en[NS] ?? {})
const jobT = createTranslator('en', CATALOGUE.en['portal-jobs'] ?? {})
const deliveryT = createTranslator('en', CATALOGUE.en['portal-deliveries'] ?? {})
const PREFIX = '/p/CONCERIA-PROVA'

describe('the purchase order: tabs 5 → 3 (Lines · Confirm or propose · Ship notices)', () => {
  it('no Messages and no Documents tab: the conversation docks, the documents went where they do work', () => {
    expect(RECORD_TABS).toEqual(['lines', 'confirm', 'asn'])
    expect(RECORD_TABS as readonly string[]).not.toContain('messages')
    expect(RECORD_TABS as readonly string[]).not.toContain('documents')
  })

  it('every old address keeps working (R-8): ?tab=documents and ?tab=messages open Lines; nonsense and prototype keys too', () => {
    expect(tabOf('documents')).toBe('lines')
    expect(tabOf('messages')).toBe('lines')
    expect(tabOf('confirm')).toBe('confirm')
    expect(tabOf('asn')).toBe('asn')
    expect(tabOf('constructor')).toBe('lines')
    expect(tabOf('toString')).toBe('lines')
    expect(tabOf(null)).toBe('lines')
    expect(MERGED_TABS).toEqual({ documents: 'lines', messages: 'lines' })
    expect(recordHref(PREFIX, 'po', 'asn')).toBe(`${PREFIX}/orders/po?tab=asn`)
  })

  it('Home’s Reply opens the PO with its docked conversation shown and its box focused (the frame’s arrival rule)', () => {
    expect(replyToOrderHref(PREFIX, 'po1')).toBe(`${PREFIX}/orders/po1?tab=messages#messages`)
    expect(replyHref(PREFIX, { record: { type: 'PurchaseOrder', id: 'po1', label: 'PO-2026-0101' } } as never, true)).toBe(`${PREFIX}/orders/po1?tab=messages#messages`)
  })

  it('the band: three tabs, the PO PDF (as sent, no prices) in ⋯ with its day, Ask a question about this PO', () => {
    const page = confirmedPage()
    const band = orderBandOf({ t, locale: 'en', page, tab: 'lines', prefix: PREFIX, done: false, confirmHeld: null, notices: 2 })
    expect(band.tabs?.items.map((item) => item.id)).toEqual(['lines', 'confirm', 'asn'])
    const pdf = band.more?.find((item) => item.id === 'pdf')
    expect(pdf?.href).toBe(`/api/portal/purchase-orders/${page.order.id}/copy?language=en`)
    expect(pdf?.description).toMatch(/^Sent on .+ · no prices$/)
    expect(band.ask).toEqual({ type: 'PurchaseOrder', id: page.order.id, label: page.order.documentNumber })
  })
})

describe('the workshop job: tabs 5 → 3 (Kit received · Progress · Send back)', () => {
  it('no Messages and no Documents tab; the band holds the three tabs and asks about the job', () => {
    expect(JOB_TABS).toEqual(['kit', 'progress', 'sendback'])
    const job = jobOf()
    const band = jobBandOf({ t: jobT, job, tab: 'kit', prefix: PREFIX, acceptHeld: null, declineHeld: null })
    expect(band.tabs?.items.map((item) => item.id)).toEqual(['kit', 'progress', 'sendback'])
    expect(band.ask).toEqual({ type: 'SubcontractOrder', id: job.id, label: job.number })
  })
})

describe('the delivery notice: the ORDER’s conversation docks beside it', () => {
  it('the band’s Ask a question names the order the delivery is for (the same conversation the page docks)', () => {
    const page = noticePage()
    const band = noticeBandOf({ t: deliveryT, locale: 'en', prefix: PREFIX, page, stepping: false, changeHeld: null })
    expect(band.ask).toEqual({ type: 'PurchaseOrder', id: page.notice.purchaseOrder.id, label: page.notice.purchaseOrder.number })
  })
})

const dock = (html: string) => html.match(/<aside[^>]*id="messages"/g)?.length ?? 0
const MISSING = new Set(['loading', 'error', 'missing'])

describe('every record page docks its ONE conversation (the portal record frame)', () => {
  it('SCR-189-record: one docked conversation on every tab; none while the order loads, fails or is not theirs', () => {
    for (const [locale, id, html] of everyCase(recordScreen as unknown as DesignScreen<unknown>)) {
      expect(dock(html), `${id} (${locale})`).toBe(MISSING.has(id) ? 0 : 1)
      expect(html, `${id} (${locale}): no Messages tab`).not.toMatch(/tab=messages/)
      expect(html, `${id} (${locale}): no Documents tab`).not.toMatch(/tab=documents/)
    }
  })

  it('SCR-193: one docked conversation on every tab of a read job; the phone case shows “Messages (2 new)”', () => {
    for (const [locale, id, html] of everyCase(jobScreen as unknown as DesignScreen<unknown>)) {
      if (id === 'sheet') continue
      expect(dock(html), `${id} (${locale})`).toBe(MISSING.has(id) ? 0 : 1)
    }
    const phone = everyCase(jobScreen as unknown as DesignScreen<unknown>).find(([locale, id]) => locale === 'en' && id === 'phone')
    expect(textOf(phone![2])).toContain('Messages (2 new)')
  })

  it('SCR-227-notice and -announce: the order’s conversation docks once the order is known; choosing an order has no dock', () => {
    for (const [locale, id, html] of everyCase(noticeScreen as unknown as DesignScreen<unknown>)) {
      expect(dock(html), `${id} (${locale})`).toBe(MISSING.has(id) ? 0 : 1)
    }
    const announce = everyCase(announceScreen as unknown as DesignScreen<unknown>)
    for (const [locale, id, html] of announce) {
      const pickingOrder = /choose|pick|no-orders|not-shippable/i.test(id)
      if (pickingOrder) expect(dock(html), `${id} (${locale})`).toBe(0)
    }
    expect(announce.some(([, , html]) => dock(html) === 1)).toBe(true)
  })
})

describe('nothing the Documents tab held is lost', () => {
  const html = (screen: DesignScreen<unknown>, id: string) => everyCase(screen).find(([locale, caseId]) => locale === 'en' && caseId === id)![2]

  it('the PO: the order as sent (its price-free PDF) on Lines; what we ask for on Confirm or propose; each DDT on Ship notices', () => {
    const lines = html(recordScreen as unknown as DesignScreen<unknown>, 'lines')
    const open = orderPage()
    expect(textOf(lines)).toContain(t('docs.asSent', { number: open.order.documentNumber }))
    expect(lines).toContain(`/api/portal/purchase-orders/${open.order.id}/copy?language=en`)
    const asks = html(recordScreen as unknown as DesignScreen<unknown>, 'confirmed-asks')
    expect(textOf(asks)).toContain('Upload the Cr VI report of batch 2231')
    expect(textOf(asks)).toContain(t('docs.requests'))
    const asn = html(recordScreen as unknown as DesignScreen<unknown>, 'asn')
    expect(textOf(asn)).toContain(t('asn.ddt', { number: '118/2026' }))
  })

  it('the job: the job sheet, our kit DDT and your photos under Kit received', () => {
    const kit = html(jobScreen as unknown as DesignScreen<unknown>, 'kit-documents')
    expect(kit).toMatch(/\/jobs\/[^"]+\/sheet/)
    expect(textOf(kit)).toContain(jobT('docs.title'))
    expect(textOf(kit)).toMatch(/DDT-2026-0331/)
  })
})

describe('the brand wall (W36, WALL-G18): a supplier or workshop page never names a brand', () => {
  it('no case of the PO, the notice, the announce steps or the job holds anything of either brand', () => {
    for (const screen of [recordScreen, noticeScreen, announceScreen, jobScreen] as unknown as DesignScreen<unknown>[]) {
      for (const [locale, id, html] of everyCase(screen)) {
        expect(scanText(textOf(html), BRAND_ALPHA), `${screen.screen}/${id} (${locale})`).toEqual([])
        expect(scanText(textOf(html), BRAND_BETA), `${screen.screen}/${id} (${locale})`).toEqual([])
        expect(scanText(html, BRAND_ALPHA), `${screen.screen}/${id} (${locale}) markup`).toEqual([])
        expect(scanText(html, BRAND_BETA), `${screen.screen}/${id} (${locale}) markup`).toEqual([])
      }
    }
  })

  it('the conversation words of the three pages are in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      expect(CATALOGUE[locale][NS]?.['thread.label'], locale).toContain('{number}')
      expect(CATALOGUE[locale]['portal-jobs']?.['thread.label'], locale).toContain('{number}')
      expect(CATALOGUE[locale]['portal-deliveries']?.['thread.label'], locale).toContain('{number}')
      expect(CATALOGUE[locale][NS]?.['tabs.messages'], locale).toBeUndefined()
      expect(CATALOGUE[locale]['portal-jobs']?.['tabs.documents'], locale).toBeUndefined()
    }
  })
})
