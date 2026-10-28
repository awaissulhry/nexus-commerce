import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SignBlock } from './SignBlock'
import { emailLooksValid, emailMatches, nameMatches, nameWords, signCanAccept, signProblems } from './signBlockModel'

describe('typed name, loosely (G12)', () => {
  it('ignores case, accents, punctuation, spacing and word order', () => {
    expect(nameMatches('maria rossi', 'Maria Rossi')).toBe(true)
    expect(nameMatches('  MARIA   ROSSI ', 'Maria Rossi')).toBe(true)
    expect(nameMatches('Rossi Maria', 'Maria Rossi')).toBe(true)
    expect(nameMatches('Rossi, Maria', 'Maria Rossi')).toBe(true)
    expect(nameMatches('Élodie Dupré', 'elodie dupre')).toBe(true)
    expect(nameMatches("Mario D'Amico", 'Mario D Amico')).toBe(true)
    expect(nameMatches('Mario Damico', "Mario D'Amico")).toBe(true)
  })

  it('accepts an extra word (a middle name), never a missing or different one', () => {
    expect(nameMatches('Maria Grazia Rossi', 'Maria Rossi')).toBe(true)
    expect(nameMatches('Maria', 'Maria Rossi')).toBe(false)
    expect(nameMatches('Maria Bianchi', 'Maria Rossi')).toBe(false)
    expect(nameMatches('Mario Rossi', 'Maria Rossi')).toBe(false)
    expect(nameMatches('', 'Maria Rossi')).toBe(false)
    expect(nameMatches('...', 'Maria Rossi')).toBe(false)
  })

  it('splits a name into comparable words', () => {
    expect(nameWords("  José-María  O'Neill ")).toEqual(['jose', 'maria', 'o', 'neill'])
  })
})

describe('email check (G12)', () => {
  it('looks like an address: one @, a dot after it, no spaces', () => {
    expect(emailLooksValid('maria@example.com')).toBe(true)
    expect(emailLooksValid(' maria@example.com ')).toBe(true)
    expect(emailLooksValid('maria@example')).toBe(false)
    expect(emailLooksValid('maria example.com')).toBe(false)
    expect(emailLooksValid('ma ria@example.com')).toBe(false)
  })

  it('is the address the link went to, ignoring case and spaces', () => {
    expect(emailMatches(' Maria@Example.com ', 'maria@example.com')).toBe(true)
    expect(emailMatches('maria@example.org', 'maria@example.com')).toBe(false)
    expect(emailMatches('', '')).toBe(false)
  })
})

describe('sign block validation (G12)', () => {
  const rules = { expectedName: 'Maria Rossi', askEmail: true, expectedEmail: 'maria@example.com', acknowledgements: ['mtm', 'terms'] }

  it('names every problem: empty name, bad email, unticked acknowledgements', () => {
    const p = signProblems({ name: ' ', email: 'maria@', acknowledged: ['terms'] }, rules)
    expect(p).toEqual({ name: 'empty', email: 'invalid', acknowledgements: ['mtm'] })
    expect(signCanAccept(p)).toBe(false)
  })

  it('a different name and another address are mismatches', () => {
    const p = signProblems({ name: 'Maria Bianchi', email: 'maria@example.org', acknowledged: ['mtm', 'terms'] }, rules)
    expect(p.name).toBe('mismatch')
    expect(p.email).toBe('mismatch')
  })

  it('accepts when all hold; without an expected name or email any non-empty name and well-formed address pass', () => {
    expect(signCanAccept(signProblems({ name: 'rossi maria', email: 'MARIA@example.com', acknowledged: ['terms', 'mtm'] }, rules))).toBe(true)
    expect(signCanAccept(signProblems({ name: 'Chiunque', acknowledged: [] }, {}))).toBe(true)
    expect(signProblems({ name: 'X', email: '', acknowledged: [] }, { askEmail: true }).email).toBe('empty')
    expect(signProblems({ name: 'X', email: 'a@b.it', acknowledged: [] }, { askEmail: true }).email).toBeNull()
  })
})

describe('SignBlock markup (G12)', () => {
  const props = {
    title: 'Accetta il preventivo',
    summary: h('p', null, 'Totale 1.200 €'),
    legal: h('p', null, 'Scrivendo il tuo nome accetti.'),
    acknowledgements: [{ id: 'mtm', label: 'Ho letto: su misura, niente reso.' }],
    nameLabel: 'Nome e cognome',
    expectedName: 'Maria Rossi',
    nameEmptyLabel: 'Scrivi nome e cognome',
    nameMismatchLabel: 'Il nome non è quello del preventivo',
    email: { label: 'Email', emptyLabel: 'Scrivi la email', invalidLabel: 'Email non valida' },
    acceptLabel: 'Accetto',
    onAccept: vi.fn(),
    declineLabel: 'Rifiuta',
    onDecline: vi.fn(),
  }

  it('summary, legal, tick, name, email, then Decline before Accept; no error shown before anything is typed', () => {
    const out = render(h(SignBlock, props))
    const order = ['Totale', 'Scrivendo', 'Ho letto', 'Nome e cognome', 'Email', 'Rifiuta', 'Accetto'].map((w) => out.indexOf(w))
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true)
    expect(out).not.toContain('Scrivi nome e cognome')
    expect(out).toMatch(/<form class="nds-sign-form" novalidate=""/i)
    expect(out).toMatch(/type="submit" class="nds-floor-btn primary size-lg"/)
    expect(out).toMatch(/autoComplete="name"/)
    expect(out).toMatch(/type="email"/)
  })

  it('busy holds Accept with its words and makes the fields read-only; held says the link\'s reason on screen', () => {
    const busy = render(h(SignBlock, { ...props, state: 'busy', busyLabel: 'Invio in corso' }))
    expect(busy).toMatch(/aria-busy="true"/)
    expect(busy).toMatch(/type="button" class="nds-floor-btn primary size-lg" aria-disabled="true" aria-description="Invio in corso">.*?nds-floor-btn-label">Invio in corso</)
    expect(busy).toMatch(/readOnly=""/i)
    expect(busy).not.toMatch(/\sdisabled=""/)
    const held = render(h(SignBlock, { ...props, heldReason: 'Questo link è già stato usato' }))
    // Said on screen, not only to a screen reader; Decline is held too.
    expect(held).toMatch(/class="nds-sign-message" data-tone="warning" role="status">Questo link è già stato usato</)
    expect(held.match(/aria-description="Questo link è già stato usato"/g)).toHaveLength(2)
  })

  it('done replaces the form with the app\'s end state, announced', () => {
    const out = render(h(SignBlock, { ...props, state: 'done', done: h('p', null, 'Accettato: copia inviata.') }))
    expect(out).toMatch(/class="nds-sign-done" role="status"/)
    expect(out).toContain('Accettato: copia inviata.')
    expect(out).not.toContain('<form')
    // What was accepted stays in view.
    expect(out).toContain('Totale 1.200 €')
  })
})
