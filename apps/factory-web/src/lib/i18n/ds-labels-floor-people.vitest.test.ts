import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FLOOR_ELAPSED_LABELS, FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { FLOOR_CARD_LABELS, FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FLOOR_NAME_PICKER_LABELS, FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import { FLOOR_LIST_UPDATES_LABELS, FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { READ_ALOUD_LABELS } from '@nexus/ui/floor/ReadAloud/index'
import { PIN_SIGN_BLOCK_LABELS, PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { LAW_REF_LABELS } from '@nexus/ui/components/LawRef/index'
import { LEGAL_GATE_LABELS, LegalGate } from '@nexus/ui/components/LegalGate/index'
import { PRIVACY_NOTE_LABELS, PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { PROTECTED_VALUE_LABELS, ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { DAY_STRIP_LABELS, DayStrip } from '@nexus/ui/components/DayStrip/index'
import { DUE_CELL_LABELS, DueCell } from '@nexus/ui/components/DueCell/index'
import { DOCUMENT_SEAL_LABELS, DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-28 — the floor and people parts' words in the `ds-words` catalogue (the B-W2b-04 rule): every word in both
 * languages, the English is the DS's own English, the Italian differs where the words differ, and it reaches the parts.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part =
  | 'floorElapsed' | 'floorCard' | 'floorNamePicker' | 'floorListUpdates' | 'readAloud' | 'pinSignBlock' | 'lawRef' | 'legalGate'
  | 'privacyNote' | 'protectedValue' | 'dayStrip' | 'dueCell' | 'documentSeal'
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['floorElapsed', FLOOR_ELAPSED_LABELS], ['floorCard', FLOOR_CARD_LABELS], ['floorNamePicker', FLOOR_NAME_PICKER_LABELS],
  ['floorListUpdates', FLOOR_LIST_UPDATES_LABELS], ['readAloud', READ_ALOUD_LABELS], ['pinSignBlock', PIN_SIGN_BLOCK_LABELS],
  ['lawRef', LAW_REF_LABELS], ['legalGate', LEGAL_GATE_LABELS], ['privacyNote', PRIVACY_NOTE_LABELS], ['protectedValue', PROTECTED_VALUE_LABELS],
  ['dayStrip', DAY_STRIP_LABELS], ['dueCell', DUE_CELL_LABELS], ['documentSeal', DOCUMENT_SEAL_LABELS],
]

/** Arguments for each word function: every branch (one / many, with / without). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'floorElapsed.minutes': [[1], [12]], 'floorElapsed.hours': [[1], [3]], 'floorElapsed.join': [['1 hour', '5 minutes']], 'floorElapsed.over': [['3 minutes']],
  'floorCard.cachedAt': [['10:42']],
  'floorNamePicker.jumpTo': [['M']], 'floorNamePicker.noneFor': [['Q']],
  'floorListUpdates.changed': [[0], [1], [3]],
  'readAloud.voice': [['Alice']],
  'pinSignBlock.signingAs': [['Marta Demo']], 'pinSignBlock.entered': [[3, 6]],
  'lawRef.about': [['D.Lgs. 81/2008 art. 37']],
  'legalGate.recordedBy': [['Demo Person'], ['Demo Person', '3 Nov 2026']], 'legalGate.summary': [[3, 5]], 'legalGate.onFolded': [[], ['1 Dec 2026']],
  'legalGate.onButOpen': [[1], [2]], 'legalGate.held': [[1, ['Notice']], [2, ['Notice', 'Codes']]],
  'protectedValue.recordedAt': [['10:42']],
  'dayStrip.shift': [['08:00', '17:00']], 'dayStrip.span': [['Worked', '08:00', '12:00']], 'dayStrip.at': [['Clock-in', '08:02']],
  'dueCell.overdue': [[1], [3]], 'dueCell.dueIn': [[1], [12]], 'dueCell.validUntil': [['12 Mar 2027']], 'dueCell.doneOn': [['3 Nov 2026']],
  'documentSeal.signedOn': [['3 Nov 2026']], 'documentSeal.signedCount': [[1, 2]], 'documentSeal.match': [['lul.pdf']], 'documentSeal.mismatch': [['lul.pdf']],
}
const samplesFor = (key: string) => SAMPLES[key] ?? [['x']]

function* pairs(prefix: string, def: object, mine: object): Generator<[string, unknown, unknown]> {
  for (const [key, value] of Object.entries(def)) {
    const path = `${prefix}.${key}`
    const own = (mine as Record<string, unknown>)?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) yield* pairs(path, value, own as object)
    else yield [path, value, own]
  }
}
const call = (fn: unknown, args: readonly unknown[]) => (fn as (...a: unknown[]) => unknown)(...args)

describe('the B-W2b-28 parts’ words in the ds-words catalogue', () => {
  it('every word has a word in each language (nothing falls back to the DS English, no key leaks)', () => {
    for (const labels of [IT, EN]) for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, labels[part])) {
        expect(own, `${path} is missing`).toBeDefined()
        expect(typeof own, path).toBe(typeof value)
        if (typeof own === 'function') for (const args of samplesFor(path)) expect(String(call(own, args)), path).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/)
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
    // The same in both languages: unit letters, a dash, a placeholder pattern, and "{entered} di {total}"-like numbers.
    const same = new Set(['floorElapsed.hourUnit', 'floorElapsed.minuteUnit', 'dueCell.none', 'dayStrip.span'])
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, IT[part])) {
        if (same.has(path)) continue
        if (typeof value === 'string') expect(own, path).not.toBe(value)
        if (typeof value === 'function') {
          const en = [...pairs(part, def, EN[part])].find(([p]) => p === path)![2]
          for (const args of samplesFor(path)) expect(call(own, args), `${path}(${JSON.stringify(args)})`).not.toBe(call(en, args))
        }
      }
    }
    expect(IT.floorElapsed.minutes(1)).toBe('1 minuto')
    expect(IT.floorElapsed.minutes(12)).toBe('12 minuti')
    expect(IT.dueCell.dueIn(12)).toBe('Scade tra 12 giorni')
    expect(IT.dueCell.overdue(1)).toBe('Scaduto da 1 giorno')
    expect(IT.legalGate.held(2, ['Informativa', 'Codici paghe'])).toBe('Mancano 2 condizioni: Informativa, Codici paghe')
    expect(IT.floorListUpdates.changed(0)).toBe('Elenco cambiato')
    expect(IT.floorListUpdates.changed(3)).toBe('Elenco cambiato: 3 aggiornamenti')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const T0 = Date.parse('2026-11-03T08:00:00Z')
    const html = [
      renderToStaticMarkup(createElement(FloorElapsed, { label: 'In lavorazione', since: T0, now: T0 + 12 * 60_000, labels: IT.floorElapsed })),
      renderToStaticMarkup(createElement(FloorCard, { icon: null, kind: 'Fascio', code: 'B-000123', status: { label: 'Pronto' }, asOf: '2026-11-03T09:42:00Z', formatTime: () => '10:42', labels: IT.floorCard })),
      renderToStaticMarkup(createElement(FloorNamePicker, { label: 'Scegli', people: [{ id: 'a', name: 'Marta Demo' }], recentIds: ['a'], onPick: () => {}, labels: IT.floorNamePicker })),
      renderToStaticMarkup(createElement(FloorListUpdates, { pending: 2, onShow: () => {}, labels: IT.floorListUpdates })),
      renderToStaticMarkup(createElement(PinSignBlock, { meaning: 'x', signer: { name: 'Marta Demo' }, onSign: () => {}, labels: IT.pinSignBlock })),
      renderToStaticMarkup(createElement(LegalGate, { title: 'Cottimo', items: [{ id: 'a', label: 'Informativa', state: 'missing' }], action: { label: 'Avvia', onClick: () => {} }, labels: IT.legalGate })),
      renderToStaticMarkup(createElement(PrivacyNote, { level: 'line', recorded: true, labels: IT.privacyNote })),
      renderToStaticMarkup(createElement(ProtectedValue, { label: 'Giudizio', allowed: true, onOpen: () => {}, labels: IT.protectedValue })),
      renderToStaticMarkup(createElement(DayStrip, { label: 'x', from: T0, to: T0 + 8 * 3_600_000, segments: [{ id: 's', from: T0, to: T0 + 3_600_000, kind: 'break' }], labels: IT.dayStrip })),
      renderToStaticMarkup(createElement(DueCell, { value: '2026-11-15', today: '2026-11-03', labels: IT.dueCell })),
      renderToStaticMarkup(createElement(DocumentSeal, { version: 'v1', sha256: 'ab'.repeat(32), sealedAt: 'x', timestampSource: 'y', signers: [{ id: 'a', name: 'Demo' }], labels: IT.documentSeal })),
    ].join('')
    for (const word of ['In lavorazione: 12 minuti', 'Salvato su questo tablet', 'Hanno lavorato qui di recente', 'Elenco cambiato: 2 aggiornamenti · Mostra', 'Firmi come Marta Demo', 'Manca 1 condizione: Informativa', 'Totali di linea', 'L’apertura viene registrata', 'Pausa', 'Scade tra 12 giorni', 'In attesa di firma', 'Verifica un file'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/minutes|Saved on|Worked here|List changed|Signing as|conditions? missing|Line totals|is recorded|>Break<|Due in|Waiting to sign|Verify a file/)
  })
})
