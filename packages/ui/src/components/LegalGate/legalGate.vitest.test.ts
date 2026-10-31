import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LawRef, lawRefText } from '../LawRef/LawRef'
import { LegalGate, type LegalGateItem } from './LegalGate'
import { LEGAL_GATE_LABELS } from './LegalGateLabels'
import { legalGateFolds, legalGateHeld, legalGateSummary } from './legalGateModel'

/** B-W2b-28 — LegalGate (and the LawRef chips it carries). Made-up records. */
const ITEMS: LegalGateItem[] = [
  { id: 'basis', label: 'Scans name workers with a recorded legal basis', state: 'met', recordedBy: 'Demo Person', recordedAt: '3 Nov 2026', law: { law: 'Statuto dei Lavoratori art. 4', plain: 'Remote monitoring needs an agreement or an authorisation.' } },
  { id: 'notice', label: 'Worker notice acknowledged', state: 'missing', detail: '14 of 16 acknowledged', href: '/people/notice' },
  { id: 'codes', label: 'Payroll codes mapped', state: 'expired' },
  { id: 'scheme', label: 'Scheme and CCNL chosen', state: 'unknown' },
]
const met = ITEMS.map((i) => ({ ...i, state: 'met' as const }))

describe('legalGate rules', () => {
  it('counts only met as met and names every other condition in the held reason', () => {
    expect(legalGateSummary(ITEMS)).toMatchObject({ total: 4, met: 1 })
    expect(legalGateHeld(ITEMS, LEGAL_GATE_LABELS)).toBe('3 conditions missing: Worker notice acknowledged, Payroll codes mapped, Scheme and CCNL chosen')
    expect(legalGateHeld([ITEMS[1]], LEGAL_GATE_LABELS)).toBe('1 condition missing: Worker notice acknowledged')
    expect(legalGateHeld(met, LEGAL_GATE_LABELS)).toBeNull()
    // Nothing listed is never a free pass.
    expect(legalGateHeld([], LEGAL_GATE_LABELS)).toBe('No conditions are listed for this switch')
  })
  it('folds only when on with every condition met', () => {
    expect(legalGateFolds(true, met)).toBe(true)
    expect(legalGateFolds(false, met)).toBe(false)
    expect(legalGateFolds(true, ITEMS)).toBe(false)
    expect(legalGateFolds(true, [])).toBe(false)
  })
})

describe('LegalGate', () => {
  it('lists each condition with its state in words, the law chip, who recorded it and the link; the switch is held with the reason on screen', () => {
    const html = render(h(LegalGate, { title: 'Piece pay at Demo Site', items: ITEMS, action: { label: 'Start piece pay', onClick: () => {} } }))
    for (const word of ['Met', 'Missing', 'Expired', 'Not checked', 'Recorded by Demo Person · 3 Nov 2026', 'Not recorded yet', 'Record it', '14 of 16 acknowledged', '1 of 4 conditions met', 'Statuto dei Lavoratori art. 4']) expect(html).toContain(word)
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('class="nds-legalgate-held">3 conditions missing:')
    expect(html).not.toContain(' disabled=""')
  })
  it('on with every condition met folds to one line; on with one open says so and stays open', () => {
    const folded = render(h(LegalGate, { title: 'Piece pay', items: met, on: true, onSince: '1 Dec 2026' }))
    expect(folded).toContain('On since 1 Dec 2026 · every condition met')
    expect(folded).toContain('Show conditions')
    expect(folded).not.toContain('nds-legalgate-items')
    const open = render(h(LegalGate, { title: 'Piece pay', items: [met[0], { ...met[1], state: 'expired' as const }], on: true }))
    expect(open).toContain('On, but 1 condition is no longer met')
    expect(open).toContain('nds-legalgate-items')
  })
  it('speaks the host’s language', () => {
    const html = render(h(LegalGate, { title: 'Cottimo', items: ITEMS, labels: { states: { met: 'Soddisfatto', missing: 'Manca', expired: 'Scaduto', unknown: 'Da verificare' }, summary: (m: number, t: number) => `${m} di ${t} condizioni` } }))
    expect(html).toContain('Soddisfatto')
    expect(html).toContain('1 di 4 condizioni')
  })
})

describe('LawRef', () => {
  it('is a real button that names the law, opens the plain words and says the official link opens a new tab', () => {
    const html = render(h(LawRef, { law: 'D.Lgs. 81/2008 art. 37', plain: 'Training of workers.', href: 'https://example.org/law' }))
    expect(html).toContain('<button')
    expect(html).toContain('aria-label="D.Lgs. 81/2008 art. 37 — what it says"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('D.Lgs. 81/2008 art. 37')
    expect(lawRefText('D.Lgs. 81/2008 art. 37', ' Training of workers. ')).toBe('D.Lgs. 81/2008 art. 37 — Training of workers.')
    expect(lawRefText('D.Lgs. 81/2008', '')).toBe('D.Lgs. 81/2008')
  })
})
