import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import type { OfficeMe } from '../../lib/api/office'
import { CATALOGUE } from '../../lib/i18n/messages'
import { LOCALES } from '../../lib/i18n/locales'
import { changePassword, confirmTotp, disableTotp, setLocale, signOutHere, startTotpSetup } from './me-api'
import {
  authenticatorAtRest,
  checkCurrentPassword,
  checkTotpCode,
  groupedSecret,
  otherProblem,
  passwordChangeProblem,
  profileModel,
  totpConfirmProblem,
  totpDisableProblem,
  type MeProblem,
} from './me-model'

/** SCR-007: the profile's model from `me`, the checks, the refusals in the page's words, and the calls. */

const ME: OfficeMe = {
  user: { id: '0190f0e2-3333-7000-8000-000000000001', email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'en-GB' },
  tenant: { id: '0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10', slug: 'demo', name: 'Officina Demo' },
  company: { id: '0190f0e2-1111-7000-8000-000000000001', code: 'DEMO', name: 'Officina Demo S.r.l.' },
  session: { id: '0190f0e2-5555-7000-8000-000000000001', createdAt: '2026-10-28T08:00:00.000Z', idleExpiresAt: '2026-10-28T16:00:00.000Z', absoluteExpiresAt: '2026-11-04T08:00:00.000Z', stepUpUntil: null },
  mfa: { enabled: false, required: true, satisfied: false, recoveryCodesLeft: 0 },
  permissions: [],
}

const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, issues: { path: string }[] = []) => new ApiError(kind, status, 'x', 'English for the logs', null, issues as never)

describe('the profile from me (SCR-007)', () => {
  it('the person, the language, this session and the authenticator at rest', () => {
    const model = profileModel(ME, 'dark')
    expect(model).toMatchObject({
      person: { displayName: 'Alex Demo', email: 'alex.demo@example.com' },
      tenant: 'Officina Demo',
      locale: 'en',
      theme: 'dark',
      timeZone: 'Europe/Rome',
      password: { state: 'closed' },
      authenticator: { state: 'off', required: true },
      session: { createdAt: ME.session.createdAt, idleExpiresAt: ME.session.idleExpiresAt, absoluteExpiresAt: ME.session.absoluteExpiresAt },
    })
    expect(authenticatorAtRest({ enabled: true, required: false, satisfied: true, recoveryCodesLeft: 7 })).toEqual({ state: 'on', required: false, recoveryCodesLeft: 7 })
    expect(profileModel({ ...ME, user: { ...ME.user, locale: 'de' } }, 'system').locale).toBe('it')
  })

  it('checks a form before it asks, and shows the set-up key in groups of four', () => {
    expect(checkCurrentPassword('')).toEqual({ current: { key: 'field.currentRequired' } })
    expect(checkTotpCode('12 34 56')).toEqual({})
    expect(checkTotpCode('ABCDE-23456')).toEqual({ code: { key: 'field.codeFormat' } })
    expect(groupedSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
  })
})

describe('a refusal is said in the page\'s words', () => {
  it('a new password: the current one wrong, the new one refused, the account locked', () => {
    expect(passwordChangeProblem(error('invalid', 400, [{ path: 'currentPassword' }]))).toBe('wrongPassword')
    expect(passwordChangeProblem(error('invalid', 400, [{ path: 'password' }]))).toBe('passwordRefused')
    expect(passwordChangeProblem(error('forbidden', 403))).toBe('locked')
    expect(passwordChangeProblem(error('signed_out', 401))).toBe('signedOut')
    expect(passwordChangeProblem(error('rate_limited', 429))).toBe('rateLimited')
    expect(passwordChangeProblem(error('conflict', 409))).toBe('changed')
  })

  it('the authenticator: a code that does not match, a wrong password, a lock, a change meanwhile', () => {
    expect(totpConfirmProblem(error('invalid', 400))).toBe('wrongCode')
    expect(totpConfirmProblem(error('conflict', 409))).toBe('changed')
    expect(totpDisableProblem(error('invalid', 400))).toBe('wrongPassword')
    expect(totpDisableProblem(error('forbidden', 403))).toBe('locked')
    expect(totpDisableProblem(error('conflict', 409))).toBe('changed')
    expect(otherProblem(error('unavailable', 0))).toBe('unavailable')
  })
})

type Reply = { status: number; body?: unknown }

function scripted(replies: Record<string, Reply>) {
  const calls: { url: string; csrf: string | null; company: string | null; body: unknown }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({ url, csrf: headers.get('x-csrf-token'), company: headers.get('x-factory-company'), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const reply = replies[url.replace(/^\/api/, '')] ?? { status: 404, body: { error: { code: 'route_not_found', message: url } } }
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status })
  }
  return { api: createApiClient({ baseUrl: '/api', company: 'DEMO', fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => 'csrf-1' }), calls }
}

