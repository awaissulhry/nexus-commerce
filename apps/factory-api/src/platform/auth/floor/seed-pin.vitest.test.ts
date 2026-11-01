import { describe, expect, it } from 'vitest'
import { pinKeyring, pinProblems, verifyPin } from '@nexus/factory-domain/auth/floor/pin'
import { SCRYPT_PARAMS } from '@nexus/factory-domain/auth/password/password'
// The factory-db seeds are no package export: a test reads them where they live.
import { SEED_PIN_PEPPER, SEED_WORKER_PIN, seedWorkerPinHash } from '../../../../../../packages/factory-db/seed/floor-auth'
import { LOCAL_PIN_PEPPER } from '../../../env'

// The seed workers' PIN (B-W2b-30, packages/factory-db/seed/floor-auth.ts): it opens with the pepper of a local API and
// with no other, and the first sign-in re-hashes it with the full scrypt settings.

describe('the seed workers PIN', () => {
  it('is hashed with the local pepper of env.ts, so a local API opens it', async () => {
    expect(SEED_PIN_PEPPER).toBe(LOCAL_PIN_PEPPER)
    const check = await verifyPin(SEED_WORKER_PIN, await seedWorkerPinHash(), pinKeyring(LOCAL_PIN_PEPPER))
    expect(check).toEqual({ ok: true, needsRehash: true })
    expect(SCRYPT_PARAMS.logN).toBeGreaterThan(12)
  })

  it('opens nothing with another pepper (staging and production have their own)', async () => {
    const check = await verifyPin(SEED_WORKER_PIN, await seedWorkerPinHash(), pinKeyring('a-made-up-pin-pepper-of-at-least-thirty-two-chars'))
    expect(check.ok).toBe(false)
  })

  it('passes the PIN policy for both seed workers of each plant', () => {
    for (const employeeCode of ['SEED-A1-1', 'SEED-A1-2', 'SEED-B1-1', 'SEED-B1-2']) expect(pinProblems(SEED_WORKER_PIN, { employeeCode })).toEqual([])
  })
})
