import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PresenceMark } from './PresenceMark'
import { presenceLine, type Presence } from '../grid/renderers/presence'
const p: Presence = { intent: 'LIVE', intentAt: null, fact: 'SELLING', observedAt: '2026-09-13T12:00:00Z', now: Date.parse('2026-09-13T12:00:01Z'), freshnessMs: 5000, inFlight: false }
it('keeps intent and channel fact on separate Tag/Pill primitives and includes the observation time', () => {
 const html = render(createElement(PresenceMark, { presence: p }))
 expect(html).toContain('nds-tag info'); expect(html).toContain('nds-pill success has-dot')
 expect(html).toContain('Listed'); expect(html).toContain('Selling'); expect(html).toContain('<time')
 expect(html).not.toContain('nds-badge')
})
it('cannot paint green for missing, old, pending or unknown-source observations', () => {
 for (const presence of [{ ...p, observedAt: null }, { ...p, now: p.now + 10000 }, { ...p, inFlight: true }, { ...p, fact: 'UNKNOWN' as const }]) {
   expect(render(createElement(PresenceMark, { presence }))).not.toContain('success')
 }
 expect(render(createElement(PresenceMark, { presence: p, via: null }))).not.toContain('success')
})

it('preserves a refused observation when its timestamp and source are absent', () => {
 const html = render(createElement(PresenceMark, { presence: { ...p, fact: 'REFUSED', observedAt: null }, via: null }))
 expect(html).toContain('nds-pill warning has-dot')
 expect(html).toContain('Could not ask')
 expect(html).toContain('not checked')
 expect(html).not.toContain('The observation source is not known.')
})
it('renders the one supplied canonical line for unstated intent and provisional provenance', () => {
 const line = presenceLine({ ...p, fact: 'UNKNOWN', observedAt: null })
 line.intent = { label: 'Never stated', tone: 'neutral', sentence: 'No intent has been stated.' }
 line.sentence = 'Provisional: the server derived this record from legacy data.'
 const html = render(createElement(PresenceMark, { presence: p, line, via: null }))
 expect(html).toContain('Never stated')
 expect(html).toContain(line.sentence)
 expect(html).not.toContain('Listed')
 expect(html).not.toContain('success')
})

it('accepts an aggregate canonical line and clock without inventing a member Presence', () => {
 const line = presenceLine({ ...p, fact: 'UNKNOWN', observedAt: null })
 line.intent = { label: '4 listings', tone: 'neutral', sentence: 'This is a distribution.' }
 line.fact = { label: '3 selling · 1 not checked', tone: 'neutral', sentence: 'One observation is missing.' }
 line.sentence = '3 selling · 1 not checked. One observation is missing.'
 const html = render(createElement(PresenceMark, { line, now: p.now }))
 expect(html).toContain('4 listings')
 expect(html).toContain(line.sentence)
 expect(html).not.toContain('Listed')
})

it('separates compact intent and fact cells without duplicating axes or losing the canonical explanation', () => {
 const line = presenceLine(p)
 const intent = render(createElement(PresenceMark, { presence: p, axis: 'intent', compact: true }))
 expect(intent).toContain('nds-tag info')
 expect(intent).not.toContain('nds-pill')
 expect(intent).not.toContain('nds-as-of')
 expect(intent).not.toContain('nds-presence-sentence')
 expect(intent).toContain('tabindex="0"')
 expect(intent).toContain(line.sentence)
 const fact = render(createElement(PresenceMark, { presence: p, axis: 'fact', compact: true }))
 expect(fact).not.toContain('nds-tag')
 expect(fact).toContain('nds-pill success')
 expect(fact).toContain('nds-as-of')
 expect(fact).toContain(line.sentence)
 const unknown = render(createElement(PresenceMark, { presence: p, via: null, compact: true }))
 expect(unknown).not.toContain('channel confirmed')
 expect(unknown).toContain('The observation source is not known.')
})
