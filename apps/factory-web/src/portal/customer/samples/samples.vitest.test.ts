import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BRAND_ROUND_STATUSES, STYLE_STAGES } from '@nexus/factory-domain/sales/portal-samples/rules'
import { SCAN_STATES } from '@nexus/factory-domain/product/techpack/scan'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { RoundRead, WaitingRead } from './api'
import { designScreen } from './fixtures'
import { addressOf, addressQuery, answerProblem, answerRefusal, commentNeeded, decisionHeld, decisionTitle, decisionsOf, dueStateOf, neighbourOf, NS, requestHeld, roundsShown, samplesBandOf, trackingText } from './model'

/**
 * SCR-225 › the brand's Samples & tech packs (B-W2b-262), pure: the address, the waiting rows' due, the decision's rules
 * (the same as Home's pop-up and the Approve link: words with comments and with a rejection; held for a preview, the role,
 * offline, the request's own state), the tracking line, one style's rounds, the band — and every design case drawn in
 * Italian and English with no raw key, made-up data only.
 */

const id = (n: number) => `0190f0e2-1950-7000-8000-${String(n).padStart(12, '0')}`
const t = createTranslator('en', CATALOGUE.en[NS] ?? {})

describe('the address', () => {
  it('keeps only ids it can read and writes them back', () => {
    const params = new URLSearchParams(`decide=${id(1).toUpperCase()}&style=nope`)
    expect(addressOf(params)).toEqual({ decide: id(1), style: null })
    expect(addressQuery({ decide: id(1), style: id(2) })).toBe(`?style=${id(2)}&decide=${id(1)}`)
    expect(addressQuery({ decide: null, style: null })).toBe('')
  })
})

