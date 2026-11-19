import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import type { Accountants } from './api'
import { designScreen } from './fixtures'
import { accountantRows, blankInvite, changeHeld, changeSaveHeld, endHeld, inviteBody, inviteHeld, inviteProblems, laterEndHeld, mayGive, NS, OWNER_GIVES, OWNER_LATER, rowHeld, writeProblemKey } from './model'

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
  // F-CP-159 (follow-up 13): finance manages the access, the Owner gives it (`give`).
  may: { manage: true, give: false },
}
const OWNER_MAY: Accountants['may'] = { manage: true, give: true }

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
    // F-CP-159: the Owner gives the access (the API's `may.give`, follow-up 13; the other holds as before).
    expect(inviteHeld(null)).toBe('office.held.reading')
    expect(inviteHeld({ ...ANSWER, may: { manage: false, give: true } })).toBe('office.held.noManage')
    expect(inviteHeld({ firms: [], may: OWNER_MAY })).toBe('office.held.noFirm')
    expect(inviteHeld({ ...ANSWER, may: OWNER_MAY })).toBeNull()
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

// ── F-CP-159 (customer page lane, the money wall; the API's B-CP-011) ──
describe('F-CP-159: only the Owner gives the accountant access (it sees our prices)', () => {
  const tOf = (locale: 'it' | 'en', ns: string) => createTranslator(locale, CATALOGUE[locale][ns] ?? {})

  // follow-up 13: who gives it is the API's `may.give` (a live holder of the Owner role), never guessed from the session.
  it('reads who gives the access from the list’s may.give: the Owner yes, finance no, nobody before the list is read', () => {
    expect(mayGive({ may: OWNER_MAY })).toBe(true)
    expect(mayGive({ may: { manage: true, give: false } })).toBe(false)
    expect(mayGive({ may: { manage: false, give: false } })).toBe(false)
    expect(mayGive(null)).toBe(false)
  })

  it('holds Give access for anyone the API does not let give it, before any other reason but the reading', () => {
    expect(inviteHeld(ANSWER)).toBe(OWNER_GIVES)
    expect(inviteHeld({ ...ANSWER, may: { manage: false, give: false } })).toBe(OWNER_GIVES)
    expect(inviteHeld({ firms: [], may: { manage: true, give: false } })).toBe(OWNER_GIVES)
    expect(inviteHeld(null)).toBe('office.held.reading')
    expect(inviteHeld({ ...ANSWER, may: OWNER_MAY })).toBeNull()
  })

  it('a later end is the Owner’s; an earlier end, the same day and an access with no end stay finance’s', () => {
    const row = { accessUntil: '2027-01-31T22:59:59.999Z' }
    expect(laterEndHeld(row, '2027-02-01', false)).toBe(OWNER_LATER)
    expect(laterEndHeld(row, '2027-06-30', false)).toBe(OWNER_LATER)
    expect(laterEndHeld(row, '2027-01-15', false)).toBeNull()
    expect(laterEndHeld(row, '2027-01-31', false)).toBeNull()
    expect(laterEndHeld(row, '2027-02-01', true)).toBeNull()
    expect(laterEndHeld({ accessUntil: null }, '2027-02-01', false)).toBeNull()
    expect(laterEndHeld(row, '', false)).toBeNull()
    // finance keeps changing (shortening) and ending: the row acts are not held by the money wall.
    const [, active] = accountantRows(ANSWER, true)
    expect(changeHeld(active!, true)).toBeNull()
    expect(endHeld(active!, true)).toBeNull()
  })

  it('says the API’s refusal (roleKey / accessUntil onlyOwnerGivesPrices) in the same words, never its English', () => {
    expect(writeProblemKey(new ApiError('forbidden', 403, 'forbidden', 'English', null, [{ path: 'roleKey/onlyOwnerGivesPrices' }]))).toBe(OWNER_GIVES)
    expect(writeProblemKey(new ApiError('forbidden', 403, 'forbidden', 'English', null, [{ path: 'accessUntil/onlyOwnerGivesPrices' }]))).toBe(OWNER_LATER)
  })

  it('reuses the catalogue’s words for the rule (Admin › Security "Who sees prices") in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      expect(t(locale)(OWNER_GIVES)).toBe(tOf(locale, 'admin-security')('sec.priceHolders.hint'))
      for (const key of [OWNER_GIVES, OWNER_LATER, 'moneyWall.changeEarlier']) expect(t(locale)(key), `${locale} ${key}`).not.toBe(key)
    }
    expect(t('en')(OWNER_GIVES)).toBe('Only the Owner gives a role that sees prices.')
    expect(t('it')(OWNER_GIVES)).toBe('Solo il titolare dà un ruolo che vede i prezzi.')
  })

  it('Save the date waits for a later end in words; an earlier day saves; busy, no day and a past day as before', () => {
    const row = { accessUntil: '2027-01-31T22:59:59.999Z' }
    const change = (until: string, busy = false) => ({ row, until, today: '2026-11-19', busy })
    expect(changeSaveHeld(change('2027-03-01'), false)).toBe(OWNER_LATER)
    expect(changeSaveHeld(change('2027-03-01'), true)).toBeNull()
    expect(changeSaveHeld(change('2026-12-20'), false)).toBeNull()
    expect(changeSaveHeld(change('2026-12-20', true), false)).toBe('office.held.busy')
    expect(changeSaveHeld(change(''), false)).toBe('office.invite.problem.until')
    expect(changeSaveHeld(change('2026-11-01'), false)).toBe('office.invite.problem.past')
  })

  it('the design cases: finance and a Sales worker see Give access held in words, the Owner sees it open', () => {
    const entryOf = (id: string) => designScreen.cases.find((item) => item.id === id)!.model
    const draw = (id: string, locale: 'it' | 'en' = 'en') =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view, { model: entryOf(id) })))
    for (const id of ['as-finance', 'as-sales', 'read-only']) {
      expect(entryOf(id).model.owner, id).toBe(false)
      for (const locale of ['it', 'en'] as const) expect(draw(id, locale), `${id} ${locale}`).toContain(t(locale)(OWNER_GIVES))
    }
    expect(entryOf('as-sales').role).toBe('sales')
    expect(entryOf('as-owner').model.owner).toBe(true)
    // follow-up 13: every case reads `owner` from its answer's may.give (the view holds Give access with it)
    for (const entry of designScreen.cases) expect(entry.model.model.owner, entry.id).toBe(entry.model.role === 'owner')
    expect(draw('as-owner')).not.toContain(t('en')(OWNER_GIVES))
    for (const id of ['invite', 'invite-filled', 'invite-every-company', 'invite-refused', 'step-up', 'done', 'change']) expect(entryOf(id).model.owner, id).toBe(true)
    // the change pop-ups (a dialog draws only in the browser): a later day held in words, an earlier day saves, the refusal in words
    const held = (id: string) => {
      const model = entryOf(id).model
      return changeSaveHeld(model.change!, model.owner)
    }
    expect(held('change-later-held')).toBe(OWNER_LATER)
    expect(held('change-earlier')).toBeNull()
    expect(entryOf('change-refused').model.change!.problem).toBe(OWNER_LATER)
    // no price, no amount on any of them
    for (const id of ['as-finance', 'as-sales']) expect(draw(id)).not.toMatch(/€\s?\d|\d+[.,]\d{2}\s?€/)
  })
})
// ── end F-CP-159 ──

const KEY = /\b(?:office|state|notice|held|stepUp|moneyWall)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

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
