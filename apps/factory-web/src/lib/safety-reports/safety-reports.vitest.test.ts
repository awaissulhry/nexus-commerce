import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { intakeProblems } from '@nexus/factory-domain/sales/safety-reports/rules'
import { ApiError } from '../api/errors'
import type { DesignScreen } from '../design/design-screen'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { designScreen as publicScreen } from '../../links/public-doc/report/fixtures'
import { designScreen as portalScreen } from '../../portal/customer/returns/safety/fixtures'
import { safetyHeldOf } from '../../portal/customer/returns/safety/model'
import { FRESH_DIALOG, sendHeld, shownProblems } from './dialog'
import { EMPTY_INTAKE, intakeBodyOf, intakeDirty, intakeFieldProblems, NS, patchIntake, sendRefusalOf, waitOf, type IntakeDraft } from './intake'
import { photoName } from './photos'

/**
 * B-W2b-357: the safety report's shared form (the public DoC page, the portal, the office) says factory-domain's own rules,
 * never sends the injury words without someone hurt and the consent tick, names a refusal in words, and every design case
 * of the two doors from outside draws in both languages with no key on screen.
 */

const TODAY = '2026-11-12'
const FILLED: IntakeDraft = { ...EMPTY_INTAKE, serial: 'SN-1', whatHappened: 'The seam opened.', injured: false }

describe('the form says factory-domain’s rules, field by field', () => {
  const cases: Array<[string, IntakeDraft, 'public' | 'portal' | 'office', string | null, Record<string, string>]> = [
    ['empty from outside: what happened, anyone hurt, the serial or batch', EMPTY_INTAKE, 'public', null, { whatHappened: 'problem.whatHappened', injured: 'problem.injured', serial: 'problem.serialOrBatch' }],
    ['empty in the office: only what happened', EMPTY_INTAKE, 'office', null, { whatHappened: 'problem.whatHappened' }],
    ['a batch page needs no serial', { ...EMPTY_INTAKE, whatHappened: 'x', injured: false }, 'public', 'L-1', {}],
    ['an accident asks the day and the place', { ...FILLED, accident: true }, 'portal', null, { occurredOn: 'problem.occurredOnNeeded', place: 'problem.placeNeeded' }],
    ['hurt: the day and the place; words without the tick never leave', { ...FILLED, injured: true, injuryWords: 'cut' }, 'public', null, { occurredOn: 'problem.occurredOnNeeded', place: 'problem.placeNeeded' }],
    ['a day in the future', { ...FILLED, occurredOn: '2026-12-01' }, 'office', null, { occurredOn: 'problem.occurredOnFuture' }],
    ['a bad e-mail', { ...FILLED, email: 'nope' }, 'public', null, { email: 'problem.email' }],
  ]
  for (const [name, draft, door, batch, expected] of cases) {
    it(name, () => {
      expect(intakeFieldProblems(draft, door, TODAY, batch)).toEqual(expected)
      // The same facts, as the API checks them, refuse the same fields (factory-domain's own rule).
      const paths = intakeProblems(intakeBodyOf(draft, door, batch), TODAY, door !== 'office').map((issue) => issue.path.replace('body/reporter/', '').replace('body/', ''))
      expect([...new Set(paths)].sort()).toEqual(Object.keys(expected).sort())
    })
  }

  it('the injury words go only with someone hurt AND the consent; the portal sends no reporter; the QR’s batch wins', () => {
    expect(intakeBodyOf({ ...FILLED, injured: true, injuryWords: 'cut' }, 'public').injuryWords).toBeNull()
    expect(intakeBodyOf({ ...FILLED, injured: true, consent: true, injuryWords: ' cut ' }, 'public')).toMatchObject({ injuryWords: 'cut', injuryConsent: true })
    expect(intakeBodyOf({ ...FILLED, injured: false, consent: true, injuryWords: 'cut' }, 'public')).toMatchObject({ injuryWords: null, injuryConsent: null })
    expect(intakeBodyOf({ ...FILLED, name: 'A', email: 'a@example.com' }, 'portal').reporter).toBeNull()
    expect(intakeBodyOf({ ...FILLED, name: 'A' }, 'public').reporter).toEqual({ name: 'A', email: null, phone: null })
    expect(intakeBodyOf({ ...FILLED, batchNumber: 'typed' }, 'public', 'L-QR').batchNumber).toBe('L-QR')
    expect(patchIntake({ ...FILLED, injured: true, consent: true }, { injured: false }).consent).toBe(false)
    expect(intakeDirty(EMPTY_INTAKE)).toBe(false)
    expect(intakeDirty(FILLED)).toBe(true)
  })
})

