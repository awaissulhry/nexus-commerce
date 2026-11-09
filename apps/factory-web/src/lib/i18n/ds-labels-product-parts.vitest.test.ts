import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VERSION_COMPARE_LABELS, VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { RULE_BUILDER_LABELS, RuleBuilder } from '@nexus/ui/patterns/RuleBuilder/index'
import { SIZE_COLUMNS_LABELS, SizeFill } from '@nexus/ui/grid/size-columns/index'
import { GARMENT_ZONE_MAP_LABELS, GarmentZoneMap } from '@nexus/ui/components/GarmentZoneMap/index'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-207 — the product parts' words in the `ds-words` catalogue (the B-W2b-04 rule): every word in both languages, the
 * English is the DS's own English, the Italian differs where the words differ, and it reaches the parts.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part = 'versionCompare' | 'ruleBuilder' | 'sizeColumns' | 'garmentZoneMap'
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['versionCompare', VERSION_COMPARE_LABELS],
  ['ruleBuilder', RULE_BUILDER_LABELS],
  ['sizeColumns', SIZE_COLUMNS_LABELS],
  ['garmentZoneMap', GARMENT_ZONE_MAP_LABELS],
]

/** Arguments for each word function: every branch (one / many, with / without). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'versionCompare.title': [['Rev 3', 'Rev 4']], 'versionCompare.notIn': [['Rev 3']], 'versionCompare.sizeChange': [['M', '1.1', '1.2', '+0.1'], ['M', '—', '1.2', null]],
  'versionCompare.summary': [[1, 0, 0], [0, 2, 0], [1, 1, 3], [0, 0, 0]], 'versionCompare.showUnchanged': [[1], [4]], 'versionCompare.noteHead': [['Rev 3', 'Rev 4']],
  'versionCompare.noteAdded': [['30 · PRO-01']], 'versionCompare.noteRemoved': [['40 · LBL-02']], 'versionCompare.noteChanged': [['10 · LEA-001', 'Qty 1 → 2']],
  'versionCompare.noteField': [['Qty', '1', '2']], 'versionCompare.noteSize': [['M', '1.1', '1.2']], 'versionCompare.noteTotal': [['Cost', '€ 1', '€ 2']],
  'ruleBuilder.list': [[['A'], 'or'], [['A', 'B'], 'or'], [['A', 'B', 'C'], 'nor']], 'ruleBuilder.withUnit': [['20', '%']],
  'ruleBuilder.row': [[2]], 'ruleBuilder.fieldOf': [[2]], 'ruleBuilder.operatorOf': [[2]], 'ruleBuilder.valueOf': [[2]], 'ruleBuilder.removeRow': [[2]],
  'ruleBuilder.maxRows': [[10]], 'ruleBuilder.unfinished': [[2]], 'ruleBuilder.rowProblem': [[2, 'enter a value']], 'ruleBuilder.problems.range': [[0, 100], [5, null], [null, 9]],
  'sizeColumns.baseHeader': [['M']], 'sizeColumns.headerTooltip': [['M', 'cm', true], ['S', null, false]], 'sizeColumns.cellTooltip': [['M', '62.5', 'cm', false], ['M', null, null, true], ['XL', '64', 'cm', true]],
  'sizeColumns.group': [['cm'], [null]], 'sizeColumns.notNumber': [['M', 'abc']], 'sizeColumns.fillBase': [['M', '59 cm']], 'sizeColumns.fillKeep': [[1], [3]],
  'sizeColumns.fillChanges': [[1], [3]], 'sizeColumns.fillChange': [['S', '56', '56.5'], ['XS', null, '54']], 'sizeColumns.fillBaseMissing': [['M']], 'sizeColumns.fillBelowZero': [['XS']],
  'garmentZoneMap.picked': [['Chest']], 'garmentZoneMap.marked': [['Chest', '4'], ['Chest', '']],
}
const samplesFor = (key: string) => SAMPLES[key] ?? [['x', 'y']]

function* pairs(prefix: string, def: object, mine: object): Generator<[string, unknown, unknown]> {
  for (const [key, value] of Object.entries(def)) {
    const path = `${prefix}.${key}`
    const own = (mine as Record<string, unknown>)?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) yield* pairs(path, value, own as object)
    else yield [path, value, own]
  }
}
const call = (fn: unknown, args: readonly unknown[]) => (fn as (...a: unknown[]) => unknown)(...args)

describe('the B-W2b-207 parts’ words in the ds-words catalogue', () => {
  it('every word has a word in each language (nothing falls back to the DS English, no key leaks)', () => {
    for (const labels of [IT, EN]) for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, labels[part])) {
        expect(own, `${path} is missing`).toBeDefined()
        expect(typeof own, path).toBe(typeof value)
        if (typeof own === 'function') for (const args of samplesFor(path)) expect(String(call(own, args)), path).not.toMatch(/(?:^|\s)[a-zA-Z]+\.[a-zA-Z.]+(?:$|\s)/)
        else if (typeof own === 'string') expect(own, path).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/)
      }
    }
  })

  it('the English catalogue says exactly the DS English', () => {
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, EN[part])) {
        if (typeof value === 'function') for (const args of samplesFor(path)) expect(call(own, args), `${path}(${JSON.stringify(args)})`).toBe(call(value, args))
        else expect(own, path).toEqual(value)
      }
    }
  })

  it('the Italian differs from the English wherever the words differ', () => {
    // The same in both languages: marks, joins and the patterns with no words of their own.
    const same = new Set([
      'versionCompare.none', 'versionCompare.join', 'versionCompare.noteHead', 'versionCompare.noteChanged', 'versionCompare.noteField', 'versionCompare.noteTotal',
      'ruleBuilder.withUnit', 'sizeColumns.notNeeded', 'sizeColumns.baseHeader', 'sizeColumns.fillBase', 'garmentZoneMap.marked',
    ])
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, IT[part])) {
        if (same.has(path)) continue
        if (typeof value === 'string') expect(own, path).not.toBe(value)
        if (typeof value === 'function') {
          const en = [...pairs(part, def, EN[part])].find(([p]) => p === path)![2]
          for (const args of samplesFor(path)) {
            const one = call(own, args)
            if (path === 'ruleBuilder.list' && (args[0] as string[]).length === 1) continue
            if (path === 'garmentZoneMap.marked' || path === 'sizeColumns.group') continue
            // "M: 62.5 cm" is the same pattern in both languages; the words differ once it is missing or typed by hand.
            if (path === 'sizeColumns.cellTooltip' && args[1] !== null && args[3] === false) continue
            if (path === 'sizeColumns.fillChange' && args[1] !== null) continue
            expect(one, `${path}(${JSON.stringify(args)})`).not.toBe(call(en, args))
          }
        }
      }
    }
    expect(IT.versionCompare.summary(1, 2, 3)).toBe('1 aggiunta · 2 rimosse · 3 modificate')
    expect(IT.ruleBuilder.list(['Perforazione', 'Fodera termica', 'Gobba'], 'nor')).toBe('Perforazione, Fodera termica né Gobba')
    expect(IT.sizeColumns.fillChanges(1)).toBe('Cambia 1 valore')
    expect(IT.sizeColumns.cellTooltip('XL', '64', 'cm', true)).toBe('XL: 64 cm · scritto a mano')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const html = [
      renderToStaticMarkup(
        createElement(VersionCompare, {
          before: { label: 'Rev 3' },
          after: { label: 'Rev 4' },
          lines: [
            { id: 'a', label: '10 · Pelle', before: { fields: { q: '1,20 m²' }, sizes: { M: '1.2' } }, after: { fields: { q: '1,30 m²' }, sizes: { M: '1.25' } } },
            { id: 'b', label: '20 · Cerniera', before: { fields: { q: '1' } }, after: { fields: { q: '1' } } },
            { id: 'c', label: '30 · Protezione', before: null, after: { fields: { q: '2' } } },
          ],
          fields: [{ id: 'q', label: 'Quantità' }],
          sizes: ['M'],
          locale: 'it-IT',
          onUseAsNote: () => {},
          labels: IT.versionCompare,
        }),
      ),
      renderToStaticMarkup(
        createElement(RuleBuilder, {
          label: 'Regola',
          fields: [{ id: 'm', label: 'il margine', kind: 'number', unit: '%' }],
          value: { combinator: 'or', rows: [{ id: 'a', field: 'm', operator: 'lt', value: '20' }, { id: 'b', field: null, operator: null, value: null }] },
          onChange: () => {},
          onApply: () => {},
          lead: 'Un preventivo va approvato quando',
          labels: IT.ruleBuilder,
        }),
      ),
      renderToStaticMarkup(createElement(SizeFill, { sizes: ['S', 'M', 'L'], base: 'M', values: { S: null, M: '59', L: '61' }, unit: 'cm', defaultIncrement: '2,5', locale: 'it-IT', onApply: () => {}, labels: IT.sizeColumns })),
      renderToStaticMarkup(createElement(GarmentZoneMap, { zones: [{ id: 'CHEST', label: 'Petto' }, { id: 'LINING', label: 'Fodera' }], value: 'CHEST', onChange: () => {}, label: 'Dove', marks: [{ zone: 'CHEST', value: 3 }], labels: IT.garmentZoneMap })),
    ].join('')
    for (const word of ['Rev 3 a confronto con Rev 4', '1 aggiunta · 1 modificata', 'Assente in Rev 3', 'Taglia M: da 1,2 a 1,25, +0,05', 'Mostra 1 riga invariata', 'Usa come nota di modifica',
      'Un preventivo va approvato quando il margine è sotto 20 % o (la condizione 2 non è completa)', 'Condizione 2: scegli cosa controlla', 'Almeno una (O)',
      'Base M: 59 cm', 'Cambiano 2 valori', 'S: mancante → 56,5 cm', 'Riempi', 'Zona: Petto', 'Zone segnate', 'Giacca, dietro'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/compared with|Not in Rev|Per size|Show 1|Use as change|is under|Condition 2|Any of them|values change|missing|Zone: |Marked zones|Jacket, back/)
  })
})
