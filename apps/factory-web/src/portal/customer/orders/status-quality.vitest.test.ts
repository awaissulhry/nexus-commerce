import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { productionQualitySchema, type FinalInspection, type ProductionOrder, type ProductionQuality } from '../production/api'
import { anyTakenBack, checkPiecesText, FINAL_STATE_TONE, finalLinesText, photoStepHeld, qualityLinesOf, qualityNothing, qualityShared, reportNamesOf, waitingHrefOf } from '../production/model'
import type { OrderRecord } from './api'
import { at, dayAt, documentsRead, ORDER_ID, orderRecord, progressRead, requestsOf, shipmentsRead } from './design-data'
import type { OrderRecordActions, OrderRecordViewModel } from './view/OrderRecordView'
import { StatusTab } from './view/StatusTab'

/**
 * F-PR-12c — the portal order › Status & progress, part 3: + Quality & photos (production plan §4 "first piece, in-line, final
 * results and photos of its own goods — single-brand work orders only"; 06-tree P-ORD-quality; wall PW-P04). At the level Quality
 * & photos only (a lower level asks no read and draws nothing): per line and size the pieces released by quality and taken back
 * since, a line partly made on shared work said in the API's words; first-piece, cutting and end-of-line checks; each final
 * inspection with its lines, result, sampling, defects and "Open the report" when the factory issued one; what held its goods;
 * the photos shared on its order. Never the inspection's own number, a work order, an inspector, a worker, a line or a note.
 * Italian portal words speak to the customer as "voi". Brand Beta reads; nothing of Brand Alpha is ever drawn. Made-up data.
 */

const PREFIX = `/p/${BRAND_BETA.code}`
const w = (en: string, it = en) => ({ it, en })
const TU_FORM = /\b(tu|tuo|tua|tuoi|tue|te|ti)\b/i
const STYLE = { code: BRAND_BETA.numbers.style, name: 'Beta touring jacket' }
const BLACK = { code: 'BLK', name: 'Nero' }
const SAND = { code: 'SND', name: 'Sabbia' }

function production(over: Partial<ProductionOrder> = {}): ProductionOrder {
  const progress = progressRead()
  return {
    asOf: at(0),
    level: 'QUALITY',
    levelWords: w('+ Quality & photos', '+ Qualità e foto'),
    urgencyOn: false,
    urgentUse: null,
    order: { id: ORDER_ID, customerRef: BRAND_BETA.customerRef, number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), orderedOn: dayAt(-20), promiseDate: dayAt(10), originalPromiseDate: dayAt(10), promiseMoved: false },
    inProduction: true,
    stage: { code: 'QUALITY', words: w('Quality check', 'Controllo qualità'), since: dayAt(-1), next: { code: 'READY', words: w('Ready to ship', 'Pronto per la spedizione') }, ahead: 0, aheadWords: null, sewingNotCounted: false, sewingNotCountedWords: null },
    health: { code: 'ON_TRACK', words: w('On track', 'In linea'), reason: null },
    waiting: { code: 'US', words: w('Waiting on us', 'Tocca a noi'), since: null },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    holds: [],
    urgency: null,
    promiseHistory: [],
    progress: { asOf: progress.asOf, refreshSeconds: 60, lines: progress.lines, whole: progress.whole, percent: progress.percent },
    gates: null,
    live: { events: ['brand_production.stage_reached'] },
    ...over,
  }
}

function finalOf(over: Partial<FinalInspection> = {}): FinalInspection {
  return {
    inspectionId: 'b2b2b2b2-0000-4000-8000-000000000301',
    state: 'PASSED',
    stateWords: w('Passed', 'Superato'),
    decidedOn: dayAt(-1),
    lines: [1, 2],
    sampling: { garments: 200, sample: 32, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 2, acceptMinor: 3 },
    defects: {
      critical: 0,
      major: 1,
      minor: 2,
      found: [
        { defectClass: 'MAJOR', classWords: w('Major', 'Maggiore'), code: 'SEAM-OPEN', words: w('Open seam', 'Cucitura aperta'), garments: 1 },
        { defectClass: 'MINOR', classWords: w('Minor', 'Minore'), code: 'THREAD-LOOSE', words: null, garments: 2 },
      ],
    },
    report: { madeOn: dayAt(-1) },
    ...over,
  }
}

