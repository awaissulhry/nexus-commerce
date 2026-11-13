import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { COMPANY_ID, REMINDERS_ALL, REMINDERS_DEFAULT, REMINDERS_FOLLOW, REMINDERS_OWN_ON } from '../demo'
import { designScreen } from '../fixtures'
import type { ReminderSettings } from '../api'
import { chaseWordsKey, DEFAULT_CADENCE_DAYS, DEFAULT_HOURS, timingBody, timingChanged, timingDraftOf, timingHeld, timingInForce, timingProblems } from './model'

/**
 * B-W2b-382 (the screen gap B-W2b-377 left): Purchasing › Settings › Confirmation — the confirm-by hours and the reminders'
 * cadence as fields (`PUT /purchasing/reminders/settings/timing`, the Owner's) and the chase in words (OFF: no chase).
 */
const OWN: ReminderSettings = { ...REMINDERS_OWN_ON, company: { ...REMINDERS_OWN_ON.company!, confirmByHours: 72, reminderCadenceDays: 2 }, timing: { confirmByHours: 72, cadenceDays: 2, source: { confirmByHours: 'COMPANY', cadenceDays: 'COMPANY' } } }

describe('the reminders’ timing', () => {
  it('starts from the scope’s own row (empty: not set there)', () => {
    expect(timingDraftOf(OWN, 'company')).toEqual({ hours: '72', days: '2' })
    expect(timingDraftOf(REMINDERS_DEFAULT, 'company')).toEqual({ hours: '', days: '' })
    expect(timingDraftOf(REMINDERS_ALL, 'all')).toEqual({ hours: '', days: '' })
  })
  it('accepts whole hours 1–720 and days 1–30, or empty', () => {
    expect(timingProblems({ hours: '', days: '' })).toEqual({})
    expect(timingProblems({ hours: '96', days: '3' })).toEqual({})
    expect(timingProblems({ hours: '721', days: '0' })).toEqual({ hours: 'timing.problem.hours', days: 'timing.problem.days' })
    expect(timingProblems({ hours: '4.5', days: 'x' })).toEqual({ hours: 'timing.problem.hours', days: 'timing.problem.days' })
  })
  it('sends both values of the scope’s row at its version; empty clears', () => {
    expect(timingBody(OWN, { hours: '96', days: '' }, 'company', COMPANY_ID)).toEqual({ companyId: COMPANY_ID, confirmByHours: 96, reminderCadenceDays: null, version: 2 })
    expect(timingBody(REMINDERS_DEFAULT, { hours: '48', days: '2' }, 'company', COMPANY_ID)).toEqual({ companyId: COMPANY_ID, confirmByHours: 48, reminderCadenceDays: 2 })
    expect(timingBody(REMINDERS_ALL, { hours: '', days: '5' }, 'all', COMPANY_ID)).toEqual({ companyId: null, confirmByHours: null, reminderCadenceDays: 5, version: 1 })
    expect(timingChanged(OWN, 'company', { hours: '72', days: '2' })).toBe(false)
    expect(timingChanged(OWN, 'company', { hours: '72', days: '3' })).toBe(true)
  })
  it('holds Save with why: not the Owner, offline, busy, a field to fix', () => {
    expect(timingHeld({ ...OWN, mayChange: false }, 'company', { hours: '1', days: '1' }, false, false)).toBe('timing.held.noRight')
    expect(timingHeld({ ...REMINDERS_ALL, mayChange: false }, 'all', { hours: '1', days: '1' }, false, false)).toBe('timing.held.noRightAll')
    expect(timingHeld(OWN, 'company', { hours: '1', days: '1' }, true, false)).toBe('timing.held.offline')
    expect(timingHeld(OWN, 'company', { hours: '1000', days: '1' }, false, false)).toBe('timing.held.problem')
    expect(timingHeld(OWN, 'company', { hours: '96', days: '3' }, false, false)).toBeNull()
  })
  it('says what holds now and where it comes from; the default is 48 hours and every day', () => {
    expect(DEFAULT_HOURS).toBe(48)
    expect(DEFAULT_CADENCE_DAYS).toBe(1)
    expect(timingInForce(REMINDERS_DEFAULT).hours.key).toBe('timing.inForce.hoursDefault')
    expect(timingInForce(OWN)).toEqual({ hours: { key: 'timing.inForce.hours.COMPANY', params: { hours: 72, count: 72 } }, days: { key: 'timing.inForce.days.COMPANY', params: { days: 2, count: 2 } } })
    expect(timingInForce(REMINDERS_FOLLOW).days.params.days).toBe(1)
    expect(chaseWordsKey(false)).toBe('timing.chase.off')
  })
})

describe('SCR-256 draws the timing in both languages', () => {
  const View = designScreen.view as unknown as ComponentType<{ model: unknown }>
  const render = (id: string, locale: 'it' | 'en') =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: designScreen.cases.find((item) => item.id === id)!.model })))
  it.each(designScreen.cases.filter((item) => item.id.startsWith('w2b-382-')).map((item) => item.id))('%s: no key left on screen', (id) => {
    for (const locale of ['it', 'en'] as const) expect(render(id, locale)).not.toMatch(/\b(?:timing|confirm|done)\.[a-zA-Z]+/)
  })
  it('the fields say what holds, the chase in words; reminders off: no chase is sent', () => {
    const en = render('w2b-382-timing', 'en')
    expect(en).toContain('Now: 72 hours after the send, set for this company.')
    expect(en).toContain('Now: every 2 days, set for this company.')
    expect(en).toContain('chases its late lines every 2 days')
    const off = render('w2b-382-timing-follow', 'it')
    expect(off).toContain('il giro giornaliero non invia né solleciti né inseguimenti')
    expect(render('w2b-382-timing-bad', 'en')).toContain('Write whole hours from 1 to 720')
    expect(render('w2b-382-timing-buyer', 'en')).toContain('Only the Owner sets when suppliers are asked to confirm')
  })
})
