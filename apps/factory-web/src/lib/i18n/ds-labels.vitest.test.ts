import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ACTION_CONFIRM_LABELS, AS_OF_LABELS, COMBOBOX_LABELS, CONFIRM_PHRASE_FIELD_LABELS, COUNTDOWN_LABELS, DATE_FIELD_LABELS, DATE_RANGE_PICKER_LABELS,
  DATE_TIME_FIELD_LABELS, FILE_DROPZONE_LABELS, JOB_PROGRESS_LABELS, MEDIA_STRIP_LABELS, MODAL_LABELS, TIMELINE_LABELS,
  ConfirmPhraseField, FileDropzone, MediaStrip, Timeline,
} from '@nexus/ui/components'
import { DETAIL_MODAL_LABELS, EDIT_MODE_BAR_LABELS, PREFERENCES_MODAL_LABELS, REVIEW_CHANGES_LABELS, STEP_UP_MODAL_LABELS } from '@nexus/ui/patterns'
import { COLOR_SWATCH_PICKER_LABELS, ICON_PICKER_LABELS, SWATCHES, TAG_ICONS, TEXTAREA_LABELS, Textarea } from '@nexus/ui/primitives'
import { CELL_SAVE_MARK_LABELS, GRID_DENSITY_TOGGLE_LABELS } from '@nexus/ui/grid'
import { dsLabels, relativeTime, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-04 — the `ds-words` catalogue as every DS part's labels: each word the DS speaks has one (nothing falls back to
 * the DS's English on an Italian page), the English catalogue says the DS's own English, and the Italian reaches the
 * parts. The design lab `/design/ds-words` shows them in a browser.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

const DEFAULTS: ReadonlyArray<readonly [Exclude<keyof DsLabels, 'reviewDoneVerb'>, object]> = [
  ['modal', MODAL_LABELS], ['editModeBar', EDIT_MODE_BAR_LABELS], ['review', REVIEW_CHANGES_LABELS], ['detail', DETAIL_MODAL_LABELS],
  ['stepUp', STEP_UP_MODAL_LABELS], ['actionConfirm', ACTION_CONFIRM_LABELS], ['cellSaveMark', CELL_SAVE_MARK_LABELS], ['dateField', DATE_FIELD_LABELS],
  ['dateTimeField', DATE_TIME_FIELD_LABELS], ['dateRange', DATE_RANGE_PICKER_LABELS], ['asOf', AS_OF_LABELS], ['timeline', TIMELINE_LABELS],
  ['countdown', COUNTDOWN_LABELS], ['preferences', PREFERENCES_MODAL_LABELS], ['density', GRID_DENSITY_TOGGLE_LABELS], ['jobProgress', JOB_PROGRESS_LABELS],
  ['iconPicker', ICON_PICKER_LABELS], ['colorSwatch', COLOR_SWATCH_PICKER_LABELS], ['fileDropzone', FILE_DROPZONE_LABELS], ['mediaStrip', MEDIA_STRIP_LABELS],
  ['combobox', COMBOBOX_LABELS], ['confirmPhrase', CONFIRM_PHRASE_FIELD_LABELS], ['textarea', TEXTAREA_LABELS],
]

/** Arguments to call a word function with: every branch it has (one / many, true / false, left / right). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'editModeBar.unsaved': [[1], [3]],
  'review.title': [[1], [4]], 'review.save': [[1], [4]], 'review.ack': [[1], [3]], 'review.savingOf': [[1, 3]],
  'review.counted': [[2, 'saved']], 'review.notCounted': [[1, 'saved']], 'review.changesNot': [[1, 'saved'], [2, 'saved']],
  'review.conflict': [['Bid', '1.00', '1.20']],
  'detail.position': [[3, 12]], 'detail.first': [['rule', false], ['rule', true]], 'detail.last': [['rule', false], ['rule', true]],
  'countdown.in': [['14 s']],
  'preferences.matchCount': [[3, 98]], 'preferences.columnCount': [[98]], 'preferences.selectMatches': [[1], [4]], 'preferences.clearMatches': [[1], [4]],
  'preferences.groupShown': [[3, 7]], 'preferences.groupMatches': [[2]], 'preferences.inViewCount': [[7, 18]], 'preferences.selected': [[3]],
  'preferences.hiddenFromList': [[1]], 'preferences.pinnedAbove': [[2]],
  'preferences.groupToggle': [[true, false, 'Identity'], [true, true, 'Identity'], [false, false, 'Identity'], [false, true, 'Identity']],
  'preferences.lockedAt': [['left'], ['right']], 'preferences.selectGroupInView': [['Identity', false], ['Identity', true]],
  'preferences.groupCount': [[3, 7, 0], [3, 7, 1]], 'preferences.groupCountTitle': [[3, 7, 0], [3, 7, 1]],
  'preferences.dragOver': [['Status', 'Size']], 'preferences.dragDropped': [['Status', 'Size']], 'preferences.filter': [['Columns']],
  'jobProgress.elapsed': [['1 min 3 s']],
  'fileDropzone.unsupported': [['.csv, .xlsx']], 'fileDropzone.tooLarge': [['big.pdf', '5MB']], 'fileDropzone.hintWithSize': [['.pdf', '5MB']], 'fileDropzone.hintSizeOnly': [['5MB']],
  'mediaStrip.items': [['Photos', 3]], 'mediaStrip.position': [['Front', 1, 3]],
  'mediaStrip.type': [['IMAGE'], ['VIDEO'], ['EXTERNAL_VIDEO'], ['MODEL_3D'], ['MODEL3D'], ['AUDIO'], ['DOC'], ['SOMETHING']],
  'textarea.counter': [[312, 500]], 'textarea.tooLong': [[1], [38]],
  'confirmPhrase.typeToConfirm': [[createElement('strong', null, 'SKU-1')]],
  'actionConfirm.subject': [['sku'], ['external-id'], ['coordinate']],
}
const samplesFor = (key: string, fn: (...args: never[]) => unknown) => SAMPLES[key] ?? (fn.length >= 2 ? [['Status', 'Size']] : [['Status']])
/** The words a value says: text, or a React node as HTML. */
const said = (value: unknown): string => (isValidElement(value) ? renderToStaticMarkup(value) : String(value))

/** A part's words passed on to another part (default `{}` = that part's own English): walked as that part's. */
const NESTED: Readonly<Record<string, object>> = { dateField: DATE_FIELD_LABELS, asOf: AS_OF_LABELS, confirmPhrase: CONFIRM_PHRASE_FIELD_LABELS }

/** Each word of a DS default, with the factory's value for it: [path, DS, factory] (nested objects walked). */
function* pairs(prefix: string, def: object, mine: object): Generator<[string, unknown, unknown]> {
  for (const [key, raw] of Object.entries(def)) {
    const path = `${prefix}.${key}`
    const own = (mine as Record<string, unknown>)[key]
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length && NESTED[key] ? NESTED[key] : raw
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) yield* pairs(path, value, own as object)
    else yield [path, value, own]
  }
}

