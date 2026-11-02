import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTENDANCE_SETTINGS, workedExample } from '@nexus/factory-domain/people/attendance/rules'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { LAW_VALUES } from '@nexus/factory-domain/people/limits/rules'
import { gateDriftNotes, gateReadiness } from '@nexus/factory-domain/people/privacy/gate'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { CompanyPrivacy, LimitEntry } from './api'
import { designScreen as settingsScreen } from './fixtures'
import { designScreen as historyScreen } from './history/fixtures'
import { HISTORY_ACTIONS, historyWords } from './history/view/HistoryView'
import { ABSENCE_CATEGORIES, basisCanCoverLeads, blankCode, codeHeld, exampleOf, gateReasonHeld, isChecked, limitBodyOf, limitDraftOf, limitHeld, limitsChanged, noteWords, privacyDirty, privacyHeld, privacyWidens, ROUNDING_CHOICES, roundingChanges, roundingHeld, RULE_KINDS, settingsCan, settingsProblem } from './model'

/**
 * People › People settings (SCR-265; B-W2b-65): who may do what, the worked example in words beside the domain's, what a
 * limit sends and what the law holds, which privacy change widens (a reason and a code) and which narrows (never asks), the
 * API's sentences said in our words, and every design case in both languages with no key left.
 */

const template = (key: string) => [...(templateOf(key)?.permissions ?? [])]

describe('settings: who may do what', () => {
  it('reads each section from its own right', () => {
    expect(settingsCan(template('admin'))).toMatchObject({ privacy: true, managePrivacy: false, attendance: true, manageAttendance: true, limits: true, manageLimits: true })
    expect(settingsCan(template('production_manager'))).toMatchObject({ privacy: true, manageAttendance: false, manageLimits: false })
    expect(settingsCan(template('sales'))).toMatchObject({ privacy: false, attendance: false, limits: false })
  })
})

describe('settings: rounding', () => {
  it('says as many lines as the domain, for every kind of setting', () => {
    for (const roundingMinutes of ROUNDING_CHOICES) {
      for (const settings of [DEFAULT_ATTENDANCE_SETTINGS, { ...DEFAULT_ATTENDANCE_SETTINGS, roundingMinutes, lateGraceMinutes: 5, earlyClockInFromShiftStart: false, autoClockOutAfterMinutes: 30, fixedBreaks: false, overtimeUnitMinutes: 5 }]) {
        expect(exampleOf(settings)).toHaveLength(workedExample(settings).length)
      }
    }
  })

  it('agrees with the domain on the times it writes', () => {
    const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5, roundingMinutes: 15 }
    const en = createTranslator('en', messagesFor('en', ['people-settings'])['people-settings']!)
    const ours = exampleOf(settings).map((line) => en(line.key, line.params))
    expect(ours).toEqual(workedExample(settings))
  })

  it('counts the changes and holds a value out of range', () => {
    expect(roundingChanges(DEFAULT_ATTENDANCE_SETTINGS, DEFAULT_ATTENDANCE_SETTINGS)).toBe(0)
    expect(roundingChanges(DEFAULT_ATTENDANCE_SETTINGS, { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5, fixedBreaks: false })).toBe(2)
    expect(roundingHeld({ ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 61 })).toBe('rounding.problem.lateGraceMinutes')
    expect(roundingHeld(DEFAULT_ATTENDANCE_SETTINGS)).toBeNull()
  })
})

describe('settings: absence codes', () => {
  it('holds a code until it has its code and Italian name', () => {
    expect(codeHeld(blankCode())).toBe('code.problem.code')
    expect(codeHeld({ ...blankCode(), code: 'FER' })).toBe('code.problem.labelI18n')
    expect(codeHeld({ ...blankCode(), code: 'FER', nameIt: 'Ferie' })).toBeNull()
  })
})

const entry = (kind: LimitEntry['kind'], over: Partial<LimitEntry> = {}): LimitEntry => ({ kind, inForce: null, own: null, law: { limitMinutes: LAW_VALUES[kind].limitMinutes, breakMinutes: LAW_VALUES[kind].breakMinutes, referenceMonths: LAW_VALUES[kind].referenceMonths, legalReference: LAW_VALUES[kind].legalReference }, ...over })

describe('settings: working-time limits', () => {
  it('starts from the law when nothing is on record', () => {
    expect(limitDraftOf(entry('DAILY_REST'))).toMatchObject({ hours: 11, action: 'WARN', source: 'LAW' })
    expect(limitDraftOf(entry('WEEKLY_AVERAGE'))).toMatchObject({ hours: 48, referenceMonths: 4 })
    expect(limitDraftOf(entry('OVERTIME_YEARLY_CAP')).hours).toBe(250)
  })

  it('sends only what differs, with the version of this very scope, in minutes', () => {
    const row = entry('DAILY_REST')
    const draft = { ...limitDraftOf(row), action: 'BLOCK' as const }
    expect(limitsChanged([row], { DAILY_REST: limitDraftOf(row) })).toEqual([])
    expect(limitsChanged([row], { DAILY_REST: draft })).toEqual([draft])
    expect(limitBodyOf(draft, row, { companyId: 'c', siteId: 's' })).toMatchObject({ companyId: 'c', siteId: 's', version: null, limitMinutes: 660, breakMinutes: null, referenceMonths: null, action: 'BLOCK' })
  })

  it('a value looser than the law is held unless a CCNL allows it', () => {
    const draft = { ...limitDraftOf(entry('DAILY_REST')), hours: 9 }
    expect(limitHeld(draft)).toBe('limits.problem.limitMinutes')
    expect(limitHeld({ ...draft, source: 'CCNL', legalReference: 'CCNL Demo art. 7' })).toBeNull()
    expect(limitHeld({ ...draft, source: 'CCNL', legalReference: ' ' })).toBe('limits.problem.legalReference')
  })

  it('says which limits nothing checks yet', () => {
    expect(RULE_KINDS.filter((kind) => !isChecked(kind))).toEqual(['WEEKLY_REST', 'NIGHT_AVERAGE'])
  })
})

