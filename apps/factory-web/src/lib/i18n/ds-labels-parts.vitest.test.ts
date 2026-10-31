import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FILE_ROW_LABELS, FileRow } from '@nexus/ui/components'
import { SAVE_STATUS_LABELS, SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { SELECTABLE_CARD_LABELS, SelectableCard } from '@nexus/ui/components/SelectableCard/index'
import { RECORD_NAV_LABELS } from '@nexus/ui/patterns/record-nav/index'
import { CHECK_LIST_LABELS, CheckList } from '@nexus/ui/patterns/checklist/index'
import { TRACE_TREE_LABELS } from '@nexus/ui/patterns/trace-tree/index'
import { PRINT_VIEW_LABELS } from '@nexus/ui/patterns/print-view/index'
import { MARGIN_METER_LABELS, MarginMeter } from '@nexus/ui/charts/margin-meter/index'
import { WATERFALL_LABELS } from '@nexus/ui/charts/waterfall/index'
import { BAR_LIST_LABELS } from '@nexus/ui/charts/bar-list/index'
import { CARD_LIST_LABELS } from '@nexus/ui/grid/card-list/index'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-09 — the shared parts' words in the `ds-words` catalogue (the B-W2b-04 rule for the new parts): every word in
 * both languages, the English is the DS's own English, the Italian differs where the words differ, and it reaches the
 * parts. `recordNav` is `detail`'s words (one Prev / Next rule).
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part = 'fileRow' | 'saveStatus' | 'recordNav' | 'checkList' | 'traceTree' | 'printView' | 'marginMeter' | 'waterfall' | 'barList' | 'selectableCard' | 'cardList'
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['fileRow', FILE_ROW_LABELS], ['saveStatus', SAVE_STATUS_LABELS], ['recordNav', RECORD_NAV_LABELS], ['checkList', CHECK_LIST_LABELS],
  ['traceTree', TRACE_TREE_LABELS], ['printView', PRINT_VIEW_LABELS], ['marginMeter', MARGIN_METER_LABELS], ['waterfall', WATERFALL_LABELS],
  ['barList', BAR_LIST_LABELS], ['selectableCard', SELECTABLE_CARD_LABELS], ['cardList', CARD_LIST_LABELS],
]