function quality(over: Partial<ProductionQuality> = {}): ProductionQuality {
  return {
    asOf: at(0),
    level: 'QUALITY',
    lines: [
      {
        lineId: 'b2b2b2b2-0000-4000-8000-000000000211',
        seq: 1,
        style: STYLE,
        colourway: BLACK,
        ordered: 30,
        released: 24,
        reversed: 2,
        sizes: [
          { size: '48', ordered: 10, released: 10, reversed: 0 },
          { size: '50', ordered: 12, released: 10, reversed: 2 },
          { size: '52', ordered: 8, released: 4, reversed: 0 },
        ],
        sharedWork: false,
        sharedWorkWords: null,
      },
      {
        lineId: 'b2b2b2b2-0000-4000-8000-000000000212',
        seq: 2,
        style: { code: 'BX-210', name: 'Beta trousers' },
        colourway: SAND,
        ordered: 16,
        released: 0,
        reversed: 0,
        sizes: [{ size: null, ordered: 16, released: 0, reversed: 0 }],
        sharedWork: true,
        sharedWorkWords: w('Inspection results are shared only for work made for you alone.', 'I risultati dei controlli si condividono solo per la produzione fatta interamente per voi.'),
      },
    ],
    finals: [
      finalOf(),
      finalOf({ inspectionId: 'b2b2b2b2-0000-4000-8000-000000000302', state: 'FAILED', stateWords: w('Failed', 'Non superato'), lines: [1], defects: { critical: 1, major: 0, minor: 0, found: [] }, report: null }),
      finalOf({ inspectionId: 'b2b2b2b2-0000-4000-8000-000000000303', state: 'WAITING', stateWords: w('Waiting', 'In attesa'), decidedOn: null, lines: [1], defects: null, report: null }),
    ],
    checks: [
      { kind: 'FIRST_PIECE', words: w('First piece', 'Primo capo'), state: 'PASSED', stateWords: w('Passed', 'Superato'), countWords: w('3 passed · 1 failed', '3 superati · 1 non superato'), pieces: 40, defectivePieces: 2, lastOn: dayAt(-4) },
      { kind: 'END_OF_LINE', words: w('End-of-line check', 'Controllo a fine linea'), state: 'WAITING', stateWords: w('Waiting', 'In attesa'), countWords: w('1 waiting', '1 in attesa'), pieces: 0, defectivePieces: 0, lastOn: null },
    ],
    holds: [
      { kind: 'QUALITY', words: w('Measurements out of tolerance', 'Misure fuori tolleranza'), since: dayAt(-6), until: dayAt(-5), active: false, stateWords: w('Ended', 'Concluso') },
      { kind: 'PRODUCTION', words: w('Material on its way', 'Materiale in arrivo'), since: dayAt(-2), until: null, active: true, stateWords: w('Active', 'In corso') },
    ],
    photos: [
      { id: 'b2b2b2b2-0000-4000-8000-000000000401', name: 'BX-200 first piece front.jpg', contentType: 'image/jpeg', sizeBytes: 420_000, sharedOn: dayAt(-3) },
      { id: 'b2b2b2b2-0000-4000-8000-000000000402', name: 'BX-200 label detail.jpg', contentType: 'image/jpeg', sizeBytes: 310_000, sharedOn: dayAt(-2) },
    ],
    live: { events: ['brand_production.stage_reached', 'brand_production.hold_changed'] },
    ...over,
  }
}

function betaRecord(): OrderRecord {
  // The design record ships to another made-up customer: Brand Beta's own address here (the tab draws the ship-to).
  return orderRecord({ number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), customerRef: BRAND_BETA.customerRef, status: 'IN_PRODUCTION', shipTo: { name: `${BRAND_BETA.legalName} — Lager`, line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, country: BRAND_BETA.address.country } })
}

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
    waitingHref: waitingHrefOf(PREFIX),
    quality: { state: 'ready', read: quality() },
    ...over,
  }
}

