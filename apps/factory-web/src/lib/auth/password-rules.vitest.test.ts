import { describe, expect, it } from 'vitest'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblems } from '@nexus/factory-domain/auth/password/password'
import { checkNewPassword, PASSWORD_RULES } from './password-rules'

describe('a new password, checked before it is sent (PLT-047, PLT-070)', () => {
  it('follows the API\'s rules, and is typed the same twice', () => {
    expect(checkNewPassword({ password: 'short', confirmation: 'short' })).toEqual({ password: { key: 'field.passwordShort', params: { min: 12 } } })
    expect(checkNewPassword({ password: 'aaaabbbbaaaabbbb', confirmation: 'aaaabbbbaaaabbbb' })).toEqual({ password: { key: 'field.passwordSimple' } })
    expect(checkNewPassword({ password: 'alex-demo-likes-tea', confirmation: 'alex-demo-likes-tea' }, { email: 'alex.demo@example.com', displayName: 'Alex Demo' })).toEqual({
      password: { key: 'field.passwordName' },
    })
    expect(checkNewPassword({ password: 'calm-meadow-river-91', confirmation: 'calm-meadow-river-19' })).toEqual({ confirmation: { key: 'field.repeatMismatch' } })
    expect(checkNewPassword({ password: 'calm-meadow-river-91', confirmation: 'calm-meadow-river-91' })).toEqual({})
  })

  it('mirrors factory-domain\'s password rules: it refuses what the API refuses, the well-known list aside', () => {
    expect(PASSWORD_RULES.min).toBe(PASSWORD_MIN_LENGTH)
    expect(PASSWORD_RULES.max).toBe(PASSWORD_MAX_LENGTH)
    const person = { email: 'alex.demo@example.com', displayName: 'Alex Demo' }
    const samples = ['short', 'x'.repeat(300), '            ', 'abababababab', 'calm-meadow-river-91', 'demo-alex-stuff-1', 'my alex.demo@example.com', 'Ünïcødé-wörds-ok-1', 'quiet harbour lantern']
    for (const password of samples) {
      const ours = Object.keys(checkNewPassword({ password, confirmation: password }, person)).length > 0
      const api = passwordProblems(password, person).length > 0
      expect(ours, password).toBe(api)
    }
  })
})