describe('what waits and the decision', () => {
  it('words the due as the ActionList draws it', () => {
    const now = Date.parse('2026-11-10T10:00:00Z')
    expect(dueStateOf('2026-11-09T10:00:00Z', now)).toBe('overdue')
    expect(dueStateOf('2026-11-10T20:00:00Z', now)).toBe('today')
    expect(dueStateOf('2026-11-12T10:00:00Z', now)).toBe('soon')
    expect(dueStateOf('2026-11-20T10:00:00Z', now)).toBe('later')
    expect(dueStateOf('nope', now)).toBe('none')
  })

  it('asks words with comments and with a rejection, as the API does', () => {
    expect(decisionsOf({ may: { answer: true, withChanges: true } })).toEqual(['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'])
    expect(decisionsOf({ may: { answer: true, withChanges: false } })).toEqual(['APPROVED', 'REFUSED'])
    expect(answerProblem(null, '')).toEqual({ key: 'decide.problem.choose', field: 'decision' })
    expect(answerProblem('REFUSED', '  ')).toEqual({ key: 'decide.problem.why', field: 'comment' })
    expect(answerProblem('APPROVED_WITH_CHANGES', '')).toEqual({ key: 'decide.problem.what', field: 'comment' })
    expect(answerProblem('APPROVED', 'x'.repeat(4001))).toEqual({ key: 'decide.problem.long', field: 'comment' })
    expect(answerProblem('APPROVED', '')).toBeNull()
    expect(commentNeeded('APPROVED')).toBe(false)
    expect(answerRefusal('conflict')).toEqual({ key: 'decide.problem.changed', reload: true })
    expect(answerRefusal('not_found')).toMatchObject({ gone: true })
    expect(answerRefusal(null).key).toBe('decide.problem.failed')
  })

  it('holds the signature with the first reason: preview, role (naming the admins), offline, busy, unread, the request', () => {
    const open = { may: { answer: true, withChanges: true }, request: { status: 'OPEN' as const } }
    const base = { preview: false, mayApprove: true, offline: false, busy: false, page: open as never, admins: ['Paolo Esempio'] }
    expect(decisionHeld({ ...base, preview: true, mayApprove: false })).toEqual({ key: 'held.preview' })
    expect(decisionHeld({ ...base, mayApprove: false })).toEqual({ key: 'held.mayApproveAsk', params: { admins: 'Paolo Esempio' } })
    expect(decisionHeld({ ...base, mayApprove: false, admins: [] })).toEqual({ key: 'held.mayApprove' })
    expect(decisionHeld({ ...base, offline: true })).toEqual({ key: 'held.offline' })
    expect(decisionHeld({ ...base, busy: true })).toEqual({ key: 'held.busy' })
    expect(decisionHeld({ ...base, page: null })).toEqual({ key: 'held.reading' })
    expect(decisionHeld(base)).toBeNull()
    expect(requestHeld({ may: { answer: false, withChanges: false }, request: { status: 'REFUSED' } as never })).toBe('held.answered')
    expect(requestHeld({ may: { answer: false, withChanges: false }, request: { status: 'EXPIRED' } as never })).toBe('held.closed')
  })

  it('titles the dialog by the round ("Decide on Fit · round 2") or by the kind and style, and steps through the queue', () => {
    const round = { kind: 'SAMPLE', round: { id: id(1), number: 'SR-2026-0001', kind: 'FIT', roundNo: 2, label: { it: 'SR-2026-0001 · Fit · giro 2', en: 'SR-2026-0001 · Fit · round 2' } }, style: null } as unknown as WaitingRead
    expect(decisionTitle(round, t, 'en')).toBe('Decide on Fit · round 2')
    const leather = { kind: 'LEATHER', round: null, style: { id: id(2), code: 'BA-JKT-27', name: 'x' } } as unknown as WaitingRead
    expect(decisionTitle(leather, t, 'en')).toBe('Decide on Leather · BA-JKT-27')
    expect(neighbourOf(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(neighbourOf(['a', 'b', 'c'], 'a', -1)).toBeNull()
    expect(neighbourOf(['a', 'b'], 'z', 1)).toBe('a')
  })
})

describe('the rows and the band', () => {
  it('writes the tracking line and shows one style’s rounds', () => {
    expect(trackingText({ carrierName: 'Corriere Esempio', trackingNumber: 'CE001', trackingUrl: null, sentAt: null, receivedAt: null })).toBe('Corriere Esempio · CE001')
    expect(trackingText({ carrierName: ' ', trackingNumber: null, trackingUrl: null, sentAt: null, receivedAt: null })).toBeNull()
    expect(trackingText(null)).toBeNull()
    const rounds = [{ id: '1', style: { id: 'a' } }, { id: '2', style: { id: 'b' } }] as unknown as RoundRead[]
    expect(roundsShown(rounds, 'b').map((round) => round.id)).toEqual(['2'])
    expect(roundsShown(rounds, null)).toHaveLength(2)
  })

  it('offers "Decide N waiting samples" only when some wait', () => {
    expect(samplesBandOf({ t, asOf: '10:42', waiting: 3, onDecideFirst: () => undefined, held: null }).actions.map((action) => action.label)).toEqual(['Decide 3 waiting samples'])
    expect(samplesBandOf({ t, asOf: null, waiting: 0, onDecideFirst: () => undefined, held: null }).actions).toEqual([])
  })

  it('has words for every status, stage and tech pack state in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const tr = createTranslator(locale, CATALOGUE[locale][NS] ?? {})
      for (const key of [...BRAND_ROUND_STATUSES.map((status) => `status.${status}`), ...STYLE_STAGES.map((stage) => `stage.${stage}`), ...SCAN_STATES.map((state) => `pack.state.${state}`)]) expect(tr(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})

const KEY = /\b(band|keys|state|held|noAccess|waiting|kind|round|stage|status|styles|pack|rounds|decide|decided)\.[a-zA-Z_-]+/

describe('SCR-225 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(25)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'buyer')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('In attesa della tua decisione')
    expect(html).toContain('I tuoi modelli in sviluppo')
    expect(html).toContain('Giri di campionatura')
    expect(html).not.toContain('Waiting for your decision')
    expect(html).not.toContain('Sample rounds')
  })
})