const ACTIONS: OrderRecordActions = { onAsk: () => undefined, onRetryProduction: () => undefined, onRetryQuality: () => undefined, onReport: () => undefined, onPhoto: () => undefined }
const draw = (over: Partial<OrderRecordViewModel> = {}, locale: Locale = 'en') => {
  const record = betaRecord()
  return render(createElement(StatusTab, { model: model(record, over), record, actions: ACTIONS }), locale)
}
const withQuality = (read: ProductionQuality): Partial<OrderRecordViewModel> => ({ quality: { state: 'ready', read } })

describe('+ Quality & photos on the order’s Status & progress (F-PR-12c, level Quality & photos only)', () => {
  it('a section not shared is not drawn: hidden or absent quality draws nothing; no production read, no quality', () => {
    for (const over of [{ quality: { state: 'hidden' as const, read: null } }, { quality: undefined }, { production: { state: 'hidden' as const, read: null } }]) {
      const text = textOf(draw(over))
      for (const words of ['Quality and photos', 'Released by quality', 'Final inspection', 'Open the report']) expect(text).not.toContain(words)
    }
    expect(textOf(draw())).toContain('Quality and photos')
  })

  it('released by quality: per line the pieces of its own cells released and taken back, per size behind "Per size"', () => {
    const text = textOf(draw())
    expect(text).toContain('Released by quality')
    expect(text).toContain(`Line 1 · ${STYLE.code} Nero`)
    expect(text).toContain('Line 2 · BX-210 Sabbia')
    for (const head of ['Ordered', 'Released', 'Taken back']) expect(text).toContain(head)
    // Taken back said once, as the column's meaning, because some were.
    expect(text).toContain('Taken back: pieces released earlier that we took back to check again.')
    expect(textOf(draw(withQuality(quality({ lines: quality().lines.map((line) => ({ ...line, reversed: 0, sizes: line.sizes.map((size) => ({ ...size, reversed: 0 })) })) }))))).not.toContain('Taken back: pieces')
    // Per size only for a line of several sizes.
    expect(text).toContain(`Line 1 · ${STYLE.code} Nero: per size`)
    expect(text).not.toContain('Line 2 · BX-210 Sabbia: per size')
  })

  it('a line partly made on shared work says, in the API’s words, that its results are not shared', () => {
    expect(textOf(draw())).toContain('Line 2 · BX-210 Sabbia: Inspection results are shared only for work made for you alone.')
    expect(textOf(draw({}, 'it'))).toContain('Riga 2 · BX-210 Sabbia: I risultati dei controlli si condividono solo per la produzione fatta interamente per voi.')
  })

  it('checks during production: the last result, the count, the pieces with a defect, the day; a waiting check reads waiting', () => {
    const text = textOf(draw())
    expect(text).toContain('Checks during production')
    expect(text).toContain('First piece')
    expect(text).toContain('3 passed · 1 failed')
    expect(text).toContain('2 of 40 pieces with a defect')
    expect(text).toContain('End-of-line check')
    expect(text).toContain('1 waiting')
    // No check of its alone work: no part.
    expect(textOf(draw(withQuality(quality({ checks: [] }))))).not.toContain('Checks during production')
  })

  it('final inspection: lines, result and day, the sampling over its own garments, the defects, the report when issued', () => {
    const html = draw()
    const text = textOf(html)
    expect(text).toContain('Final inspection')
    expect(text).toContain('Lines 1, 2')
    expect(text).toContain('Line 1')
    for (const words of ['Passed', 'Failed', 'Waiting', 'Decided on', '32 of 200 garments', 'Inspection level', 'Major 2.5: up to 2 · Minor 4.0: up to 3']) expect(text).toContain(words)
    expect(text).toContain('Critical 0 · Major 1 · Minor 2')
    // Each defect found: the library's words, else its code.
    expect(text).toContain('Open seam')
    expect(text).toContain('THREAD-LOOSE')
    // One report issued: one "Open the report"; decided without one: said; being recorded: the result comes later.
    expect(text.match(/Open the report/g)?.length ?? 0).toBe(1)
    expect(text).toContain('No report has been issued for this inspection yet.')
    expect(text).toContain('Being checked: the result comes once it is decided.')
    // No final of its alone work: no part.
    expect(textOf(draw(withQuality(quality({ finals: [] }))))).not.toContain('Final inspection')
  })

  it('holds by reason in our words, active or ended, with since and until (never a note, never who)', () => {
    const text = textOf(draw())
    expect(text).toContain('Holds')
    expect(text).toContain('Measurements out of tolerance')
    expect(text).toContain('Ended')
    expect(text).toContain('Material on its way')
    expect(text).toContain('Active')
  })

  it('photos shared on its order: one row each with the day, opened one at a time; files held in a preview or offline', () => {
    const html = draw()
    const text = textOf(html)
    expect(text).toContain('Photos')
    expect(text).toContain('BX-200 first piece front.jpg')
    expect(text).toContain('BX-200 label detail.jpg')
    expect(text).toContain('Shared on')
    expect(text).toContain('View')
    const held = draw({ fileHeld: CATALOGUE.en['portal-orders']!['held.previewFiles']! })
    expect(held).toContain(`aria-description="${CATALOGUE.en['portal-orders']!['held.previewFiles']!}"`)
    expect(textOf(draw(withQuality(quality({ photos: [] }))))).not.toContain('BX-200 first piece front.jpg')
  })

  it('nothing checked yet: one line; being read: a placeholder; a failed read says so with Try again, keeping what was read', () => {
    const empty = quality({ lines: quality().lines.map((line) => ({ ...line, released: 0, reversed: 0, sizes: line.sizes.map((size) => ({ ...size, released: 0, reversed: 0 })) })), finals: [], checks: [], holds: [], photos: [] })
    const none = textOf(draw(withQuality(empty)))
    expect(none).toContain('Nothing on this order has been checked by quality yet.')
    expect(none).not.toContain('Released by quality')
    expect(draw({ quality: { state: 'loading', read: null } })).toContain('aria-busy="true" aria-label="Quality of this order"')
    const failed = textOf(draw({ quality: { state: 'error', read: null } }))
    expect(failed).toContain('Could not load the quality of this order')
    expect(failed).toContain('Try again')
    const kept = textOf(draw({ quality: { state: 'error', read: quality() } }))
    expect(kept).toContain('Could not load the quality of this order')
    expect(kept).toContain('Released by quality')
  })

  it('read again with the order’s production, said as such (not "Live": nothing is pushed); offline says since when', () => {
    // + Progress says it already; the quality card says it once more for its own figures.
    const times = (text: string, words: string) => text.split(words).length - 1
    expect(times(textOf(draw()), 'refreshes every minute')).toBe(times(textOf(draw({ quality: undefined })), 'refreshes every minute') + 1)
    expect(times(textOf(draw({ offlineSince: at(0) })), 'Offline · as of')).toBe(times(textOf(draw({ offlineSince: at(0), quality: undefined })), 'Offline · as of') + 1)
    expect(textOf(draw())).not.toContain('Live ·')
  })

  it('Italian: the same parts in Italian words, and the customer is "voi" (never "tu")', () => {
    const text = textOf(draw({}, 'it'))
    for (const words of ['Qualità e foto', 'Rilasciati dal controllo qualità', 'Ripresi', 'Controlli durante la produzione', 'Ispezione finale', 'Righe 1, 2', 'Aprite il rapporto', 'Blocchi', 'Foto', 'Condivisa il']) expect(text).toContain(words)
    const mine = Object.entries(CATALOGUE.it['portal-orders']!).filter(([key]) => key.startsWith('production.quality.'))
    expect(mine.length).toBeGreaterThan(50)
    for (const [key, value] of mine) expect(value, key).not.toMatch(TU_FORM)
  })

  it('PW-P04 (screen): Brand Beta’s quality holds nothing of Brand Alpha, never the office’s SO- or INS- series, a work order or a person of ours', () => {
    // The API's answer as it could come, with what the web must never keep: the inspection's own number, a work order, an
    // inspector, a releaser, a lot, a production line, a note.
    const raw = quality()
    const answer = {
      ...raw,
      order: { id: ORDER_ID, customerRef: BRAND_BETA.customerRef, number: BRAND_BETA.numbers.order, yourNumber: null },
      finals: raw.finals.map((final) => ({ ...final, number: 'INS-2026-0412', workOrderNumber: 'WO-2026-0077', inspector: 'Ivo Ispettore', report: final.report ? { ...final.report, version: 2, language: 'it' } : null })),
      lines: raw.lines.map((line) => ({ ...line, workOrderId: 'wo-1', lotSize: 400 })),
      holds: raw.holds.map((hold) => ({ ...hold, code: 'MEASURE', note: 'office words only', placedBy: 'Paola Planner' })),
      checks: raw.checks.map((check) => ({ ...check, passed: 3, failed: 1, waiting: 0, operator: 'Olga Operaia', productionLineId: 'line-2' })),
    }
    const parsed = productionQualitySchema.parse(answer)
    for (const locale of ['it', 'en'] as const) {
      const html = draw(withQuality(parsed), locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(/\b(SO|INS|WO)-\d{4}-\d+/)?.[0] ?? null, locale).toBeNull()
      for (const words of ['Ivo Ispettore', 'Paola Planner', 'Olga Operaia', 'office words only', 'line-2']) expect(textOf(html), `${locale} ${words}`).not.toContain(words)
    }
  })

  it('PW-P04 (web): a key the API never sends — a work order, an inspector, a lot, a note, the inspection’s number — is never kept', () => {
    const raw = quality()
    const answer = {
      ...raw,
      otherParty: BRAND_ALPHA.code,
      finals: raw.finals.map((final) => ({ ...final, number: 'INS-2026-0412', workOrderId: 'wo-1', inspector: 'Ivo Ispettore' })),
      lines: raw.lines.map((line) => ({ ...line, workOrderId: 'wo-1', lotSize: 400, cellIds: ['c-1'] })),
      holds: raw.holds.map((hold) => ({ ...hold, code: 'MEASURE', note: 'office words only', placedBy: 'Paola Planner' })),
      photos: raw.photos.map((photo) => ({ ...photo, sourceFileId: 'f-1', recordType: 'WorkOrder', recordId: 'wo-1' })),
    }
    const keys = JSON.stringify(productionQualitySchema.parse(answer))
    for (const key of ['otherParty', '"number"', 'workOrderId', 'inspector', 'lotSize', 'cellIds', '"code":"MEASURE"', '"note"', 'placedBy', 'sourceFileId', 'recordType', 'recordId', BRAND_ALPHA.code]) expect(keys, key).not.toContain(key)
    // A defect keeps its library code (the customer's words when the library has none); that is not a hold's code.
    expect(keys).toContain('THREAD-LOOSE')
  })
})

