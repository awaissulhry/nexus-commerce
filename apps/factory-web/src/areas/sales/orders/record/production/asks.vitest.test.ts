import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { OrderIssue } from './api'
import { askStarterOf, asksOf, firstLineOf, NO_ASKS, onItOf, QUOTE_MAX } from './asks'

// F-PT-103 (order PRODUCTION tab, W1): Ask for an update — the asks line (waiting · escalated · answered · none), the ready question.

const w = (en: string, it: string) => ({ en, it })
const issue = (over: Partial<OrderIssue> = {}): OrderIssue => ({
  id: 'i1',
  source: 'OFFICE',
  sourceWords: w('Question for production', 'Domanda per la produzione'),
  status: 'OPEN',
  record: { type: 'SalesOrder', id: 'so1', label: 'SEED-SO-0002' },
  raisedAt: '2026-11-20T15:20:00Z',
  dueOn: '2026-11-23',
  answeredAt: null,
  escalation: null,
  task: { id: 't1', assignee: 'SOMEONE_ELSE' },
  batch: null,
  excerpt: 'Where is SEED-SO-0002 now?',
  ...over,
})

describe('F-PT-103: the asks line of the order', () => {
  it('none: nothing asked, nothing waits', () => {
    expect(asksOf([])).toEqual(NO_ASKS)
    expect(asksOf(null)).toEqual(NO_ASKS)
  })

  it('waiting: the newest open office ask — when, due, still with the supervisor; who and the door only once the server sends them', () => {
    const view = asksOf([issue({ id: 'old', raisedAt: '2026-11-18T09:00:00Z' }), issue()])
    expect(view.open).toEqual({ id: 'i1', at: '2026-11-20T15:20:00Z', by: null, due: '2026-11-23', escalated: null, messageId: null, workOrder: null })
    expect(view.waiting).toBe(2)
    const named = asksOf([issue({ askedBy: { id: 'u1', name: 'Alex Demo' }, messageId: 'm1' })])
    expect(named.open?.by).toBe('Alex Demo')
    expect(named.open?.messageId).toBe('m1')
  })

  it('escalated: past its day it says the escalation’s own words; an ask on a work order names it', () => {
    const view = asksOf([issue({ escalation: { step: 1, at: '2026-11-23T07:00:00Z', words: w('now with the backup', 'ora al sostituto') }, record: { type: 'WorkOrder', id: 'wo1', label: 'SEED-WO-0411' } })])
    expect(view.open?.escalated).toEqual(w('now with the backup', 'ora al sostituto'))
    expect(view.open?.workOrder).toBe('SEED-WO-0411')
  })

  it('answered by a reply (B-PT-010): "Latest update" with who, when and the first line; without the reply only when', () => {
    const replied = issue({ status: 'ANSWERED', answeredAt: '2026-11-20T13:10:00Z', reply: { at: '2026-11-20T13:10:00Z', messageId: 'm2', by: { id: 'u2', name: 'Carlo Prova' }, excerpt: 'Cutting done for all 244.\nSewing line 2 at 212.' } })
    expect(asksOf([replied]).latest).toEqual({ at: '2026-11-20T13:10:00Z', by: 'Carlo Prova', text: 'Cutting done for all 244.', messageId: 'm2', answeredFor: null })
    expect(asksOf([replied]).open).toBeNull()
    expect(asksOf([replied]).waiting).toBe(0)
    const ticked = issue({ status: 'ANSWERED', answeredAt: '2026-11-20T13:10:00Z' })
    expect(asksOf([ticked]).latest).toEqual({ at: '2026-11-20T13:10:00Z', by: null, text: null, messageId: null, answeredFor: null })
    // L8 (B-PT-010b): one reply answered the asks of other orders too — those the reader may open by number, the rest counted.
    const batch = { id: 'b1', issues: 3, orders: [{ id: 'o2', number: 'SEED-SO-0090' }], more: 1 }
    expect(asksOf([{ ...ticked, batch }]).latest?.answeredFor).toEqual({ orders: ['SEED-SO-0090'], more: 1 })
    expect(asksOf([{ ...ticked, batch: { id: 'b1', issues: 1, orders: [], more: 0 } }]).latest?.answeredFor).toBeNull()
  })

  it('the customer’s questions count as waiting but are never an update ask', () => {
    const view = asksOf([issue({ source: 'BRAND', sourceWords: w('Reported by the customer', 'Segnalato dal cliente') })])
    expect(view.open).toBeNull()
    expect(view.waiting).toBe(1)
  })

  it('a quote is one line of at most 140 characters', () => {
    expect(firstLineOf('\n  first  \nsecond')).toBe('first')
    expect(firstLineOf('x'.repeat(200))).toHaveLength(QUOTE_MAX)
    expect(firstLineOf(null)).toBeNull()
  })
})