const company = (over: Partial<CompanyPrivacy['settings']> = {}): CompanyPrivacy => ({ company: { id: 'c', code: 'C', name: 'C' }, settings: { minimumGroupSize: 5, figureRoleKeys: ['admin'], version: 1, ...over }, named: [], roles: [] })

describe('settings: privacy', () => {
  it('widening needs a reason; narrowing never asks', () => {
    const value = company()
    const base = { minimumGroupSize: 5, figureRoleKeys: ['admin'], reason: '' }
    expect(privacyDirty(value, base)).toBe(false)
    expect(privacyWidens(value, { ...base, minimumGroupSize: 4 })).toBe(true)
    expect(privacyWidens(value, { ...base, figureRoleKeys: ['admin', 'hr'] })).toBe(true)
    expect(privacyWidens(value, { ...base, minimumGroupSize: 6 })).toBe(false)
    expect(privacyWidens(value, { ...base, figureRoleKeys: [] })).toBe(false)
    expect(privacyHeld(value, { ...base, minimumGroupSize: 4 })).toBe('privacy.problem.reason')
    expect(privacyHeld(value, { ...base, minimumGroupSize: 4, reason: 'accordo RSU' })).toBeNull()
    expect(privacyHeld(value, { ...base, minimumGroupSize: 6 })).toBeNull()
    expect(privacyHeld(value, { ...base, minimumGroupSize: 2, reason: 'accordo RSU' })).toBe('privacy.problem.size')
  })

  it('only an agreement or an authorisation can cover leads, and a gate needs a reason', () => {
    expect(basisCanCoverLeads('UNION_AGREEMENT')).toBe(true)
    expect(basisCanCoverLeads('NOT_REQUIRED')).toBe(false)
    expect(gateReasonHeld('no')).toBe('gate.problem.reason')
    expect(gateReasonHeld('pronti')).toBeNull()
  })

  it('every sentence the API says about a gate has our words', () => {
    const facts = { purpose: 'PERFORMANCE' as const, workerNotice: null, dpia: { id: 'd', versionNo: 2, reviewDueOn: '2026-01-01' }, siteBasis: null, scanSubject: 'STATION' as const, today: '2026-11-02' }
    const notes = [
      ...gateReadiness(facts).notes,
      ...gateDriftNotes({ gate: { noticeId: 'old', dpiaId: 'old', basisKind: 'NOT_REQUIRED', basisReference: 'a', purpose: 'PERFORMANCE' }, workerNotice: { id: 'new' }, dpia: { id: 'new' }, siteBasis: { kind: 'UNION_AGREEMENT', reference: 'b' } } as never),
    ]
    expect(notes.length).toBeGreaterThanOrEqual(2)
    for (const note of notes) expect(noteWords(note).key, note).not.toBe('note.other')
    expect(noteWords('Dpia review').key).toBe('note.other')
    expect(noteWords(gateReadiness(facts).notes[0]!).params).toEqual({ version: '2', day: '2026-01-01' })
  })

  it('reads a refusal by its field, the code taken, else the shared words', () => {
    expect(settingsProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/CODE_TAKEN' }]))).toEqual({ ns: 'settings', words: { key: 'field.codeTaken' } })
    expect(settingsProblem(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/legalReference' }]))).toEqual({ ns: 'settings', words: { key: 'field.legalReference' } })
    expect(settingsProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ ns: 'people', words: { key: 'problem.conflict' } })
  })
})

describe('settings: the audit window', () => {
  it('says each action of these settings; another is "Changed"', () => {
    expect(historyWords('people.switchOnPurpose')).toBe('history.action.switchOnPurpose')
    expect(historyWords('people.other')).toBe('history.action.other')
  })
})

const LEFT_KEY = /(?:^|[>\s"])(?:band|section|card|rounding|example|code|category|limits|privacy|basis|gate|note|stepUp|done|held|field|leave|history|keys|common|problem)\.[a-zA-Z_]+/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'people', 'people-settings', 'admin', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [settingsScreen, historyScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people-settings'])['people-settings']!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const category of ABSENCE_CATEGORIES) has(`category.${category}`)
      for (const kind of RULE_KINDS) {
        has(`limits.kind.${kind}`)
        has(`limits.value.${kind}`)
      }
      for (const action of HISTORY_ACTIONS) has(`history.action.${action}`)
    }
  })
})