describe('a refusal in words', () => {
  const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, issues: { path: string; message: string }[]) => new ApiError(kind, status, kind, 'x', null, issues)
  it('the door closed, a wait, a device check, the fields, an unknown code, a role that does not send', () => {
    expect(sendRefusalOf(error('conflict', 409, [{ path: 'held/OFF', message: 'x' }]), FILLED, 'public').key).toBe('refused.off')
    expect(sendRefusalOf(error('conflict', 409, [{ path: 'held/OFF', message: 'x' }]), FILLED, 'portal').key).toBe('refused.offPortal')
    expect(sendRefusalOf(error('rate_limited', 429, [{ path: 'retryAfter', message: '125' }]), FILLED, 'public')).toMatchObject({ key: 'refused.wait', waitSeconds: 125 })
    expect(sendRefusalOf(error('rate_limited', 429, [{ path: 'challenge', message: 'x' }]), FILLED, 'public')).toMatchObject({ key: 'refused.check', challenge: true })
    expect(sendRefusalOf(error('invalid', 400, [{ path: 'body/reporter/email', message: 'x' }]), FILLED, 'public')).toMatchObject({ key: 'refused.fields', fields: { email: 'problem.email' } })
    expect(sendRefusalOf(error('not_found', 404, []), FILLED, 'public').key).toBe('refused.unknownCode')
    expect(sendRefusalOf(error('forbidden', 403, []), FILLED, 'portal').key).toBe('refused.forbidden')
    expect(waitOf(125)).toEqual({ unit: 'minutes', count: 3 })
    expect(waitOf(20)).toEqual({ unit: 'seconds', count: 20 })
  })

  it('Send waits with why; the problems show after Next', () => {
    expect(sendHeld({ ...FRESH_DIALOG, busy: true })).toBe('dialog.sending')
    expect(sendHeld({ ...FRESH_DIALOG, busy: true, checking: true })).toBe('dialog.checking')
    expect(sendHeld({ ...FRESH_DIALOG, refusal: { key: 'refused.wait', wait: { unit: 'minutes', count: 3 } } })).toBe('held.wait')
    expect(sendHeld(FRESH_DIALOG, true)).toBe('held.offline')
    expect(shownProblems(FRESH_DIALOG, 'public', TODAY, null)).toEqual({})
    expect(Object.keys(shownProblems({ ...FRESH_DIALOG, tried: true }, 'public', TODAY, null))).toEqual(expect.arrayContaining(['whatHappened', 'injured', 'serial']))
    expect(photoName('PSR-2026-0007', 2)).toBe('PSR-2026-0007-photo-2.jpg')
  })
})

describe('the portal’s openers say why they wait (GATE-PRIVACY first)', () => {
  const status = (over: Partial<{ open: boolean; mayRequest: boolean }>) => ({ state: 'read' as const, status: { open: true, words: null, mayRequest: true, mayUpload: true, ...over } })
  it('closed, a role that does not send, a preview, offline, reading', () => {
    expect(safetyHeldOf(status({ open: false }), { offline: false, preview: false })).toBe('portal.held.closed')
    expect(safetyHeldOf(status({ mayRequest: false, open: false }), { offline: false, preview: false })).toBe('portal.held.noRequest')
    expect(safetyHeldOf(status({}), { offline: false, preview: true })).toBe('portal.held.preview')
    expect(safetyHeldOf(status({}), { offline: true, preview: false })).toBe('portal.held.offline')
    expect(safetyHeldOf({ state: 'loading' }, { offline: false, preview: false })).toBe('portal.held.reading')
    expect(safetyHeldOf(status({}), { offline: false, preview: false })).toBeNull()
  })
})

const LEFT_KEY = /\b(?:common|held|intake|review|problem|refused|dialog|photos|scan|public|portal|register|list|log|record|accident|authority|garment|status|source|outcome|viewName|new|row|keys|noAccess|read|receipt)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case of the doors from outside draws in both languages with no key on screen', () => {
  for (const screen of [publicScreen, portalScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:portal|files|threads|sales|public|returns)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
            .replace(/\bart\.\s?\d+/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the catalogue has every key in both languages', () => {
    for (const locale of LOCALES) expect(Object.keys(CATALOGUE[locale][NS] ?? {}).length).toBe(Object.keys(CATALOGUE.it[NS] ?? {}).length)
  })
})