describe('the rules behind it (production/model, F-PR-12c block)', () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) => {
    const words = CATALOGUE.en['portal-orders']!
    const count = params?.count
    const text = words[key] ?? (typeof count === 'number' ? (words[`${key}_${count === 1 ? 'one' : 'other'}`] ?? words[`${key}_other`]) : undefined) ?? key
    return Object.entries(params ?? {}).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), text)
  }
  const day = (iso: string) => `day ${iso}`

  it('qualityShared: only the level Quality & photos asks the read', () => {
    expect(qualityShared(production())).toBe(true)
    for (const level of ['STATUS', 'PROGRESS', 'GATES'] as const) expect(qualityShared(production({ level })), level).toBe(false)
    expect(qualityShared(null)).toBe(false)
    expect(qualityShared(undefined)).toBe(false)
  })

  it('qualityLinesOf: the line’s own words, a size-less line under its own word, the shared words only on a shared line', () => {
    const rows = qualityLinesOf(quality(), 'en', t)
    expect(rows.map((row) => row.label)).toEqual([`Line 1 · ${STYLE.code} Nero`, 'Line 2 · BX-210 Sabbia'])
    expect(rows[0]!.sizes.map((size) => size.size)).toEqual(['48', '50', '52'])
    expect(rows[1]!.sizes[0]!.size).toBe('Made to measure')
    expect(rows[0]!.shared).toBeNull()
    expect(rows[1]!.shared).toBe('Inspection results are shared only for work made for you alone.')
    expect(qualityLinesOf(quality(), 'it', t)[1]!.shared).toContain('interamente per voi')
  })

  it('qualityNothing and anyTakenBack', () => {
    expect(qualityNothing(quality())).toBe(false)
    const zero = quality().lines.map((line) => ({ ...line, released: 0, reversed: 0 }))
    expect(qualityNothing(quality({ lines: zero, finals: [], checks: [], holds: [], photos: [] }))).toBe(true)
    expect(qualityNothing(quality({ lines: zero, finals: [], checks: [], holds: [] }))).toBe(false)
    expect(anyTakenBack(quality())).toBe(true)
    expect(anyTakenBack(quality({ lines: zero }))).toBe(false)
  })

  it('finalLinesText, reportNamesOf: our words and the day, never the office’s number of the inspection', () => {
    expect(finalLinesText(finalOf(), t)).toBe('Lines 1, 2')
    expect(finalLinesText(finalOf({ lines: [1] }), t)).toBe('Line 1')
    expect(finalLinesText(finalOf({ lines: [] }), t)).toBe('This order')
    const named = reportNamesOf(finalOf(), day, t)
    expect(named.title).toBe(`Inspection report · Lines 1, 2 · day ${dayAt(-1)}`)
    expect(named.fileName).toBe(`Inspection report ${dayAt(-1)}.pdf`)
    expect(JSON.stringify(named)).not.toMatch(/INS-|WO-/)
    expect(reportNamesOf(finalOf({ decidedOn: null, report: null }), day, t)).toEqual({ title: 'Inspection report · Lines 1, 2', fileName: 'Inspection report.pdf' })
  })

  it('checkPiecesText, FINAL_STATE_TONE, photoStepHeld', () => {
    expect(checkPiecesText({ pieces: 40, defectivePieces: 2 }, t)).toBe('2 of 40 pieces with a defect')
    expect(checkPiecesText({ pieces: 1, defectivePieces: 0 }, t)).toBe('0 of 1 piece with a defect')
    expect(checkPiecesText({ pieces: 0, defectivePieces: 0 }, t)).toBeNull()
    expect(FINAL_STATE_TONE).toEqual({ PASSED: 'success', FAILED: 'danger', WAITING: 'neutral' })
    expect(photoStepHeld(0, 1, 1, t)).toBe('This is the only photo.')
    expect(photoStepHeld(0, 3, -1, t)).toBe('This is the first photo.')
    expect(photoStepHeld(2, 3, 1, t)).toBe('This is the last photo.')
    expect(photoStepHeld(1, 3, 1, t)).toBeNull()
    expect(photoStepHeld(1, 3, -1, t)).toBeNull()
  })

  it('the F-PR-12c words exist in both languages, with the same keys', () => {
    const keys = (locale: 'it' | 'en') => Object.keys(CATALOGUE[locale]['portal-orders']!).filter((key) => key.startsWith('production.quality.')).sort()
    expect(keys('it')).toEqual(keys('en'))
    for (const key of ['production.quality.title', 'production.quality.finals.openReport', 'production.quality.finals.reportMissing', 'production.quality.photos.gone', 'production.quality.checks.pieces_one', 'production.quality.finals.lines_other']) expect(keys('en')).toContain(key)
  })
})
