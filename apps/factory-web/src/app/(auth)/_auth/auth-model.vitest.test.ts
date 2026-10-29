import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { checkCode, checkForgot, checkInvitation, checkSignIn, codeOf, newPasswordProblem, signInProblem, tokenFromFragment, type AuthProblem } from './auth-model'

const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, issues: { path: string }[] = []) =>
  new ApiError(kind, status, 'x', 'the API said something', null, issues as never)

describe('the sign-in forms check themselves before asking (SCR-001)', () => {
  it('sign-in needs a company, an email address and a password', () => {
    expect(checkSignIn({ company: '', email: '', password: '' })).toEqual({
      company: { key: 'field.companyRequired' },
      email: { key: 'field.emailRequired' },
      password: { key: 'field.passwordRequired' },
    })
    expect(checkSignIn({ company: ' demo ', email: 'alex.demo', password: 'x' })).toEqual({ email: { key: 'field.emailFormat' } })
    expect(checkSignIn({ company: 'demo', email: ' Alex.Demo@Example.com ', password: 'x' })).toEqual({})
    expect(checkForgot({ company: 'demo', email: 'nobody@example' })).toEqual({ email: { key: 'field.emailFormat' } })
  })

  it('a code is 6 digits from the app, or a recovery code in recovery mode', () => {
    expect(codeOf('123 456', false)).toBe('123456')
    expect(codeOf('12345', false)).toBeNull()
    expect(codeOf('abcde-23456', true)).toBe('ABCDE23456')
    expect(codeOf('ABCDE-2345O', true)).toBeNull()
    expect(checkCode('123456', true)).toEqual({ code: { key: 'field.recoveryFormat' } })
    expect(checkCode('ABCDE-23456', false)).toEqual({ code: { key: 'field.codeFormat' } })
    expect(checkCode('ABCDE 23456', true)).toEqual({})
  })

  it('an invitation needs a name, and a new password by the shared rules (lib/auth/password-rules)', () => {
    expect(checkInvitation({ displayName: ' ', password: 'calm-meadow-river-91', confirmation: 'calm-meadow-river-91' }, 'new.person@example.com')).toEqual({
      displayName: { key: 'field.nameRequired' },
    })
    expect(checkInvitation({ displayName: 'New Person', password: 'new-person-2026', confirmation: 'new-person-2026' }, 'new.person@example.com')).toEqual({
      password: { key: 'field.passwordName' },
    })
  })
})

describe('an API refusal becomes the page\'s own sentence, never which part was wrong', () => {
  it('sign-in: one answer for a wrong company, email, password or a lock; another for a wrong code', () => {
    expect(signInProblem(error('signed_out', 401), 'password')).toBe('wrongCredentials')
    expect(signInProblem(error('signed_out', 401), 'code')).toBe('wrongCode')
    expect(signInProblem(error('forbidden', 403), 'password')).toBe('suspended')
    expect(signInProblem(error('rate_limited', 429), 'code')).toBe('rateLimited')
    expect(signInProblem(error('unavailable', 0), 'password')).toBe('unavailable')
    expect(signInProblem(error('internal', 500), 'password')).toBe('unavailable')
  })

  it('a new password: the link gone, the password refused, or the API away', () => {
    expect(newPasswordProblem(error('not_found', 404))).toBe('link-invalid')
    expect(newPasswordProblem(error('invalid', 400, [{ path: 'password' }]))).toBe('passwordRefused')
    expect(newPasswordProblem(error('invalid', 400))).toBe('invalid')
    expect(newPasswordProblem(error('rate_limited', 429))).toBe('rateLimited')
    expect(newPasswordProblem(error('unavailable', 502))).toBe('unavailable')
  })
})

describe('a mailed link\'s token comes from the fragment only', () => {
  const token = '0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10.0190f0e2-3333-7000-8000-000000000001.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'

  it('reads #token=… and refuses anything else', () => {
    expect(tokenFromFragment(`#token=${token}`)).toBe(token)
    expect(tokenFromFragment(`#token=${encodeURIComponent(token)}`)).toBe(token)
    expect(tokenFromFragment('#token=a.b.c')).toBeNull()
    expect(tokenFromFragment(`#token=${token}x`)).toBeNull()
    expect(tokenFromFragment('')).toBeNull()
    expect(tokenFromFragment(null)).toBeNull()
  })
})

describe('every sentence the sign-in pages can show exists in Italian and English (PLT-127)', () => {
  const problems: AuthProblem[] = ['wrongCredentials', 'wrongCode', 'suspended', 'rateLimited', 'unavailable', 'passwordRefused', 'changeExpired', 'noCompany', 'invalid']
  const fields = ['companyRequired', 'emailRequired', 'emailFormat', 'passwordRequired', 'codeFormat', 'recoveryFormat', 'nameRequired', 'passwordShort', 'passwordLong', 'passwordSimple', 'passwordName', 'repeatMismatch']

  it('the same keys in both languages, and every problem and field check named', () => {
    const it_ = CATALOGUE.it.auth ?? {}
    const en = CATALOGUE.en.auth ?? {}
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    for (const locale of LOCALES) {
      const auth = CATALOGUE[locale].auth ?? {}
      for (const key of [...problems.map((p) => `problem.${p}`), ...fields.map((f) => `field.${f}`)]) expect(auth[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
