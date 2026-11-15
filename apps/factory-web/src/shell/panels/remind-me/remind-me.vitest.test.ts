import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PERSONAL_TEMPLATES } from '@nexus/factory-domain/insights/personal'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as remindScreen } from './fixtures'
import { dayBeforeAt, noteProblem, pickedProblem, remindOptions, whenWords } from './model'
import { designScreen as todayRemindScreen } from './today/fixtures'
import { reminderWriteProblem } from './api'
import { ApiError } from '../../../lib/api/errors'

/** Remind me (B-W2b-388; COL-041): the choices in the site's time, the day before, the words in it and en, every case drawn. */

/** A message key of the catalogues these screens use, drawn as text (never words). */
const KEY_ON_SCREEN = /\b(remind|set|today|waiting|reminders|following|views|prefs|push|board|held)\.[a-zA-Z]/

// Friday 13 November 2026, 09:30 in Rome.
const FRIDAY = Date.UTC(2026, 10, 13, 8, 30)

describe('Remind me', () => {
  it('offers later today, tomorrow, Monday, a date and "when something changes", in the site’s time', () => {
    const options = remindOptions(FRIDAY)
    expect(options.map((option) => option.choice)).toEqual(['LATER_TODAY', 'TOMORROW', 'MONDAY', 'PICK', 'UNTIL_CHANGE'])
    expect(options[0]).toEqual({ choice: 'LATER_TODAY', kind: 'AT_TIME', remindAt: '2026-11-13T15:00:00.000Z' })
    expect(options[1]!.remindAt).toBe('2026-11-14T07:00:00.000Z')
    expect(options[2]!.remindAt).toBe('2026-11-16T07:00:00.000Z')
    expect(options.at(-1)).toEqual({ choice: 'UNTIL_CHANGE', kind: 'ON_CHANGE', remindAt: null })
    // After 16:00 "later today" is gone.
    expect(remindOptions(Date.UTC(2026, 10, 13, 16, 0)).map((option) => option.choice)[0]).toBe('TOMORROW')
  })

  it('checks a picked moment and the note', () => {
    expect(pickedProblem('', FRIDAY)).toBe('remind.pickFirst')
    expect(pickedProblem('2026-11-13T08:00:00.000Z', FRIDAY)).toBe('remind.past')
    expect(pickedProblem('2028-01-01T08:00:00.000Z', FRIDAY)).toBe('remind.tooFar')
    expect(pickedProblem('2026-11-20T08:00:00.000Z', FRIDAY)).toBeNull()
    expect(noteProblem('x'.repeat(501))).toBe('remind.noteLong')
    expect(noteProblem('Supplier promised a date')).toBeNull()
  })

  it('"Remind me the day before" is 08:00 the day before, and held once that has passed', () => {
    expect(dayBeforeAt('2026-11-17', FRIDAY)).toBe('2026-11-16T07:00:00.000Z')
    expect(dayBeforeAt('2026-11-14', FRIDAY)).toBeNull()
  })

  it('says when a reminder comes back, came back or was done', () => {
    expect(whenWords({ state: 'WAITING', kind: 'AT_TIME', remindAt: 'x', cameBackAt: null, doneAt: null })).toEqual({ key: 'remind.when.at', at: 'x' })
    expect(whenWords({ state: 'WAITING', kind: 'ON_CHANGE', remindAt: null, cameBackAt: null, doneAt: null })).toEqual({ key: 'remind.when.onChange', at: null })
    expect(whenWords({ state: 'CAME_BACK', kind: 'ON_CHANGE', remindAt: null, cameBackAt: 'y', doneAt: null })).toEqual({ key: 'remind.when.back', at: 'y' })
    expect(whenWords({ state: 'DONE', kind: 'AT_TIME', remindAt: 'x', cameBackAt: 'y', doneAt: 'z' })).toEqual({ key: 'remind.when.done', at: 'z' })
  })

  it('says a refused change by its code: done, too many, moved', () => {
    const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path, message: 'x' }])
    expect(reminderWriteProblem(conflict('reminder/DONE'))).toEqual({ key: 'remind.problem.done', reload: true })
    expect(reminderWriteProblem(conflict('reminder/TOO_MANY'))).toEqual({ key: 'remind.problem.tooMany', reload: false })
    expect(reminderWriteProblem(conflict('version'))).toEqual({ key: 'remind.problem.changed', reload: true })
    expect(reminderWriteProblem(new ApiError('not_found', 404, 'not_found', 'x')).key).toBe('remind.problem.gone')
  })

  it('Today says a reminder that came back in it and en (every phrase key of the domain has words)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['home']).home ?? {})
      for (const key of Object.keys(PERSONAL_TEMPLATES).filter((entry) => entry.includes('REMINDER'))) expect(t(`today.w.${key}`), `${locale} today.w.${key}`).not.toBe(`today.w.${key}`)
      for (const key of ['today.kind.REMINDER', 'today.own.doneReminder', 'today.remind.dayBefore', 'today.remind.set', 'today.remind.passed']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })

  it('draws every case of SCR-543 and SCR-548 with no key on screen', () => {
    for (const screen of [remindScreen, todayRemindScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: item.model })))
          expect(html, `${screen.screen} ${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
        }
      }
    }
  })
})