describe('the profile\'s calls (office client: CSRF header and company)', () => {
  it('saves the language and a new password', async () => {
    const { api, calls } = scripted({
      '/auth/office/locale': { status: 200, body: { locale: 'en' } },
      '/auth/office/password': { status: 200, body: { status: 'password_changed', sessionsEnded: 2 } },
    })
    expect(await setLocale(api, 'en')).toEqual({ ok: true, value: { locale: 'en' } })
    expect(await changePassword(api, { current: 'quiet-harbour-lantern-58', password: 'calm-meadow-river-91' })).toEqual({ ok: true, value: { status: 'password_changed', sessionsEnded: 2 } })
    expect(calls).toEqual([
      { url: '/api/auth/office/locale', csrf: 'csrf-1', company: 'DEMO', body: { locale: 'en' } },
      { url: '/api/auth/office/password', csrf: 'csrf-1', company: 'DEMO', body: { currentPassword: 'quiet-harbour-lantern-58', password: 'calm-meadow-river-91' } },
    ])
  })

  it('sets the authenticator up: the secret, then the codes shown once; switches it off with the password', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `ABCDE-2345${i}`)
    const { api } = scripted({
      '/auth/office/totp/setup': { status: 200, body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' } },
      '/auth/office/totp/confirm': { status: 200, body: { recoveryCodes: codes } },
      '/auth/office/totp/disable': { status: 400, body: { error: { code: 'validation_failed', message: 'The password is wrong.', issues: [{ path: 'password', message: 'Wrong password.' }] } } },
      '/auth/office/sign-out': { status: 200, body: { status: 'signed_out' } },
    })
    expect(await startTotpSetup(api)).toEqual({ ok: true, value: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' } })
    expect(await confirmTotp(api, '123456')).toEqual({ ok: true, value: { recoveryCodes: codes } })
    expect(await disableTotp(api, 'wrong')).toEqual({ ok: false, problem: 'wrongPassword' })
    expect(await signOutHere(api)).toMatchObject({ ok: true })
  })
})

describe('every sentence the profile can show exists in Italian and English (PLT-127)', () => {
  const problems: MeProblem[] = ['wrongPassword', 'wrongCode', 'locked', 'rateLimited', 'passwordRefused', 'changed', 'unavailable', 'signedOut']
  const fields = ['currentRequired', 'codeFormat', 'passwordRequired', 'passwordShort', 'passwordLong', 'passwordSimple', 'passwordName', 'repeatMismatch']

  it('the same keys in both languages, every problem and every field check', () => {
    expect(Object.keys(CATALOGUE.it.me ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en.me ?? {}).sort())
    for (const locale of LOCALES) {
      const me = CATALOGUE[locale].me ?? {}
      for (const key of [...problems.map((p) => `problem.${p}`), ...fields.map((f) => `field.${f}`), 'display.themes.light', 'display.themes.dark', 'display.themes.system']) {
        expect(me[key], `${locale} ${key}`).toBeTruthy()
      }
    }
  })
})