describe('the ds-words catalogue as DS labels', () => {
  it('every word a DS part speaks has a word in each language (nothing falls back to the DS English)', () => {
    for (const labels of [IT, EN]) for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, labels[part])) {
        expect(own, `${path} is missing`).toBeDefined()
        expect(typeof own, path).toBe(typeof value)
      }
    }
    // A key the catalogue does not have would come back as the key itself.
    const leaked = JSON.stringify(IT, (_k, v) => (typeof v === 'function' ? undefined : v)).match(/"[a-zA-Z]+\.[a-zA-Z.]+"/g)
    expect(leaked).toBeNull()
  })

  it('the English catalogue says exactly the DS English (times aside: they follow the site, PLT-134)', () => {
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, EN[part])) {
        if (/(^|\.)asOf\.(ago|when)$/.test(path)) continue
        if (typeof value === 'function') {
          for (const args of samplesFor(path.replace(/^actionConfirm\.(confirmPhrase)\./, '$1.'), value as never)) {
            expect(said((own as (...a: unknown[]) => unknown)(...args)), `${path}(${args.join(', ')})`).toBe(said((value as (...a: unknown[]) => unknown)(...args)))
          }
        } else if (path === 'dateRange.presets') {
          for (const label of ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Last Month', 'Last 3 Months', 'Last 12 Months']) expect((own as Record<string, string>)[label]).toBe(label)
        } else if (path === 'iconPicker.names') {
          for (const icon of TAG_ICONS) expect((own as Record<string, string>)[icon.id]).toBe(icon.label)
        } else if (path === 'colorSwatch.names') {
          for (const swatch of SWATCHES) expect((own as Record<string, string>)[swatch.name]).toBe(swatch.name)
        } else {
          expect(own, path).toEqual(value)
        }
      }
    }
  })

  it('the Italian differs from the English wherever the words differ', () => {
    const same = new Set(['countdown.second', 'countdown.minute', 'countdown.hour', 'dateRange.locale', 'colorSwatch.names.Lime'])
    for (const [part] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, EN[part], IT[part])) {
        if (same.has(path) || typeof value !== 'string') continue
        expect(own, path).not.toBe(value)
      }
    }
    expect(IT.dateRange.locale).toBe('it-IT')
    expect(IT.dateField.weekdays).toEqual(['D', 'L', 'M', 'M', 'G', 'V', 'S'])
    expect(IT.review.title(1)).toBe('Rivedi 1 modifica')
    expect(IT.review.title(3)).toBe('Rivedi 3 modifiche')
    expect(IT.detail.previous('riga')).toBe('riga precedente')
    const n = (x: number) => x.toLocaleString('it-IT')
    expect(IT.detail.position(12_000, 34_000)).toBe(`${n(12_000)} di ${n(34_000)}`)
    expect(IT.textarea.tooLong(1)).toBe('1 carattere di troppo')
    expect(IT.mediaStrip.type('MODEL3D')).toBe('Modello 3D')
    expect(IT.iconPicker.names.star).toBe('Stella')
    expect(IT.colorSwatch.names.Grey).toBe('Grigio')
    expect(renderToStaticMarkup(createElement('p', null, IT.editModeBar.unsaved(2)))).toBe('<p><b>2</b> modifiche non salvate</p>')
  })

  it('writes relative times in the page language on the DS ladder', () => {
    const now = Date.parse('2026-10-31T10:00:00Z')
    expect(relativeTime('2026-10-31T09:58:00Z', now, 'it')).toBe('2 minuti fa')
    expect(relativeTime('2026-10-31T09:58:00Z', now, 'en')).toBe('2 minutes ago')
    expect(relativeTime('2026-09-01T10:00:00Z', now, 'it')).toBe('9 settimane fa')
    expect(relativeTime('bad', now, 'it')).toBe('bad')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const html = [
      renderToStaticMarkup(createElement(Timeline, { label: 'Passi', labels: IT.timeline, steps: [{ key: 'a', label: 'Spedito', tone: 'danger', at: null }] })),
      renderToStaticMarkup(createElement(FileDropzone, { onFiles: () => {}, accept: '.pdf', maxBytes: 1024 * 1024, labels: IT.fileDropzone })),
      renderToStaticMarkup(createElement(MediaStrip, { items: [{ id: '1', type: 'IMAGE', muted: true }], label: 'Foto', onReorder: () => {}, labels: IT.mediaStrip })),
      renderToStaticMarkup(createElement(ConfirmPhraseField, { phrase: 'ORD-1', value: 'OR', onChange: () => {}, id: 'x', labels: IT.confirmPhrase })),
      renderToStaticMarkup(createElement(Textarea, { value: 'a'.repeat(12), onChange: () => {}, limit: 10, labels: IT.textarea })),
    ].join('')
    for (const word of ['Problema: ', 'non ancora', 'Trascina qui un file', 'fino a 1MB', 'Foto, 1 elementi multimediali', 'Immagine, posizione 1 di 1',
      'Digita <strong class="nds-confirm-h">ORD-1</strong> esattamente per confermare', 'Continua a digitare.', '12 / 10 · 2 caratteri di troppo']) expect(html).toContain(word)
    expect(html).not.toMatch(/Problem: |not yet|Drag &amp; drop|up to|media items|position 1 of|Type <|Keep typing|characters too long/)
  })
})
