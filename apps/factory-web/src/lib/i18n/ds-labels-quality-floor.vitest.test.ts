import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GATE_EXPLAINER_LABELS, GateExplainer } from '@nexus/ui/components/GateExplainer/index'
import { SIGN_OFF_PANEL_LABELS, SignOffPanel } from '@nexus/ui/components/SignOffPanel/index'
import { LIMIT_METER_LABELS, LimitMeter, ToleranceCell } from '@nexus/ui/components/LimitMeter/index'
import { FLOOR_CHECKLIST_LABELS, FloorChecklist } from '@nexus/ui/floor/FloorChecklist/index'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-78 — the quality and floor parts' words in the `ds-words` catalogue (the B-W2b-04 rule): every word in both
 * languages, the English is the DS's own English, the Italian differs where the words differ, and it reaches the parts.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part = 'gateExplainer' | 'signOffPanel' | 'limitMeter' | 'floorChecklist'
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['gateExplainer', GATE_EXPLAINER_LABELS],
  ['signOffPanel', SIGN_OFF_PANEL_LABELS],
  ['limitMeter', LIMIT_METER_LABELS],
  ['floorChecklist', FLOOR_CHECKLIST_LABELS],
]

/** Arguments for each word function: every branch (one / many, with / without). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'gateExplainer.summary': [[1, 3]], 'gateExplainer.who': [['Compliance lead']], 'gateExplainer.how': [['Renew it']], 'gateExplainer.overrideWho': [['Plant manager']],
  'gateExplainer.asOf': [['3 Nov 2026, 10:42']], 'gateExplainer.showWhy': [['Blocked: size 58']], 'gateExplainer.held': [[1, ['A']], [2, ['A', 'B']]],
  'gateExplainer.unknownHeld': [[1, ['A']], [2, ['A', 'B']]], 'gateExplainer.now': [['PENDING']], 'gateExplainer.allMet': [[1], [3]], 'gateExplainer.more': [[2]],
  'signOffPanel.signedBy': [['Marta Demo'], ['Marta Demo', 'Inspector']], 'signOffPanel.rejectedBy': [['Paolo Prova']], 'signOffPanel.whoMay': [['Quality lead']],
  'signOffPanel.summary': [[1, 2]], 'signOffPanel.step': [[2]], 'signOffPanel.afterStep': [[1, 'Result signed']],
  'limitMeter.limit': [['3']], 'limitMeter.minimum': [['40']], 'limitMeter.belowLoq': [['3']], 'limitMeter.loq': [['0.5']],
  'limitMeter.nominal': [['52', '0.5', '0.5', true], ['52', '0.2', '1', false]], 'limitMeter.overBy': [['1.3 cm']], 'limitMeter.underBy': [['0.6 cm']], 'limitMeter.cellOf': [['1.2', '3']],
  'floorChecklist.failedBecause': [['Label missing']], 'floorChecklist.progress': [[1, 4]], 'floorChecklist.checked': [[3, 5]], 'floorChecklist.failedCount': [[1], [2]],
  'floorChecklist.whatIsWrong': [['CE mark']], 'floorChecklist.photo': [['CE mark']], 'floorChecklist.announcePass': [['CE mark']], 'floorChecklist.announceFail': [['CE mark']],
  'floorChecklist.announceGroup': [['Labels', 1], ['Labels', 4]], 'floorChecklist.left': [[1, ['CE mark']], [2, ['CE mark', 'Care label']]],
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

describe('the B-W2b-78 parts’ words in the ds-words catalogue', () => {
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
    // The same in both languages: a PIN, the "< 3" and "52 ± 0.5" patterns, "1.2 / 3".
    const same = new Set(['signOffPanel.methods.pin', 'limitMeter.belowLoq', 'limitMeter.nominal', 'limitMeter.cellOf'])
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
    expect(IT.gateExplainer.held(2, ['Certificato', 'Cr VI'])).toBe('2 controlli non soddisfatti: Certificato; Cr VI')
    expect(IT.floorChecklist.left(1, ['Marchio CE'])).toBe('Manca 1 controllo obbligatorio: Marchio CE')
    expect(IT.floorChecklist.failedCount(2)).toBe('2 non conformi')
    expect(IT.signOffPanel.signedBy('Marta Demo', 'Collaudatrice')).toBe('Firmato da Marta Demo (Collaudatrice)')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const html = [
      renderToStaticMarkup(createElement(GateExplainer, { title: 'Certificato', checks: [{ id: 'a', label: 'Copre la taglia 58', state: 'fail', who: 'Responsabile conformità' }], override: { none: 'Nessuna deroga per legge' }, labels: IT.gateExplainer })),
      renderToStaticMarkup(createElement(SignOffPanel, { steps: [{ id: 'a', label: 'Esito firmato', state: 'signed', signer: 'Marta Demo', method: 'pin' }, { id: 'b', label: 'Rilascio', state: 'waiting', whoMay: 'Qualità', rules: [{ id: 'f', kind: 'fourEyes', state: 'broken' }] }], labels: IT.signOffPanel })),
      renderToStaticMarkup(createElement(LimitMeter, { value: 1.2, limit: 3, unit: 'mg/kg', labels: IT.limitMeter })),
      renderToStaticMarkup(createElement(ToleranceCell, { value: 53.3, nominal: 52, tolerance: 0.5, unit: 'cm', labels: IT.limitMeter })),
      renderToStaticMarkup(
        createElement(FloorChecklist, {
          groups: [{ id: 'g', label: 'Etichette', items: [{ id: 'ce', label: 'Marchio CE' }, { id: 'o', label: 'Origine', required: false }] }],
          answers: { ce: { result: 'fail', reasonLabel: 'Manca', photo: true } },
          onPass: () => {},
          onFail: () => {},
          onPassGroup: () => {},
          action: { label: 'Firma', onClick: () => {} },
          labels: IT.floorChecklist,
        }),
      ),
    ].join('')
    for (const word of ['Bloccato', 'Chi può sbloccarlo: Responsabile conformità', 'Deroga', 'Firmato da Marta Demo · PIN', '1 di 2 firmati', 'Hai firmato un passaggio precedente', 'limite 3', 'Conforme', 'oltre di 1.3 cm', 'Gruppo conforme', 'Non conforme: Manca · con foto', 'Da controllare · Facoltativo'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/Blocked|Who can clear|Signed by|of 2 signed|You signed|limit 3|>Pass<|over by|Group passes|Failed:|Not checked|Optional/)
  })
})
