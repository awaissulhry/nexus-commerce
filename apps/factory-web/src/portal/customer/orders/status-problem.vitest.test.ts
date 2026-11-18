import { createElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import type { ProductionOrder } from '../production/api'
import { problemChipOf } from '../production/problem/model'
import { useProductionPageWords } from '../production/words'
import { orderBandOf } from './band'
import { at, dayAt, documentsRead, ORDER_ID, orderRecord, orderWords, progressRead, requestsOf, shipmentsRead } from './design-data'
import type { OrderRecord } from './api'
import type { OrderRecordActions, OrderRecordViewModel } from './view/OrderRecordView'
import { StatusTab } from './view/StatusTab'

/**
 * F-PR-24 — the portal order › Status & progress: the problems the customer reported on the order ("Problem reported · Waiting on us
 * since 16 Nov", then "Answered 17 Nov"; never who answers — whoever does signs in the thread) with "Report a problem" (also in the
 * band's ⋯), and "Order files (3)": the newest files we shared on the order and its lines, each opened or downloaded, "All in
 * Documents (4)"; reading, could not read + Try again, none: not drawn. Brand Beta's tab holds nothing of Brand Alpha and never the
 * office's SO- series (PW-P02, PW-15). Made-up data only.
 */

const PREFIX = `/p/${BRAND_BETA.code}`
const w = (en: string, it = en) => ({ it, en })

function production(over: Partial<ProductionOrder> = {}): ProductionOrder {
  return {
    asOf: at(0),
    level: 'STATUS',
    levelWords: w('Status only', 'Solo lo stato'),
    urgencyOn: false,
    urgentUse: null,
    order: { id: ORDER_ID, customerRef: BRAND_BETA.customerRef, number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), orderedOn: dayAt(-20), promiseDate: dayAt(10), originalPromiseDate: dayAt(10), promiseMoved: false },
    inProduction: true,
    stage: { code: 'SEWING', words: w('Sewing', 'Cucitura'), since: dayAt(-3), next: null, ahead: 0, aheadWords: null, sewingNotCounted: false, sewingNotCountedWords: null },
    health: null,
    waiting: { code: 'US', words: w('Waiting on us', 'Tocca a noi'), since: dayAt(-2) },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    holds: [],
    urgency: null,
    promiseHistory: [],
    progress: null,
    problem: { state: 'WAITING_ON_US', since: dayAt(-1), on: null, inOrder: null },
    live: { events: [] },
    ...over,
  }
}

const betaRecord = (): OrderRecord => orderRecord({ number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), customerRef: BRAND_BETA.customerRef, status: 'IN_PRODUCTION' })

function model(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab: 'status',
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf().map((item) => ({ ...item, orderNumber: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef })) },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    historyOpen: false,
    dialog: null,
    production: { state: 'ready', read: production() },
    waitingHref: `${PREFIX}/`,
    ...over,
  }
}

/** The chip as the page words it (the portal-production words), drawn with the order's own words around it. */
function ChipOf({ read, children }: { read: ProductionOrder; children: (chip: ReturnType<typeof problemChipOf>) => ReactElement }) {
  const words = useProductionPageWords()
  return children(problemChipOf(read.problem, words.t, words.day))
}
const ACTIONS: OrderRecordActions = { onReportProblem: () => undefined, onPreview: () => undefined, onDownload: () => undefined, onRetryDocuments: () => undefined }
function draw(over: Partial<OrderRecordViewModel> = {}, locale: Locale = 'en', read = production(), report: { held: string | null } | null = { held: null }) {
  const record = betaRecord()
  return render(
    createElement(ChipOf, {
      read,
      children: (chip) => createElement(StatusTab, { model: model(record, { production: { state: 'ready', read }, problem: { chip, report }, ...over }), record, actions: ACTIONS }),
    }),
    locale,
  )
}

