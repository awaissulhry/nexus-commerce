import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { everyCase, leftKeys, render, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import {
  CHECK_WARNINGS,
  chipWords,
  classify,
  cleanAddress,
  confirmHeld,
  defaultSubject,
  defaultTo,
  RECIPIENT_KINDS,
  recipientsHeld,
  sendBody,
  suggestions,
  warningLines,
  type Recipient,
  type SendCheck,
} from './model'
import { Recipients } from './view/Recipients'

/** B-TH-207 — To and Cc, the send check with its 6 warnings, another customer's address refused unless ticked, the text kept. */

const alpha = [BRAND_ALPHA.contact, BRAND_ALPHA.portalPerson].map((person) => ({ name: person.name, email: person.email }))
const bruno: Recipient = { address: BRAND_BETA.contact.email, name: BRAND_BETA.contact.name, kind: 'OTHER_PARTY', organisation: BRAND_BETA.tradeName }
const check = (more: Partial<SendCheck> = {}): SendCheck => ({ party: { id: 'a', name: BRAND_ALPHA.tradeName }, recipients: [], warnings: [], attachments: [], outsideCustomer: [], ...more })

describe('the codes are the API’s (the mis-send read)', () => {
  // B-TH-280: the old record panels' guard (shell/panels/mis-send) went; the codes are compared with the API's own list
  // (apps/factory-api platform/email-out/mis-send/rules.ts MIS_SEND_WARNINGS, RECIPIENT_KINDS) as written there.
  it('the same six warnings and four recipient kinds as the API', () => {
    expect([...CHECK_WARNINGS]).toEqual(['OTHER_ORGANISATION', 'UNKNOWN_RECIPIENT', 'MENTIONS_COST', 'NAMES_OTHER_CUSTOMER', 'INTERNAL_MENTION', 'OFFICE_FILE'])
    expect([...RECIPIENT_KINDS]).toEqual(['PARTY', 'OTHER_PARTY', 'OURS', 'UNKNOWN'])
  })
})

describe('To suggests only this customer’s contacts (W21)', () => {
  it('matches name or address, leaves out who is already on the lines, offers a typed address as it is', () => {
    expect(suggestions('', alpha, []).contacts.map((contact) => contact.name)).toEqual([BRAND_ALPHA.contact.name, BRAND_ALPHA.portalPerson.name])
    expect(suggestions('anna', alpha, []).contacts.map((contact) => contact.name)).toEqual([BRAND_ALPHA.portalPerson.name])
    expect(suggestions('', alpha, [BRAND_ALPHA.contact.email]).contacts).toHaveLength(1)
    expect(suggestions(BRAND_BETA.contact.email, alpha, [])).toEqual({ contacts: [], free: BRAND_BETA.contact.email })
    expect(suggestions('bruno', alpha, []).contacts).toEqual([])
    expect(suggestions(BRAND_ALPHA.contact.email, alpha, []).free).toBeNull()
  })

  it('the rendered suggestions never hold another customer’s people', () => {
    const html = render(createElement(Recipients, { to: [], cc: [], subject: 'Re: x', contacts: alpha, partyName: BRAND_ALPHA.tradeName, onChange: () => undefined }))
    expect(scanText(textOf(html), BRAND_BETA)).toEqual([])
  })

  it('cleans an address as the API takes it', () => {
    expect(cleanAddress(' <Alma.Alfieri@Brand-Alpha.example> ')).toBe('alma.alfieri@brand-alpha.example')
    expect(cleanAddress('not an address')).toBeNull()
  })
})

describe('each chip with its organisation', () => {
  it('the check names whose an address is: another customer in red, unknown in amber', () => {
    const typed: Recipient = { address: bruno.address, name: null, kind: null, organisation: null }
    const classified = classify(typed, check({ recipients: [{ address: bruno.address, kind: 'OTHER_PARTY', source: 'CONTACT', organisation: { id: 'b', name: BRAND_BETA.tradeName }, personName: BRAND_BETA.contact.name }] }))
    expect(classified).toEqual(bruno)
    expect(chipWords(bruno)).toEqual({ key: 'chip.other', params: { org: BRAND_BETA.tradeName } })
    expect(chipWords({ ...typed, kind: 'UNKNOWN' })).toEqual({ key: 'chip.unknown' })
    expect(chipWords(typed)).toEqual({ key: 'chip.checking' })
    const html = render(createElement(Recipients, { to: [bruno], cc: [], subject: 'Re: x', contacts: alpha, partyName: BRAND_ALPHA.tradeName, onChange: () => undefined }))
    expect(html).toContain('fw-rt-chip is-other')
    expect(textOf(html)).toContain(`${BRAND_BETA.contact.name} ${BRAND_BETA.tradeName} — another customer`)
  })

  it('a reply opens with the record’s contact in To and a subject', () => {
    expect(defaultTo(alpha, BRAND_ALPHA.tradeName)).toEqual([{ address: BRAND_ALPHA.contact.email, name: BRAND_ALPHA.contact.name, kind: 'PARTY', organisation: BRAND_ALPHA.tradeName }])
    expect(defaultTo([], 'x')).toEqual([])
    expect(defaultSubject('Label position', 'SO-1')).toBe('Re: Label position')
    expect(defaultSubject('Re: Label position', 'SO-1')).toBe('Re: Label position')
    expect(defaultSubject(null, 'SO-1')).toBe('SO-1')
  })

  it('a reply needs a recipient, at most 50 addresses and a subject under 200 characters', () => {
    expect(recipientsHeld([], [], 'x')).toEqual({ key: 'held.noRecipient' })
    expect(recipientsHeld(Array.from({ length: 51 }, (_, i) => ({ ...bruno, address: `${i}@x.example` })), [], 'x')).toEqual({ key: 'held.tooMany', params: { max: 50 } })
    expect(recipientsHeld([bruno], [], 'x'.repeat(201))).toEqual({ key: 'held.subject', params: { max: 200 } })
    expect(recipientsHeld([bruno], [], 'x')).toBeNull()
  })
})

describe('the send check', () => {
  it('another customer’s address waits for the tick; an office file waits for the text; a failed check lets the send go', () => {
    const outside = check({ outsideCustomer: [bruno.address] })
    expect(confirmHeld({ status: 'ready', check: outside }, { outside: false }, false)).toBe('check.held.outside')
    expect(confirmHeld({ status: 'ready', check: outside }, { outside: true }, false)).toBeNull()
    expect(confirmHeld({ status: 'ready', check: check({ warnings: [{ code: 'OFFICE_FILE', items: ['a.xlsx'] }] }) }, { outside: true }, false)).toBe('check.held.officeFile')
    expect(confirmHeld({ status: 'checking' }, { outside: false }, false)).toBe('check.held.checking')
    expect(confirmHeld({ status: 'error', problem: 'problem.unavailable', retry: true }, { outside: false }, false)).toBeNull()
    expect(confirmHeld({ status: 'error', problem: 'problem.forbidden', retry: false }, { outside: false }, false)).toBe('check.held.refused')
    expect(confirmHeld({ status: 'ready', check: check() }, { outside: false }, true)).toBe('check.held.sending')
    expect(confirmHeld({ status: 'ready', check: check({ warnings: [{ code: 'MENTIONS_COST', items: ['price'] }] }) }, { outside: false }, false)).toBeNull()
  })

  it('all six warnings in the picture’s order, with words in both languages', () => {
    const all = check({ warnings: [...CHECK_WARNINGS].reverse().map((code) => ({ code, items: ['x'] })) })
    expect(warningLines(all).map((line) => line.code)).toEqual([...CHECK_WARNINGS])
    expect(warningLines(all).filter((line) => line.blocking).map((line) => line.code)).toEqual(['OFFICE_FILE'])
  })

  it('the tick goes with the send only when given (the API records it); To and Cc apart', () => {
    expect(sendBody({ to: [bruno], cc: [], subject: ' ', body: 'Hi', attachments: ['f'], outside: false })).toEqual({ to: [bruno.address], body: 'Hi', attachments: ['f'] })
    expect(sendBody({ to: [bruno], cc: [{ ...bruno, address: 'c@x.example' }], subject: 'Re: a', body: 'Hi', attachments: [], outside: true })).toEqual({ to: [bruno.address], cc: ['c@x.example'], subject: 'Re: a', body: 'Hi', attachments: [], sendOutside: true })
  })
})

describe('SCR-006-send in both languages', () => {
  const cases = everyCase(designScreen)
  it('every case draws, with no message key left on screen', () => {
    for (const [locale, id, html] of cases) expect(leftKeys(html, ['chip', 'held', 'who', 'check', 'problem', 'outside', 'warning', 'notice', 'mode', 'mark', 'send']), `${locale} ${id}`).toEqual([])
  })

  it('the brand wall: on Brand Beta’s order nothing of Brand Alpha (B-TH-203)', () => {
    for (const [locale, id, html] of cases) {
      if (id !== 'brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(locale === 'en' ? `Send to ${BRAND_BETA.tradeName}` : `Invia a ${BRAND_BETA.tradeName}`)
    }
  })
})
