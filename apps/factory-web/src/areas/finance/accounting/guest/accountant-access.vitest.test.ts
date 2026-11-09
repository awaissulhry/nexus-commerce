import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import type { Accountants } from './api'
import { designScreen } from './fixtures'
import { accountantRows, blankInvite, changeHeld, endHeld, inviteBody, inviteHeld, inviteProblems, NS, rowHeld, writeProblemKey } from './model'

/**
 * Accountant access on Finance › Close (B-W2b-201; SCR-268-office), the pure part: one list of every firm's accountants, what
 * holds each act and why, the invite draft and its problems, the refusals by issue path, and every design case drawn with no
 * key on screen.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const id = (n: number) => `0190f0e2-2681-7000-8000-${String(n).padStart(12, '0')}`
const person = (n: number, displayName: string, status: Accountants['firms'][number]['people'][number]['status'], over: Partial<Accountants['firms'][number]['people'][number]> = {}) => ({
  id: id(n),
  displayName,
  email: `${displayName.toLowerCase().split(' ')[0]}@studio.example`,
  status,
  accessUntil: '2027-01-31T22:59:59.999Z',
  endsSoon: false,
  ended: false,
  lastSignInAt: null,
  invitationExpiresAt: status === 'INVITED' ? '2026-11-20T10:00:00.000Z' : null,
  version: 1,
  ...over,
})
const ANSWER: Pick<Accountants, 'firms' | 'may'> = {
  firms: [
    { party: { id: id(1), code: 'STUDIO', name: 'Studio Esempio', everyCompany: false }, portalOn: true, people: [person(11, 'Zoe Esempio', 'ACTIVE'), person(12, 'Anna Esempio', 'DEACTIVATED'), person(13, 'Bruno Esempio', 'INVITED')] },
    { party: { id: id(2), code: 'REVISORI', name: 'Revisori Fittizi', everyCompany: true }, portalOn: false, people: [] },
  ],
  may: { manage: true },
}

describe('who has access', () => {
  it('every firm’s accountants in one list, by name; those whose access ended only when asked, last', () => {
    expect(accountantRows(ANSWER, false).map((row) => [row.displayName, row.firmName])).toEqual([
      ['Bruno Esempio', 'Studio Esempio'],
      ['Zoe Esempio', 'Studio Esempio'],
    ])
    expect(accountantRows(ANSWER, true).map((row) => row.displayName)).toEqual(['Bruno Esempio', 'Zoe Esempio', 'Anna Esempio'])
  })

  it('holds each act with the reason', () => {
    const [invited, active, ended] = accountantRows(ANSWER, true)
    expect(rowHeld(ended!)).toBe('office.held.left')
    expect(rowHeld(active!)).toBeNull()
    expect(changeHeld(active!, false)).toBe('office.held.noManage')
    expect(changeHeld(ended!, true)).toBe('office.held.left')
    expect(endHeld(invited!, true)).toBeNull()
    expect(endHeld({ ...invited!, invitationExpiresAt: null }, true)).toBe('office.held.expired')
    expect(inviteHeld(null)).toBe('office.held.reading')
    expect(inviteHeld({ ...ANSWER, may: { manage: false } })).toBe('office.held.noManage')
    expect(inviteHeld({ firms: [], may: { manage: true } })).toBe('office.held.noFirm')
    expect(inviteHeld(ANSWER)).toBeNull()
  })
})

describe('the invite', () => {
  it('starts with the only firm and three months; every field says what is missing; the end is the whole day', () => {
    const draft = blankInvite([ANSWER.firms[0]!], '2026-11-09')
    expect(draft).toMatchObject({ partyId: id(1), locale: 'it', until: '2027-02-09' })
    expect(blankInvite(ANSWER.firms, '2026-11-09').partyId).toBe('')
    expect(inviteProblems({ ...draft, until: '2026-11-08' }, '2026-11-09')).toEqual({ displayName: 'office.invite.problem.name', email: 'office.invite.problem.email', until: 'office.invite.problem.past' })
    const ready = { ...draft, displayName: ' Marta Esempio ', email: ' marta@studio.example ' }
    expect(inviteProblems(ready, '2026-11-09')).toEqual({})
    const body = inviteBody(id(3), ready)
    expect(body).toMatchObject({ companyId: id(3), partyId: id(1), displayName: 'Marta Esempio', email: 'marta@studio.example', locale: 'it' })
    expect(new Date(body.accessUntil).getTime()).toBeGreaterThan(Date.parse('2027-02-09T00:00:00Z'))
  })

  it('says a refusal from its issue path or its kind, never the API’s English', () => {
    expect(writeProblemKey(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'partyId' }]))).toBe('office.problem.firm')
    expect(writeProblemKey(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'email' }]))).toBe('office.problem.email')
    expect(writeProblemKey(new ApiError('conflict', 409, 'conflict', 'English'))).toBe('office.problem.conflict')
    expect(writeProblemKey(new ApiError('forbidden', 403, 'forbidden', 'English'))).toBe('office.problem.forbidden')
    for (const locale of ['it', 'en'] as const) {
      for (const key of ['office.problem.firm', 'office.problem.email', 'office.problem.until', 'office.problem.conflict', 'office.problem.forbidden', 'office.problem.invalid', 'office.problem.unavailable', 'office.problem.generic']) expect(t(locale)(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})

const KEY = /\b(?:office|state|notice|held|stepUp)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-268-office design cases', () => {
  it('every case draws in Italian and English with no key on screen and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(15)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })
})
