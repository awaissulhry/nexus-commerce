import { readFileSync } from 'node:fs'
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
import { OverviewTab } from './view/OverviewTab' // pp-w2 (t.1): moved from status-problem onto the Overview

/**
 * F-PR-24 — the portal order › Overview (pp-w2; was Status & progress): the problems the customer reported on the order — a strip of
 * "Where your order is" ("Problem reported · Waiting on us since 16 Nov", then "Answered 17 Nov"; never who answers: whoever does signs
 * in the thread); "Report a problem" is the band's ⋯ only (the lone row went: P0-B5). "Order files (3)" went from the Overview (O1-B3:
 * one home for files, the Files tab). Brand Beta's tab holds nothing of Brand Alpha and never the office's SO- series (PW-P02, PW-15).
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

// fix-pr-4: Brand Beta's own delivery address (the design data's default is Brand Alpha's warehouse: the facts draw it).
const betaRecord = (): OrderRecord =>
  orderRecord({ yourNumber: customerNumberOf('ORDER', 4), customerRef: BRAND_BETA.customerRef, status: 'IN_PRODUCTION', shipTo: { name: `${BRAND_BETA.legalName} — Lager`, ...BRAND_BETA.address, contactName: 'Wareneingang' } })

function model(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab: 'overview',
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
      children: (chip) => createElement(OverviewTab, { model: model(record, { production: { state: 'ready', read }, problem: { chip, report }, ...over }), record, actions: ACTIONS }),
    }),
    locale,
  )
}

describe('the problems it reported on this order, and Report a problem', () => {
  it('"Problem reported · Waiting on us since …" (a strip, no door: our answer comes in Messages); then "Answered …" — never who answers', () => {
    const waiting = textOf(draw())
    expect(waiting).toContain('Problem reported · Waiting on us since')
    // pp-w2 (P0-B5): "Report a problem" is the band's ⋯ only (below), never a lone button of the Overview.
    expect(waiting).not.toContain('Report a problem')
    const answered = textOf(draw({}, 'en', production({ problem: { state: 'ANSWERED', since: null, on: dayAt(0), inOrder: null } })))
    expect(answered).toMatch(/Answered \S/)
    expect(answered).not.toContain('Waiting on us since')
    // The batch's other orders: "Answered in your order 13" — the customer's own number, never the office's SO- series.
    const elsewhere = draw({}, 'en', production({ problem: { state: 'ANSWERED_IN', since: null, on: dayAt(0), inOrder: { id: 'o-13', number: 'SO-2026-0913', customerRef: null, yourNumber: customerNumberOf('ORDER', 13) } } }))
    expect(textOf(elsewhere)).toContain('Answered in your order 13')
    expect(elsewhere).not.toContain('SO-2026-0913')
    const italian = textOf(draw({}, 'it'))
    expect(italian).toContain('Problema segnalato · Tocca a noi dal')
    expect(italian).not.toContain('Segnala un problema')
  })

  it('no problem reported: no strip; the Overview never offers "Report a problem" (the band does, held with its words)', () => {
    const none = textOf(draw({}, 'en', production({ problem: null }), null))
    expect(none).not.toContain('Report a problem')
    expect(none).not.toContain('Problem reported')
    expect(textOf(draw({}, 'en', production({ problem: null })))).not.toContain('Report a problem')
    // Not in production (no production read drawn): neither the chip nor the button.
    const record = betaRecord()
    expect(textOf(render(createElement(OverviewTab, { model: model(record, { production: { state: 'hidden', read: null }, problem: { chip: null, report: { held: null } } }), record, actions: ACTIONS })))).not.toContain('Report a problem')
  })

  it('the band’s ⋯ offers it too (held with the words), and only where the page offers it', () => {
    const record = betaRecord()
    const facts = { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null }
    const band = (problem?: { held: string | null } | null) => orderBandOf({ words: orderWords('en'), record, prefix: PREFIX, facts: { ...facts, ...(problem === undefined ? {} : { problem }) } })
    expect(band({ held: null }).more?.find((item) => item.id === 'problem')).toMatchObject({ label: 'Report a problem', disabled: false })
    expect(band({ held: 'No connection: try again when you are back online.' }).more?.find((item) => item.id === 'problem')).toMatchObject({ disabled: true, description: 'No connection: try again when you are back online.' })
    expect(band(null).more?.some((item) => item.id === 'problem')).toBe(false)
    expect(band().more?.some((item) => item.id === 'problem')).toBe(false)
  })
})

// pp-w2 (w2.4, O1-B3): the same file showed in up to four places — the Overview's "Order files (3)" went (the Files tab holds them).
describe('no "Order files" on the Overview any more (one home for files: the Files tab)', () => {
  it('whatever the documents read says, the Overview draws none of them, and the page reads no documents for it', () => {
    for (const documents of [{ state: 'ready' as const, read: documentsRead() }, { state: 'loading' as const, read: null }, { state: 'error' as const, read: null }]) {
      const text = textOf(draw({ documents }))
      for (const words of ['Order files', 'All in Documents', 'DDT-2026-0144', "The order's files could not be read."]) expect(text, words).not.toContain(words)
    }
    expect(textOf(draw({}, 'it'))).not.toContain("File dell'ordine")
    const page = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain("tab === 'overview' && productionReady && readsDocuments")
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
