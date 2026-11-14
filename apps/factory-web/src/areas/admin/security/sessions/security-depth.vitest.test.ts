import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { SECURITY_ACTOR_KINDS, SECURITY_EVENT_KINDS, SECURITY_RESULTS, SECURITY_SURFACES } from '../events/api'
import { detailLines, eventsQuery, eventsState, looksLikeAddress, summaryOf, whoWords } from '../events/model'
import { actionKey, fixedKey, stepUpChanges, stepUpOf, stepUpWider, switched } from '../step-up/model'
import { STEP_UP_FIXED } from './api'
import { DEMO_EVENTS, DEMO_SETTINGS } from './fixtures'
import { durationWords, lengthChanges, lengthErrors, lengthsOf, lengthsWider, settingsRefusal } from './model'

/** B-W2b-413: Session lengths, Actions that ask for a fresh code, Security events — the pure rules and their words. */

const words = CATALOGUE.en['admin-security-depth'] ?? {}
const t = createTranslator('en', words)
const ID = '0190f0e2-5e7e-7000-8000-000000000001'

describe('session lengths', () => {
  it('counts what changed, says when it widens (a fresh code), and checks with the domain’s rules', () => {
    const now = lengthsOf(DEMO_SETTINGS)
    expect(lengthChanges(DEMO_SETTINGS, now)).toBe(0)
    expect(lengthsWider(DEMO_SETTINGS, { ...now, officeIdleMinutes: 600 })).toBe(true)
    expect(lengthsWider(DEMO_SETTINGS, { ...now, officeIdleMinutes: 240, portalLongestHours: 8 })).toBe(false)
    expect(lengthChanges(DEMO_SETTINGS, { ...now, officeIdleMinutes: 240, portalLongestHours: 8 })).toBe(2)
    expect(lengthErrors({ ...now, portalIdleMinutes: 45 })).toEqual({ portalIdleMinutes: 'lengths.error.range' })
    expect(lengthErrors({ ...now, officeIdleMinutes: 1440, officeLongestHours: 12 })).toEqual({ officeIdleMinutes: 'lengths.error.idleLongest' })
  })

  it('a length in words', () => {
    expect(durationWords(480, t)).toBe('8 hours')
    expect(durationWords(10080, t)).toBe('7 days')
    expect(durationWords(90, t)).toBe('1 h 30 min')
    expect(durationWords(30, t)).toBe('30 minutes')
  })

  it('a refused save names its fields from the codes; 409 says read again', () => {
    expect(settingsRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/officeIdleMinutes/range' }, { path: 'body/stepUpOff/2/fixedAction' }]))).toEqual({ notice: 'settings.problem.invalid', fields: { officeIdleMinutes: 'range', stepUpOff: 'fixedAction' } })
    expect(settingsRefusal(new ApiError('conflict', 409, 'conflict', 'x')).notice).toBe('settings.problem.stale')
  })
})

describe('actions that ask for a fresh code', () => {
  it('switching off or allowing more tries widens; switching on is stricter; a fixed action never switches', () => {
    const now = stepUpOf(DEMO_SETTINGS)
    expect(now.off).toEqual(['invoices.issue'])
    const bank = DEMO_SETTINGS.stepUp.actions[0]!
    const access = DEMO_SETTINGS.stepUp.actions[1]!
    expect(stepUpWider(DEMO_SETTINGS, switched(now, bank, false))).toBe(true)
    expect(stepUpWider(DEMO_SETTINGS, switched(now, DEMO_SETTINGS.stepUp.actions[5]!, true))).toBe(false)
    expect(switched(now, access, false)).toBe(now)
    expect(stepUpWider(DEMO_SETTINGS, { ...now, maxFailures: 6 })).toBe(true)
    expect(stepUpWider(DEMO_SETTINGS, { ...now, lockMinutes: 30 })).toBe(false)
    expect(stepUpChanges(DEMO_SETTINGS, { ...switched(now, bank, false), lockMinutes: 30 })).toBe(2)
  })

  it('every action of the API and every reason it is fixed has words in both languages', () => {
    for (const locale of LOCALES) {
      const own = CATALOGUE[locale]['admin-security-depth'] ?? {}
      for (const action of DEMO_SETTINGS.stepUp.actions) expect(own[actionKey(action.key)], `${locale} ${action.key}`).toBeTruthy()
      for (const code of STEP_UP_FIXED) expect(own[fixedKey(code)]).toBeTruthy()
    }
  })
})

describe('security events', () => {
  it('the address holds the export’s own terms and the open event', () => {
    const state = eventsState(new URLSearchParams(`view=failed-sign-ins&surface=FLOOR&ip=192.0.2.10&event=${ID}&tab=x`))
    expect(state).toEqual({ filters: { view: 'failed-sign-ins', surface: 'FLOOR', ip: '192.0.2.10' }, open: ID })
    expect(eventsState(new URLSearchParams('view=all&surface=MOON&ip=nope&event=1'))).toEqual({ filters: { view: null, surface: null, ip: null }, open: null })
    expect(eventsQuery('tab=x&event=old', { view: 'exports', surface: null, ip: null }, null)).toBe('tab=x&view=exports')
    expect(looksLikeAddress('2001:db8::1')).toBe(true)
    expect(looksLikeAddress('192.0.2')).toBe(false)
  })

  it('who: a person by name, a floor worker never; details from codes only', () => {
    expect(whoWords(DEMO_EVENTS[1]!, t)).toBe('Marco Prova')
    expect(whoWords(DEMO_EVENTS[7]!, t)).toBe('A floor worker')
    expect(whoWords(DEMO_EVENTS[0]!, t)).toBe('Unknown')
    const lines = detailLines(DEMO_EVENTS[3]!.details, t, { permission: (name) => `[${name}]`, time: (iso) => iso })
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ['Right asked', '[costing.view]'],
      ['Request', 'GET /costing/styles/:styleId/revisions/:revisionId/cost-sheet'],
    ])
    expect(summaryOf(DEMO_EVENTS[1]!, t, (name) => name)).toBe('Wrong password')
    expect(summaryOf(DEMO_EVENTS[4]!, t, (name) => name)).toBe('admin.audit · CSV')
  })

  it('every kind, surface, result and actor has words in both languages', () => {
    for (const locale of LOCALES) {
      const own = CATALOGUE[locale]['admin-security-depth'] ?? {}
      for (const kind of SECURITY_EVENT_KINDS) expect(own[`events.kind.${kind}`]).toBeTruthy()
      for (const surface of SECURITY_SURFACES) expect(own[`events.surface.${surface}`]).toBeTruthy()
      for (const result of SECURITY_RESULTS) expect(own[`events.result.${result}`]).toBeTruthy()
      for (const actor of SECURITY_ACTOR_KINDS.filter((kind) => kind !== 'PERSON')) expect(own[`events.who.${actor}`]).toBeTruthy()
    }
  })
})
