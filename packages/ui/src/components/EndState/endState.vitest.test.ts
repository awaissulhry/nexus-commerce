import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EndState } from './EndState'
import { END_STATE_LABELS } from './EndStateLabels'
import { endStateActionView, endStateSteps, mailtoOf, telOf } from './endStateModel'

/** B-W2b-155 — EndState: what happened, what happens next, your copy, the reference, whom to contact. */
describe('endStateActionView', () => {
  it('acts by default; held with its reason; busy and done hold with their words', () => {
    expect(endStateActionView({ label: 'Ask for a new link' }, 'Working…')).toEqual({ words: 'Ask for a new link', held: null })
    expect(endStateActionView({ label: 'Pay', heldReason: 'Nothing left to pay' }, 'Working…')).toEqual({ words: 'Pay', held: 'Nothing left to pay' })
    expect(endStateActionView({ label: 'Ask', busy: true }, 'Working…')).toEqual({ words: 'Working…', held: 'Working…' })
    expect(endStateActionView({ label: 'Ask', done: 'Asked — we passed it on', busy: true }, 'Working…')).toEqual({ words: 'Asked — we passed it on', held: 'Asked — we passed it on' })
  })
})

describe('contact links', () => {
  it('mailto and tel only for something that looks like one', () => {
    expect(mailtoOf('anna@brand.example')).toBe('mailto:anna@brand.example')
    expect(mailtoOf('not an address')).toBeNull()
    expect(mailtoOf('a@b')).toBeNull()
    expect(telOf('+39 0721 123 456')).toBe('tel:+390721123456')
    expect(telOf('(0721) 12-34')).toBe('tel:07211234')
    expect(telOf('call us')).toBeNull()
    expect(telOf(null)).toBeNull()
  })
})

describe('endStateSteps', () => {
  it('an array as given without empties; one node as one; nothing as none', () => {
    expect(endStateSteps(['a', '', null, 'b'])).toEqual(['a', 'b'])
    expect(endStateSteps('one')).toEqual(['one'])
    expect(endStateSteps(undefined)).toEqual([])
  })
})

describe('EndState markup', () => {
  const html = renderToStaticMarkup(
    createElement(EndState, {
      title: 'Accettato — grazie, Anna.',
      body: 'Abbiamo inviato una copia ad anna@brand.example.',
      next: ['Versate l’acconto entro il 20 nov.', 'Confermiamo l’ordine entro 1 giorno lavorativo.'],
      facts: [{ label: 'Accettato da', value: 'Anna Rossi' }],
      reference: { value: 'Q-2026-0042' },
      copy: { href: '/files/q.pdf', fileName: 'Q-2026-0042.pdf' },
      actions: [{ label: 'Chiedi un nuovo link', done: 'Richiesto — l’abbiamo inoltrato' }],
      contact: { name: 'Marco Demo', email: 'marco@factory.example', phone: '+39 0721 000 000' },
      labels: {
        next: 'Cosa succede ora',
        receipt: 'La vostra ricevuta',
        reference: 'Riferimento',
        copyReference: (v: string) => `Copia il riferimento ${v}`,
        yourCopyNamed: (f: string) => `Scarica la vostra copia (${f})`,
        contact: 'Domande?',
        emailTo: (n: string) => `Scrivi a ${n}`,
        callTo: (n: string) => `Chiama ${n}`,
      },
    }),
  )
  it('the headline is a focusable heading that names the section', () => {
    expect(html).toMatch(/<section class="nds-endstate" data-tone="success" aria-labelledby="([^"]+)"><div class="nds-endstate-head">.*<h2 id="\1" tabindex="-1" class="nds-endstate-title">Accettato — grazie, Anna\.<\/h2>/)
  })
  it('the next steps are an ordered list; the receipt a description list', () => {
    expect(html).toContain('<ol class="nds-endstate-steps"><li>Versate')
    expect(html).toContain('<dt>Accettato da</dt><dd>Anna Rossi</dd>')
  })
  it('the reference copies, your copy downloads, the contact is real links — all in the page\'s words', () => {
    expect(html).toContain('aria-label="Copia il riferimento Q-2026-0042"')
    expect(html).toMatch(/<a href="\/files\/q\.pdf" download="Q-2026-0042\.pdf" class="nds-btn">.*Scarica la vostra copia \(Q-2026-0042\.pdf\)<\/a>/)
    expect(html).toContain('href="mailto:marco@factory.example"')
    expect(html).toContain('href="tel:+390721000000"')
    for (const english of Object.values(END_STATE_LABELS).filter((w): w is string => typeof w === 'string' && w !== 'Copied' && w !== 'Working…' && !w.startsWith('Could not'))) {
      expect(html).not.toContain(`>${english}<`)
    }
  })
  it('a done action is held with its words (pressed once)', () => {
    expect(html).toMatch(/aria-disabled="true" aria-description="Richiesto — l’abbiamo inoltrato"/)
  })
  it('a dead link: neutral, its own icon, no receipt blocks', () => {
    const dead = renderToStaticMarkup(createElement(EndState, { tone: 'neutral', title: 'This link no longer opens.', actions: [{ label: 'Ask for a new link', variant: 'primary', onClick: () => {} }] }))
    expect(dead).toContain('data-tone="neutral"')
    expect(dead).not.toContain('nds-endstate-block')
    expect(dead).toContain('class="nds-btn primary"')
  })
})