describe('the problems it reported on this order, and Report a problem', () => {
  it('"Problem reported · Waiting on us since …" with Report a problem; then "Answered …" — never who answers', () => {
    const waiting = textOf(draw())
    expect(waiting).toContain('Problem reported · Waiting on us since')
    expect(waiting).toContain('Report a problem')
    const answered = textOf(draw({}, 'en', production({ problem: { state: 'ANSWERED', since: null, on: dayAt(0), inOrder: null } })))
    expect(answered).toMatch(/Answered \S/)
    expect(answered).not.toContain('Waiting on us since')
    // The batch's other orders: "Answered in your order 13" — the customer's own number, never the office's SO- series.
    const elsewhere = draw({}, 'en', production({ problem: { state: 'ANSWERED_IN', since: null, on: dayAt(0), inOrder: { id: 'o-13', number: 'SO-2026-0913', customerRef: null, yourNumber: customerNumberOf('ORDER', 13) } } }))
    expect(textOf(elsewhere)).toContain('Answered in your order 13')
    expect(elsewhere).not.toContain('SO-2026-0913')
    const italian = textOf(draw({}, 'it'))
    expect(italian).toContain('Problema segnalato · Tocca a noi dal')
    expect(italian).toContain('Segnala un problema')
  })

  it('no problem reported and no right to write to us: nothing of it is drawn; a preview holds the button with the words', () => {
    const none = textOf(draw({}, 'en', production({ problem: null }), null))
    expect(none).not.toContain('Report a problem')
    expect(none).not.toContain('Problem reported')
    expect(textOf(draw({}, 'en', production({ problem: null })))).toContain('Report a problem')
    const held = draw({}, 'en', production(), { held: 'A preview reads only: nothing is sent from it.' })
    expect(held).toContain('aria-disabled="true"')
    // Not in production (no production read drawn): neither the chip nor the button.
    const record = betaRecord()
    expect(textOf(render(createElement(StatusTab, { model: model(record, { production: { state: 'hidden', read: null }, problem: { chip: null, report: { held: null } } }), record, actions: ACTIONS })))).not.toContain('Report a problem')
  })

  it('the band’s ⋯ offers it too (held with the words), and only where the page offers it', () => {
    const record = betaRecord()
    const facts = { changeHeld: null, cancelHeld: null, reconfirm: null, shipments: 1, moves: 0, confirmation: true, pay: null }
    const band = (problem?: { held: string | null } | null) => orderBandOf({ words: orderWords('en'), record, tab: 'status', prefix: PREFIX, facts: { ...facts, ...(problem === undefined ? {} : { problem }) } })
    expect(band({ held: null }).more?.find((item) => item.id === 'problem')).toMatchObject({ label: 'Report a problem', disabled: false })
    expect(band({ held: 'No connection: try again when you are back online.' }).more?.find((item) => item.id === 'problem')).toMatchObject({ disabled: true, description: 'No connection: try again when you are back online.' })
    expect(band(null).more?.some((item) => item.id === 'problem')).toBe(false)
    expect(band().more?.some((item) => item.id === 'problem')).toBe(false)
  })
})

describe('Order files (3): the newest files we shared on this order and its lines', () => {
  it('the newest three, each opened (a PDF) or downloaded, and "All in Documents (4)" to the Documents tab', () => {
    const html = draw()
    const text = textOf(html)
    expect(text).toContain('Order files (4)')
    expect(text).toContain('All in Documents (4)')
    expect(html).toContain(`href="${PREFIX}/orders/${ORDER_ID}?tab=documents"`)
    // documentsRead: four current documents (an earlier version is not one of them), the newest three shown.
    expect(text).toContain('DDT-2026-0144')
    expect(text).toContain('DoC JKT-DEMO-01 rev. 2')
    expect(text).not.toContain('FT-2026-00031')
    expect(text).toContain('Open')
    expect(text).toContain('Download')
    expect(textOf(draw({}, 'it'))).toContain("File dell'ordine (4)")
  })

  it('reading: its place; could not be read: said with Try again; none, or no right to the documents: not drawn', () => {
    expect(textOf(draw({ documents: { state: 'loading', read: null } }))).not.toContain('Order files (')
    const failed = textOf(draw({ documents: { state: 'error', read: null } }))
    expect(failed).toContain("The order's files could not be read.")
    expect(failed).toContain('Try again')
    expect(textOf(draw({ documents: { state: 'ready', read: documentsRead({ items: [], count: 0 }) } }))).not.toContain('Order files')
    expect(textOf(draw({ documents: { state: 'noAccess', read: null } }))).not.toContain('Order files')
    // A preview or offline holds Open and Download with the reason.
    expect(draw({ fileHeld: 'A preview opens no file.' })).toContain('aria-disabled="true"')
  })
})

describe('PW-P02 / PW-15 (screen): Brand Beta’s tab holds nothing of Brand Alpha, never the office’s SO- series, never a person of ours', () => {
  it('in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = draw({}, locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(/\bSO-\d{4}-\d+/)?.[0] ?? null, locale).toBeNull()
      expect(textOf(html), locale).not.toMatch(/supervisor|supervisore|answered by|risposto da/i)
    }
  })
})
