import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { END_STATE_LABELS, EndState } from '@nexus/ui/components/EndState/index'
import { CODE_INPUT_LABELS, CodeInput } from '@nexus/ui/components/CodeInput/index'
import { REF_PAIR_LABELS, RefPair } from '@nexus/ui/components/RefPair/index'
import { MILESTONE_TRACKER_LABELS, MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { PAYMENT_PANEL_LABELS, PaymentPanel } from '@nexus/ui/components/PaymentPanel/index'
import { ACTION_LIST_LABELS, ActionList } from '@nexus/ui/patterns/ActionList/index'
import { PARTNER_THREAD_LABELS, PartnerThread } from '@nexus/ui/patterns/PartnerThread/index'
import { LINE_RESPONSE_LIST_LABELS, LineResponseList } from '@nexus/ui/patterns/LineResponseList/index'
import { PORTAL_ACTION_BAR_LABELS, PortalActionBar } from '@nexus/ui/patterns/PortalActionBar/index'
import { SIZE_GRID_COPY, SizeGridEditor } from '@nexus/ui/grid/size-grid/index'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import type { Locale } from './locales'

/**
 * B-W2b-155 — the portal and link parts' words in the `ds-words` catalogue (the B-W2b-04 rule): every word in both
 * languages, the English is the DS's own English, the Italian differs where the words differ, and it reaches the parts.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part =
  | 'endState' | 'codeInput' | 'refPair' | 'milestoneTracker' | 'paymentPanel' | 'actionList' | 'partnerThread' | 'lineResponseList'
  | 'portalActionBar' | 'sizeGridStacked'
const STACKED = Object.fromEntries(Object.keys(EN.sizeGridStacked).map((key) => [key, SIZE_GRID_COPY[key as keyof typeof SIZE_GRID_COPY]]))
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['endState', END_STATE_LABELS], ['codeInput', CODE_INPUT_LABELS], ['refPair', REF_PAIR_LABELS], ['milestoneTracker', MILESTONE_TRACKER_LABELS],
  ['paymentPanel', PAYMENT_PANEL_LABELS], ['actionList', ACTION_LIST_LABELS], ['partnerThread', PARTNER_THREAD_LABELS],
  ['lineResponseList', LINE_RESPONSE_LIST_LABELS], ['portalActionBar', PORTAL_ACTION_BAR_LABELS], ['sizeGridStacked', STACKED],
]

/** Arguments for each word function: every branch (one / many, with / without). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'endState.copyReference': [['R-2026-0031']], 'endState.yourCopyNamed': [['Q-2026-0042.pdf']], 'endState.emailTo': [['Anna Rossi']], 'endState.callTo': [['Anna Rossi']],
  'codeInput.hint': [[6]], 'codeInput.triesLeft': [[1], [2]], 'codeInput.resendIn': [['45 s']],
  'refPair.copy': [['4500-1234']], 'refPair.pair': [['Your PO 4500-1234', 'Our ref. SO-1']],
  'milestoneTracker.doneOn': [['3 Nov']], 'milestoneTracker.partlyOn': [['3 Nov']], 'milestoneTracker.usually': [['12 Nov']], 'milestoneTracker.stepOf': [[3, 6]],
  'milestoneTracker.promised': [['14 Nov']], 'milestoneTracker.moved': [[1], [2]], 'milestoneTracker.move': [['3 Nov', '10 Nov', '14 Nov']], 'milestoneTracker.set': [['1 Nov', '10 Nov']],
  'paymentPanel.pay': [['714,00 €']], 'paymentPanel.paying': [[], ['Stripe']], 'paymentPanel.fields': [[], ['Stripe']], 'paymentPanel.secure': [[], ['Stripe']],
  'actionList.groupCount': [[1], [3]], 'actionList.overdue': [[], ['3 Nov']], 'actionList.dueIn': [['5 h']], 'actionList.dueOn': [['12 Nov']],
  'partnerThread.messageFrom': [['Anna Rossi', '3 Nov, 10:42']], 'partnerThread.attached': [[1], [3]],
  'lineResponseList.line': [['20']], 'lineResponseList.askedValue': [['120', 'm²', '3 Dec 2026']], 'lineResponseList.delivery': [['60', 'm²', '3 Dec 2026']],
  'lineResponseList.answerOther': [['100', 'm²', '10 Dec 2026']], 'lineResponseList.answerSplit': [['60 m² by 3 Dec', '60 m² by 17 Dec']],
  'lineResponseList.answerSubstitute': [['NAP-14', '120 m² by 3 Dec 2026']], 'lineResponseList.reason': [['Tannery late']], 'lineResponseList.changeSaid': [['Two dye batches']],
  'lineResponseList.changeAria': [['20']], 'lineResponseList.asAskedAgainAria': [['20']], 'lineResponseList.review': [['3 lines as asked']],
  'lineResponseList.summary.allAsAsked': [[1], [3]], 'lineResponseList.summary.asAsked': [[1], [3]], 'lineResponseList.summary.later': [[1], [2]],
  'lineResponseList.summary.earlier': [[1], [2]], 'lineResponseList.summary.quantity': [[1], [2]], 'lineResponseList.summary.split': [[1], [2]],
  'lineResponseList.summary.cannot': [[1], [2]], 'lineResponseList.summary.substitute': [[1], [2]], 'lineResponseList.summary.change': [[1], [2]],
  'lineResponseList.sheetTitle': [['20']], 'lineResponseList.quantity': [['m²']], 'lineResponseList.problems.reasonLong': [[500]], 'lineResponseList.problems.substituteLong': [[2000]],
  'sizeGridStacked.colourTab': [['Black', '24']], 'sizeGridStacked.left': [['12']], 'sizeGridStacked.less': [['Black, size M']], 'sizeGridStacked.more': [['Black, size M']],
  'sizeGridStacked.atMax': [['99,999']], 'sizeGridStacked.stackTotals': [[{ colour: 'Black', total: '24', grand: '60' }]],
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

describe('the B-W2b-155 parts’ words in the ds-words catalogue', () => {
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
    // The same in both languages: patterns of placeholders only.
    const same = new Set(['refPair.pair', 'milestoneTracker.move', 'lineResponseList.summaryJoin'])
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
    expect(IT.codeInput.triesLeft(1)).toBe('Resta 1 tentativo')
    expect(IT.codeInput.triesLeft(2)).toBe('Restano 2 tentativi')
    expect(IT.milestoneTracker.moved(1)).toBe('Data spostata una volta')
  })

  it('reaches the parts: an Italian page shows no DS English', () => {
    const html = [
      renderToStaticMarkup(createElement(EndState, { title: 'Inviato', next: ['a', 'b'], reference: { value: 'R-1' }, contact: { name: 'Marco Demo', email: 'm@x.example' }, labels: IT.endState })),
      renderToStaticMarkup(createElement(CodeInput, { value: '', onChange: () => {}, triesLeft: 2, resend: { onResend: () => {} }, labels: IT.codeInput })),
      renderToStaticMarkup(createElement(RefPair, { theirs: '4500-1234', ours: 'SO-1', labels: IT.refPair })),
      renderToStaticMarkup(createElement(MilestoneTracker, { steps: [{ id: 'a', label: 'Confermato', state: 'done', date: '3 nov' }, { id: 'b', label: 'In produzione', state: 'todo', expected: '12 nov' }], promise: { date: '14 nov', history: [{ on: '3 nov', from: '10 nov', to: '14 nov' }] }, labels: IT.milestoneTracker })),
      renderToStaticMarkup(createElement(PaymentPanel, { amount: '714,00 €', purpose: 'Acconto', state: 'waiting', providerName: 'Stripe', labels: IT.paymentPanel })),
      renderToStaticMarkup(createElement(ActionList, { groups: [{ id: 'g', label: 'Ordini', items: [{ id: 'i', title: 'Conferma', due: { at: '2026-11-01T00:00:00Z', state: 'overdue', text: '1 nov' }, verb: { label: 'Conferma', kind: 'inline', onRun: () => {} } }] }], labels: IT.actionList })),
      renderToStaticMarkup(createElement(PartnerThread, { companyName: 'Demo', messages: [], composer: { value: '', onChange: () => {}, onSend: () => {} }, labels: IT.partnerThread })),
      renderToStaticMarkup(createElement(LineResponseList, { today: '2026-11-03', lines: [{ id: 'l', title: 'NAPPA', asked: { quantity: '120', unit: 'm²', date: '2026-12-03', dateText: '3 dic 2026' } }], answers: {}, onAllAsAsked: () => {}, labels: IT.lineResponseList })),
      renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Invia', heldReason: 'x' }, labels: IT.portalActionBar })),
      renderToStaticMarkup(createElement(SizeGridEditor, { layout: 'stacked', colours: [{ key: 'b', label: 'Nero' }, { key: 't', label: 'Cuoio' }], sizes: [{ key: 'M', label: 'M' }], value: { b: { M: 0 } }, onChange: () => {}, left: { b: { M: 4 } }, copy: IT.sizeGridStacked })),
    ].join('')
    for (const word of ['Cosa succede ora', 'Domande?', 'Restano 2 tentativi', 'Invia un nuovo codice', 'Vostro rif.', 'Nostro rif.', 'Fatto · 3 nov', 'Di solito entro il 12 nov', 'Promesso per il 14 nov', 'Data spostata una volta', 'In ritardo dal 1 nov', 'Restano', 'Già a 0', 'Tutti i colori'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/What happens next|Questions\?|tries left|Send a new code|Your ref\.|Our ref\.|Done ·|Usually by|Promised for|Date moved|Overdue|All colourways|Already 0|>Actions</)
  })
})
