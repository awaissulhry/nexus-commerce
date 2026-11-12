import { describe, expect, it } from 'vitest'
import type { ComposedDocument } from '../../documents/compose'
import { SAMPLE_ORDER_LAYOUT, SAMPLE_ORDER_WORDS, sampleOrderDocument } from './document'
import {
  countsInProductionSpend,
  developmentStyleRefusal,
  developmentWords,
  planLinesRefusal,
  PRODUCTION_ORDER_KINDS,
  sampleLineDescription,
  sampleLineRefusal,
  sampleRoundRefusal,
} from './rules'

const composed = (language: 'it' | 'en'): ComposedDocument => ({
  type: 'PURCHASE_ORDER',
  language,
  layout: 'PURCHASE_ORDER/1',
  title: language === 'it' ? 'Ordine di acquisto' : 'Purchase order',
  issuer: { heading: 'Committente', name: 'Officina Demo S.r.l.', lines: [] },
  identity: [
    { label: 'Numero', value: 'PO-00012' },
    { label: 'Data', value: '12/11/2026' },
  ],
  banner: null,
  blocks: [],
  facts: [{ label: 'Pagamento', value: '30 gg' }],
  table: { columns: [], rows: [] },
  totals: [],
  notes: null,
  notices: ['the purchase order notice'],
  signatures: [],
  footer: { legal: '', text: null, page: '', continued: '' },
  meta: { title: 'Ordine di acquisto PO-00012', author: 'Officina Demo S.r.l.', subject: 'PURCHASE_ORDER/1 it', createdAt: '2026-11-11T23:00:00.000Z', keywords: 'PURCHASE_ORDER PO-00012 2026-11-12' },
})

const STYLE = { code: 'GIA-DEMO-01', name: 'Giacca Demo' }

describe('sample orders (B-W2b-347)', () => {
  it('counts only standard orders as production buying', () => {
    expect(PRODUCTION_ORDER_KINDS).toEqual(['STANDARD'])
    expect(countsInProductionSpend('STANDARD')).toBe(true)
    expect(countsInProductionSpend('SAMPLE')).toBe(false)
  })

  it('writes the sample words first in the line, the buyer’s after', () => {
    expect(sampleLineDescription('HIDE', 'it', null)).toBe('Pelle campione')
    expect(sampleLineDescription('COLOUR_CARD', 'en', '  ')).toBe('Colour card')
    expect(sampleLineDescription('SWATCH', 'it', ' 20 × 20 cm ')).toBe('Campione di materiale · 20 × 20 cm')
  })

  it('refuses a closed style, a closed round, another style’s round', () => {
    expect(developmentStyleRefusal({ code: 'S1', status: 'ACTIVE', lifecycle: 'SAMPLING' })).toBeNull()
    expect(developmentStyleRefusal({ code: 'S1', status: 'ARCHIVED', lifecycle: 'SAMPLING' })?.code).toBe('STYLE_CLOSED')
    expect(developmentStyleRefusal({ code: 'S1', status: 'ACTIVE', lifecycle: 'DISCONTINUED' })?.code).toBe('STYLE_CLOSED')
    expect(sampleRoundRefusal({ number: 'SR-1', styleId: 'a', stage: 'IN_MAKING' }, 'a')).toBeNull()
    expect(sampleRoundRefusal({ number: 'SR-1', styleId: 'a', stage: 'DECIDED' }, 'a')?.code).toBe('ROUND_CLOSED')
    expect(sampleRoundRefusal({ number: 'SR-1', styleId: 'a', stage: 'CANCELLED' }, 'a')?.message).toContain('cancelled')
    expect(sampleRoundRefusal({ number: 'SR-1', styleId: 'b', stage: 'REQUESTED' }, 'a')?.code).toBe('ROUND_OF_ANOTHER_STYLE')
  })

  it('buys materials only; a sample hide is leather', () => {
    expect(sampleLineRefusal('HIDE', { code: 'PEL-1', kind: 'LEATHER' })).toBeNull()
    expect(sampleLineRefusal('HIDE', { code: 'FOD-1', kind: 'LINING' })?.code).toBe('HIDE_NOT_LEATHER')
    expect(sampleLineRefusal('SWATCH', { code: 'FOD-1', kind: 'LINING' })).toBeNull()
    expect(sampleLineRefusal('COLOUR_CARD', { code: 'GIA-1-M', kind: 'FINISHED' })?.code).toBe('NOT_A_MATERIAL')
    expect(planLinesRefusal('PO-00012').code).toBe('SAMPLE_ORDER_TAKES_NO_PLAN_LINES')
  })

  it('says what the order is for, with the round when it has one', () => {
    expect(developmentWords({ style: STYLE, round: null }, 'it')).toBe('GIA-DEMO-01 Giacca Demo')
    expect(developmentWords({ style: STYLE, round: { number: 'SR-2026-0003', kind: 'PROTO', roundNo: 1 } }, 'it')).toBe('GIA-DEMO-01 Giacca Demo · Prototipo, giro 1 (SR-2026-0003)')
    expect(developmentWords({ style: STYLE, round: { number: 'SR-2026-0004', kind: 'FIT', roundNo: 2 } }, 'en')).toBe('GIA-DEMO-01 Giacca Demo · Fit, round 2 (SR-2026-0004)')
  })

  it('titles the composed order a sample order, says what it is for and that it is no production order', () => {
    const it = sampleOrderDocument(composed('it'), { style: STYLE, round: { number: 'SR-2026-0003', kind: 'PROTO', roundNo: 1 } })
    expect(it.title).toBe('Ordine di campionatura')
    expect(it.layout).toBe(SAMPLE_ORDER_LAYOUT)
    expect(it.facts[0]).toEqual({ label: 'Per lo sviluppo di', value: 'GIA-DEMO-01 Giacca Demo · Prototipo, giro 1 (SR-2026-0003)' })
    expect(it.facts[1]).toEqual({ label: 'Pagamento', value: '30 gg' })
    expect(it.notices).toEqual(['the purchase order notice', SAMPLE_ORDER_WORDS.it.notice])
    expect(it.meta.title).toBe('Ordine di campionatura PO-00012')
    expect(it.meta.subject).toBe('PURCHASE_ORDER/1-SAMPLE it')
    const en = sampleOrderDocument(composed('en'), { style: STYLE, round: null })
    expect(en.title).toBe('Sample order')
    expect(en.facts[0]?.label).toBe('For the development of')
  })

  it('leaves a production order as it is', () => {
    const plain = composed('it')
    expect(sampleOrderDocument(plain, null)).toBe(plain)
    expect(() => sampleOrderDocument({ ...plain, type: 'DDT' }, { style: STYLE, round: null })).toThrow(/purchase order/)
  })
})
