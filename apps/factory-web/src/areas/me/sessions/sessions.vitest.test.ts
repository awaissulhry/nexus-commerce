import { describe, expect, it } from 'vitest'
import { DEVICE_KINDS } from '@nexus/factory-domain/auth/sessions/device'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { DEMO_SESSIONS } from './fixtures'
import { deviceWords, othersOf, placeWords, sessionProblem, sessionRows } from './model'

/** B-W2b-413: Where I'm signed in and a person's Signed in now, in words (PLT-064). */

const t = createTranslator('en', CATALOGUE.en['admin-security-depth'] ?? {})

describe('live sessions in words', () => {
  it('this browser first, then the last used; the others are what Sign out everywhere else ends', () => {
    const rows = sessionRows([...DEMO_SESSIONS].reverse())
    expect(rows[0]!.current).toBe(true)
    expect(rows.slice(1).map((row) => row.lastUsedAt)).toEqual([...rows.slice(1).map((row) => row.lastUsedAt)].sort().reverse())
    expect(othersOf(DEMO_SESSIONS)).toBe(3)
    expect(othersOf(DEMO_SESSIONS.slice(0, 1))).toBe(0)
  })

  it('says the device kind in the person’s language, else the stored label, else unknown; the browser as it is', () => {
    expect(deviceWords({ deviceKind: 'MAC', deviceLabel: 'Mac', browser: 'Firefox 132' }, t)).toBe('Mac · Firefox 132')
    expect(deviceWords({ deviceKind: null, deviceLabel: 'Smart TV', browser: null }, t)).toBe('Smart TV')
    expect(deviceWords({ deviceKind: null, deviceLabel: null, browser: null }, t)).toBe('Unknown device')
    expect(deviceWords({ deviceKind: 'ANDROID_PHONE', deviceLabel: null, browser: null }, createTranslator('it', CATALOGUE.it['admin-security-depth'] ?? {}))).toBe('Telefono Android')
  })

  it('a place is a city and a country, a country, or unknown: never an address', () => {
    expect(placeWords({ country: 'IT', city: 'Milano' }, 'en', t)).toBe('Milano, Italy')
    expect(placeWords({ country: 'IT', city: null }, 'it', t)).toBe('Italia')
    expect(placeWords({ country: null, city: null }, 'en', t)).toBe('Unknown place')
  })

  it('a refusal in words from its code', () => {
    expect(sessionProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'sessions/current' }]))).toBe('session.problem.current')
    expect(sessionProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'sessions/self' }]))).toBe('session.problem.self')
    expect(sessionProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('session.problem.gone')
    expect(sessionProblem(new Error('x'))).toBe('session.problem.failed')
  })

  it('every device kind and surface has words in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['admin-security-depth'] ?? {}
      for (const kind of DEVICE_KINDS) expect(words[`session.device.${kind}`], `${locale} ${kind}`).toBeTruthy()
      for (const surface of ['OFFICE', 'PORTAL', 'PREVIEW']) expect(words[`session.surface.${surface}`]).toBeTruthy()
    }
  })
})
