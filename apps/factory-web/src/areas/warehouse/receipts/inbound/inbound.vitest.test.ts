import { describe, expect, it } from 'vitest'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { EXPECTED } from '../demo/fixtures'
import { receiptBody } from '../model'
import type { InboundCard, NoticePrefill } from './api'
import { designScreen } from './fixtures'
import { cardOf, draftFromNotice, INBOUND_NAMESPACE, lanesOf, receiveHeldKey, receiveHref, siteRows, trimZeros } from './model'

/** The inbound board and the receiving form filled from a ship notice (B-W2b-182; SCM-110, SCM-106), pure. */

const t = (key: string, params?: Readonly<Record<string, string | number>>) => `${key}${params ? JSON.stringify(params) : ''}`
const leather = EXPECTED[0]!
const lining = EXPECTED[1]!
const card = designScreen.cases[0]!.model.model.board as { status: 'ready'; value: { cards: InboundCard[]; days: string[]; sites: { id: string; code: string; name: string }[]; asOf: string; from: string; complete: boolean } }

describe('the inbound board (SCM-110)', () => {
  it('draws a column per day, today named, the late deliveries counted on the first', () => {
    const lanes = lanesOf(card.value, card.value.cards, '2026-11-09', 'en', t)
    expect(lanes).toHaveLength(7)
    expect(lanes[0]).toMatchObject({ id: '2026-11-09', total: 1, tone: 'danger', detail: 'lane.late{"count":1}' })
    expect(lanes[0]!.label).toMatch(/^lane\.today/)
    expect(lanes[3]).toMatchObject({ id: '2026-11-12', total: 2, detail: null })
    expect(lanes[6]).toMatchObject({ total: 0 })
  })

  it('makes a card of a ship notice (its tracking state, verdict, notes) and of a confirmed order; the card opens the PO', () => {
    const notice = card.value.cards.find((entry) => entry.shipNotice?.verdict === 'NOT_AS_ORDERED')!
    const drawn = cardOf(notice, '/w/DEMO', t, (text) => text)
    expect(drawn.label).toBe(`${notice.shipNotice!.number} · ${notice.purchaseOrder.number}`)
    expect(drawn.href).toBe(`/w/DEMO/purchasing/orders/${notice.purchaseOrder.id}`)
    expect(drawn.marks?.map((mark) => mark.label)).toEqual(['verdict.NOT_AS_ORDERED', 'state.IN_TRANSIT'])
    expect(drawn.fields?.map((field) => field.label)).toEqual(['card.lines', 'card.tracking', 'card.hides', 'card.supplierNote'])
    const order = card.value.cards.find((entry) => entry.kind === 'ORDER')!
    expect(cardOf(order, '/w/DEMO', t, (text) => text).fields?.find((field) => field.label === 'card.tracking')?.value).toBe('card.noNotice')
    expect(receiveHref('/w/DEMO', notice)).toBe(`/w/DEMO/warehouse/receipts/new?order=${notice.purchaseOrder.id}&notice=${notice.shipNotice!.id}`)
    expect(receiveHref('/w/DEMO', order)).toBe(`/w/DEMO/warehouse/receipts/new?order=${order.purchaseOrder.id}`)
    expect(receiveHeldKey(false)).toBe('held.noReceive')
    expect(receiveHeldKey(true)).toBeNull()
  })

  it('keeps a row per site, one without deliveries too', () => {
    const rows = siteRows({ ...card.value, sites: [...card.value.sites, { id: 'south', code: 'S', name: 'South' }] })
    expect(rows.map((row) => [row.site.name, row.cards.length])).toEqual([
      [card.value.sites[0]!.name, card.value.cards.length],
      ['South', 0],
    ])
  })

  it('has every word in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = createTranslator(locale, messagesFor(locale, [INBOUND_NAMESPACE])[INBOUND_NAMESPACE]!)
      for (const key of ['title', 'menu.show', 'menu.hide', 'held.noReceive', 'card.noNotice', 'state.RECEIVED_WITH_DIFFERENCES', 'verdict.CHECK', 'note.hint']) expect(words(key)).not.toBe(key)
    }
  })
})

describe('the receipt filled from a ship notice (SCM-106)', () => {
  const prefill: NoticePrefill = {
    purchaseOrderId: leather.purchaseOrderId,
    shipNoticeId: 'notice-1',
    supplierDdtNumber: 'DDT-45',
    supplierDdtDate: '2026-11-10',
    lines: [
      { purchaseOrderLineId: leather.purchaseOrderLineId, quantity: null, lots: [{ supplierLotRef: 'L-77', dyeBatch: '2231', quantity: null, hides: [{ supplierCode: '2231-001', area: '21.0000', areaUom: 'FT2', grade: 'A', thicknessMm: '1.2' }, { supplierCode: '2231-002', area: '19.8500', areaUom: 'FT2', grade: null, thicknessMm: null }] }] },
      { purchaseOrderLineId: lining.purchaseOrderLineId, quantity: null, lots: [{ supplierLotRef: 'R-9', dyeBatch: null, quantity: '60.0000', hides: [] }] },
    ],
  }

  it('fills each hide with its declared area, a lot per dye batch, the DDT, and names the notice in the body', () => {
    const draft = draftFromNotice(leather.purchaseOrderId, EXPECTED, prefill)
    expect(draft.shipNoticeId).toBe('notice-1')
    expect(draft).toMatchObject({ ddtNumber: 'DDT-45', ddtDate: '2026-11-10' })
    const leatherLine = draft.lines.find((line) => line.line.purchaseOrderLineId === leather.purchaseOrderLineId)!
    expect(leatherLine.include).toBe(true)
    expect(leatherLine.lots).toHaveLength(1)
    expect(leatherLine.lots[0]).toMatchObject({ supplierLotRef: 'L-77', dyeBatch: '2231' })
    expect(leatherLine.lots[0]!.hides.map((hide) => [hide.supplierCode, hide.area, hide.areaUom, hide.grade, hide.thicknessMm])).toEqual([
      ['2231-001', '21', 'FT2', 'A', '1.2'],
      ['2231-002', '19.85', 'FT2', '', ''],
    ])
    const liningLine = draft.lines.find((line) => line.line.purchaseOrderLineId === lining.purchaseOrderLineId)!
    expect(liningLine.lots[0]).toMatchObject({ supplierLotRef: 'R-9', quantity: '60', hides: [] })
    const body = receiptBody(draft, 'Europe/Rome')
    expect(body).toMatchObject({ purchaseOrderId: leather.purchaseOrderId, shipNoticeId: 'notice-1', supplierDdtNumber: 'DDT-45' })
    expect(body.lines[0]!.lots![0]!.hides!.map((hide) => hide.area)).toEqual(['21', '19.85'])
  })

  it('leaves the order lines the notice does not carry out of the receipt', () => {
    const only = draftFromNotice(leather.purchaseOrderId, EXPECTED, { ...prefill, lines: [prefill.lines[0]!] })
    expect(only.lines.filter((line) => line.include).map((line) => line.line.purchaseOrderLineId)).toEqual([leather.purchaseOrderLineId])
  })

  it('writes a decimal as a person types it', () => {
    expect([trimZeros('21.0000'), trimZeros('10.5000'), trimZeros('100'), trimZeros('0.2500')]).toEqual(['21', '10.5', '100', '0.25'])
  })
})