describe('F-PT-103: who is on it, and the ready question', () => {
  it('the supervisor and backup; nobody yet; not read (no People right)', () => {
    expect(onItOf({ supervisor: { name: 'Carlo Prova', me: false }, backup: { name: 'Bea Esempio' } })).toEqual({ kind: 'supervisor', name: 'Carlo Prova', me: false, backup: 'Bea Esempio' })
    expect(onItOf({ supervisor: null, backup: null })).toEqual({ kind: 'nobody' })
    expect(onItOf(null)).toEqual({ kind: 'unread' })
  })

  it('the order’s question names the promise; a work order’s its due day; words in it + en (office "tu")', () => {
    const day = (value: string) => `<${value}>`
    expect(askStarterOf({ number: 'SO-1', promise: '2026-12-07' }, day).body).toEqual({ key: 'productionTab.ask.starter', params: { number: 'SO-1', promise: '<2026-12-07>' } })
    expect(askStarterOf({ number: 'SO-1', promise: null }, day).body.key).toBe('productionTab.ask.starterNoPromise')
    expect(askStarterOf({ number: 'SO-1', promise: null, workOrder: { number: 'WO-1', due: '2026-12-04' } }, day).title).toEqual({ key: 'productionTab.ask.titleAbout', params: { number: 'WO-1' } })
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.ask.title', 'productionTab.ask.titleAbout', 'productionTab.ask.starter', 'productionTab.ask.starterNoPromise', 'productionTab.ask.starterWo', 'productionTab.ask.starterWoNoDue', 'productionTab.ask.send', 'productionTab.ask.button', 'productionTab.ask.menu', 'productionTab.ask.noSupervisor'])
        expect(t(key, { number: 'SO-1', promise: '7 Dec', due: '4 Dec' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
    const it_ = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it_('productionTab.ask.button')).toBe('Chiedi un aggiornamento')
    expect(it_('productionTab.ask.noSupervisor')).toBe('Nessun responsabile ancora: lo ricevono i responsabili di produzione dopo 1 giorno lavorativo')
  })
})

describe('F-PT-103: one act, three doors — Production now, a work order’s row and the band ⋯ ("Ask for an update…")', () => {
  it('the band ⋯ item is renamed, opens the same note as a ready ask; a sent note reads the asks again', () => {
    const view = readFileSync(new URL('../view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("label: t('productionTab.ask.menu')")
    expect(view).toContain('onSelect: () => actions?.people?.onAsk?.(askPreset)')
    expect(view).not.toContain("t('menu.askSupervisor')")
    const band = readFileSync(new URL('../use-band-acts.ts', import.meta.url), 'utf8')
    expect(band).toContain("'band', 'salesOrders', preset ?? null)")
    expect(band).toContain('input.againAsks?.()')
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("const asks = useOrderAsks(api, order.status === 'ready' ? order.value.id : null, tab === 'production')")
    expect(container).toContain("if (parts.includes('quality')) asks.again()")
    // The view reads what the container read: no fetching hook in the section.
    const now = readFileSync(new URL('../view/production/NowSection.tsx', import.meta.url), 'utf8')
    expect(now).not.toMatch(/from '[^']*use-order-asks'/)
    expect(now).toContain('const mayAsk = !!people?.mayNote && stateNow !== \'after\'')
  })
})
