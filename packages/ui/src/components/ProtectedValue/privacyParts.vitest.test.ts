import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrivacyNote } from '../PrivacyNote/PrivacyNote'
import { privacyNoteText, privacyTone } from '../PrivacyNote/privacyNoteModel'
import { ProtectedValue } from './ProtectedValue'
import { protectedValueView } from './protectedValueModel'

/** B-W2b-28 — PrivacyNote and ProtectedValue: say the level at rest; protected data only behind a recorded open. */
describe('PrivacyNote', () => {
  it('tones by level, least to most personal', () => {
    expect(privacyTone('line')).toBe('neutral')
    expect(privacyTone('team')).toBe('neutral')
    expect(privacyTone('individual')).toBe('info')
    expect(privacyTone('protected')).toBe('warning')
  })
  it('says the level, who may see more, the law and that opening is recorded — all on screen, as a note', () => {
    const html = render(h(PrivacyNote, { level: 'line', text: 'Line totals · individual figures private', whoMore: 'HR and the worker see individual figures', law: h('span', null, 'Statuto art. 4'), recorded: true }))
    expect(html).toContain('role="note"')
    expect(html).toContain('aria-label="Privacy"')
    const at = (s: string) => html.indexOf(s)
    expect(at('Line totals · individual figures private')).toBeLessThan(at('HR and the worker'))
    expect(at('HR and the worker')).toBeLessThan(at('Statuto art. 4'))
    expect(at('Statuto art. 4')).toBeLessThan(at('Opening this is recorded'))
    expect(render(h(PrivacyNote, { level: 'protected' }))).toContain('Protected data')
    expect(privacyNoteText({ level: 'Team totals', whoMore: ' ', recorded: 'Opening this is recorded' })).toBe('Team totals · Opening this is recorded')
  })
  it('speaks the host’s language', () => {
    const html = render(h(PrivacyNote, { level: 'team', recorded: true, labels: { levels: { line: 'Totali di linea', team: 'Totali di squadra', individual: 'Dati di una persona', protected: 'Dati protetti' }, recorded: 'L’apertura è registrata', region: 'Privacy' } }))
    expect(html).toContain('Totali di squadra')
    expect(html).toContain('L’apertura è registrata')
  })
})

describe('ProtectedValue', () => {
  it('chooses the view: restricted for others; for an entitled role closed → opening → open, or failed', () => {
    expect(protectedValueView({ allowed: false, value: 'x' })).toBe('restricted')
    expect(protectedValueView({ allowed: true })).toBe('closed')
    expect(protectedValueView({ allowed: true, opening: true })).toBe('opening')
    expect(protectedValueView({ allowed: true, failed: true })).toBe('failed')
    expect(protectedValueView({ allowed: true, value: null })).toBe('open')
  })
  it('never draws the value for a person without the role, even when one is passed', () => {
    const html = render(h(ProtectedValue, { label: 'Fitness judgement', allowed: false, value: 'Fit with limits', restrictedReason: 'Only HR and safety roles' }))
    expect(html).toContain('Restricted')
    expect(html).toContain('Only HR and safety roles')
    expect(html).not.toContain('Fit with limits')
  })
  it('an entitled role sees Show and that opening is recorded; open shows the value with the view mark; opening is held', () => {
    const closed = render(h(ProtectedValue, { label: 'Fitness judgement', allowed: true, onOpen: () => {} }))
    expect(closed).toContain('Show')
    expect(closed).toContain('Opening it is recorded')
    const open = render(h(ProtectedValue, { label: 'Fitness judgement', allowed: true, value: 'Fit with limits', recordedAt: '10:42', onHide: () => {} }))
    expect(open).toContain('Fit with limits')
    expect(open).toContain('View recorded · 10:42')
    expect(open).toContain('Hide')
    expect(render(h(ProtectedValue, { label: 'x', allowed: true, opening: true, onOpen: () => {} }))).toContain('aria-disabled="true"')
    expect(render(h(ProtectedValue, { label: 'x', allowed: true, failed: true, onOpen: () => {} }))).toContain('It could not be opened')
  })
})
