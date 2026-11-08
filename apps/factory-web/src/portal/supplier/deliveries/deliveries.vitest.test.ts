import { describe, expect, it } from 'vitest'
import { NOTICE_STATES as DOMAIN_STATES, REASON_CODES, VERDICTS as DOMAIN_VERDICTS } from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { NOTICE_STATES, VERDICTS } from './api'
import { draftPage, HIDES, noticePage, noticesRead, ROWS, sheetRead, SHIPPABLE } from './design-data'
import {
  cancelHeld,
  chipsOf,
  hidesOfSheet,
  issueKeysOf,
  KNOWN_REASONS,
  lineProblemsOf,
  linesBody,
  linesChanged,
  linesDraftOf,
  linesHeld,
  noticeHref,
  noticesCsv,
  NS,
  reasonWords,
  rowHref,
  sendHeld,
  sendReasonsOf,
  shipLinesOf,
  termsBody,
  termsDraftOf,
  termsProblemsOf,
  writeHeld,
} from './model'

/**
 * SCR-227 (B-W2b-186), the pure rules: the API's codes all have words, a check's figures in the page's language, a sheet
 * row's problems from its columns, the lines and terms of the steps and why each waits, what holds the send, the cancel, the
 * list's chips and CSV. No price anywhere.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const FACTS = { mayWrite: true, preview: false, offline: false, busy: false }

describe('words for every code the API sends (B-W2b-182)', () => {
  it('knows every state, verdict and reason, in both languages', () => {
    expect([...NOTICE_STATES]).toEqual([...DOMAIN_STATES])
    expect([...VERDICTS]).toEqual([...DOMAIN_VERDICTS])
    expect([...KNOWN_REASONS]).toEqual([...REASON_CODES])
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale][NS] ?? {}
      for (const state of NOTICE_STATES) expect(words[`state.${state}`], `${locale} state.${state}`).toBeTypeOf('string')
      for (const verdict of VERDICTS) expect(words[`verdict.${verdict}`], `${locale} verdict.${verdict}`).toBeTypeOf('string')
      for (const code of REASON_CODES) expect(words[`reason.${code}`], `${locale} reason.${code}`).toBeTypeOf('string')
    }
  })

  it('says a reason from its code and figures, numbers and units in the page’s language', () => {
    const over = { code: 'OVER_ORDER', params: { shipping: '13500.5', before: '0', expected: '12000', upTo: '12600', pct: '5', uom: 'FT2' } }
    expect(reasonWords(over, t('it'), 'it')).toBe('13.500,5 ft² con 0 ft² già ricevuti o in viaggio: più dei 12.000 ft² ordinati (fino a 12.600 con la tolleranza del 5 %).')
    expect(reasonWords({ code: 'GRADE', params: { grade: 'B', asked: 'A' } }, t('en'), 'en')).toBe('Grade B: the order asks A.')
    expect(reasonWords({ code: 'SOMETHING_NEW', params: {} }, t('en'), 'en')).toMatch(/cannot word/)
  })
})

describe('the packing list sheet', () => {
  it('says why a row does not read from its column, a hide listed twice with the other row', () => {
    const rows = hidesOfSheet(sheetRead(true))
    const area = rows.find((row) => row.row === 14)!
    expect(area.verdict).toBeNull()
    expect(area.problems).toEqual([{ key: 'sheetRow.area' }])
    const twice = rows.find((row) => row.row === 15)!
    expect(twice.problems).toEqual([{ key: 'sheetRow.twice', params: { hide: '2231-002', other: 3 } }])
    expect(rows.filter((row) => row.verdict === 'NOT_AS_ORDERED').map((row) => row.hideNumber)).toEqual(['2231-017', '2231-006'])
  })
})

describe('1 · what you ship', () => {
  const choices = SHIPPABLE.orders[0]!.lines
  it('a new notice ships every open line in full, typed in the page’s language', () => {
    const lines = shipLinesOf({ choices })
    expect(lines.map((line) => line.seq)).toEqual([10, 20])
    const draft = linesDraftOf(lines, null, 'it')
    expect(Object.values(draft).map((line) => [line.include, line.quantity])).toEqual([
      [true, '1200'],
      [true, '300'],
    ])
    expect(linesBody(lines, draft, 'it').map((line) => line.quantity)).toEqual(['1200', '300'])
  })

  it('a notice starts from its own lines; an order line it does not carry stays off', () => {
    const page = draftPage({ leather: false })
    const lines = shipLinesOf({ choices, notice: page.notice, addable: [choices[0]!] })
    const draft = linesDraftOf(lines, page.notice, 'en')
    expect(draft[choices[0]!.purchaseOrderLineId]!.include).toBe(false)
    expect(draft[choices[1]!.purchaseOrderLineId]).toMatchObject({ include: true, quantity: '150' })
    expect(linesChanged(linesBody(lines, draft, 'en'), page.notice)).toBe(false)
    const more = { ...draft, [choices[0]!.purchaseOrderLineId]: { ...draft[choices[0]!.purchaseOrderLineId]!, include: true } }
    expect(linesChanged(linesBody(lines, more, 'en'), page.notice)).toBe(true)
  })

  it('holds Next with the reason: no line, a quantity that does not read, a preview first', () => {
    const lines = shipLinesOf({ choices })
    const draft = linesDraftOf(lines, null, 'it')
    const id = lines[1]!.id
    expect(lineProblemsOf({ ...draft, [id]: { ...draft[id]!, quantity: '12,4,5' } }, 'it')).toEqual({ [id]: 'lines.problem.number' })
    expect(lineProblemsOf({ ...draft, [id]: { ...draft[id]!, quantity: '0' } }, 'it')).toEqual({ [id]: 'lines.problem.zero' })
    expect(lineProblemsOf({ ...draft, [id]: { ...draft[id]!, quantity: ' ' } }, 'it')).toEqual({ [id]: 'lines.problem.empty' })
    expect(linesHeld(Object.fromEntries(Object.entries(draft).map(([key, line]) => [key, { ...line, include: false }])), 'it', FACTS)).toBe('held.noLine')
    expect(linesHeld(draft, 'it', { ...FACTS, preview: true, mayWrite: false })).toBe('held.preview')
    expect(linesHeld(draft, 'it', { ...FACTS, mayWrite: false })).toBe('held.mayWrite')
    expect(linesHeld(draft, 'it', FACTS)).toBeNull()
  })
})

describe('3 · transport and papers', () => {
  it('says what is wrong with the terms and sends blanks as null', () => {
    const draft = { ...termsDraftOf(null), shipDate: '2026-11-10', expectedDate: '2026-11-09', ddtDate: '2026-11-08', parcels: '0' }
    expect(termsProblemsOf(draft)).toEqual({ expectedDate: 'terms.problem.order', ddtDate: 'terms.problem.ddtDate', parcels: 'terms.problem.parcels' })
    expect(termsBody({ ...termsDraftOf(null), parcels: '3', carrier: '  ' })).toMatchObject({ parcels: 3, carrier: null, shipDate: null })
  })
})

describe('4 · review and send', () => {
  it('names what holds the send in its own words, counting the documents the API names', () => {
    const page = { ...draftPage(), sendHeld: ['…', '…', 'A test report is needed before sent: none is on file.'] }
    expect(sendReasonsOf(page, '')).toEqual([{ key: 'send.noShipDate' }, { key: 'send.noExpected' }, { key: 'send.documents', params: { count: 1 } }])
    expect(sendHeld(page, '', FACTS)).toBe('held.send')
  })

  it('something not as ordered goes only with a note', () => {
    const page = { ...draftPage({ hides: HIDES, terms: true }), sendHeld: [] }
    expect(page.notice.verdict).toBe('NOT_AS_ORDERED')
    expect(sendReasonsOf(page, '')).toEqual([{ key: 'send.needNote' }])
    expect(sendHeld(page, 'Due pelli fuori scelta: decidete voi.', FACTS)).toBeNull()
    expect(sendHeld(noticePage(), 'x', FACTS)).toBe('held.sent')
  })
})

describe('refusals, cancel, the list', () => {
  it('says a refusal from its issue paths', () => {
    expect(issueKeysOf([{ path: 'body/shipDate' }, { path: 'body/lines/0/quantity' }, { path: 'body/headers/area' }, { path: 'body/note' }, { path: 'x' }])).toEqual(['issue.shipDate', 'issue.lines', 'issue.headers', 'issue.note', 'issue.other'])
  })

  it('a sent notice is cancelled with a reason; a draft is discarded without one', () => {
    const sent = { id: 'a', number: 'ASN-1', status: 'SENT', version: 1, orderNumber: 'PO-1' }
    expect(cancelHeld(sent, ' ', FACTS)).toBe('cancel.held.reason')
    expect(cancelHeld(sent, 'Camion annullato', FACTS)).toBeNull()
    expect(cancelHeld({ ...sent, status: 'DRAFT' }, '', FACTS)).toBeNull()
    expect(cancelHeld({ ...sent, status: 'RECEIVED' }, 'x', FACTS)).toBe('held.closed')
    expect(writeHeld({ ...FACTS, offline: true })).toBe('held.offline')
  })

  it('chips count every state that has notices; a draft opens at its steps', () => {
    expect(chipsOf(noticesRead(), null).map((chip) => [chip.state, chip.count])).toEqual([
      [null, 6],
      ['DRAFT', 1],
      ['ANNOUNCED', 1],
      ['IN_TRANSIT', 1],
      ['RECEIVED', 1],
      ['RECEIVED_WITH_DIFFERENCES', 1],
      ['CANCELLED', 1],
    ])
    expect(rowHref('/p/X', ROWS[0]!)).toBe(noticeHref('/p/X', ROWS[0]!.id, 'lines'))
    expect(rowHref('/p/X', ROWS[1]!)).toBe(`/p/X/deliveries/${ROWS[1]!.id}`)
  })

  it('exports a view as CSV with the header in the person’s language and no price', () => {
    const csv = noticesCsv(ROWS.slice(1, 2), t('it'))
    expect(csv.split('\r\n')[0]).toBe('Avviso di spedizione,Ordine,Il tuo riferimento,Parte il,Arriva il,Vettore,Numero di tracking,Il tuo DDT,Righe,Pelli,Stato')
    expect(csv).toContain('ASN-2026-0014,PO-2026-0101')
    expect(csv).toContain('In viaggio')
    expect(csv).not.toMatch(/€|price|prezzo/i)
  })
})