/** Arguments for each word function: every branch (one / many, true / false). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'saveStatus.savedAt': [['10:42']], 'saveStatus.failed': [[1], [3]], 'saveStatus.unsavedCount': [[1], [2]], 'saveStatus.offlineCount': [[1], [4]],
  'recordNav.position': [[3, 12]], 'recordNav.first': [['order', false], ['order', true]], 'recordNav.last': [['order', false], ['order', true]],
  'checkList.allPass': [[1], [7]], 'checkList.open': [[1, 1], [1, 5], [2, 7]], 'checkList.button': [['Release', 1], ['Release', 2]],
  'checkList.held': [[1, 'Lot released'], [2, 'Lot released, Certificate valid']], 'checkList.join': [[['A', 'B']]],
  'traceTree.possibleCount': [[1], [3]], 'traceTree.selected': [[1], [12]],
  'printView.printedBy': [['Demo Person', '31 Oct 2026, 10:42']], 'printView.printedOn': [['31 Oct 2026, 10:42']],
  'printView.filters': [['Status: Open']], 'printView.filter': [['Status', 'Open']],
  'marginMeter.underFloor': [['18.2 %', '20.0 %']], 'marginMeter.underTarget': [['24.0 %', '30.0 %']], 'marginMeter.onTarget': [['31.5 %', '30.0 %']],
  'marginMeter.overFloor': [['22.0 %', '20.0 %']], 'marginMeter.plain': [['22.0 %']], 'marginMeter.floorMark': [['20.0 %']], 'marginMeter.targetMark': [['30.0 %']],
  'waterfall.up': [['€6.00']], 'waterfall.down': [['€4.50']], 'waterfall.stepName': [['Options', '+ €6.00', '€58.00']], 'waterfall.totalName': [['Net', '€53.50']],
  'waterfall.open': [['Quantity break']],
  'barList.parts': [[[{ label: '0–30 days', value: '€8,000' }, { label: '31–60 days', value: '€4,400' }]]], 'barList.pick': [['Rossi', '18.2 %']],
  'cardList.selected': [[1], [3]], 'cardList.selectOne': [['SO-0001']], 'cardList.ascending': [['Total']], 'cardList.descending': [['Total']],
}
const samplesFor = (key: string, fn: (...args: never[]) => unknown) => SAMPLES[key] ?? (fn.length >= 2 ? [['Status', 'Size']] : [['Status']])

function* pairs(prefix: string, def: object, mine: object): Generator<[string, unknown, unknown]> {
  for (const [key, value] of Object.entries(def)) {
    const path = `${prefix}.${key}`
    const own = (mine as Record<string, unknown>)?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) yield* pairs(path, value, own as object)
    else yield [path, value, own]
  }
}

describe('the B-W2b-09 parts’ words in the ds-words catalogue', () => {
  it('every word has a word in each language (nothing falls back to the DS English, no key leaks)', () => {
    for (const labels of [IT, EN]) for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, labels[part])) {
        expect(own, `${path} is missing`).toBeDefined()
        expect(typeof own, path).toBe(typeof value)
        if (typeof own === 'function') for (const args of samplesFor(path, own as never)) expect(String((own as (...a: unknown[]) => unknown)(...args)), path).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/)
        else if (typeof own === 'string') expect(own, path).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/)
      }
    }
  })

  it('the English catalogue says exactly the DS English', () => {
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, EN[part])) {
        if (typeof value === 'function') {
          for (const args of samplesFor(path, value as never)) {
            expect((own as (...a: unknown[]) => unknown)(...args), `${path}(${JSON.stringify(args)})`).toBe((value as (...a: unknown[]) => unknown)(...args))
          }
        } else {
          expect(own, path).toEqual(value)
        }
      }
    }
  })

  it('the Italian differs from the English wherever the words differ', () => {
    // Words that are the same in both languages: a sign, a dash, a placeholder alone, a separator, "Offline".
    const same = new Set(['saveStatus.offline', 'checkList.join', 'printView.join', 'printView.filter', 'marginMeter.plain', 'barList.unknown', 'cardList.ascending', 'cardList.descending', 'waterfall.up', 'waterfall.down', 'waterfall.totalName', 'barList.parts'])
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, IT[part])) {
        if (same.has(path)) continue
        if (typeof value === 'string') expect(own, path).not.toBe(value)
        if (typeof value === 'function') {
          const en = [...pairs(part, def, EN[part])].find(([p]) => p === path)![2] as (...a: unknown[]) => unknown
          for (const args of samplesFor(path, value as never)) expect((own as (...a: unknown[]) => unknown)(...args), `${path}(${JSON.stringify(args)})`).not.toBe(en(...args))
        }
      }
    }
    expect(IT.saveStatus.failed(1)).toBe('1 modifica non salvata')
    expect(IT.saveStatus.failed(3)).toBe('3 modifiche non salvate')
    expect(IT.checkList.button('Rilascia', 2)).toBe('Rilascia · 2 controlli aperti')
    expect(IT.checkList.open(1, 5)).toBe('1 controllo aperto su 5')
    expect(IT.checkList.open(3, 5)).toBe('3 controlli aperti su 5')
    expect(IT.recordNav.previous('ordine')).toBe('ordine precedente')
    expect(IT.recordNav.position(53, 56)).toBe('53 di 56')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const html = [
      renderToStaticMarkup(createElement(FileRow, { name: 'ddt.pdf', onReplace: () => {}, onRemove: () => {}, labels: IT.fileRow })),
      renderToStaticMarkup(createElement(SaveStatus, { state: { kind: 'failed', count: 2 }, onRetry: () => {}, labels: IT.saveStatus })),
      renderToStaticMarkup(createElement(SelectableCard, { title: 'L1', selected: true, onSelect: () => {}, labels: IT.selectableCard })),
      renderToStaticMarkup(createElement(CheckList, { label: 'Prima del rilascio', checks: [{ id: 'a', state: 'fail', name: 'Lotto rilasciato' }], labels: IT.checkList })),
      renderToStaticMarkup(createElement(MarginMeter, { value: 18.2, floor: 20, locale: 'it', labels: IT.marginMeter })),
    ].join('')
    for (const word of ['Sostituisci file', 'Rimuovi file', '2 modifiche non salvate', 'Riprova', 'Selezionata', 'Il controllo è aperto', 'Aperto', 'sotto il minimo del 20,0']) expect(html).toContain(word)
    expect(html).not.toMatch(/Replace file|Remove file|not saved|Retry|>Selected<|checks? open|>Open<|under the/)
  })
})
