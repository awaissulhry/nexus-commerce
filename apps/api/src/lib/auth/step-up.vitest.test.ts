/**
 * MCP.5 — a fresh 2FA code for connecting Claude: right code once, and a lock after 5 wrong ones.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { __stepUpTest, registerStepUpRedis, STEP_UP_MAX_FAILURES, verifyStepUpCode, type StepUpRedis } from './step-up.js'

const secret = generateSecret()

beforeEach(() => __stepUpTest.reset())

describe('MCP.5 — step-up 2FA', () => {
  it('accepts the right code once, then refuses it as reused', async () => {
    const code = generateSync({ secret })
    expect(await verifyStepUpCode('u1', secret, code)).toBe('ok')
    expect(await verifyStepUpCode('u1', secret, code)).toBe('reused')
    expect(await verifyStepUpCode('u2', secret, code)).toBe('ok')
  })

  it('locks after 5 wrong codes, even for the right one', async () => {
    for (let i = 1; i < STEP_UP_MAX_FAILURES; i++) expect(await verifyStepUpCode('u1', secret, '000000')).toBe('invalid')
    expect(await verifyStepUpCode('u1', secret, '000000')).toBe('locked')
    expect(await verifyStepUpCode('u1', secret, generateSync({ secret }))).toBe('locked')
  })

  it('refuses a missing secret or a malformed code as a wrong guess', async () => {
    expect(await verifyStepUpCode('u1', null, generateSync({ secret }))).toBe('invalid')
    expect(await verifyStepUpCode('u1', secret, 'abcdef')).toBe('invalid')
    expect(await verifyStepUpCode('u1', secret, undefined)).toBe('invalid')
  })

  it('is shared through Redis while it is connected', async () => {
    const store = new Map<string, string>()
    const redis: StepUpRedis = {
      status: 'ready',
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => (store.has(key) ? null : (store.set(key, value), 'OK')),
      incr: async (key) => { const next = Number(store.get(key) ?? 0) + 1; store.set(key, String(next)); return next },
      pexpire: async () => 1,
    }
    registerStepUpRedis(() => redis)
    const code = generateSync({ secret })
    expect(await verifyStepUpCode('u1', secret, code)).toBe('ok')
    expect([...store.keys()].some((key) => key.startsWith('auth:step-up:used:u1:'))).toBe(true)
    expect(await verifyStepUpCode('u1', secret, code)).toBe('reused')
  })
})
