import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTranslator, catalogueFor } from '../../../lib/i18n/messages'
import type { IncomingRow } from './api'
import { afterConfirmed, catalogueConfirmPlan, catalogueFactsOf, confirmRunOf, confirmRunOne, factsByIdOf, factsWordsOf, offersConfirm, receiptOf, receiptSays, type CatalogueFacts } from './catalogue-facts'
import { incomingBarOf } from './bar'
import { confirmedWordsOf } from './view/InquiriesView'
import { HELD_ROW, SENT_ROW, TEXT_ROW, readRow } from '../orders/list/office-sheet/fixtures'

const t = createTranslator('en', catalogueFor('en', 'orders-sheet', 'office'))

const incoming = (id: string, over: Partial<IncomingRow> = {}): IncomingRow =>
  ({
    key: `CATALOGUE_ORDER:${id}`,
    kind: 'CATALOGUE_ORDER',
    id,
    number: `RQ-${id}`,
    companyId: 'company-1',
    receivedAt: '2026-11-27T09:00:00Z',
    party: { id: 'party-1', code: 'C-ALPHA', name: 'Alpha Racing' },
    fromWords: 'Alpha Racing',
    prospect: false,
    summary: 'Team suits',
    pieces: 5,
    wantedDate: null,
    state: 'SENT',
    stateWords: { it: 'Inviato', en: 'Sent' },
    open: true,
    waiting: { for: 'US', workingMinutes: 10, overdue: false },
    version: 3,
    opens: { place: 'INCOMING', id },
    request: null,
    catalogueOrder: { status: 'SENT', source: 'PORTAL', customerRef: null, lines: 1, styles: [], requestedDate: null, decidedAt: null, salesOrder: null, quote: null },
    changeRequest: null,
    ...over,
  }) as IncomingRow

const facts: ReadonlyMap<string, CatalogueFacts> = factsByIdOf([SENT_ROW, TEXT_ROW, HELD_ROW])

describe('owb-of4 step 1 — Incoming’s Sent orders with the sheet read’s facts', () => {
  it('"n details still open" comes from the read; a text order says "Sent as text · product not picked"', () => {
    expect(factsWordsOf(facts.get('req-sent')!, t)).toBe('2 details still open')
    expect(factsWordsOf(facts.get('req-text')!, t)).toBe('Sent as text · product not picked')
    expect(factsWordsOf(catalogueFactsOf(readRow()), t)).toBeNull()
  })

  it('only Sent requests of the read give facts; a line without a product or a customer on hold holds', () => {
    expect([...factsByIdOf([SENT_ROW, readRow(), readRow({ kind: 'REQUEST', id: 'req-draft', life: 'DRAFT' })]).keys()]).toEqual(['req-sent'])
    expect(facts.get('req-held')?.holds).toBe(true)
    expect(catalogueFactsOf({ ...SENT_ROW, customerOnHold: true }).holds).toBe(true)
  })

  it('a text order → no Confirm in bulk (skipped and counted); the ones that hold are skipped too', () => {
    const plan = catalogueConfirmPlan([incoming('req-sent'), incoming('req-text'), incoming('req-held'), incoming('req-unknown')], facts)
    expect(plan.go.map((row) => row.id)).toEqual(['req-sent'])
    expect(plan).toMatchObject({ text: 1, held: 1, other: 1 })
  })

  it('the bar draws Confirm N first for a reader with orders.manage and says the skips', () => {
    const bar = incomingBarOf({ manage: true, tasks: false, threads: false, orders: true }, [incoming('req-sent'), incoming('req-text')], null, null, facts)
    expect(bar.promoted[0]).toMatchObject({ id: 'confirm', label: { ns: 'orders-sheet', key: 'incoming.bulkConfirm', params: { count: 1 } }, held: null })
    expect(bar.note).toEqual({ ns: 'orders-sheet', key: 'incoming.bulkSkips', params: { text: 1, held: 0 } })
    const noRight = incomingBarOf({ manage: true, tasks: false, threads: false }, [incoming('req-sent')], null, null, facts)
    expect(noRight.promoted.some((act) => act.id === 'confirm')).toBe(false)
  })

  it('Confirm the order… shows on a Sent order the reader may confirm (a text order too: the window picks its product), never on a decided one', () => {
    expect(offersConfirm(incoming('req-text'), facts.get('req-text'), true)).toBe(true)
    expect(offersConfirm(incoming('req-sent'), facts.get('req-sent'), false)).toBe(false)
    expect(offersConfirm(incoming('req-sent', { catalogueOrder: { status: 'ACCEPTED', source: 'PORTAL', customerRef: null, lines: 1, styles: [], requestedDate: null, decidedAt: null, salesOrder: null, quote: null } }), facts.get('req-sent'), true)).toBe(false)
  })

  it('what Confirm did, in words (and what was left for later)', () => {
    expect(confirmedWordsOf({ done: 2, text: 1, held: 0, other: 0, refused: 0, left: 0 }, t)).toBe('2 orders confirmed · 1 text order skipped: pick its product first')
    expect(confirmedWordsOf({ done: 1, text: 0, held: 0, other: 0, refused: 0, left: 2 }, t)).toBe('1 order confirmed · 2 left: confirm them later')
  })
})

describe('owb-of4 (lead fix) — Confirm opens THE Confirm window (owb-of5 ConfirmOrderWindow), one order at a time', () => {
  it('bulk Confirm walks the plan’s orders through the window; each confirm brings the next; the end says what it did', () => {
    const plan = catalogueConfirmPlan([incoming('req-sent'), incoming('req-text'), incoming('req-held')], facts)
    let run = confirmRunOf({ ...plan, go: [...plan.go, incoming('req-two')] })
    expect(run.queue).toEqual(['req-sent', 'req-two'])
    run = afterConfirmed(run)
    expect(run.queue).toEqual(['req-two'])
    run = afterConfirmed(run)
    expect(receiptOf(run)).toEqual({ done: 2, text: 1, held: 1, other: 0, refused: 0, left: 0 })
  })

  it('a door is a run of one; a window closed at once says nothing, one closed midway leaves the rest for later', () => {
    expect(receiptSays(receiptOf(confirmRunOne('req-sent')))).toBe(false)
    expect(receiptOf(afterConfirmed({ queue: ['a', 'b', 'c'], done: 0, text: 0, held: 0, other: 0 }))).toMatchObject({ done: 1, left: 2 })
  })

  it('the row’s door and the ⋯ menu open the ONE window; Accept as quote and Refuse stay as they were', () => {
    const view = readFileSync(new URL('./view/InquiriesView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import { ConfirmOrderWindow } from '../../orders/draft/ConfirmOrderWindow'")
    expect(view).not.toContain("onCatalogueVerb?.(data, 'order')")
    expect(view).toContain("onCatalogueVerb?.(data, 'quote')")
    expect(view).toContain("onCatalogueVerb?.(data, 'refuse')")
    expect(view.match(/onConfirmDoor\?\.\(data\)/g)).toHaveLength(2)
  })
})
